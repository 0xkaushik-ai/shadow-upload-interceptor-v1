#!/usr/bin/env bash
set -euo pipefail

HOST_NAME="com.secureintent.shadow"
SERVICE_NAME="com.secureintent.shadow.service"
BROWSER_FLAVOR="${1:-chrome}"
SERVICE_MODE="${SHADOW_SERVICE_MODE:-install}"
CONFIG_ROOT="${XDG_CONFIG_HOME:-${HOME}/.config}"
SYSTEMD_USER_DIR="${SHADOW_SYSTEMD_USER_DIR:-${CONFIG_ROOT}/systemd/user}"
SERVICE_FILE="${SYSTEMD_USER_DIR}/${SERVICE_NAME}"
PLATFORM="$(uname -s)"
LAUNCH_LABEL="com.secureintent.shadow"
LAUNCH_AGENTS_DIR="${SHADOW_LAUNCH_AGENTS_DIR:-${HOME}/Library/LaunchAgents}"
LAUNCH_PLIST="${LAUNCH_AGENTS_DIR}/${LAUNCH_LABEL}.plist"

case "${BROWSER_FLAVOR}" in
  chrome) BROWSER_CONFIG_DIR="google-chrome"; MAC_BROWSER_DIR="Google/Chrome" ;;
  chrome-for-testing) BROWSER_CONFIG_DIR="google-chrome-for-testing"; MAC_BROWSER_DIR="Google/Chrome for Testing" ;;
  chromium) BROWSER_CONFIG_DIR="chromium"; MAC_BROWSER_DIR="Chromium" ;;
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

if [[ "${SERVICE_MODE}" == "install" && "${PLATFORM}" != "Darwin" ]] && ! command -v systemctl >/dev/null 2>&1; then
  echo "systemctl is required to stop the detached daemon safely." >&2
  exit 1
fi
if [[ "${SERVICE_MODE}" == "install" && "${PLATFORM}" == "Darwin" ]] && ! command -v launchctl >/dev/null 2>&1; then
  echo "launchctl is required to stop the detached macOS user agent safely." >&2
  exit 1
fi

if [[ "${PLATFORM}" == "Darwin" ]]; then
  HOST_DIR="${SHADOW_NATIVE_HOST_DIR:-${HOME}/Library/Application Support/${MAC_BROWSER_DIR}/NativeMessagingHosts}"
else
  HOST_DIR="${SHADOW_NATIVE_HOST_DIR:-${CONFIG_ROOT}/${BROWSER_CONFIG_DIR}/NativeMessagingHosts}"
fi
HOST_MANIFEST="${HOST_DIR}/${HOST_NAME}.json"
if [[ -n "${SECUREINTENT_SHADOW_SOCKET:-}" ]]; then
  DAEMON_SOCKET="${SECUREINTENT_SHADOW_SOCKET}"
elif [[ -n "${XDG_RUNTIME_DIR:-}" ]]; then
  DAEMON_SOCKET="${XDG_RUNTIME_DIR}/secureintent-shadow/daemon.sock"
else
  DAEMON_SOCKET="/run/user/$(id -u)/secureintent-shadow/daemon.sock"
fi

if [[ "${PLATFORM}" == "Darwin" && -z "${SECUREINTENT_SHADOW_SOCKET:-}" ]]; then
  DAEMON_SOCKET="${HOME}/Library/Caches/secureintent-shadow/daemon.sock"
fi

if [[ "${PLATFORM}" == "Darwin" && "${SERVICE_MODE}" == "install" ]]; then
  if ! BOOTOUT_OUTPUT="$(launchctl bootout "gui/$(id -u)/${LAUNCH_LABEL}" 2>&1)"; then
    case "${BOOTOUT_OUTPUT}" in
      *"No such process"*|*"Could not find service"*|*"not loaded"*) ;;
      *)
        echo "launchctl bootout failed for ${LAUNCH_LABEL}: ${BOOTOUT_OUTPUT}" >&2
        exit 1
        ;;
    esac
  fi
fi

if [[ "${SERVICE_MODE}" == "install" && "${PLATFORM}" != "Darwin" ]]; then
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

if [[ "${SERVICE_MODE}" != "ephemeral" && "${PLATFORM}" != "Darwin" ]]; then
  if [[ -e "${SERVICE_FILE}" || -L "${SERVICE_FILE}" ]]; then
    rm -f -- "${SERVICE_FILE}"
    echo "Removed detached daemon service: ${SERVICE_FILE}"
  else
    echo "Detached daemon service was already absent: ${SERVICE_FILE}"
  fi
fi

if [[ "${SERVICE_MODE}" != "ephemeral" && "${PLATFORM}" == "Darwin" ]]; then
  if [[ -e "${LAUNCH_PLIST}" || -L "${LAUNCH_PLIST}" ]]; then
    rm -f -- "${LAUNCH_PLIST}"
    echo "Removed launchd user agent: ${LAUNCH_PLIST}"
  else
    echo "launchd user agent was already absent: ${LAUNCH_PLIST}"
  fi
fi

if [[ "${SERVICE_MODE}" != "ephemeral" && -S "${DAEMON_SOCKET}" ]]; then
  rm -f -- "${DAEMON_SOCKET}"
  echo "Removed stale daemon socket: ${DAEMON_SOCKET}"
fi

if [[ "${SERVICE_MODE}" == "install" && "${PLATFORM}" != "Darwin" ]]; then
  systemctl --user daemon-reload
fi

echo "Compiled broker and daemon binaries were preserved and remain recoverable in daemon/target/."
