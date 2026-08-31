# SecureIntent — Shadow Upload Interceptor for macOS

This README applies only to the macOS implementation on
`shadow-upload-interceptor-macos-version` and the `macos-part1-v1.0.0` release line.

**Files are inspected locally before release. The detached daemon returns only Block or Allow, and
policy decides what happens when scanning is unavailable.**

This branch is the macOS version of SecureIntent's upload-boundary vertical slice: a polished dummy
AI destination, a Chrome MV3 extension built with WXT/React/TypeScript, a short-lived Rust Native
Messaging broker, and an independently managed Rust scanner daemon. The assessed daemon is a
zero-window Tauri v2 executable managed by `launchd`. Chrome can exit while that daemon PID and its
private Unix listener remain alive. No file bytes are sent to a cloud service.

Use `shadow-upload-interceptor-macos-version` for macOS development. Immutable v1.0.0 sources are
tagged `macos-part1-v1.0.0`.

## Part 1 requirement coverage

| Requirement | Implemented result |
|---|---|
| WXT upload interception | A `document_start` content script synchronously captures ordinary file inputs and trusted drag/drop before page handlers run |
| Browser-to-OS bridge | The MV3 worker uses an origin-pinned Chrome Native Messaging broker; no localhost TCP or WebSocket listener exists |
| Detached Tauri listener | A zero-window Tauri v2 process owns the persistent scanner loop independently of Chrome; persistent installation uses a macOS `launchd` user agent |
| Raw byte boundary | `File.arrayBuffer()` becomes `Uint8Array`; bounded chunks are base64-encoded only where Native Messaging's JSON protocol requires it |
| Mock secret scan | Rust scans byte content for PEM private-key markers and AWS-style access-key identifiers, regardless of filename |
| Volatile, zeroizing memory | The broker and daemon never write file data to disk and scrub their directly owned file-content frames, decoded chunks, and aggregate scan buffer with `zeroize` |
| Block/Allow resolution | Allow reconstructs the page `FileList`; Block leaves it empty and mounts a warning in a closed Shadow DOM |
| Failure behavior | Missing, disconnected, timed-out, malformed, and oversized scans block by default; validated local or managed policy can explicitly choose fail-open |

## The 60-second demo

1. Open the local **Forge** page at `http://localhost:4173`.
2. Drop [`testdata/allow.txt`](testdata/allow.txt). Forge reports **Allowed — uploaded** and shows
   the filename and size, proving the extension resumed the original upload.
3. Drop [`testdata/block.pem`](testdata/block.pem). A SecureIntent warning appears on the page and
   Forge reports **Blocked — not sent**. The sample is deliberately fake; it only contains the
   marker used by the assessment.
4. Drop [`testdata/oversized-8mb.txt`](testdata/oversized-8mb.txt). Its logical size is exactly
   8 MiB + 1 byte, so the bundled policy blocks it without sending it to the daemon.
5. Stop the printed daemon PID (ephemeral demo) or the user service (manual installation), then try
   again. The extension-owned status changes to **Local scanner offline**, and the bundled
   fail-closed policy blocks instead of releasing unscanned bytes. Restart the daemon and the
   status automatically reports **Local scanner restored** without reloading Forge.

Decisions come from bytes, never extensions: [`testdata/renamed-secret.txt`](testdata/renamed-secret.txt)
still blocks, while the browser suite proves that harmless bytes renamed `private-key.pem` are
allowed.

The warning and live daemon-status card are rendered by the extension in separate closed Shadow
DOM roots. The card reports checking, online, scanning, offline, and restored states. Health checks
run while the tab is visible and on focus; hidden tabs do not continuously launch health brokers.
The page cannot inspect either component's internal UI, and removing a host element cannot recover
a file that was already blocked.

When the daemon is unavailable, the warning explains that fail-closed policy blocked the upload and
asks the user to start or restart the daemon before selecting the file again. A secret finding uses
different copy, so scanner outages are never presented as detected credentials.

## Prerequisites

- Google Chrome 148+ for manual loading. The disposable launcher supports Chrome for Testing or
  Chromium 148+ on macOS.
