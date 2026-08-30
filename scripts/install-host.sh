#!/usr/bin/env bash
set -euo pipefail

HOST_NAME="com.secureintent.shadow"
SERVICE_NAME="com.secureintent.shadow.service"
EXTENSION_ID="${1:-}"
BROWSER_FLAVOR="${2:-chrome}"
DAEMON_VARIANT="${3:-native}"
SERVICE_MODE="${SHADOW_SERVICE_MODE:-install}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
DAEMON_MANIFEST="${REPO_DIR}/daemon/Cargo.toml"
CONFIG_ROOT="${XDG_CONFIG_HOME:-${HOME}/.config}"
SYSTEMD_USER_DIR="${SHADOW_SYSTEMD_USER_DIR:-${CONFIG_ROOT}/systemd/user}"
SERVICE_FILE="${SYSTEMD_USER_DIR}/${SERVICE_NAME}"

case "${BROWSER_FLAVOR}" in
  chrome) BROWSER_CONFIG_DIR="google-chrome" ;;
  chrome-for-testing) BROWSER_CONFIG_DIR="google-chrome-for-testing" ;;
  chromium) BROWSER_CONFIG_DIR="chromium" ;;
  *)
    echo "Unsupported browser flavor: ${BROWSER_FLAVOR}" >&2
    echo "Expected chrome, chrome-for-testing, or chromium." >&2
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

for required_command in awk cargo node realpath sha256sum stat; do
  if ! command -v "${required_command}" >/dev/null 2>&1; then
    echo "Missing installer dependency: ${required_command}" >&2
    exit 1
  fi
done
if [[ "${SERVICE_MODE}" == "install" ]] && ! command -v systemctl >/dev/null 2>&1; then
  echo "systemctl is required to install the detached user service." >&2
  exit 1
fi

if [[ ! "${EXTENSION_ID}" =~ ^[a-p]{32}$ ]]; then
  echo "Usage: ./scripts/install-host.sh <extension-id> [browser] [native|tauri]" >&2
  echo "The ID must contain only letters a through p." >&2
  exit 2
fi

BROKER_BINARY="${REPO_DIR}/daemon/target/release/secureintent-shadow-host"
echo "Building the short-lived Rust Native Messaging broker..."
cargo build --release --manifest-path "${DAEMON_MANIFEST}" --bin secureintent-shadow-host

case "${DAEMON_VARIANT}" in
  native)
    DAEMON_BINARY="${REPO_DIR}/daemon/target/release/secureintent-shadow-daemon"
    echo "Building the dependency-light detached Rust scanner daemon..."
    cargo build --release --manifest-path "${DAEMON_MANIFEST}" --bin secureintent-shadow-daemon
    ;;
  tauri)
    DAEMON_BINARY="${REPO_DIR}/daemon/target/release/secureintent-shadow-tauri"
    if ! command -v pkg-config >/dev/null 2>&1 || \
      ! pkg-config --exists javascriptcoregtk-4.1 webkit2gtk-4.1; then
      echo "The detached Tauri daemon requires Tauri v2's Linux development packages." >&2
      echo "Debian/Ubuntu/Kali: sudo apt install libwebkit2gtk-4.1-dev" >&2
      exit 1
    fi
    echo "Building the zero-window detached Tauri v2 scanner daemon..."
    cargo build --release --manifest-path "${DAEMON_MANIFEST}" \
      --features tauri-host --bin secureintent-shadow-tauri
    ;;
  *)
    echo "Unsupported daemon variant: ${DAEMON_VARIANT}" >&2
    echo "Expected native or tauri." >&2
    exit 2
    ;;
esac

for binary in "${BROKER_BINARY}" "${DAEMON_BINARY}"; do
  if [[ ! -f "${binary}" ]]; then
    echo "Expected Rust binary was not produced: ${binary}" >&2
    exit 1
  fi
  chmod 0755 "${binary}"
