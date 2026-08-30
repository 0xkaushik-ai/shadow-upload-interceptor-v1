#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
HOST_NAME="com.secureintent.shadow"
SERVICE_NAME="com.secureintent.shadow.service"
PLATFORM="$(uname -s)"
ORIGINAL_HOME="${HOME}"
EXTENSION_ID="abcdefghijklmnopabcdefghijklmnop"
INSTALL_TEST_SERVICE_MODE="${SHADOW_INSTALL_TEST_SERVICE_MODE:-files-only}"
INSTALL_TEST_DAEMON_VARIANT="${SHADOW_INSTALL_TEST_DAEMON_VARIANT:-native}"
TEMPORARY_ROOT=""
TEMPORARY_SOCKET_ROOT=""
TEST_DAEMON_PID=""
TEST_LAUNCHD_CLEANUP="0"

case "${INSTALL_TEST_SERVICE_MODE}" in
  files-only|install) ;;
  *)
    echo "SHADOW_INSTALL_TEST_SERVICE_MODE must be files-only or install." >&2
    exit 2
    ;;
esac
case "${INSTALL_TEST_DAEMON_VARIANT}" in
  native) EXPECTED_DAEMON_NAME="secureintent-shadow-daemon" ;;
  tauri) EXPECTED_DAEMON_NAME="secureintent-shadow-tauri" ;;
  *)
    echo "SHADOW_INSTALL_TEST_DAEMON_VARIANT must be native or tauri." >&2
    exit 2
    ;;
esac
if [[ "${INSTALL_TEST_SERVICE_MODE}" == "install" && "${PLATFORM}" != "Darwin" ]]; then
  echo "The real service-manager installer test is currently supported only on macOS." >&2
  exit 2
fi

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
  if [[ "${TEST_LAUNCHD_CLEANUP}" == "1" ]]; then
    launchctl bootout "gui/$(id -u)/com.secureintent.shadow" >/dev/null 2>&1 || true
  fi
  if [[ -n "${TEST_DAEMON_PID}" ]] && kill -0 "${TEST_DAEMON_PID}" >/dev/null 2>&1; then
    kill "${TEST_DAEMON_PID}" >/dev/null 2>&1 || true
    wait "${TEST_DAEMON_PID}" 2>/dev/null || true
  fi
  if [[ -n "${TEMPORARY_SOCKET_ROOT}" ]]; then
    case "${TEMPORARY_SOCKET_ROOT}" in
      /tmp/secureintent-socket.??????) rm -rf -- "${TEMPORARY_SOCKET_ROOT}" ;;
      *) echo "Refusing to remove unexpected socket test directory: ${TEMPORARY_SOCKET_ROOT}" >&2 ;;
    esac
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
export SHADOW_LAUNCH_AGENTS_DIR="${INSTALL_TEST_ROOT}/launch-agents"
export SHADOW_SERVICE_MODE="${INSTALL_TEST_SERVICE_MODE}"
if [[ "${PLATFORM}" == "Darwin" ]]; then
  # AF_UNIX sockaddr_un has a small path limit on macOS. Keep only the socket in this short,
  # private directory; registrations and generated plist files stay under the supplied test root.
  TEMPORARY_SOCKET_ROOT="$(mktemp -d /tmp/secureintent-socket.XXXXXX)"
  chmod 0700 "${TEMPORARY_SOCKET_ROOT}"
  export SECUREINTENT_SHADOW_SOCKET="${TEMPORARY_SOCKET_ROOT}/daemon.sock"
else
  export SECUREINTENT_SHADOW_SOCKET="${INSTALL_TEST_ROOT}/runtime/daemon.sock"
fi
mkdir -p "${SHADOW_NATIVE_HOST_DIR}" "${SHADOW_SYSTEMD_USER_DIR}" "${SHADOW_LAUNCH_AGENTS_DIR}" "${INSTALL_TEST_ROOT}/runtime"
chmod 0700 "${SHADOW_NATIVE_HOST_DIR}" "${SHADOW_SYSTEMD_USER_DIR}" "${SHADOW_LAUNCH_AGENTS_DIR}" "${INSTALL_TEST_ROOT}/runtime"

if [[ "${PLATFORM}" == "Darwin" && "${INSTALL_TEST_SERVICE_MODE}" == "install" ]]; then
  LAUNCH_DOMAIN="gui/$(id -u)"
  if launchctl print "${LAUNCH_DOMAIN}/com.secureintent.shadow" >/dev/null 2>&1; then
    echo "Refusing to replace an existing com.secureintent.shadow launchd service during testing." >&2
    exit 1
  fi
  # The label was absent, so cleanup may safely boot it out even if a later assertion fails.
  TEST_LAUNCHD_CLEANUP="1"
fi

"${SCRIPT_DIR}/install-host.sh" "${EXTENSION_ID}" chrome "${INSTALL_TEST_DAEMON_VARIANT}"