- [Node.js](https://nodejs.org/en/download) 22 or newer. The launchers select the pinned pnpm
  10.28.2 automatically; a global pnpm installation is not required.
- [Rust](https://www.rust-lang.org/tools/install) 1.85 or newer.
- A logged-in macOS desktop session with per-user `launchd` available.
- macOS source builds: Xcode Command Line Tools (`xcode-select --install`), as required by
  [Tauri's macOS prerequisites](https://v2.tauri.app/start/prerequisites/).
- Persistent installation must run from the logged-in desktop user's Terminal without `sudo`.
- Tauri v2 builds use the WebKit and application frameworks supplied by macOS and the Xcode Command
  Line Tools.

Chrome 148 is intentional: the extension opts into structured-clone messaging so a `Uint8Array`
can be copied from the content script to the MV3 worker without converting the file to base64 in
the page context. Native Messaging remains JSON and is base64-chunked only at that boundary.

## One-command demo

The launchers build everything locally, use a fresh browser profile, and remove their temporary
runtime state on exit. They never require a pre-installed pnpm version or an explicit browser path
when a supported browser is installed in a standard location.

Start from the immutable macOS v1.0.0 release:

```bash
git clone --branch macos-part1-v1.0.0 \
  https://github.com/0xkaushik-ai/shadow-upload-interceptor-v1.git \
  shadow-upload-interceptor
cd shadow-upload-interceptor
```

macOS, assessed detached Tauri daemon (Chrome for Testing or Chromium is auto-discovered):

```bash
chmod +x run-macos.sh
./run-macos.sh --tauri-daemon
```

Use plain `./run-macos.sh` only when you intentionally want the dependency-light native daemon
instead of the assessed Tauri executable. If browser auto-discovery cannot find a compatible
binary, install one into the Playwright cache with:

```bash
npx --yes pnpm@10.28.2 --dir extension install --frozen-lockfile
npx --yes pnpm@10.28.2 --dir extension exec playwright install chromium
```

You can override discovery with `DEMO_CHROME_BIN=/absolute/path/to/browser`.

The launcher installs pnpm dependencies, builds the WXT extension, builds and registers the Rust
broker and zero-window Tauri daemon, serves Forge on port 4173, and opens a fresh temporary Chrome
for Testing or Chromium profile with the unpacked extension loaded. The Native Messaging manifest
registers only the small broker; the separate Tauri process owns the private listener and scan loop.
Chrome may create and terminate brokers without owning the daemon lifecycle.

The launcher discovers compatible Playwright/Puppeteer browser caches or accepts
`DEMO_CHROME_BIN=/path/to/chrome`. It places the disposable profile, Native Messaging manifest,
socket, and service state under a short `/tmp/secureintent-shadow-*` path so macOS Unix socket limits
are respected. Manual installation uses a persistent `launchd` user agent. The default launcher
substitutes the standalone Rust daemon for the assessed Tauri executable; pass `--tauri-daemon` for
the official Part 1 path.

On macOS, `./run-macos.sh` finds Chrome for Testing or Chromium in the standard application and
Playwright-cache paths, checks version 148+, then runs the shared launcher with its pinned pnpm
selection. Set `DEMO_CHROME_BIN` to override discovery.

Because Chrome resolves user-level Native Messaging hosts relative to an overridden user-data
directory, the launcher installs a pinned host manifest inside its disposable profile. Manual setup
still installs to the browser's normal per-user configuration directory.

Official branded Chrome removed command-line unpacked-extension loading in version 137. The runner
therefore refuses to launch branded Chrome instead of silently opening an unprotected Forge page.
For regular Google Chrome, use the manual `chrome://extensions` setup below.

The unpacked extension carries a public development key so its ID is stable and the launcher can
pin the exact Native Messaging `allowed_origin` automatically. The key is not a credential or a
private signing key. A production build would obtain its stable identity from the Chrome Web Store
or enterprise-managed deployment.

To build and register the Tauri variant without opening Chrome, use
`./run-macos.sh --prepare-only --tauri-daemon`.

## macOS persistent installation

The one-command demo above is disposable: it uses a temporary browser profile, socket, and daemon,
then removes that runtime state when the demo exits. Use this section to load the extension into
ordinary Google Chrome and install the Tauri scanner as a persistent per-user `launchd` service.
Run every command as your normal logged-in macOS user—never with `sudo`.

### 1. Install the build tools

Install Apple's Command Line Tools:

```bash
xcode-select --install
```

Install Node.js 22+ from the [official Node.js download](https://nodejs.org/en/download), then
install Rust with the [official `rustup` installer](https://www.rust-lang.org/tools/install):

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"
rustup toolchain install stable
rustup default stable
```

Confirm that the required tools are visible in a new Terminal:

```bash
xcode-select -p
node --version
npm --version
rustc --version
cargo --version
```

`node` must report 22 or newer and `rustc` must report 1.85 or newer. No global pnpm installation is
needed.

### 2. Clone and build

```bash
git clone --branch macos-part1-v1.0.0 \
  https://github.com/0xkaushik-ai/shadow-upload-interceptor-v1.git \
  shadow-upload-interceptor
cd shadow-upload-interceptor
chmod +x run-macos.sh scripts/*.sh
npx --yes pnpm@10.28.2 --dir extension install --frozen-lockfile
npx --yes pnpm@10.28.2 --dir extension build
```

The unpacked extension is now at `extension/.output/chrome-mv3`.

### 3. Load the extension in Google Chrome

1. Open `chrome://extensions` in Google Chrome 148 or newer.
2. Enable **Developer mode**.
3. Select **Load unpacked**.
4. Choose the repository's `extension/.output/chrome-mv3` directory.
5. Copy the 32-character extension ID displayed on the extension card.

The extension ID contains only letters `a` through `p`. If Chrome gives the extension a different
ID after a rebuild, rerun the installer with the new ID so Native Messaging remains pinned to the
exact extension origin.

### 4. Install the Tauri daemon and Native Messaging broker

Replace the value below with the ID copied from Chrome:

```bash
export EXTENSION_ID="paste_the_32_character_extension_id_here"
./scripts/install-host.sh "$EXTENSION_ID" chrome tauri
```

The installer builds release binaries, writes the Chrome Native Messaging manifest, creates the
`launchd` property list, bootstraps the user agent, and waits for its private socket. A successful
installation ends with `Service state: launchd com.secureintent.shadow`.

The service property list contains absolute paths into this clone. Do not move or delete the
repository while it is installed. If you move it, rerun the installer from the new location.

Fully quit Chrome with **Command-Q**, then reopen it. Closing only the current window is not enough
to guarantee that Chrome reloads its Native Messaging registration.

### 5. Run the protected Forge page

In a second Terminal, from the repository root, run:

```bash
node scripts/serve-demo.mjs dummy-page 4173
```

Open `http://localhost:4173`, then try:

- `testdata/allow.txt` — allowed and delivered to Forge.
- `testdata/block.pem` — blocked before Forge receives it.
- `testdata/oversized-8mb.txt` — blocked by the bundled maximum-size policy.

Only this local Forge origin is currently in the extension's build-time match list. The server can
be stopped with **Control-C** without stopping the `launchd` scanner.

### 6. Verify, inspect, or restart the service

Keep the same `EXTENSION_ID` value available in the Terminal and run the full diagnostic:

```bash
./scripts/doctor.sh "$EXTENSION_ID" chrome
```

The doctor validates the pinned manifest, executable broker, `launchd` PID, `0600` socket, and
Health/Block/Allow requests through three separate broker processes. It also proves the daemon PID
survives those broker exits.

Inspect or restart only the background scanner with:

```bash
launchctl print "gui/$(id -u)/com.secureintent.shadow"
launchctl kickstart -k "gui/$(id -u)/com.secureintent.shadow"
```

If the extension card reports **Local scanner offline**, run the `kickstart` command while Forge is
open. The visible tab rechecks the daemon automatically and changes through **Local scanner
restored** to **Local scanner online**; select the file again only after protection is active.

The daemon starts automatically in the user's graphical login session and `launchd` keeps it alive.
Chrome starts the short-lived `secureintent-shadow-host` broker only when the extension needs it;
closing Chrome does not stop the Tauri daemon.

### 7. Update or uninstall

To update a source installation, pull the code, rebuild, and rerun the installer with the same
Chrome extension ID:

```bash
git pull --ff-only
npx --yes pnpm@10.28.2 --dir extension install --frozen-lockfile
npx --yes pnpm@10.28.2 --dir extension build
./scripts/install-host.sh "$EXTENSION_ID" chrome tauri
```

Reload the unpacked extension from `chrome://extensions`, then fully quit and reopen Chrome.

To remove the macOS service and Google Chrome registration:

```bash
./scripts/uninstall-host.sh chrome
```

Then remove the unpacked extension from `chrome://extensions`. The uninstaller stops and removes the
launch agent, manifest, and stale socket, but deliberately preserves compiled binaries under
`daemon/target/`; after uninstalling, the repository can be deleted safely.

Use the same browser flavor for every lifecycle command. Substitute `chrome-for-testing` or
`chromium` consistently for `chrome` when that is the browser you registered:

```bash
./scripts/install-host.sh "$EXTENSION_ID" chromium tauri
./scripts/doctor.sh "$EXTENSION_ID" chromium
./scripts/uninstall-host.sh chromium
```

### macOS troubleshooting

- **`run-macos.sh` cannot find a browser:** install the Playwright browser using the two `npx`
  commands in the one-command demo section, or set `DEMO_CHROME_BIN` to the executable for Chrome
  for Testing or Chromium 148+. Branded Google Chrome must use the manual load-unpacked flow.
- **The extension reports degraded protection:** confirm that the browser flavor and extension ID
  passed to `install-host.sh` match the browser currently open, fully restart Chrome, and run
  `doctor.sh`.
- **The doctor reports a missing executable:** the repository was probably moved or its
  `daemon/target` directory was deleted. Rerun `install-host.sh` from the repository's current path.
- **Port 4173 is already in use:** stop the existing process or close the previous Forge server
  before starting `serve-demo.mjs` again.
- **Distribution warning:** this is a source/developer installation. Tauri bundling is disabled, so
  the repository builds for the current Mac architecture and does not yet ship a Developer
  ID-signed or notarized universal `.app`, DMG, PKG, updater, or tray UI.

## Installation paths and service model

The installer registers `secureintent-shadow-host`, the short-lived broker, by writing its absolute
path plus the exact extension origin to the browser-specific location below:

| Platform/browser | Native Messaging manifest |
|---|---|
| macOS / Google Chrome | `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.secureintent.shadow.json` |
| macOS / Chrome for Testing | `~/Library/Application Support/Google/Chrome for Testing/NativeMessagingHosts/com.secureintent.shadow.json` |
| macOS / Chromium | `~/Library/Application Support/Chromium/NativeMessagingHosts/com.secureintent.shadow.json` |

The installer writes the mode-`0600`
`~/Library/LaunchAgents/com.secureintent.shadow.plist` and bootstraps it with `launchctl`. The user
agent owns either `secureintent-shadow-tauri` or `secureintent-shadow-daemon`, which listens at
`~/Library/Caches/secureintent-shadow/daemon.sock`. The runtime directory is `0700`, the socket is
`0600`, and both sides verify same-user peer credentials with `getpeereid`.

The registration is written atomically with mode `0600`, pins one exact extension origin, and is
validated after installation. Diagnose or remove the complete broker/service registration with:

```bash
./scripts/doctor.sh EXTENSION_ID_FROM_CHROME
./scripts/uninstall-host.sh chrome
```

`doctor.sh` checks the manifest, broker, service, socket permissions, and service PID; then it runs
Health, Block, and Allow through three separate brokers and confirms that the daemon PID survived.
Uninstall disables/removes the service, manifest, and stale socket. Built binaries remain intact.

The checked-in workflow, [`.github/workflows/part1.yml`](.github/workflows/part1.yml), runs on every
push, pull request, or manual dispatch. Its dedicated macOS job builds the native host and Tauri
daemon, bootstraps the Tauri process under `launchd`, runs the real browser loop through that
process, and publishes macOS executables as an archive with executable permissions preserved.

## Tests

```bash
cd daemon && cargo test
```

From the repository root, the detached lifecycle smoke test starts one daemon and exercises three
separate Native Messaging brokers without Chrome:

```bash
cargo build --manifest-path daemon/Cargo.toml \
  --bin secureintent-shadow-host --bin secureintent-shadow-daemon
node scripts/smoke-detached.mjs
./scripts/test-install.sh
```

On macOS, the same installer test can exercise the real launchd-managed Tauri lifecycle. It refuses
to replace an existing SecureIntent launch agent:

```bash
SHADOW_INSTALL_TEST_SERVICE_MODE=install \
SHADOW_INSTALL_TEST_DAEMON_VARIANT=tauri \
  ./scripts/test-install.sh
```

```bash
corepack pnpm@10.28.2 --dir extension test
corepack pnpm@10.28.2 --dir extension compile
corepack pnpm@10.28.2 --dir extension build
```

The real-browser suite launches a fresh Chromium profile and checks picker and trusted drag/drop
flows through Native Messaging, renamed files, closed Shadow DOM, both size-cap policies, and both
allow-on-failure and block-on-failure behavior:

```bash
cargo build --manifest-path daemon/Cargo.toml \
  --bin secureintent-shadow-host --bin secureintent-shadow-daemon
cd extension
corepack pnpm@10.28.2 exec playwright install chromium
corepack pnpm@10.28.2 e2e
```

Rust tests cover every registered rule, strict framing, protocol versioning, split markers,
malformed requests, offsets, sizes, private-directory rejection, socket modes, peer credentials,
broker request filtering, and zeroizing scan ownership. The lifecycle smoke test proves that one
daemon PID survives Health, Block, and Allow brokers. TypeScript tests cover protocol validation,
policy parsing and enforcement, native-client failures and timeouts, synchronous interception,
stale responses, removed inputs, drop routing, DOM metadata minimization, and `FileList`
reconstruction. A reviewer does not need GTK or WebKit to run the default equivalent daemon core.

The last verified local run completed 29 Rust unit tests, 29 extension unit tests, and 7 real-browser
tests. The Tauri lifecycle smoke also proved that one PID survives malformed IPC and three separate
Native Messaging broker sessions.

### Detached Tauri v2 daemon

Tauri is a real independent executable, not a compile-time label on the Chrome-owned broker. It has
no window or web frontend. Tauri owns the main-thread application lifecycle while a named Rust OS
thread binds the persistent AF_UNIX listener before desktop-runtime initialization. On macOS:

```bash
xcode-select --install
cargo build --release --manifest-path daemon/Cargo.toml \
  --features tauri-host --bin secureintent-shadow-tauri --bin secureintent-shadow-host
SHADOW_DAEMON_BINARY=daemon/target/release/secureintent-shadow-tauri \
  SHADOW_HOST_BINARY=daemon/target/release/secureintent-shadow-host \
  node scripts/smoke-detached.mjs
./run-macos.sh --tauri-daemon
```

The ordinary `./run-macos.sh` intentionally remains dependency-light. CI separately builds the
Tauri executable, runs its lifecycle smoke, bootstraps it under `launchd`, and exercises the full
Chrome for Testing loop. In both variants Chrome launches only `secureintent-shadow-host`;
disconnecting it never terminates the daemon. Persistent installation is owned by the macOS
`launchd` user agent. No tray or UI is needed for Part 1.

## Why Native Messaging plus AF_UNIX, not localhost WebSockets

Chrome launches the registered broker and connects over inherited stdin/stdout. The manifest pins
the exact extension origin, including its required trailing slash. Ordinary pages and content
scripts cannot call `connectNative`; only the privileged extension worker can. The broker relays
bounded frames to the persistent daemon over a filesystem-scoped Unix socket in the current user's
private runtime directory. Both endpoints verify the peer UID. There is no TCP port, port discovery,
or HTTP/CORS/PNA exception.

The daemon returns a tiny verdict—never bytes or matched substrings. A localhost WebSocket would be
reachable from browser origins and would require a separate authentication, Origin, and Private
Network Access design. For very large production files, Native Messaging can vend a one-use socket
capability for a raw-binary transfer; this bounded slice keeps the existing chunked v1 frames intact
across the local socket so the assessed TS/Rust boundary stays explicit.

## Memory and zero retention

The daemon validates the declared size before allocating. It preallocates one
`Zeroizing<Vec<u8>>`, validates contiguous offsets, wraps every decoded chunk in `Zeroizing`, scans
the final buffer as bytes, and drops it before writing the verdict. Incoming JSON frames are also
held in a zeroizing buffer, and serde borrows the base64 field instead of copying it. The broker's
relayed frame is independently zeroizing and drops immediately after forwarding. The extension also
overwrites the content-script and worker `Uint8Array` allocations after each decision as a
best-effort reduction in browser-side lifetime.

Zeroization is an ownership guarantee, not a claim of magical erasure. Chrome, OS pipes, JavaScript
garbage collection, system allocators, crash dumps, swap, and dependency internals may create
copies the Rust processes do not own. The broker and daemon zero every sensitive allocation they
directly own, do not write temporary files, and never log file contents.

## Configurable failure policy

Missing broker or daemon, connection failure, disconnect, protocol mismatch, malformed response,
timeout, and files over the configured bound produce an explicit `unavailable` outcome rather than
a scanner verdict. Policy independently selects `allow` or `block` for scanner failures and
oversized files.
The bundled policy defaults to Block for both. This prevents a missing scanner or an oversized file
from silently bypassing the guard. Until a validated policy arrives from the background, the content
script uses the same secure block-on-failure fallback.

Policy can be supplied through `chrome.storage.local` for development or the read-only
`chrome.storage.managed` area for enterprise deployment; managed values win. The bundled
`policy_schema.json` defines the managed shape. An unmanaged developer who deliberately needs
fail-open behavior can opt into it from the extension service worker's DevTools with:

```js
await chrome.storage.local.set({
  guardPolicy: {
    onUnavailable: 'allow',
    onTooLarge: 'allow',
    maxFileBytes: 8 * 1024 * 1024,
    scanTimeoutMs: 2500,
  },
});
```

Invalid policy objects are rejected atomically. The maximum bound cannot exceed the Rust daemon's
8 MiB limit, and runtime origin policy can only narrow the extension's build-time match scope.

## Deliberate limits

- Chrome for Testing or Chromium 148+ on macOS is supported by the disposable demo launcher.
- One file is scanned per picker/drop interaction.
- Files larger than the configured bound are allowed or blocked according to policy; they are never
  sent to the broker or daemon.
- The demo registry scans byte content for PEM RSA, PKCS#8, OpenSSH private-key markers, and
  access-key-shaped `AKIA`/`ASIA` identifiers. It is intentionally not a production entropy/parser
  engine.
- The page is a local prop. No ChatGPT, Claude, SaaS, cloud, account, or telemetry integration exists.
- The detached Tauri daemon has no window, tray, updater, settings,
  capabilities, or frontend.
- The repository builds a Tauri executable and installs it as a user service; signed Tauri bundles,
  Chrome Web Store packaging, Windows registration, and automatic updates are later product
  phases.

## Two-minute Loom shot list

**0:00–0:15 — The promise.** Show Forge and say: “SecureIntent inspects the transfer boundary,
locally. The destination receives an allowed file or nothing.”

**0:15–0:35 — Allow.** Drop `allow.txt`. Point to **Scanning locally…**, then the attached filename
and size. Explain that a new `FileList` proves the original page flow resumed.

**0:35–1:00 — Block.** Drop `block.pem`. Show the closed-shadow warning and Forge's
**Blocked — not sent** state. Open Network briefly: no cloud scan occurred.

**1:00–1:25 — The bridge.** Show the broker manifest's pinned `allowed_origins`, the active
`launchd` service PID, the `0600` Unix socket, then `scan.rs` and the zeroizing session allocation.

**1:25–1:45 — Limits and lifecycle.** Drop `oversized-8mb.txt` to show fail-closed size handling,
then show `node scripts/smoke-detached.mjs` reporting that one daemon PID survived three broker exits.

**1:45–2:00 — Evidence.** Run `cargo test` and close with: “Raw bytes stay local; the daemon returns
only Block or Allow.”

See [ARCHITECTURE.md](ARCHITECTURE.md) for protocol and threat-model details and
[PART2-STRATEGIC-BRIEF.md](PART2-STRATEGIC-BRIEF.md) for the 12-month enterprise direction.
