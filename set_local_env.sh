#!/bin/sh
# Manage the self-contained Linux x86_64 runtime stored in .local-env.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_ROOT=$SCRIPT_DIR
RUNTIME_ROOT="$PROJECT_ROOT/.local-env"
PYTHON_ROOT="$RUNTIME_ROOT/python"
PYTHON_EXE="$PYTHON_ROOT/bin/python3"
WINDOWS_PYTHON_EXE="$PYTHON_ROOT/python.exe"
PACKAGES_ROOT="$RUNTIME_ROOT/packages"
PIPER_MODULE="$PACKAGES_ROOT/piper/__init__.py"
ONNX_MODULE="$PACKAGES_ROOT/onnxruntime/__init__.py"
INSTALL_MARKER="$RUNTIME_ROOT/install.json"
DOWNLOAD_ROOT="$RUNTIME_ROOT/downloads"
WHEEL_ROOT="$DOWNLOAD_ROOT/wheels"
EXTRACT_ROOT="$RUNTIME_ROOT/python-extract"
FFMPEG_ROOT="$RUNTIME_ROOT/ffmpeg"
FFMPEG_EXE="$FFMPEG_ROOT/bin/ffmpeg"
FFPROBE_EXE="$FFMPEG_ROOT/bin/ffprobe"
REQUIREMENTS_FILE="$PROJECT_ROOT/tools/local-runtime-requirements-linux.txt"
WHEEL_MANIFEST_FILE="$PROJECT_ROOT/tools/local-runtime-wheels-linux.json"
DOWNLOADER="$PROJECT_ROOT/tools/download_runtime_asset.mjs"

PYTHON_VERSION=3.10.20
PYTHON_ARCHIVE='cpython-3.10.20+20260718-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz'
PYTHON_ARCHIVE_PATH="$DOWNLOAD_ROOT/$PYTHON_ARCHIVE"
PYTHON_URL='https://github.com/astral-sh/python-build-standalone/releases/download/20260718/cpython-3.10.20%2B20260718-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz'
PYTHON_SHA256='3d71c71aad818dab1776dca94f76667d88126e06623d916a21371117d17d21e7'
FFMPEG_VERSION=6.1.1
FFMPEG_DOWNLOAD="$DOWNLOAD_ROOT/ffmpeg-linux-x64"
FFPROBE_DOWNLOAD="$DOWNLOAD_ROOT/ffprobe-linux-x64"
FFMPEG_LICENSE_DOWNLOAD="$DOWNLOAD_ROOT/linux-x64.LICENSE"
FFMPEG_URL='https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-linux-x64'
FFMPEG_SHA256='e7e7fb30477f717e6f55f9180a70386c62677ef8a4d4d1a5d948f4098aa3eb99'
FFPROBE_URL='https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffprobe-linux-x64'
FFPROBE_SHA256='4f231a1960d83e403d08f7971e271707bec278a9ae18e21b8b5b03186668450d'
FFMPEG_LICENSE_URL='https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/linux-x64.LICENSE'
FFMPEG_LICENSE_SHA256='8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903'

usage() {
  printf '%s\n' \
    'Usage:' \
    '  sh set_local_env.sh -install   Download and install local Python/Piper/FFmpeg' \
    '  sh set_local_env.sh -clear     Remove the project-local environment' \
    '  sh set_local_env.sh -status    Show whether the environment is ready'
}

assert_supported_platform() {
  if [ "$(uname -s)" != 'Linux' ]; then
    printf '%s\n' 'set_local_env.sh supports Linux only.' >&2
    exit 2
  fi
  case "$(uname -m)" in
    x86_64|amd64) ;;
    *)
      printf '%s\n' 'The bundled Linux runtime currently supports x86_64 only.' >&2
      exit 2
      ;;
  esac
}

require_node() {
  if ! command -v node >/dev/null 2>&1; then
    printf '%s\n' 'Node.js was not found in PATH. Install Node.js 20 or newer, then run this command again.' >&2
    exit 1
  fi
  node_major=$(node -p 'Number(process.versions.node.split(".")[0])')
  if [ "$node_major" -lt 20 ] 2>/dev/null; then
    printf '%s\n' 'ONNXTTS requires Node.js 20 or newer.' >&2
    exit 1
  fi
}

has_windows_environment() {
  if [ -f "$WINDOWS_PYTHON_EXE" ]; then
    return 0
  fi
  if [ -f "$INSTALL_MARKER" ]; then
    while IFS= read -r marker_line; do
      case "$marker_line" in
        *windows-*) return 0 ;;
      esac
    done < "$INSTALL_MARKER"
  fi
  return 1
}