HOST_MANIFEST="${SHADOW_NATIVE_HOST_DIR}/${HOST_NAME}.json"
SERVICE_FILE="${SHADOW_SYSTEMD_USER_DIR}/${SERVICE_NAME}"
LAUNCH_PLIST="${SHADOW_LAUNCH_AGENTS_DIR}/com.secureintent.shadow.plist"
if [[ ! -f "${HOST_MANIFEST}" ]]; then
  echo "Installer did not produce a broker manifest." >&2
  exit 1
fi
if [[ "${PLATFORM}" == "Darwin" && ! -f "${LAUNCH_PLIST}" ]]; then echo "Installer did not produce launchd agent." >&2; exit 1; fi
if [[ "${PLATFORM}" != "Darwin" && ! -f "${SERVICE_FILE}" ]]; then echo "Installer did not produce systemd service." >&2; exit 1; fi
if [[ "${PLATFORM}" != "Darwin" ]]; then node -e '
  const fs = require("node:fs");
  const [manifestPath, servicePath, expectedSocket, expectedDaemon] = process.argv.slice(1);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (!manifest.path.endsWith("/secureintent-shadow-host")) {
    throw new Error("Chrome manifest does not point to the short-lived broker");
  }
  const service = fs.readFileSync(servicePath, "utf8");
  for (const required of [
    "ExecStart=\"",
    `${expectedDaemon}\"`,
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
' "${HOST_MANIFEST}" "${SERVICE_FILE}" "${SECUREINTENT_SHADOW_SOCKET}" "${EXPECTED_DAEMON_NAME}"; fi
if [[ "${PLATFORM}" == "Darwin" ]]; then
  plutil -lint "${LAUNCH_PLIST}"
  node -e '
    const fs=require("node:fs"); const [path, socket, expectedDaemon]=process.argv.slice(1);
    if ((fs.statSync(path).mode & 0o777) !== 0o600) throw new Error("plist mode is not 0600");
    const text=fs.readFileSync(path,"utf8");
    for (const value of ["com.secureintent.shadow", expectedDaemon, "SECUREINTENT_SHADOW_SOCKET", socket]) {
      if (!text.includes(value)) throw new Error(`plist missing ${value}`);
    }
  ' "${LAUNCH_PLIST}" "${SECUREINTENT_SHADOW_SOCKET}" "${EXPECTED_DAEMON_NAME}"
  CFT_HOME="${INSTALL_TEST_ROOT}/cft-home"
  env -u SHADOW_NATIVE_HOST_DIR -u SECUREINTENT_SHADOW_SOCKET \
    HOME="${CFT_HOME}" \
    CARGO_HOME="${CARGO_HOME:-${ORIGINAL_HOME}/.cargo}" \
    RUSTUP_HOME="${RUSTUP_HOME:-${ORIGINAL_HOME}/.rustup}" \
    SHADOW_SERVICE_MODE="ephemeral" \
    "${SCRIPT_DIR}/install-host.sh" "${EXTENSION_ID}" chrome-for-testing native
  CFT_MANIFEST="${CFT_HOME}/Library/Application Support/Google/Chrome for Testing/NativeMessagingHosts/${HOST_NAME}.json"
  if [[ ! -f "${CFT_MANIFEST}" ]]; then
    echo "Chrome for Testing manifest was not written to its macOS user path." >&2
    exit 1
  fi
  env -u SHADOW_NATIVE_HOST_DIR -u SECUREINTENT_SHADOW_SOCKET \
    HOME="${CFT_HOME}" \
    CARGO_HOME="${CARGO_HOME:-${ORIGINAL_HOME}/.cargo}" \
    RUSTUP_HOME="${RUSTUP_HOME:-${ORIGINAL_HOME}/.rustup}" \
    SHADOW_SERVICE_MODE="ephemeral" \
    "${SCRIPT_DIR}/uninstall-host.sh" chrome-for-testing
  if [[ -e "${CFT_MANIFEST}" ]]; then
    echo "Chrome for Testing manifest was not removed from its macOS user path." >&2
    exit 1
  fi
elif command -v systemd-analyze >/dev/null 2>&1; then
  systemd-analyze --user verify "${SERVICE_FILE}"
fi

if [[ "${INSTALL_TEST_SERVICE_MODE}" == "install" ]]; then
  "${SCRIPT_DIR}/doctor.sh" "${EXTENSION_ID}" chrome
else
  "${REPO_DIR}/daemon/target/release/${EXPECTED_DAEMON_NAME}" \
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
fi
"${SCRIPT_DIR}/uninstall-host.sh" chrome
TEST_LAUNCHD_CLEANUP="0"

if [[ -e "${HOST_MANIFEST}" || -e "${SERVICE_FILE}" || -e "${LAUNCH_PLIST}" || -S "${SECUREINTENT_SHADOW_SOCKET}" ]]; then
  echo "Uninstall left a broker manifest, service, or daemon socket behind." >&2
  exit 1
fi

echo "Detached ${INSTALL_TEST_DAEMON_VARIANT} installer lifecycle test passed (${INSTALL_TEST_SERVICE_MODE})."
