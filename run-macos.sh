#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
BROWSER="${DEMO_CHROME_BIN:-}"

if [[ -z "${BROWSER}" ]]; then
  shopt -s nullglob
  for candidate in \
    "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing" \
    "${HOME}"/Library/Caches/ms-playwright/chromium-*/chrome-mac*/Google\ Chrome\ for\ Testing.app/Contents/MacOS/Google\ Chrome\ for\ Testing \
    "/Applications/Chromium.app/Contents/MacOS/Chromium"; do
    if [[ -x "${candidate}" ]]; then BROWSER="${candidate}"; break; fi
  done
fi

if [[ -z "${BROWSER}" || ! -x "${BROWSER}" ]]; then
  echo "Chrome for Testing or Chromium 148+ was not found. Set DEMO_CHROME_BIN to its executable." >&2
  exit 1
fi

VERSION="$("${BROWSER}" --version 2>/dev/null || true)"
if [[ ! "${VERSION}" =~ ([0-9]+)\. ]] || (( BASH_REMATCH[1] < 148 )); then
  echo "Chrome for Testing or Chromium 148+ is required; detected: ${VERSION:-unknown}." >&2
  exit 1
fi

exec env DEMO_CHROME_BIN="${BROWSER}" "${SCRIPT_DIR}/run-demo.sh" "$@"
