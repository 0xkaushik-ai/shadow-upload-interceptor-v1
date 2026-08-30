#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION_DIR="${SCRIPT_DIR}/extension"
EXTENSION_OUTPUT="${EXTENSION_DIR}/.output/chrome-mv3"
BUILT_MANIFEST="${EXTENSION_OUTPUT}/manifest.json"
DUMMY_PAGE_DIR="${SCRIPT_DIR}/dummy-page"
DEMO_PORT="4173"
DEMO_URL="http://localhost:${DEMO_PORT}"
DEMO_CHROME_BIN="${DEMO_CHROME_BIN:-}"
PNPM_VERSION="10.28.2"
MODE="run"
HOST_VARIANT="native"
BROWSER_FLAVOR="chrome"
SERVER_PID=""
CHROME_PID=""
CHROME_PROFILE=""
DAEMON_PID=""
DAEMON_SOCKET=""

usage() {
  cat <<'EOF'
Usage: ./run-demo.sh [--prepare-only] [--tauri-daemon]

Builds the extension, Native Messaging broker, and detached scanner daemon;
serves Forge; and opens a clean Chrome window with the extension loaded.

Options:
  --prepare-only  Build and install without starting Forge or Chrome.
  --tauri-daemon  Use the zero-window Tauri v2 daemon (requires Tauri system packages).
  --tauri-host    Backward-compatible alias for --tauri-daemon.
  -h, --help      Show this help.

Environment:
  DEMO_CHROME_BIN  Chrome for Testing or Chromium executable to launch.
EOF
}

classify_browser() {
  local version_output
  version_output="$("${DEMO_CHROME_BIN}" --version 2>/dev/null || true)"

  if [[ "${version_output}" == *"Chrome for Testing"* ]]; then
    BROWSER_FLAVOR="chrome-for-testing"
  elif [[ "${version_output}" == *"Chromium"* ]]; then
    BROWSER_FLAVOR="chromium"
  else
    echo "The automatic demo requires Chrome for Testing or Chromium 148+." >&2
    echo "Official Google Chrome 137+ ignores --load-extension, so it would open Forge unprotected." >&2
    echo "Detected: ${version_output:-unknown browser}" >&2
    echo "Set DEMO_CHROME_BIN to a compatible executable, or follow README's manual Chrome setup." >&2
    exit 1
  fi

  if [[ ! "${version_output}" =~ ([0-9]+)\. ]] || (( BASH_REMATCH[1] < 148 )); then
    echo "The extension requires browser version 148 or newer. Detected: ${version_output}" >&2
    exit 1
  fi
}

