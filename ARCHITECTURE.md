# Shadow Upload Interceptor — Architecture

## One bounded transfer

```mermaid
sequenceDiagram
    actor Developer
    participant Page as Forge dummy page
    participant CS as WXT content script
    participant BG as MV3 background worker
    participant Broker as Chrome-owned Rust NM broker
    participant Daemon as Detached Tauri/Rust daemon

    CS->>BG: health-check
    BG->>Broker: health { protocol: 1 }
    Broker->>Daemon: private Unix socket frame
    Daemon->>Broker: ready { protocol: 1 }
    Broker->>BG: ready { protocol: 1 }
    Developer->>Page: choose or drop File
    CS-->>CS: trusted input capture on window; snapshot, clear and cancel synchronously
    CS-->>Page: clear input; Scanning (metadata only)
    CS->>BG: metadata-only preflight
    CS->>CS: File.arrayBuffer() → Uint8Array only after BG permits scanning
    CS->>BG: structured-clone scan request
    BG->>Broker: connectNative(com.secureintent.shadow)
    BG->>Broker: scan_begin + base64 scan_chunk × N + scan_end
    Broker->>Daemon: relay bounded frames over AF_UNIX
    Daemon-->>Daemon: validate, decode into Zeroizing buffers, scan bytes
    Daemon-->>Daemon: drop/zero owned file allocation
    Daemon->>Broker: verdict { Block | Allow, rule id }
    Broker->>BG: verdict { Block | Allow, rule id }
    BG->>CS: verdict
    alt Block
        CS-->>Page: closed Shadow DOM warning; file remains absent
    else Allow, or bridge failure allowed by policy
        CS-->>Page: rebuild FileList; dispatch synthetic change
        Page-->>Developer: filename + size received
    else Bridge failure blocked by policy
        CS-->>Page: file remains absent; generic blocked state only
        CS-->>Developer: extension warning explains scanner failure
    end
```

## Why the earliest listener is on `window`

The original transfer event is the security boundary. Capture starts at `window`, so a listener
registered by the `document_start` content script runs before target/document handlers on the dummy
page. It calls `preventDefault()` and `stopImmediatePropagation()` before any promise or file read.
For a picker event it also snapshots the `File` and clears `input.value` synchronously. The page
therefore cannot read the original `FileList` from its normal handler while the decision is pending.
The capture listener applies to ordinary `input[type="file"]` elements, including dynamically
created inputs. For drops it resolves an associated label/input or, when unambiguous, the page's
only file input. Site-specific shadow-root and custom drop-zone adapters remain outside this demo.

`dragover` is also cancelled in capture; without that, browsers commonly refuse to deliver `drop`.
The demo handles one file at a time, matching the product moment rather than hiding a partial
multi-file policy behind optimistic UI.

Forge receives a page-visible presentation state so the demo can show scanning and blocking. That
state contains only `scanning`, `allowed`, `blocked`, or `canceled`; blocked filenames, rule IDs,
failure reasons, and file content stay inside extension-owned state and the closed-shadow warning.
The destination can spoof or remove its presentation state, but enforcement never reads it back.

## Resuming a read-only `FileList`

`HTMLInputElement.files` cannot be mutated in place. On Allow, the content script creates a
`DataTransfer`, adds the retained `File`, assigns the resulting `FileList`, and dispatches a new
bubbling `change`. The extension ignores `isTrusted === false`, preventing recursion; the page
receives the event normally. Allowed drops use this same canonical input path instead of attempting
to forge a trusted `DragEvent`.

## The privilege boundary

Content scripts cannot call Native Messaging. They send a typed-byte request to the MV3 worker,
which validates the sender against the configured protected origins, metadata, declared length, and
configured bound. That bound cannot exceed the daemon's 8 MiB maximum. Chrome 148's explicit
`message_serialization: structured_clone` setting copies the `Uint8Array` between extension
contexts. It is not a zero-copy transfer.

Only the background calls `connectNative`. Chrome launches one short-lived broker process for the
port and owns its stdio pipes. Before launch, Chrome checks the caller against the native-host
manifest, which allows exactly `chrome-extension://<ID>/`; wildcards are absent and the trailing
slash is required. The broker does not scan and does not become a service. It relays only the four
recognized, bounded request frame types to the independently running daemon.

