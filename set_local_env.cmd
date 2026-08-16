@echo off
rem Thin CMD entry point for the project-local runtime manager.
rem All filesystem, download, hash, and extraction work lives in the PS1 file.
setlocal EnableExtensions
cd /d "%~dp0"

rem Normalize the supported single action before invoking PowerShell.
set "LOCAL_ENV_ACTION="
if /i "%~1"=="-install" set "LOCAL_ENV_ACTION=install"
if /i "%~1"=="--install" set "LOCAL_ENV_ACTION=install"
if /i "%~1"=="-clear" set "LOCAL_ENV_ACTION=clear"
if /i "%~1"=="--clear" set "LOCAL_ENV_ACTION=clear"
if /i "%~1"=="-status" set "LOCAL_ENV_ACTION=status"
if /i "%~1"=="--status" set "LOCAL_ENV_ACTION=status"

rem Reject missing or unknown actions without modifying .local-env.
if not defined LOCAL_ENV_ACTION (
  echo Usage:
  echo   set_local_env.cmd -install   Download and install local Python/Piper/FFmpeg
  echo   set_local_env.cmd -clear     Remove the project-local environment
  echo   set_local_env.cmd -status    Show whether the environment is ready
  endlocal
  exit /b 2
)

rem Prefer PATH, then fall back to the Windows PowerShell system location.
set "POWERSHELL_EXE=powershell.exe"
where powershell.exe >nul 2>&1
if errorlevel 1 set "POWERSHELL_EXE=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"

rem Run without profiles so user or Conda configuration cannot alter setup.
"%POWERSHELL_EXE%" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0tools\set_local_env.ps1" -Action "%LOCAL_ENV_ACTION%"
set "LOCAL_ENV_EXIT=%ERRORLEVEL%"

rem Restore the caller's environment and preserve the setup result.
endlocal & exit /b %LOCAL_ENV_EXIT%