resolve_browser() {
  local candidate

  if [[ -n "${DEMO_CHROME_BIN}" && ! -x "${DEMO_CHROME_BIN}" ]] && command -v "${DEMO_CHROME_BIN}" >/dev/null 2>&1; then
    DEMO_CHROME_BIN="$(command -v "${DEMO_CHROME_BIN}")"
  fi

  if [[ -z "${DEMO_CHROME_BIN}" ]]; then
    for candidate in google-chrome-for-testing chromium chromium-browser; do
      if command -v "${candidate}" >/dev/null 2>&1; then
        DEMO_CHROME_BIN="$(command -v "${candidate}")"
        break
      fi
    done
  fi

  if [[ -z "${DEMO_CHROME_BIN}" ]]; then
    for candidate in \
      "${HOME}"/.cache/ms-playwright/chromium-*/chrome-linux64/chrome \
      "${HOME}"/.cache/puppeteer/chrome/*/chrome-linux64/chrome; do
      if [[ -x "${candidate}" ]]; then
        DEMO_CHROME_BIN="${candidate}"
      fi
    done
  fi

  if [[ -z "${DEMO_CHROME_BIN}" || ! -x "${DEMO_CHROME_BIN}" ]]; then
    echo "Chrome for Testing or Chromium 148+ was not found." >&2
    echo "Install one, set DEMO_CHROME_BIN, or use the README's manual Load unpacked steps." >&2
    exit 1
  fi

  classify_browser
}

while (( $# > 0 )); do
  case "$1" in
    --prepare-only) MODE="prepare" ;;
    --tauri-daemon|--tauri-host) HOST_VARIANT="tauri" ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
  shift
done

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "This demo launcher currently supports Google Chrome on Linux." >&2
  exit 1
fi

for required_command in node cargo; do
  if ! command -v "${required_command}" >/dev/null 2>&1; then
    echo "Missing required command: ${required_command}" >&2
    exit 1
  fi
done

if command -v pnpm >/dev/null 2>&1; then
  PNPM_COMMAND=(pnpm)
elif command -v npx >/dev/null 2>&1; then
  echo "pnpm is not on PATH; using pnpm ${PNPM_VERSION} through npx."
  PNPM_COMMAND=(npx --yes "pnpm@${PNPM_VERSION}")
else
  echo "Missing pnpm. Install pnpm ${PNPM_VERSION}, or provide npm/npx so it can be bootstrapped." >&2
  exit 1
fi

if [[ "${MODE}" == "run" ]]; then
  resolve_browser
fi

cleanup() {
  local exit_code=$?
  trap - EXIT INT TERM

  if [[ -n "${SERVER_PID}" ]] && kill -0 "${SERVER_PID}" >/dev/null 2>&1; then
    kill "${SERVER_PID}" >/dev/null 2>&1 || true
    wait "${SERVER_PID}" 2>/dev/null || true
  fi

  if [[ -n "${CHROME_PID}" ]] && kill -0 "${CHROME_PID}" >/dev/null 2>&1; then
    kill "${CHROME_PID}" >/dev/null 2>&1 || true
    wait "${CHROME_PID}" 2>/dev/null || true
  fi

  if [[ -n "${DAEMON_PID}" ]] && kill -0 "${DAEMON_PID}" >/dev/null 2>&1; then
    kill "${DAEMON_PID}" >/dev/null 2>&1 || true
    wait "${DAEMON_PID}" 2>/dev/null || true
  fi

  if [[ -n "${CHROME_PROFILE}" && -d "${CHROME_PROFILE}" ]]; then
    case "${CHROME_PROFILE}" in
      */secureintent-shadow-chrome.*) rm -rf -- "${CHROME_PROFILE}" ;;
      *) echo "Refusing to remove unexpected profile path: ${CHROME_PROFILE}" >&2 ;;
    esac
  fi

  exit "${exit_code}"
}
trap cleanup EXIT INT TERM

echo "[1/4] Installing extension dependencies..."
"${PNPM_COMMAND[@]}" --dir "${EXTENSION_DIR}" install --frozen-lockfile

echo "[2/4] Building the Chrome extension..."
"${PNPM_COMMAND[@]}" --dir "${EXTENSION_DIR}" build

if [[ ! -f "${BUILT_MANIFEST}" ]]; then
  echo "WXT did not produce the expected manifest: ${BUILT_MANIFEST}" >&2
  exit 1
fi

# Chrome derives an extension ID from the first 128 bits of SHA-256(public key),
# encoding each nibble as a-p. Deriving it here prevents manifest/ID drift.
EXTENSION_ID="$(node -e '
  const { createHash } = require("node:crypto");
  const { readFileSync } = require("node:fs");
  const manifest = JSON.parse(readFileSync(process.argv[1], "utf8"));
  if (typeof manifest.key !== "string" || manifest.key.length === 0) process.exit(2);
  const digest = createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest();
  const alphabet = "abcdefghijklmnop";
  let id = "";
  for (const byte of digest.subarray(0, 16)) id += alphabet[byte >> 4] + alphabet[byte & 15];
  process.stdout.write(id);
' "${BUILT_MANIFEST}")"

if [[ ! "${EXTENSION_ID}" =~ ^[a-p]{32}$ ]]; then
  echo "Could not derive a valid Chrome extension ID from the development key." >&2
  exit 1
fi

if [[ "${MODE}" == "run" ]]; then
  CHROME_PROFILE="$(mktemp -d "${TMPDIR:-/tmp}/secureintent-shadow-chrome.XXXXXX")"
fi

echo "[3/4] Building the broker and detached Rust daemon (${HOST_VARIANT})..."
if [[ "${MODE}" == "run" ]]; then
  DAEMON_SOCKET="${CHROME_PROFILE}/secureintent-shadow.sock"
  SHADOW_SERVICE_MODE="ephemeral" \
    SHADOW_NATIVE_HOST_DIR="${CHROME_PROFILE}/NativeMessagingHosts" \
    "${SCRIPT_DIR}/scripts/install-host.sh" \
      "${EXTENSION_ID}" "${BROWSER_FLAVOR}" "${HOST_VARIANT}"
