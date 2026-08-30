# SecureIntent — Shadow Upload Interceptor for Linux

This README applies only to the Linux implementation on `main` and the
`linux-part1-v1.0.0` release line.

**Files are inspected locally before release. The detached daemon returns only Block or Allow, and
policy decides what happens when scanning is unavailable.**

This repository is a production-shaped vertical slice of SecureIntent's upload boundary: a polished
dummy AI destination, a Chrome MV3 extension built with WXT/React/TypeScript, a short-lived Rust
Native Messaging broker, and an independently managed Rust scanner daemon. The assessed daemon is
also shipped as a zero-window Tauri v2 executable. Chrome can exit while that daemon PID and its
private Unix listener remain alive. No file bytes are sent to a cloud service.

## Part 1 requirement coverage

| Requirement | Implemented result |
|---|---|
| WXT upload interception | A `document_start` content script synchronously captures ordinary file inputs and trusted drag/drop before page handlers run |
| Browser-to-OS bridge | The MV3 worker uses an origin-pinned Chrome Native Messaging broker; no localhost TCP or WebSocket listener exists |
| Detached Tauri listener | A zero-window Tauri v2 process owns the persistent scanner loop independently of Chrome; manual installation is managed by a systemd user service |
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
   again. The bundled fail-closed policy blocks after a bounded health-check failure instead of
   releasing unscanned bytes.

Decisions come from bytes, never extensions: [`testdata/renamed-secret.txt`](testdata/renamed-secret.txt)
still blocks, while the browser suite proves that harmless bytes renamed `private-key.pem` are
allowed.

The warning is rendered by the extension in a closed Shadow DOM. The page cannot inspect its
internal warning UI, and removing the host element cannot recover a file that was already blocked.

## Prerequisites

- Google Chrome 148+ for manual loading; Chrome for Testing or Chromium 148+ for `run-demo.sh`
- Node.js 22 or newer (`run-demo.sh` uses pnpm 10 from `PATH` or bootstraps it through `npx`)
- Rust 1.85 or newer
- A Linux systemd user session for persistent manual installation
- Tauri path only: Tauri v2 Linux packages, including `libwebkit2gtk-4.1-dev`

Chrome 148 is intentional: the extension opts into structured-clone messaging so a `Uint8Array`
can be copied from the content script to the MV3 worker without converting the file to base64 in
the page context. Native Messaging remains JSON and is base64-chunked only at that boundary.

## One-command assessed demo

The official Part 1 path uses the actual Tauri v2 daemon. On Debian-family Linux, including Kali,
install its native dependency once and run:

```bash
sudo apt-get update
sudo apt-get install -y libwebkit2gtk-4.1-dev
chmod +x run-demo.sh
./run-demo.sh --tauri-daemon
```

The launcher installs pnpm dependencies, builds the WXT extension, builds and registers the Rust
broker and zero-window Tauri daemon, serves Forge on port 4173, and opens a fresh temporary Chrome
for Testing or Chromium profile with the unpacked extension loaded. The Native Messaging manifest
registers only the small broker; the separate Tauri process owns the private listener and scan loop.
Chrome may create and terminate brokers without owning the daemon lifecycle.

The launcher discovers compatible Playwright/Puppeteer browser caches or accepts
`DEMO_CHROME_BIN=/path/to/chrome`. It cleans up its temporary daemon when the demo ends; manual
installation uses a persistent user service. For a quick dependency-light check of the identical
scanner/protocol core, use `./run-demo.sh`; that variant substitutes the standalone Rust daemon for
the assessed Tauri executable.

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
`./run-demo.sh --prepare-only --tauri-daemon`.

## Manual setup

For the immutable Linux v1.0.0 release, clone its tag:

```bash
git clone --branch linux-part1-v1.0.0 \
  https://github.com/0xkaushik-ai/shadow-upload-interceptor-v1.git \
  shadow-upload-interceptor
cd shadow-upload-interceptor
```

Linux development continues on `main`.

```bash
cd extension && pnpm install && pnpm build && cd ..
```

