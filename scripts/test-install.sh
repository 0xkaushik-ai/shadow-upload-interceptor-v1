#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
HOST_NAME="com.secureintent.shadow"
SERVICE_NAME="com.secureintent.shadow.service"
EXTENSION_ID="abcdefghijklmnopabcdefghijklmnop"
TEMPORARY_ROOT=""
TEST_DAEMON_PID=""

if (( $# > 1 )); then
  echo "Usage: ./scripts/test-install.sh [isolated-root-directory]" >&2
  exit 2
fi

if (( $# == 1 )); then
  INSTALL_TEST_ROOT="$1"
  mkdir -p "${INSTALL_TEST_ROOT}"
else
  TEMPORARY_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/secureintent-installer-audit.XXXXXX")"
  INSTALL_TEST_ROOT="${TEMPORARY_ROOT}"
fi

cleanup() {
  if [[ -n "${TEST_DAEMON_PID}" ]] && kill -0 "${TEST_DAEMON_PID}" >/dev/null 2>&1; then
    kill "${TEST_DAEMON_PID}" >/dev/null 2>&1 || true
    wait "${TEST_DAEMON_PID}" 2>/dev/null || true
  fi
  if [[ -z "${TEMPORARY_ROOT}" ]]; then
    return
  fi
  case "${TEMPORARY_ROOT}" in
    "${TMPDIR:-/tmp}"/secureintent-installer-audit.*) rm -rf -- "${TEMPORARY_ROOT}" ;;
    *) echo "Refusing to remove unexpected test directory: ${TEMPORARY_ROOT}" >&2 ;;
  esac
}
trap cleanup EXIT

export SHADOW_NATIVE_HOST_DIR="${INSTALL_TEST_ROOT}/native-host"
export SHADOW_SYSTEMD_USER_DIR="${INSTALL_TEST_ROOT}/systemd-user"
export SHADOW_SERVICE_MODE="files-only"
export SECUREINTENT_SHADOW_SOCKET="${INSTALL_TEST_ROOT}/runtime/daemon.sock"
mkdir -p "${SHADOW_NATIVE_HOST_DIR}" "${SHADOW_SYSTEMD_USER_DIR}" "${INSTALL_TEST_ROOT}/runtime"
chmod 0700 "${SHADOW_NATIVE_HOST_DIR}" "${SHADOW_SYSTEMD_USER_DIR}" "${INSTALL_TEST_ROOT}/runtime"

"${SCRIPT_DIR}/install-host.sh" "${EXTENSION_ID}" chrome native

HOST_MANIFEST="${SHADOW_NATIVE_HOST_DIR}/${HOST_NAME}.json"
SERVICE_FILE="${SHADOW_SYSTEMD_USER_DIR}/${SERVICE_NAME}"
if [[ ! -f "${HOST_MANIFEST}" || ! -f "${SERVICE_FILE}" ]]; then
  echo "Installer did not produce both the broker manifest and daemon service." >&2
  exit 1
fi
node -e '
  const fs = require("node:fs");
  const [manifestPath, servicePath, expectedSocket] = process.argv.slice(1);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (!manifest.path.endsWith("/secureintent-shadow-host")) {
    throw new Error("Chrome manifest does not point to the short-lived broker");
  }
  const service = fs.readFileSync(servicePath, "utf8");
  for (const required of [
    "ExecStart=\"",
    "secureintent-shadow-daemon\"",
    `SECUREINTENT_SHADOW_SOCKET=${expectedSocket}`,
    "Restart=on-failure",
    "RuntimeDirectory=secureintent-shadow",
    "RuntimeDirectoryMode=0700",
    "ReadWritePaths=\"",
    "RestrictAddressFamilies=AF_UNIX",
    "UMask=0077",
    "WantedBy=graphical-session.target",
  ]) {
    if (!service.includes(required)) throw new Error(`service is missing ${required}`);
  }
' "${HOST_MANIFEST}" "${SERVICE_FILE}" "${SECUREINTENT_SHADOW_SOCKET}"
if command -v systemd-analyze >/dev/null 2>&1; then
  systemd-analyze --user verify "${SERVICE_FILE}"
fi

"${REPO_DIR}/daemon/target/release/secureintent-shadow-daemon" \
  2>"${INSTALL_TEST_ROOT}/daemon.stderr.log" &
TEST_DAEMON_PID=$!
for _attempt in {1..50}; do
  [[ -S "${SECUREINTENT_SHADOW_SOCKET}" ]] && break
  if ! kill -0 "${TEST_DAEMON_PID}" >/dev/null 2>&1; then
    echo "Detached daemon exited during installer test." >&2
    sed -n '1,80p' "${INSTALL_TEST_ROOT}/daemon.stderr.log" >&2
    exit 1
  fi
  sleep 0.1
done
if [[ ! -S "${SECUREINTENT_SHADOW_SOCKET}" ]]; then
  echo "Detached daemon did not create its test socket." >&2
  exit 1
fi

"${SCRIPT_DIR}/doctor.sh" "${EXTENSION_ID}" chrome
if ! kill -0 "${TEST_DAEMON_PID}" >/dev/null 2>&1; then
  echo "Daemon did not survive the doctor's three broker sessions." >&2
  exit 1
fi

kill "${TEST_DAEMON_PID}"
wait "${TEST_DAEMON_PID}" 2>/dev/null || true
TEST_DAEMON_PID=""
"${SCRIPT_DIR}/uninstall-host.sh" chrome

if [[ -e "${HOST_MANIFEST}" || -e "${SERVICE_FILE}" || -S "${SECUREINTENT_SHADOW_SOCKET}" ]]; then
  echo "Uninstall left a broker manifest, service, or daemon socket behind." >&2
  exit 1
fi

echo "Detached installer lifecycle test passed."