done
BROKER_BINARY="$(realpath "${BROKER_BINARY}")"
DAEMON_BINARY="$(realpath "${DAEMON_BINARY}")"
for binary in "${BROKER_BINARY}" "${DAEMON_BINARY}"; do
  if [[ "${binary}" != /* || ! -f "${binary}" || ! -x "${binary}" ]]; then
    echo "Rust executable must resolve to an absolute executable file: ${binary}" >&2
    exit 1
  fi
done

BROKER_SHA256="$(sha256sum "${BROKER_BINARY}" | awk '{print $1}')"
DAEMON_SHA256="$(sha256sum "${DAEMON_BINARY}" | awk '{print $1}')"

mkdir -p "${HOST_DIR}"
chmod 0700 "${HOST_DIR}"
node -e '
  const fs = require("node:fs");
  const { randomUUID } = require("node:crypto");
  const [manifestPath, brokerPath, extensionId] = process.argv.slice(1);
  const manifest = {
    name: "com.secureintent.shadow",
    description: "SecureIntent Shadow Upload daemon broker",
    path: brokerPath,
    type: "stdio",
    allowed_origins: [`chrome-extension://${extensionId}/`],
  };
  const temporaryPath = `${manifestPath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    fs.chmodSync(temporaryPath, 0o600);
    fs.renameSync(temporaryPath, manifestPath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
' "${HOST_MANIFEST}" "${BROKER_BINARY}" "${EXTENSION_ID}"

node -e '
  const fs = require("node:fs");
  const [manifestPath, expectedBroker, extensionId] = process.argv.slice(1);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.name !== "com.secureintent.shadow") throw new Error("wrong host name");
  if (manifest.path !== expectedBroker || !manifest.path.startsWith("/")) {
    throw new Error("host path is not the expected absolute broker path");
  }
  if (manifest.type !== "stdio") throw new Error("host type must be stdio");
  const expectedOrigin = `chrome-extension://${extensionId}/`;
  if (JSON.stringify(manifest.allowed_origins) !== JSON.stringify([expectedOrigin])) {
    throw new Error("allowed_origins is not pinned to the exact extension id");
  }
' "${HOST_MANIFEST}" "${BROKER_BINARY}" "${EXTENSION_ID}"

MANIFEST_MODE="$(stat -c '%a' "${HOST_MANIFEST}")"
if [[ "${MANIFEST_MODE}" != "600" ]]; then
  echo "Native host manifest permissions must be 600; found ${MANIFEST_MODE}." >&2
  exit 1
fi

if [[ "${SERVICE_MODE}" != "ephemeral" ]]; then
  mkdir -p "${SYSTEMD_USER_DIR}"
  node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const { randomUUID } = require("node:crypto");
    const [servicePath, daemonPath, socketPath] = process.argv.slice(1);
    const systemdQuote = (value) => {
      if (/[\u0000-\u001f\u007f]/u.test(value)) throw new Error("unsafe control character in path");
      return JSON.stringify(value.replaceAll("%", "%%"));
    };
    const lines = [
      "[Unit]",
      "Description=SecureIntent Shadow detached upload scanner",
      "After=graphical-session.target",
      "PartOf=graphical-session.target",
      "",
      "[Service]",
      "Type=simple",
      `ExecStart=${systemdQuote(daemonPath)}`,
      "RuntimeDirectory=secureintent-shadow",
      "RuntimeDirectoryMode=0700",
    ];
    if (socketPath) {
      lines.push(`Environment=${systemdQuote(`SECUREINTENT_SHADOW_SOCKET=${socketPath}`)}`);
    }
    lines.push(
      "Restart=on-failure",
      "RestartSec=1s",
      "NoNewPrivileges=true",
      "ProtectSystem=strict",
      "ProtectHome=read-only",
      socketPath
        ? `ReadWritePaths=${systemdQuote(path.dirname(socketPath))}`
        : "ReadWritePaths=%t/secureintent-shadow",
      "RestrictAddressFamilies=AF_UNIX",
      "UMask=0077",
      "",
      "[Install]",
      "WantedBy=graphical-session.target",
      "",
    );
    const temporaryPath = `${servicePath}.tmp-${process.pid}-${randomUUID()}`;
    try {
      fs.writeFileSync(temporaryPath, lines.join("\n"), { flag: "wx", mode: 0o600 });
      fs.chmodSync(temporaryPath, 0o600);
      fs.renameSync(temporaryPath, servicePath);
    } finally {
      fs.rmSync(temporaryPath, { force: true });
    }
  ' "${SERVICE_FILE}" "${DAEMON_BINARY}" "${SECUREINTENT_SHADOW_SOCKET:-}"
fi

if [[ "${SERVICE_MODE}" == "install" ]]; then
  if [[ "${DAEMON_VARIANT}" == "tauri" ]]; then
    DISPLAY_ENVIRONMENT=()
    for variable_name in DISPLAY WAYLAND_DISPLAY XAUTHORITY; do
      if [[ -n "${!variable_name:-}" ]]; then
        DISPLAY_ENVIRONMENT+=("${variable_name}")
      fi
    done
    if (( ${#DISPLAY_ENVIRONMENT[@]} > 0 )); then
      systemctl --user import-environment "${DISPLAY_ENVIRONMENT[@]}"
    fi
  fi
  systemctl --user daemon-reload
  systemctl --user enable "${SERVICE_NAME}"
  systemctl --user restart "${SERVICE_NAME}"

  if [[ -n "${SECUREINTENT_SHADOW_SOCKET:-}" ]]; then
    ACTIVE_SOCKET="${SECUREINTENT_SHADOW_SOCKET}"
  elif [[ -n "${XDG_RUNTIME_DIR:-}" ]]; then
    ACTIVE_SOCKET="${XDG_RUNTIME_DIR}/secureintent-shadow/daemon.sock"
  else
    ACTIVE_SOCKET="/run/user/$(id -u)/secureintent-shadow/daemon.sock"
  fi

  for _attempt in {1..50}; do
    [[ -S "${ACTIVE_SOCKET}" ]] && break
    sleep 0.1
  done
  if [[ ! -S "${ACTIVE_SOCKET}" ]]; then
    echo "Detached daemon did not create its private socket: ${ACTIVE_SOCKET}" >&2
    echo "Inspect it with: systemctl --user status ${SERVICE_NAME}" >&2
    exit 1
  fi
  if ! systemctl --user is-active --quiet "${SERVICE_NAME}"; then
    echo "Detached daemon service did not remain active: ${SERVICE_NAME}" >&2
    echo "Inspect it with: systemctl --user status ${SERVICE_NAME}" >&2
    exit 1
  fi
  ACTIVE_SOCKET_MODE="$(stat -c '%a' "${ACTIVE_SOCKET}")"
  if [[ "${ACTIVE_SOCKET_MODE}" != "600" ]]; then
    echo "Detached daemon socket mode must be 600; found ${ACTIVE_SOCKET_MODE}." >&2
    exit 1
  fi
fi

echo "Installed ${HOST_NAME} broker and ${DAEMON_VARIANT} detached daemon for ${BROWSER_FLAVOR}."
echo "Manifest:       ${HOST_MANIFEST} (mode ${MANIFEST_MODE})"
echo "Broker:         ${BROKER_BINARY}"
echo "Broker SHA-256: ${BROKER_SHA256}"
echo "Daemon:         ${DAEMON_BINARY}"
echo "Daemon SHA-256: ${DAEMON_SHA256}"
if [[ "${SERVICE_MODE}" != "ephemeral" ]]; then
  echo "User service:   ${SERVICE_FILE}"
fi
if [[ "${SERVICE_MODE}" == "install" ]]; then
  echo "Service state:  $(systemctl --user is-active "${SERVICE_NAME}")"
fi
echo "Next: restart Chrome, reopen http://localhost:4173, and drop testdata/block.pem."