else
  "${SCRIPT_DIR}/scripts/install-host.sh" \
    "${EXTENSION_ID}" "${BROWSER_FLAVOR}" "${HOST_VARIANT}"
fi

if [[ "${MODE}" == "run" ]]; then
  if [[ "${HOST_VARIANT}" == "tauri" ]]; then
    DAEMON_BINARY="${SCRIPT_DIR}/daemon/target/release/secureintent-shadow-tauri"
  else
    DAEMON_BINARY="${SCRIPT_DIR}/daemon/target/release/secureintent-shadow-daemon"
  fi
  SECUREINTENT_SHADOW_SOCKET="${DAEMON_SOCKET}" "${DAEMON_BINARY}" \
    2>"${CHROME_PROFILE}/daemon.stderr.log" &
  DAEMON_PID=$!
  for _attempt in {1..50}; do
    [[ -S "${DAEMON_SOCKET}" ]] && break
    if ! kill -0 "${DAEMON_PID}" >/dev/null 2>&1; then
      echo "Detached scanner daemon stopped before it became ready." >&2
      sed -n '1,80p' "${CHROME_PROFILE}/daemon.stderr.log" >&2
      exit 1
    fi
    sleep 0.1
  done
  if [[ ! -S "${DAEMON_SOCKET}" ]]; then
    echo "Detached scanner daemon did not create its private socket." >&2
    exit 1
  fi
fi

if [[ "${MODE}" == "prepare" ]]; then
  echo
  echo "Prepared SecureIntent Shadow Upload for extension ${EXTENSION_ID}."
  echo "Unpacked extension: ${EXTENSION_OUTPUT}"
  exit 0
fi

echo "[4/4] Starting Forge and Chrome..."
SERVER_TOKEN="$$-${RANDOM}-${RANDOM}"
SHADOW_DEMO_HEALTH_TOKEN="${SERVER_TOKEN}" \
  node "${SCRIPT_DIR}/scripts/serve-demo.mjs" "${DUMMY_PAGE_DIR}" "${DEMO_PORT}" &
SERVER_PID=$!

SERVER_READY="false"
for _attempt in {1..30}; do
  if node -e '
    fetch(process.argv[1])
      .then(async (response) => process.exit(response.ok && (await response.text()) === process.argv[2] ? 0 : 1))
      .catch(() => process.exit(1));
  ' "${DEMO_URL}/__secureintent_health" "${SERVER_TOKEN}"; then
    SERVER_READY="true"
    break
  fi
  if ! kill -0 "${SERVER_PID}" >/dev/null 2>&1; then
    wait "${SERVER_PID}" || true
    echo "Forge server stopped before it became ready." >&2
    exit 1
  fi
  sleep 0.1
done

if [[ "${SERVER_READY}" != "true" ]]; then
  echo "Forge did not become ready at ${DEMO_URL}. Is port ${DEMO_PORT} already in use?" >&2
  exit 1
fi

echo
echo "SecureIntent Shadow Upload is running."
echo "Extension ID: ${EXTENSION_ID}"
echo "Forge:        ${DEMO_URL}"
echo "Browser:      $("${DEMO_CHROME_BIN}" --version)"
echo "Daemon PID:   ${DAEMON_PID} (independent of Chrome's broker processes)"
echo "Try:          testdata/allow.txt, testdata/block.pem, testdata/oversized-8mb.txt"
echo "Close the demo Chrome window or press Ctrl+C to stop."

SECUREINTENT_SHADOW_SOCKET="${DAEMON_SOCKET}" "${DEMO_CHROME_BIN}" \
  --user-data-dir="${CHROME_PROFILE}" \
  --disable-extensions-except="${EXTENSION_OUTPUT}" \
  --load-extension="${EXTENSION_OUTPUT}" \
  --no-first-run \
  --no-default-browser-check \
  --new-window \
  "${DEMO_URL}" 2>"${CHROME_PROFILE}/chrome.stderr.log" &
CHROME_PID=$!
wait "${CHROME_PID}"
CHROME_PID=""
