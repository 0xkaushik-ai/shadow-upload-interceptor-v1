#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
MINIMUM_NODE_MAJOR=22
MINIMUM_RUST_MAJOR=1
MINIMUM_RUST_MINOR=85

usage() {
  cat <<'EOF'
Usage: ./run-linux.sh [--prepare-only]

Runs the complete Linux assessment path with one command:
WXT extension -> Chrome Native Messaging -> detached Tauri v2 daemon -> Forge.

Options:
  --prepare-only  Build and register the extension/host without opening Forge or Chromium.
  -h, --help      Show this help.

Environment:
  DEMO_CHROME_BIN  Chrome for Testing or Chromium 148+ executable to launch.
EOF
}

fail() {
  echo "Linux launcher error: $*" >&2
  exit 1
}

if [[ "$(uname -s)" != "Linux" ]]; then
  fail "run-linux.sh supports Linux only."
fi

case "${1:-}" in
  -h|--help)
    usage
    exit 0
    ;;
  ""|--prepare-only) ;;
  *)
    usage >&2
    exit 2
    ;;
esac

if (( $# > 1 )); then
  usage >&2
  exit 2
fi

for required_command in awk node cargo rustc pkg-config; do
  if ! command -v "${required_command}" >/dev/null 2>&1; then
    fail "missing required command: ${required_command}"
  fi
done

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
if [[ ! "${NODE_MAJOR}" =~ ^[0-9]+$ ]] || (( NODE_MAJOR < MINIMUM_NODE_MAJOR )); then
  fail "Node.js ${MINIMUM_NODE_MAJOR}+ is required; found $(node --version)."
fi

RUST_VERSION="$(rustc --version | awk '{print $2}')"
RUST_MAJOR="${RUST_VERSION%%.*}"
RUST_REMAINDER="${RUST_VERSION#*.}"
RUST_MINOR="${RUST_REMAINDER%%.*}"
if [[ ! "${RUST_MAJOR}" =~ ^[0-9]+$ || ! "${RUST_MINOR}" =~ ^[0-9]+$ ]] || \
  (( RUST_MAJOR < MINIMUM_RUST_MAJOR )) || \
  (( RUST_MAJOR == MINIMUM_RUST_MAJOR && RUST_MINOR < MINIMUM_RUST_MINOR )); then
  fail "Rust ${MINIMUM_RUST_MAJOR}.${MINIMUM_RUST_MINOR}+ is required; found $(rustc --version)."
fi

if ! pkg-config --exists javascriptcoregtk-4.1 webkit2gtk-4.1; then
  cat >&2 <<'EOF'
Linux launcher error: Tauri v2 WebKit development packages are missing.

Install them on Debian, Ubuntu, or Kali, then rerun ./run-linux.sh:
  sudo apt-get update
  sudo apt-get install -y libwebkit2gtk-4.1-dev
EOF
  exit 1
fi

echo "SecureIntent Linux one-command demo"
echo "Node:    $(node --version)"
echo "Rust:    $(rustc --version)"
echo "Daemon:  detached Tauri v2"
echo

exec "${SCRIPT_DIR}/run-demo.sh" --tauri-daemon "$@"
