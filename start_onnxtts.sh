#!/bin/sh
# Launch ONNXTTS from the project directory and forward every server option.
set -u

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd -- "$SCRIPT_DIR" || exit 1

if [ "$(uname -s)" != 'Linux' ]; then
  printf '%s\n' 'start_onnxtts.sh supports Linux only.' >&2
  exit 2
fi

has_windows_environment=false
if [ -f '.local-env/python/python.exe' ]; then
  has_windows_environment=true
elif [ -f '.local-env/install.json' ]; then
  while IFS= read -r marker_line; do
    case "$marker_line" in
      *windows-*) has_windows_environment=true; break ;;
    esac
  done < '.local-env/install.json'
fi

if [ "$has_windows_environment" = true ]; then
  printf '%s\n' \
    'A Windows project-local Python/Piper environment is already present in .local-env.' \
    'ONNXTTS will not remove or replace an environment from another platform.' \
    'Run sh set_local_env.sh -clear manually, then start ONNXTTS again.' >&2
  exit 2
fi

if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' 'Node.js was not found in PATH. Install Node.js 20 or newer, then run this command again.' >&2
  exit 1
fi

node_major=$(node -p 'Number(process.versions.node.split(".")[0])')
if [ "$node_major" -lt 20 ] 2>/dev/null; then
  printf '%s\n' 'ONNXTTS requires Node.js 20 or newer.' >&2
  exit 1
fi

exec node server.mjs "$@"