The daemon is started and restarted by a user service manager, not by Chrome. Linux uses systemd
at `$XDG_RUNTIME_DIR/secureintent-shadow/daemon.sock`; macOS uses launchd at
`~/Library/Caches/secureintent-shadow/daemon.sock`. Its directory is `0700`, its socket is `0600`,
and both peers verify same-user ownership (`SO_PEERCRED` on Linux, `getpeereid` on macOS) before
exchanging frames. Closing Chrome or any
one Native Messaging port removes only that broker connection. The daemon PID and listener remain.

For a reproducible one-command demo, the unpacked manifest contains a public development key. The
launcher derives Chrome's stable extension ID from that key and writes the matching host origin.
This public key is identity metadata, not an authentication secret; production identity comes from
a signed Web Store package or enterprise-managed deployment.

The automated launcher uses Chrome for Testing or Chromium because branded Chrome 137+ removed the
`--load-extension` command-line path. It registers the host in that browser's specific Native
Messaging directory and refuses branded Chrome rather than presenting an unprotected demo page.
Because the runner supplies a disposable `--user-data-dir`, its host manifest is written into that
profile's `NativeMessagingHosts` directory—the location Chrome actually resolves for that process.

## Native Messaging plus private local IPC, not localhost WebSockets

Native Messaging remains the browser authentication boundary and exposes no TCP listener. A web
origin cannot call the broker or daemon, and another OS user cannot enter the private runtime
directory. The AF_UNIX listener is filesystem-scoped, same-user credential checked, and never
subject to Private Network Access, CORS, firewall, proxy, or browser-store networking concerns.

Chrome frames each UTF-8 JSON message as a four-byte platform-native length followed by payload.
All supported demo targets are little-endian, the Rust broker and daemon read/write `u32le`, and
compilation is rejected on big-endian targets. The extension does not construct this frame; Chrome
does. The broker preserves that bounded frame over the socket, so there is one strict protocol
implementation in the detached daemon and no second serialization contract to drift.

Host-bound Chrome messages may be up to 64 MiB, while host-to-extension messages are limited to
approximately 1 MiB. This protocol keeps both far below those limits: each 256 KiB raw chunk becomes
about 342 KiB of base64 JSON, and the return value is a tiny verdict.

For production files far beyond this demo's bound, Native Messaging can become a control plane and
vend an expiring, single-use capability for a raw-binary socket transfer. This slice deliberately
relays the already bounded v1 JSON frames so the assessed TypeScript/Rust protocol remains directly
testable; file bytes still avoid TCP, disk, and cloud infrastructure.

## Protocol invariants

```json
{ "type": "health", "id": "uuid", "protocol": 1 }
{ "type": "scan_begin", "id": "uuid", "size": 1234, "protocol": 1 }
{ "type": "scan_chunk", "id": "uuid", "offset": 0, "data": "<base64>" }
{ "type": "scan_end", "id": "uuid" }
```

```json
{ "type": "health", "id": "uuid", "protocol": 1, "status": "ready" }
{ "type": "verdict", "id": "uuid", "decision": "block", "rule": "pem_private_key" }
```

Every request uses a strict schema; unknown fields are rejected. The daemon accepts protocol v1, one
active scan, a maximum 512 KiB JSON frame, a maximum declared file size of 8 MiB,
matching IDs, contiguous raw offsets, valid base64, no decoded overflow, and exact final length. A
violation closes that broker connection; the persistent daemon continues accepting later clients.
The worker reports an unavailable outcome and the current policy selects Allow or Block. The
verdict never includes filename, bytes, offsets, matched text, or a file-derived fingerprint.

Transport failures never masquerade as scanner verdicts. Local development policy and read-only
enterprise-managed policy independently configure unavailable and oversized-file actions, the scan
timeout, a bounded file limit, and a narrowing subset of build-time origins. Managed policy wins,
invalid candidates are rejected atomically, and the content script blocks failures until it receives
a validated policy from the background.

## Memory ownership

