#!/usr/bin/env bash
set -euo pipefail

HOST_NAME="com.secureintent.shadow"
SERVICE_NAME="com.secureintent.shadow.service"
EXTENSION_ID="${1:-}"
BROWSER_FLAVOR="${2:-chrome}"
SERVICE_MODE="${SHADOW_SERVICE_MODE:-install}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
CONFIG_ROOT="${XDG_CONFIG_HOME:-${HOME}/.config}"
SYSTEMD_USER_DIR="${SHADOW_SYSTEMD_USER_DIR:-${CONFIG_ROOT}/systemd/user}"
SERVICE_FILE="${SYSTEMD_USER_DIR}/${SERVICE_NAME}"

if [[ ! "${EXTENSION_ID}" =~ ^[a-p]{32}$ ]]; then
  echo "Usage: ./scripts/doctor.sh <extension-id> [chrome|chrome-for-testing|chromium]" >&2
  exit 2
fi

case "${BROWSER_FLAVOR}" in
  chrome) BROWSER_CONFIG_DIR="google-chrome" ;;
  chrome-for-testing) BROWSER_CONFIG_DIR="google-chrome-for-testing" ;;
  chromium) BROWSER_CONFIG_DIR="chromium" ;;
  *)
    echo "Unsupported browser flavor: ${BROWSER_FLAVOR}" >&2
    exit 2
    ;;
esac

case "${SERVICE_MODE}" in
  install|files-only|ephemeral) ;;
  *)
    echo "SHADOW_SERVICE_MODE must be install, files-only, or ephemeral." >&2
    exit 2
    ;;
esac

HOST_DIR="${SHADOW_NATIVE_HOST_DIR:-${CONFIG_ROOT}/${BROWSER_CONFIG_DIR}/NativeMessagingHosts}"
HOST_MANIFEST="${HOST_DIR}/${HOST_NAME}.json"
if [[ -n "${SECUREINTENT_SHADOW_SOCKET:-}" ]]; then
  DAEMON_SOCKET="${SECUREINTENT_SHADOW_SOCKET}"
elif [[ -n "${XDG_RUNTIME_DIR:-}" ]]; then
  DAEMON_SOCKET="${XDG_RUNTIME_DIR}/secureintent-shadow/daemon.sock"
else
  DAEMON_SOCKET="/run/user/$(id -u)/secureintent-shadow/daemon.sock"
fi

for required_command in awk node sha256sum stat; do
  if ! command -v "${required_command}" >/dev/null 2>&1; then
    echo "Missing diagnostic dependency: ${required_command}" >&2
    exit 1
  fi
done

if [[ ! -f "${HOST_MANIFEST}" ]]; then
  echo "Native host manifest is missing: ${HOST_MANIFEST}" >&2
  exit 1
fi

BROKER_BINARY="$(node -e '
  const fs = require("node:fs");
  const [manifestPath, extensionId] = process.argv.slice(1);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const expectedOrigin = `chrome-extension://${extensionId}/`;
  if (manifest.name !== "com.secureintent.shadow") throw new Error("wrong host name");
  if (manifest.type !== "stdio") throw new Error("host type is not stdio");
  if (typeof manifest.path !== "string" || !manifest.path.startsWith("/")) {
    throw new Error("broker path is not absolute");
  }
  if (JSON.stringify(manifest.allowed_origins) !== JSON.stringify([expectedOrigin])) {
    throw new Error("allowed_origins does not exactly match the extension");
  }
  process.stdout.write(manifest.path);
' "${HOST_MANIFEST}" "${EXTENSION_ID}")"

if [[ ! -f "${BROKER_BINARY}" || ! -x "${BROKER_BINARY}" ]]; then
  echo "Registered Native Messaging broker is missing or not executable: ${BROKER_BINARY}" >&2
  exit 1
fi

MANIFEST_MODE="$(stat -c '%a' "${HOST_MANIFEST}")"
if [[ "${MANIFEST_MODE}" != "600" ]]; then
  echo "Manifest mode is ${MANIFEST_MODE}; expected 600." >&2
  exit 1
fi
if [[ "${SERVICE_MODE}" != "ephemeral" && ! -f "${SERVICE_FILE}" ]]; then
  echo "Detached daemon service definition is missing: ${SERVICE_FILE}" >&2
  exit 1
fi
if [[ "${SERVICE_MODE}" == "install" ]]; then
  if ! systemctl --user is-active --quiet "${SERVICE_NAME}"; then
    echo "Detached daemon service is not active: ${SERVICE_NAME}" >&2
    exit 1
  fi
  DAEMON_PID_BEFORE="$(systemctl --user show --property MainPID --value "${SERVICE_NAME}")"
  if [[ -z "${DAEMON_PID_BEFORE}" || "${DAEMON_PID_BEFORE}" == "0" ]]; then
    echo "Detached daemon service has no live MainPID." >&2
    exit 1
  fi
fi

if [[ ! -S "${DAEMON_SOCKET}" ]]; then
  echo "Detached daemon socket is missing: ${DAEMON_SOCKET}" >&2
  exit 1
fi
SOCKET_MODE="$(stat -c '%a' "${DAEMON_SOCKET}")"
if [[ "${SOCKET_MODE}" != "600" ]]; then
  echo "Daemon socket mode is ${SOCKET_MODE}; expected 600." >&2
  exit 1
fi

echo "Manifest: ${HOST_MANIFEST} (mode ${MANIFEST_MODE})"
echo "Broker:   ${BROKER_BINARY}"
echo "SHA-256:  $(sha256sum "${BROKER_BINARY}" | awk '{print $1}')"
echo "Socket:   ${DAEMON_SOCKET} (mode ${SOCKET_MODE})"
if [[ "${SERVICE_MODE}" != "ephemeral" ]]; then
  echo "Service:  ${SERVICE_FILE}"
fi

SECUREINTENT_SHADOW_SOCKET="${DAEMON_SOCKET}" SHADOW_HOST_BINARY="${BROKER_BINARY}" \
  node "${SCRIPT_DIR}/smoke-host.mjs" --health
SECUREINTENT_SHADOW_SOCKET="${DAEMON_SOCKET}" SHADOW_HOST_BINARY="${BROKER_BINARY}" \
  node "${SCRIPT_DIR}/smoke-host.mjs" "${REPO_DIR}/testdata/block.pem" block
SECUREINTENT_SHADOW_SOCKET="${DAEMON_SOCKET}" SHADOW_HOST_BINARY="${BROKER_BINARY}" \
  node "${SCRIPT_DIR}/smoke-host.mjs" "${REPO_DIR}/testdata/allow.txt" allow

if [[ "${SERVICE_MODE}" == "install" ]]; then
  DAEMON_PID_AFTER="$(systemctl --user show --property MainPID --value "${SERVICE_NAME}")"
  if [[ "${DAEMON_PID_AFTER}" != "${DAEMON_PID_BEFORE}" ]]; then
    echo "Daemon PID changed while short-lived broker sessions disconnected." >&2
    exit 1
  fi
  echo "Persistent daemon PID: ${DAEMON_PID_AFTER}"
fi

echo "SecureIntent detached-daemon diagnostics passed."
