[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("install", "clear", "status")]
    [string] $Action
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$RuntimeRoot = Join-Path $ProjectRoot ".local-env"
$PythonRoot = Join-Path $RuntimeRoot "python"
$PythonExe = Join-Path $PythonRoot "python.exe"
$PackagesRoot = Join-Path $RuntimeRoot "packages"
$PiperModule = Join-Path $PackagesRoot "piper\__init__.py"
$OnnxRuntimeModule = Join-Path $PackagesRoot "onnxruntime\__init__.py"
$RequirementsFile = Join-Path $PSScriptRoot "local-runtime-requirements.txt"
$WheelManifestFile = Join-Path $PSScriptRoot "local-runtime-wheels.json"
$DownloadRoot = Join-Path $RuntimeRoot "downloads"
$WheelRoot = Join-Path $DownloadRoot "wheels"
$ExtractRoot = Join-Path $RuntimeRoot "python-extract"
$ArchiveName = "cpython-3.10.20+20260718-x86_64-pc-windows-msvc-install_only_stripped.tar.gz"
$ArchivePath = Join-Path $DownloadRoot $ArchiveName
$ArchiveUrl = "https://github.com/astral-sh/python-build-standalone/releases/download/20260718/cpython-3.10.20%2B20260718-x86_64-pc-windows-msvc-install_only_stripped.tar.gz"
$ArchiveSha256 = "cf7eae46857d3e4ece9f14711e477566069fbd4cf7874658132284e515d242f8"
$InstallMarker = Join-Path $RuntimeRoot "install.json"
$FfmpegVersion = "8.1.2"
$FfmpegRoot = Join-Path $RuntimeRoot "ffmpeg"
$FfmpegExe = Join-Path $FfmpegRoot "bin\ffmpeg.exe"
$FfprobeExe = Join-Path $FfmpegRoot "bin\ffprobe.exe"
$FfmpegArchiveName = "ffmpeg-8.1.2-essentials_build.zip"
$FfmpegArchivePath = Join-Path $DownloadRoot $FfmpegArchiveName
$FfmpegArchiveUrl = "https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-8.1.2-essentials_build.zip"
$FfmpegArchiveSha256 = "db580001caa24ac104c8cb856cd113a87b0a443f7bdf47d8c12b1d740584a2ec"
$FfmpegExtractRoot = Join-Path $RuntimeRoot "ffmpeg-extract"

function Test-LocalPythonEnvironment {
    return (Test-Path -LiteralPath $PythonExe -PathType Leaf) -and
        (Test-Path -LiteralPath $PiperModule -PathType Leaf) -and
        (Test-Path -LiteralPath $OnnxRuntimeModule -PathType Leaf) -and
        (Test-Path -LiteralPath $InstallMarker -PathType Leaf)
}

function Test-LocalFfmpeg {
    return (Test-Path -LiteralPath $FfmpegExe -PathType Leaf) -and
        (Test-Path -LiteralPath $FfprobeExe -PathType Leaf)
}

function Test-LocalEnvironment {
    return (Test-LocalPythonEnvironment) -and (Test-LocalFfmpeg)
}

function Get-Sha256 {
    param([Parameter(Mandatory = $true)][string] $Path)

    $stream = [System.IO.File]::OpenRead($Path)
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = $sha256.ComputeHash($stream)
        return ([System.BitConverter]::ToString($bytes)).Replace("-", "").ToLowerInvariant()
    }
    finally {
        $sha256.Dispose()
        $stream.Dispose()
    }
}

function Assert-SafeRuntimePath {
    $resolvedProject = [System.IO.Path]::GetFullPath($ProjectRoot).TrimEnd("\")
    $resolvedRuntime = [System.IO.Path]::GetFullPath($RuntimeRoot).TrimEnd("\")
    if (-not $resolvedRuntime.StartsWith($resolvedProject + "\", [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to modify a runtime directory outside the project: $resolvedRuntime"
    }
    if ([System.IO.Path]::GetFileName($resolvedRuntime) -ne ".local-env") {
        throw "Refusing to modify an unexpected runtime directory: $resolvedRuntime"
    }
}

function Remove-LocalEnvironment {
    Assert-SafeRuntimePath
    if (Test-Path -LiteralPath $RuntimeRoot) {
        Remove-Item -LiteralPath $RuntimeRoot -Recurse -Force
        Write-Host "Removed local environment: $RuntimeRoot"
    }
    else {
        Write-Host "Local environment is already clear: $RuntimeRoot"
    }
}

function Invoke-IsolatedPython {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]] $PythonArguments)

    $savedVariables = @{}
    foreach ($name in @("PYTHONHOME", "PYTHONPATH", "CONDA_PREFIX", "CONDA_DEFAULT_ENV", "CONDA_PROMPT_MODIFIER", "_CE_CONDA", "_CE_M")) {
        $savedVariables[$name] = [System.Environment]::GetEnvironmentVariable($name, "Process")
        [System.Environment]::SetEnvironmentVariable($name, $null, "Process")
    }
    $savedVariables["PYTHONNOUSERSITE"] = [System.Environment]::GetEnvironmentVariable("PYTHONNOUSERSITE", "Process")
    [System.Environment]::SetEnvironmentVariable("PYTHONNOUSERSITE", "1", "Process")

    try {
        & $PythonExe @PythonArguments
        if ($LASTEXITCODE -ne 0) {
            throw "Local Python exited with code $LASTEXITCODE."
        }
    }
    finally {
        foreach ($entry in $savedVariables.GetEnumerator()) {
            [System.Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, "Process")
        }
    }
}