The broker wraps each Chrome frame in `Zeroizing<Vec<u8>>`, relays it, and drops it immediately.
The daemon independently wraps each incoming socket frame in `Zeroizing<Vec<u8>>`.
`serde_json` borrows the base64 slice directly from that frame, and decoded chunks are separately
zeroizing. On `scan_begin`, the daemon creates an exact-capacity `Zeroizing<Vec<u8>>`; this prevents
growth reallocations from leaving abandoned sensitive allocations. The complete file stays bytes,
is checked against a deterministic byte-rule registry, and is explicitly dropped before the
verdict is serialized. Filenames and extensions never influence the decision.

This guarantees scrubbing only for allocations the broker and daemon own. Chrome and V8 hold the
original `File`/`ArrayBuffer`; OS pipes, the Unix socket, and allocators may copy; base64/JSON
dependencies and crash or swap facilities are outside absolute control. The content script and
worker overwrite their owned `Uint8Array` views after each decision, but this is best effort under
garbage collection. No temporary file, mmap, content log, or cloud request is created.

## Detached Rust/Tauri lifecycle

The Rust library is exposed through three deliberately narrow executables:

- `secureintent-shadow-host` is the short-lived Native Messaging broker. Chrome owns only this
  process, from `connectNative` until the port closes.
- `secureintent-shadow-daemon` is a dependency-light listener for the default demo and CI.
- `secureintent-shadow-tauri` is the assessed zero-window Tauri v2 listener. Tauri owns the
  main-thread application lifecycle while a named Rust OS thread binds and owns the blocking
  AF_UNIX accept loop before desktop-runtime initialization. Listener readiness therefore does not
  wait for GTK desktop services or a GUI-ready event.

The two daemon entrypoints call the same `run_daemon()` library entrypoint, so IPC authorization,
protocol validation, scanning, and zeroization cannot drift. The default demo remains
dependency-light; `./run-demo.sh --tauri-daemon` and the dedicated CI job exercise the exact Tauri
path. There is no window, tray, command surface, plugin, updater, capability, or frontend.

Manual installation writes `com.secureintent.shadow.service` under the user's systemd configuration
on Linux, or `com.secureintent.shadow.plist` under `~/Library/LaunchAgents` on macOS, and enables
it at login. systemd/launchd—not Chrome—owns, restarts, and stops the daemon. This is
intentional: a service manager is safer and more observable than double-fork/self-daemonization.
Integration tests prove that three brokers can exit while one daemon PID and socket remain
available.

## Threat model

| Threat | Control | Residual risk |
|---|---|---|
| Malicious destination page | Earliest capture, synchronous clearing, isolated content world, closed Shadow DOM | The page can hide/remove the overlay host but cannot recover already-blocked bytes; a browser exploit or earlier privileged extension is out of scope |
| Page forges extension messages | Background validates sender origin and typed request; no externally-connectable API | Compromised renderer could attack its content script, so the worker trusts only bounded bytes |
| Unrelated extension calls host | Native manifest pins one extension origin | A fully compromised Chrome profile can alter local manifests |
| Local process probes scanner | Private `0700` runtime directory, `0600` AF_UNIX socket, same-user peer checks (`SO_PEERCRED` Linux, `getpeereid` macOS), no TCP | A hostile process already running as the same user can inspect memory or replace user-owned binaries/configuration |
| Oversized/malformed input | Frame, file, offset, base64 and final-size bounds | A valid 8 MiB file intentionally consumes up to the configured bound |
| Broker/daemon crash or missing install | Bounded timeout followed by configured Allow or Block; bundled and pre-policy defaults are Block | An explicitly configured fail-open development policy releases unscanned bytes and must not be mistaken for production posture |
| Memory recovery | Zeroizing owned frames, chunks and aggregate; no disk writes | Copies outside Rust ownership, swap and privileged memory inspection remain possible |

## Path into the real product

In the existing extension, this content guard would be a sibling of the paste guard and reuse its
destination selectors and closed-shadow UI primitives. The protocol/scanner library remains shared
by the Chrome-spawned broker and Tauri desktop daemon; Native Messaging remains the authenticated
browser control plane. The demo proves that seam without merging codebases or inventing desktop UI.