In `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select:

```text
extension/.output/chrome-mv3
```

Copy the 32-character extension ID shown by Chrome, then install the assessed Tauri daemon and its
Native Messaging broker:

```bash
chmod +x scripts/install-host.sh
./scripts/install-host.sh EXTENSION_ID_FROM_CHROME chrome tauri
```

For a dependency-light local run of the identical listener/protocol core, replace `tauri` with
`native` (or omit the last two arguments).

Restart Chrome, then serve Forge with the repository's dependency-free server:

```bash
node scripts/serve-demo.mjs dummy-page 4173
```

```text
http://localhost:4173
```

The installer registers `secureintent-shadow-host`, the short-lived broker, by writing its absolute
path plus the exact extension origin to:

```text
~/.config/google-chrome/NativeMessagingHosts/com.secureintent.shadow.json
```

Chromium uses `~/.config/chromium/NativeMessagingHosts/`. This release's supported registration
paths are Google Chrome and Chromium on Linux.

It also writes and enables
`~/.config/systemd/user/com.secureintent.shadow.service`. The service owns either
`secureintent-shadow-tauri` or `secureintent-shadow-daemon`, which listens at
`$XDG_RUNTIME_DIR/secureintent-shadow/daemon.sock`. The runtime directory is `0700`, the socket is
`0600`, and both sides verify Linux peer credentials.

The registration is written atomically with mode `0600`, pins one exact extension origin, and is
validated after installation. Diagnose or remove the complete broker/service registration with:

```bash
./scripts/doctor.sh EXTENSION_ID_FROM_CHROME
./scripts/uninstall-host.sh chrome
```

`doctor.sh` checks the manifest, broker, service, socket permissions, and service PID; then it runs
Health, Block, and Allow through three separate brokers and confirms that the daemon PID survived.
Uninstall disables/removes the service, manifest, and stale socket. Built binaries remain intact.

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

```bash
cd extension && pnpm test && pnpm compile && pnpm build
```

The real-browser suite launches a fresh Chromium profile and checks picker and trusted drag/drop
flows through Native Messaging, renamed files, closed Shadow DOM, both size-cap policies, and both
allow-on-failure and block-on-failure behavior:

```bash
cd extension
pnpm exec playwright install chromium
pnpm e2e
```

Rust tests cover every registered rule, strict framing, protocol versioning, split markers,
malformed requests, offsets, sizes, private-directory rejection, socket modes, peer credentials,
broker request filtering, and zeroizing scan ownership. The lifecycle smoke test proves that one
daemon PID survives Health, Block, and Allow brokers. TypeScript tests cover protocol validation,
policy parsing and enforcement, native-client failures and timeouts, synchronous interception,
stale responses, removed inputs, drop routing, DOM metadata minimization, and `FileList`
reconstruction. A reviewer does not need GTK or WebKit to run the default equivalent daemon core.

The last verified local run completed 29 Rust unit tests, 25 extension unit tests, and 6 real-browser
tests. The Tauri lifecycle smoke also proved that one PID survives malformed IPC and three separate
Native Messaging broker sessions.

### Detached Tauri v2 daemon

Tauri is a real independent executable, not a compile-time label on the Chrome-owned broker. It has
no window or web frontend. Tauri owns the main-thread application lifecycle while a named Rust OS
thread binds the persistent AF_UNIX listener before desktop-runtime initialization, so protection
readiness does not wait for GTK desktop services or a GUI-ready event. On
Debian-family Linux, including Kali:

```bash
sudo apt install libwebkit2gtk-4.1-dev
cargo build --release --manifest-path daemon/Cargo.toml \
  --features tauri-host --bin secureintent-shadow-tauri --bin secureintent-shadow-host
SHADOW_DAEMON_BINARY=daemon/target/release/secureintent-shadow-tauri \
  SHADOW_HOST_BINARY=daemon/target/release/secureintent-shadow-host \
  node scripts/smoke-detached.mjs
./run-demo.sh --tauri-daemon
```

The ordinary `./run-demo.sh` intentionally remains dependency-light. CI separately builds the
Tauri executable and runs both lifecycle smoke tests and the full Chromium suite under a virtual
display. In both variants Chrome launches only `secureintent-shadow-host`; disconnecting it never
terminates the daemon. Persistent installation is owned by the systemd user service. No tray or UI
is needed for Part 1.

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

- Google Chrome 148+ on Linux is the supported demo platform.
- One file is scanned per picker/drop interaction.
- Files larger than the configured bound are allowed or blocked according to policy; they are never
  sent to the broker or daemon.
- The demo registry scans byte content for PEM RSA, PKCS#8, OpenSSH private-key markers, and
  access-key-shaped `AKIA`/`ASIA` identifiers. It is intentionally not a production entropy/parser
  engine.
- The page is a local prop. No ChatGPT, Claude, SaaS, cloud, account, or telemetry integration exists.
- The detached Tauri daemon is Linux-only in this slice and has no window, tray, updater, settings,
  capabilities, or frontend.
- The repository builds a Tauri executable and installs it as a user service; signed Tauri bundles,
  Chrome Web Store packaging, managed deployment, and automatic updates are later product phases.

## Two-minute Loom shot list

**0:00–0:15 — The promise.** Show Forge and say: “SecureIntent inspects the transfer boundary,
locally. The destination receives an allowed file or nothing.”

**0:15–0:35 — Allow.** Drop `allow.txt`. Point to **Scanning locally…**, then the attached filename
and size. Explain that a new `FileList` proves the original page flow resumed.

**0:35–1:00 — Block.** Drop `block.pem`. Show the closed-shadow warning and Forge's
**Blocked — not sent** state. Open Network briefly: no cloud scan occurred.

**1:00–1:25 — The bridge.** Show the broker manifest's pinned `allowed_origins`, the active systemd
service/PID, the `0600` Unix socket, then `scan.rs` and the zeroizing session allocation.

**1:25–1:45 — Limits and lifecycle.** Drop `oversized-8mb.txt` to show fail-closed size handling,
then show `node scripts/smoke-detached.mjs` reporting that one daemon PID survived three broker exits.

**1:45–2:00 — Evidence.** Run `cargo test` and close with: “Raw bytes stay local; the daemon returns
only Block or Allow.”

See [ARCHITECTURE.md](ARCHITECTURE.md) for protocol and threat-model details and
[PART2-STRATEGIC-BRIEF.md](PART2-STRATEGIC-BRIEF.md) for the 12-month enterprise direction.