function Install-LocalPythonEnvironment {
    if (Test-LocalPythonEnvironment) {
        Write-Host "Local Python/Piper runtime is already installed."
        Write-Host "Python: $PythonExe"
        Write-Host "Packages: $PackagesRoot"
        return
    }

    Assert-SafeRuntimePath
    New-Item -ItemType Directory -Path $DownloadRoot -Force | Out-Null
    if ((Test-Path -LiteralPath $ArchivePath -PathType Leaf) -and (Get-Sha256 -Path $ArchivePath) -ne $ArchiveSha256) {
        Write-Host "Discarding a cached Python archive that failed SHA-256 verification."
        Remove-Item -LiteralPath $ArchivePath -Force
    }

    if (-not (Test-Path -LiteralPath $ArchivePath -PathType Leaf)) {
        Write-Host "Downloading CPython 3.10.20 standalone..."
        $partialArchive = "$ArchivePath.part"
        Remove-Item -LiteralPath $partialArchive -Force -ErrorAction SilentlyContinue
        $curlCommand = Get-Command "curl.exe" -ErrorAction SilentlyContinue
        if ($curlCommand) {
            & $curlCommand.Source --fail --location --retry 3 --output $partialArchive $ArchiveUrl
            if ($LASTEXITCODE -ne 0) {
                Remove-Item -LiteralPath $partialArchive -Force -ErrorAction SilentlyContinue
                throw "curl.exe could not download the standalone Python archive."
            }
        }
        else {
            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
            Invoke-WebRequest -Uri $ArchiveUrl -OutFile $partialArchive -UseBasicParsing
        }
        if (-not (Test-Path -LiteralPath $partialArchive -PathType Leaf) -or (Get-Item -LiteralPath $partialArchive).Length -lt 10MB) {
            Remove-Item -LiteralPath $partialArchive -Force -ErrorAction SilentlyContinue
            throw "The downloaded standalone Python archive is missing or unexpectedly small."
        }
        if ((Get-Sha256 -Path $partialArchive) -ne $ArchiveSha256) {
            Remove-Item -LiteralPath $partialArchive -Force -ErrorAction SilentlyContinue
            throw "SHA-256 verification failed for the standalone Python archive."
        }
        Move-Item -LiteralPath $partialArchive -Destination $ArchivePath
    }
    else {
        Write-Host "Using cached Python archive: $ArchivePath"
    }

    Remove-Item -LiteralPath $PythonRoot -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $PackagesRoot -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $ExtractRoot -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Path $ExtractRoot -Force | Out-Null

    Write-Host "Extracting local Python..."
    & tar.exe -xzf $ArchivePath -C $ExtractRoot
    if ($LASTEXITCODE -ne 0) {
        throw "tar.exe could not extract the standalone Python archive."
    }

    $pythonCandidate = Get-ChildItem -LiteralPath $ExtractRoot -Filter "python.exe" -File -Recurse |
        Sort-Object { $_.FullName.Length } |
        Select-Object -First 1
    if (-not $pythonCandidate) {
        throw "The standalone Python archive did not contain python.exe."
    }
    Move-Item -LiteralPath $pythonCandidate.Directory.FullName -Destination $PythonRoot
    Remove-Item -LiteralPath $ExtractRoot -Recurse -Force

    Write-Host "Downloading pinned Piper/ONNX Runtime wheels..."
    New-Item -ItemType Directory -Path $WheelRoot -Force | Out-Null
    $wheelManifest = Get-Content -LiteralPath $WheelManifestFile -Raw | ConvertFrom-Json
    foreach ($wheel in $wheelManifest) {
        $wheelPath = Join-Path $WheelRoot $wheel.filename
        $wheelIsValid = $false
        if (Test-Path -LiteralPath $wheelPath -PathType Leaf) {
            $actualHash = Get-Sha256 -Path $wheelPath
            $wheelIsValid = $actualHash -eq $wheel.sha256
        }
        if (-not $wheelIsValid) {
            $partialWheel = "$wheelPath.part"
            Remove-Item -LiteralPath $partialWheel -Force -ErrorAction SilentlyContinue
            $curlCommand = Get-Command "curl.exe" -ErrorAction SilentlyContinue
            if ($curlCommand) {
                & $curlCommand.Source --silent --show-error --fail --location --retry 3 --output $partialWheel $wheel.url
                if ($LASTEXITCODE -ne 0) {
                    Remove-Item -LiteralPath $partialWheel -Force -ErrorAction SilentlyContinue
                    throw "curl.exe could not download $($wheel.filename)."
                }
            }
            else {
                [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
                Invoke-WebRequest -Uri $wheel.url -OutFile $partialWheel -UseBasicParsing
            }
            if (-not (Test-Path -LiteralPath $partialWheel -PathType Leaf)) {
                throw "The downloaded wheel is missing: $($wheel.filename)"
            }
            $actualHash = Get-Sha256 -Path $partialWheel
            if ($actualHash -ne $wheel.sha256) {
                Remove-Item -LiteralPath $partialWheel -Force -ErrorAction SilentlyContinue
                throw "SHA-256 verification failed for $($wheel.filename)."
            }
            Move-Item -LiteralPath $partialWheel -Destination $wheelPath -Force
        }
    }

    Write-Host "Installing Piper and ONNX Runtime into the project..."
    New-Item -ItemType Directory -Path $PackagesRoot -Force | Out-Null
    Invoke-IsolatedPython -PythonArguments @(
        "-I", "-m", "pip", "install",
        "--no-index",
        "--find-links", $WheelRoot,
        "--disable-pip-version-check",
        "--no-warn-script-location",
        "--target", $PackagesRoot,
        "--requirement", $RequirementsFile
    )

    $escapedPackages = $PackagesRoot.Replace("\", "\\").Replace("'", "\'")
    $validationCode = "import sys; sys.path.insert(0, '$escapedPackages'); import piper, numpy, onnxruntime; print('Piper runtime import check passed')"
    Invoke-IsolatedPython -PythonArguments @("-I", "-S", "-c", $validationCode)

    @{
        python = "3.10.20"
        piper = "1.5.0"
        onnxruntime = "1.23.2"
        architecture = "windows-x86_64"
        installedAt = [DateTime]::UtcNow.ToString("o")
    } | ConvertTo-Json | Set-Content -LiteralPath $InstallMarker -Encoding UTF8

    Remove-Item -LiteralPath $DownloadRoot -Recurse -Force -ErrorAction SilentlyContinue

    Write-Host "Local Python/Piper runtime is ready."
    Write-Host "Python: $PythonExe"
    Write-Host "Packages: $PackagesRoot"
}

function Install-LocalFfmpeg {
    if (Test-LocalFfmpeg) {
        Write-Host "Local FFmpeg runtime is already installed."
        Write-Host "FFmpeg: $FfmpegExe"
        return
    }

    Assert-SafeRuntimePath
    New-Item -ItemType Directory -Path $DownloadRoot -Force | Out-Null
    if ((Test-Path -LiteralPath $FfmpegArchivePath -PathType Leaf) -and (Get-Sha256 -Path $FfmpegArchivePath) -ne $FfmpegArchiveSha256) {
        Write-Host "Discarding a cached FFmpeg archive that failed SHA-256 verification."
        Remove-Item -LiteralPath $FfmpegArchivePath -Force
    }

    if (-not (Test-Path -LiteralPath $FfmpegArchivePath -PathType Leaf)) {
        Write-Host "Downloading FFmpeg $FfmpegVersion essentials build for Windows x64..."
        $partialArchive = "$FfmpegArchivePath.part"
        Remove-Item -LiteralPath $partialArchive -Force -ErrorAction SilentlyContinue
        $curlCommand = Get-Command "curl.exe" -ErrorAction SilentlyContinue
        if ($curlCommand) {
            & $curlCommand.Source --fail --location --retry 3 --output $partialArchive $FfmpegArchiveUrl
            if ($LASTEXITCODE -ne 0) {
                Remove-Item -LiteralPath $partialArchive -Force -ErrorAction SilentlyContinue
                throw "curl.exe could not download the FFmpeg archive."
            }
        }
        else {
            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
            Invoke-WebRequest -Uri $FfmpegArchiveUrl -OutFile $partialArchive -UseBasicParsing
        }
        if (-not (Test-Path -LiteralPath $partialArchive -PathType Leaf) -or (Get-Item -LiteralPath $partialArchive).Length -lt 20MB) {
            Remove-Item -LiteralPath $partialArchive -Force -ErrorAction SilentlyContinue
            throw "The downloaded FFmpeg archive is missing or unexpectedly small."
        }
        if ((Get-Sha256 -Path $partialArchive) -ne $FfmpegArchiveSha256) {
            Remove-Item -LiteralPath $partialArchive -Force -ErrorAction SilentlyContinue
            throw "SHA-256 verification failed for the FFmpeg archive."
        }
        Move-Item -LiteralPath $partialArchive -Destination $FfmpegArchivePath
    }
    else {
        Write-Host "Using cached FFmpeg archive: $FfmpegArchivePath"
    }

    Remove-Item -LiteralPath $FfmpegRoot -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $FfmpegExtractRoot -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Path $FfmpegExtractRoot -Force | Out-Null

    Write-Host "Extracting local FFmpeg..."
    Expand-Archive -LiteralPath $FfmpegArchivePath -DestinationPath $FfmpegExtractRoot -Force
    $ffmpegCandidate = Get-ChildItem -LiteralPath $FfmpegExtractRoot -Filter "ffmpeg.exe" -File -Recurse |
        Where-Object { $_.Directory.Name -eq "bin" } |
        Sort-Object { $_.FullName.Length } |
        Select-Object -First 1
    if (-not $ffmpegCandidate) {
        throw "The FFmpeg archive did not contain bin\ffmpeg.exe."
    }
    $packageRoot = Split-Path -Parent $ffmpegCandidate.Directory.FullName
    if (-not (Test-Path -LiteralPath (Join-Path $ffmpegCandidate.Directory.FullName "ffprobe.exe") -PathType Leaf)) {
        throw "The FFmpeg archive did not contain bin\ffprobe.exe."
    }
    Move-Item -LiteralPath $packageRoot -Destination $FfmpegRoot
    Remove-Item -LiteralPath $FfmpegExtractRoot -Recurse -Force

    $versionOutput = & $FfmpegExe -hide_banner -version 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "The local FFmpeg executable failed its version check."
    }
    $encoderOutput = & $FfmpegExe -hide_banner -encoders 2>&1
    if ($LASTEXITCODE -ne 0 -or -not ($encoderOutput -match "libmp3lame")) {
        throw "The local FFmpeg build does not provide the libmp3lame MP3 encoder."
    }

    Remove-Item -LiteralPath $DownloadRoot -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host ($versionOutput | Select-Object -First 1)
    Write-Host "Local FFmpeg runtime is ready."
    Write-Host "FFmpeg: $FfmpegExe"
}

function Install-LocalEnvironment {
    if (Test-LocalEnvironment) {
        Write-Host "Project-local runtime is already installed."
        Write-Host "Python: $PythonExe"
        Write-Host "Packages: $PackagesRoot"
        Write-Host "FFmpeg: $FfmpegExe"
        return
    }

    if (-not (Test-LocalPythonEnvironment)) {
        Install-LocalPythonEnvironment
    }
    else {
        Write-Host "Keeping the existing local Python/Piper runtime."
    }
    if (-not (Test-LocalFfmpeg)) {
        Install-LocalFfmpeg
    }
    else {
        Write-Host "Keeping the existing local FFmpeg runtime."
    }

    if (-not (Test-LocalEnvironment)) {
        throw "The project-local runtime is incomplete after installation."
    }
    @{
        python = "3.10.20"
        piper = "1.5.0"
        onnxruntime = "1.23.2"
        ffmpeg = $FfmpegVersion
        ffmpegBuild = "gyan.dev essentials GPLv3"
        architecture = "windows-x86_64"
        installedAt = [DateTime]::UtcNow.ToString("o")
    } | ConvertTo-Json | Set-Content -LiteralPath $InstallMarker -Encoding UTF8

    Write-Host "Project-local runtime is ready."
    Write-Host "Python: $PythonExe"
    Write-Host "Packages: $PackagesRoot"
    Write-Host "FFmpeg: $FfmpegExe"
}

switch ($Action) {
    "install" { Install-LocalEnvironment }
    "clear" { Remove-LocalEnvironment }
    "status" {
        if (Test-LocalEnvironment) {
            Write-Host "ready"
            Write-Host "Python: $PythonExe"
            Write-Host "Packages: $PackagesRoot"
            Write-Host "FFmpeg: $FfmpegExe"
            exit 0
        }
        Write-Host "missing"
        exit 1
    }
}
