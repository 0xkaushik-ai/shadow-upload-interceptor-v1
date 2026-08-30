#!/usr/bin/env bash
set -euo pipefail

HOST_NAME="com.secureintent.shadow"
SERVICE_NAME="com.secureintent.shadow.service"
BROWSER_FLAVOR="${1:-chrome}"
SERVICE_MODE="${SHADOW_SERVICE_MODE:-install}"
CONFIG_ROOT="${XDG_CONFIG_HOME:-${HOME}/.config}"
SYSTEMD_USER_DIR="${SHADOW_SYSTEMD_USER_DIR:-${CONFIG_ROOT}/systemd/user}"
SERVICE_FILE="${SYSTEMD_USER_DIR}/${SERVICE_NAME}"

case "${BROWSER_FLAVOR}" in
  chrome) BROWSER_CONFIG_DIR="google-chrome" ;;
  chrome-for-testing) BROWSER_CONFIG_DIR="google-chrome-for-testing" ;;
  chromium) BROWSER_CONFIG_DIR="chromium" ;;
  *)
    echo "Usage: ./scripts/uninstall-host.sh [chrome|chrome-for-testing|chromium]" >&2
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

if [[ "${SERVICE_MODE}" == "install" ]] && ! command -v systemctl >/dev/null 2>&1; then
  echo "systemctl is required to stop the detached daemon safely." >&2
  exit 1
fi

HOST_DIR="${SHADOW_NATIVE_HOST_DIR:-${CONFIG_ROOT}/${BROWSER_CONFIG_DIR}/NativeMessagingHosts}"
HOST_MANIFEST="${HOST_DIR}/${HOST_NAME}.json"
if [[ -n "${SECUREINTENT_SHADOW_SOCKET:-}" ]]; then
  DAEMON_SOCKET="${SECUREINTENT_SHADOW_SOCKET}"
elif [[ -n "${XDG_RUNTIME_DIR:-}" ]]; then
  DAEMON_SOCKET="${XDG_RUNTIME_DIR}/secureintent-shadow/daemon.sock"
else
  DAEMON_SOCKET="/run/user/$(id -u)/secureintent-shadow/daemon.sock"
fi

if [[ "${SERVICE_MODE}" == "install" ]]; then
  systemctl --user show-environment >/dev/null
  if systemctl --user is-active --quiet "${SERVICE_NAME}"; then
    systemctl --user stop "${SERVICE_NAME}"
  fi
  systemctl --user disable "${SERVICE_NAME}" >/dev/null 2>&1 || true
fi

if [[ -e "${HOST_MANIFEST}" || -L "${HOST_MANIFEST}" ]]; then
  rm -f -- "${HOST_MANIFEST}"
  echo "Removed Native Messaging broker registration: ${HOST_MANIFEST}"
else
  echo "Native Messaging broker registration was already absent: ${HOST_MANIFEST}"
fi

if [[ "${SERVICE_MODE}" != "ephemeral" ]]; then
  if [[ -e "${SERVICE_FILE}" || -L "${SERVICE_FILE}" ]]; then
    rm -f -- "${SERVICE_FILE}"
    echo "Removed detached daemon service: ${SERVICE_FILE}"
  else
    echo "Detached daemon service was already absent: ${SERVICE_FILE}"
  fi
fi

if [[ -S "${DAEMON_SOCKET}" ]]; then
  rm -f -- "${DAEMON_SOCKET}"
  echo "Removed stale daemon socket: ${DAEMON_SOCKET}"
fi

if [[ "${SERVICE_MODE}" == "install" ]]; then
  systemctl --user daemon-reload
fi

echo "Compiled broker and daemon binaries were preserved and remain recoverable in daemon/target/."