show_platform_conflict() {
  printf '%s\n' \
    'A Windows project-local Python/Piper environment is already present in .local-env.' \
    'ONNXTTS will not remove or replace an environment from another platform.' \
    'Run sh set_local_env.sh -clear manually, then run the requested action again.' >&2
}

local_python_ready() {
  [ -x "$PYTHON_EXE" ] \
    && [ -f "$PIPER_MODULE" ] \
    && [ -f "$ONNX_MODULE" ] \
    && [ -f "$INSTALL_MARKER" ]
}

local_ffmpeg_ready() {
  [ -x "$FFMPEG_EXE" ] && [ -x "$FFPROBE_EXE" ]
}

local_environment_ready() {
  local_python_ready && local_ffmpeg_ready
}

assert_safe_runtime_path() {
  if [ -z "$PROJECT_ROOT" ] || [ "$PROJECT_ROOT" = '/' ] \
    || [ "$RUNTIME_ROOT" != "$PROJECT_ROOT/.local-env" ]; then
    printf 'Refusing to modify an unsafe runtime path: %s\n' "$RUNTIME_ROOT" >&2
    exit 2
  fi
}

remove_runtime_child() {
  target_path=$1
  case "$target_path" in
    "$RUNTIME_ROOT"/*) rm -rf -- "$target_path" ;;
    *)
      printf 'Refusing to remove a path outside .local-env: %s\n' "$target_path" >&2
      exit 2
      ;;
  esac
}

remove_local_environment() {
  assert_safe_runtime_path
  if [ -e "$RUNTIME_ROOT" ]; then
    rm -rf -- "$RUNTIME_ROOT"
    printf 'Removed local environment: %s\n' "$RUNTIME_ROOT"
  else
    printf 'Local environment is already clear: %s\n' "$RUNTIME_ROOT"
  fi
}

download_asset() {
  asset_url=$1
  asset_output=$2
  asset_sha256=$3
  asset_minimum=$4
  node "$DOWNLOADER" \
    --url "$asset_url" \
    --output "$asset_output" \
    --sha256 "$asset_sha256" \
    --minimum-bytes "$asset_minimum"
}

invoke_isolated_python() {
  (
    unset PYTHONHOME PYTHONPATH CONDA_PREFIX CONDA_DEFAULT_ENV
    unset CONDA_PROMPT_MODIFIER _CE_CONDA _CE_M
    export PYTHONNOUSERSITE=1
    "$PYTHON_EXE" "$@"
  )
}

write_python_marker() {
  installed_at=$(node -p 'new Date().toISOString()')
  cat > "$INSTALL_MARKER" <<EOF
{
  "python": "$PYTHON_VERSION",
  "piper": "1.5.0",
  "onnxruntime": "1.23.2",
  "architecture": "linux-x86_64",
  "installedAt": "$installed_at"
}
EOF
}

write_install_marker() {
  installed_at=$(node -p 'new Date().toISOString()')
  cat > "$INSTALL_MARKER" <<EOF
{
  "python": "$PYTHON_VERSION",
  "piper": "1.5.0",
  "onnxruntime": "1.23.2",
  "ffmpeg": "$FFMPEG_VERSION",
  "ffmpegBuild": "eugeneware static GPLv3",
  "architecture": "linux-x86_64",
  "installedAt": "$installed_at"
}
EOF
}

install_local_python() {
  if local_python_ready; then
    printf '%s\n' 'Local Python/Piper runtime is already installed.'
    printf 'Python: %s\nPackages: %s\n' "$PYTHON_EXE" "$PACKAGES_ROOT"
    return
  fi

  assert_safe_runtime_path
  mkdir -p -- "$DOWNLOAD_ROOT" "$WHEEL_ROOT"
  download_asset "$PYTHON_URL" "$PYTHON_ARCHIVE_PATH" "$PYTHON_SHA256" 20000000

  remove_runtime_child "$PYTHON_ROOT"
  remove_runtime_child "$PACKAGES_ROOT"
  remove_runtime_child "$EXTRACT_ROOT"
  mkdir -p -- "$EXTRACT_ROOT"

  printf '%s\n' 'Extracting local Python...'
  tar -xzf "$PYTHON_ARCHIVE_PATH" -C "$EXTRACT_ROOT"
  if [ ! -x "$EXTRACT_ROOT/python/bin/python3" ]; then
    printf '%s\n' 'The standalone Python archive did not contain python/bin/python3.' >&2
    exit 1
  fi
  mv -- "$EXTRACT_ROOT/python" "$PYTHON_ROOT"
  remove_runtime_child "$EXTRACT_ROOT"

  printf '%s\n' 'Downloading pinned Piper/ONNX Runtime wheels...'
  node "$DOWNLOADER" --manifest "$WHEEL_MANIFEST_FILE" --output-directory "$WHEEL_ROOT"

  printf '%s\n' 'Installing Piper and ONNX Runtime into the project...'
  mkdir -p -- "$PACKAGES_ROOT"
  invoke_isolated_python -I -m pip install \
    --no-index \
    --find-links "$WHEEL_ROOT" \
    --disable-pip-version-check \
    --no-warn-script-location \
    --target "$PACKAGES_ROOT" \
    --requirement "$REQUIREMENTS_FILE"

  invoke_isolated_python -I -S -c \
    'import sys; sys.path.insert(0, sys.argv[1]); import piper, numpy, onnxruntime; print("Piper runtime import check passed")' \
    "$PACKAGES_ROOT"

  write_python_marker
  printf '%s\n' 'Local Python/Piper runtime is ready.'
  printf 'Python: %s\nPackages: %s\n' "$PYTHON_EXE" "$PACKAGES_ROOT"
}

install_local_ffmpeg() {
  if local_ffmpeg_ready; then
    printf '%s\n' 'Local FFmpeg runtime is already installed.'
    printf 'FFmpeg: %s\n' "$FFMPEG_EXE"
    return
  fi

  assert_safe_runtime_path
  mkdir -p -- "$DOWNLOAD_ROOT"
  download_asset "$FFMPEG_URL" "$FFMPEG_DOWNLOAD" "$FFMPEG_SHA256" 50000000
  download_asset "$FFPROBE_URL" "$FFPROBE_DOWNLOAD" "$FFPROBE_SHA256" 50000000
  download_asset "$FFMPEG_LICENSE_URL" "$FFMPEG_LICENSE_DOWNLOAD" "$FFMPEG_LICENSE_SHA256" 30000

  remove_runtime_child "$FFMPEG_ROOT"
  mkdir -p -- "$FFMPEG_ROOT/bin"
  mv -- "$FFMPEG_DOWNLOAD" "$FFMPEG_EXE"
  mv -- "$FFPROBE_DOWNLOAD" "$FFPROBE_EXE"
  mv -- "$FFMPEG_LICENSE_DOWNLOAD" "$FFMPEG_ROOT/LICENSE"
  chmod 755 -- "$FFMPEG_EXE" "$FFPROBE_EXE"

  "$FFMPEG_EXE" -hide_banner -version >/dev/null
  encoder_output=$("$FFMPEG_EXE" -hide_banner -encoders 2>&1)
  case "$encoder_output" in
    *libmp3lame*) ;;
    *)
      printf '%s\n' 'The local FFmpeg build does not provide the libmp3lame MP3 encoder.' >&2
      exit 1
      ;;
  esac

  printf '%s\n' 'Local FFmpeg runtime is ready.'
  printf 'FFmpeg: %s\n' "$FFMPEG_EXE"
}

install_local_environment() {
  if local_environment_ready; then
    printf '%s\n' 'Project-local runtime is already installed.'
    printf 'Python: %s\nPackages: %s\nFFmpeg: %s\n' "$PYTHON_EXE" "$PACKAGES_ROOT" "$FFMPEG_EXE"
    return
  fi

  require_node
  install_local_python
  install_local_ffmpeg
  if ! local_environment_ready; then
    printf '%s\n' 'The project-local runtime is incomplete after installation.' >&2
    exit 1
  fi
  write_install_marker
  remove_runtime_child "$DOWNLOAD_ROOT"
  printf '%s\n' 'Project-local runtime is ready.'
  printf 'Python: %s\nPackages: %s\nFFmpeg: %s\n' "$PYTHON_EXE" "$PACKAGES_ROOT" "$FFMPEG_EXE"
}

if [ "$#" -ne 1 ]; then
  usage
  exit 2
fi

case "$1" in
  -install|--install) action=install ;;
  -clear|--clear) action=clear ;;
  -status|--status) action=status ;;
  *)
    usage
    exit 2
    ;;
esac

assert_supported_platform
if [ "$action" != clear ] && has_windows_environment; then
  show_platform_conflict
  exit 2
fi

case "$action" in
  install) install_local_environment ;;
  clear) remove_local_environment ;;
  status)
    if local_environment_ready; then
      printf '%s\n' 'ready'
      printf 'Python: %s\nPackages: %s\nFFmpeg: %s\n' "$PYTHON_EXE" "$PACKAGES_ROOT" "$FFMPEG_EXE"
      exit 0
    fi
    printf '%s\n' 'missing'
    exit 1
    ;;
esac
