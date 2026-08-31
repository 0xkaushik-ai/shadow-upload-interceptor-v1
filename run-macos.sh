#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "run-macos.sh supports macOS only." >&2
  exit 1
fi

exec "${SCRIPT_DIR}/run-demo.sh" "$@"
