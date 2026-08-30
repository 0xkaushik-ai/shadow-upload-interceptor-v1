# From Individual Pro to Enterprise Teams: a 12-month technical direction

SecureIntent should become a destination firewall, not another employee-surveillance agent. That
distinction is both our architectural constraint and our market advantage: we inspect data only at
the moment a developer intentionally transfers it toward a governed destination, make the decision
locally, and retain no raw content.

## 1. BYOD: protect the work boundary, not the person

On a personal machine, “scan everything” is unacceptable. The daemon should never crawl folders,
capture global keystrokes, inspect password managers, proxy banking traffic, or build browsing
history. The browser extension and explicit IDE integrations identify a narrow event: a paste or
file is leaving for an organization-governed AI/code destination. Only that transfer is presented
to the local Rust engine; unrelated personal activity never enters our process.

Work policy must be visible. Developers should see which destinations and rule categories their
organization manages, why a transfer was blocked, when policy last updated, and whether protection
is healthy. Corporate and personal browser profiles provide an additional scope boundary, while an
emergency bypass can be policy-controlled, time-bounded, and visible to the developer. Enforcement
returns a decision and rule identifier—not the secret, file, path, prompt, or surrounding source.
This model treats the engineer as the asset: explain the risk at the moment of action, preserve the
safe path, and avoid ambient monitoring.

## 2. Decentralized policy without a permanent cloud connection

Enterprise control should be broadcast configuration with local evaluation. The control plane
publishes canonical, versioned rule bundles containing destination scope, detector bytecode/data,
severity, expiry, rollout channel, and emergency controls. Every bundle is signed with an offline
root-backed Ed25519 key. The daemon verifies the signature, schema, organization binding, expiry,
and monotonic version before atomically replacing its last-known-good policy. A two-hour jittered
poll, browser/daemon startup check, and explicit admin refresh are enough; enforcement does not need
a live socket to SecureIntent.

For 1,000 developers, staged channels—canary, 10%, 50%, general—limit false-positive blast radius.
The daemon compiles rules once, evaluates offline, retains the previous valid bundle for rollback,
and honors a separately signed kill switch. If the network disappears, last-known-good policy keeps
working until its declared grace period. If verification fails, the candidate bundle is rejected
without weakening the active one.

Telemetry is an append-only queue of privacy-minimized outcomes: anonymous installation identifier,
policy version, rule ID, destination category, decision, coarse file-size bucket, latency, and
daemon health. It never includes raw bytes, filenames, paths, matched substrings, prompts, or source
context. Optional deduplication can use a per-install salted fingerprint under explicit enterprise
policy, but content-derived telemetry is off by default. Events batch opportunistically with bounded
disk size, encryption at rest, backoff, and deletion after acknowledgement. The cloud aggregates
posture and rule effectiveness; it cannot reconstruct developer work.

The 12-month sequence is: harden the local policy runtime and signed updates; add managed enrollment
and profile-scoped destination policy; ship staged rollout and privacy-preserving health metrics;
then expose CISO controls and aggregate reporting. The dashboard is last because trustworthy local
enforcement—not a graph—is the product.

## 3. Why local-first DLP now

The modern leak path sits inside approved SaaS: a prompt box, file picker, coding agent, or support
chat already allowed through the network perimeter. Developers paste credentials and upload logs to
move quickly, while generative systems make those transfers routine. Domain blocking cannot
distinguish a harmless question from a production kubeconfig, and routing proprietary data through
a DLP vendor merely creates another copy of the material we promised to protect.

Legacy cloud DLP also taxes the developer with latency, opaque blocks, broad surveillance, and
workflows they learn to evade. A local-first engine sees the relevant bytes at the last responsible
moment, works offline, returns an immediate explainable decision, and lets safe work continue. That
is the rare architecture a CISO can mandate and an engineer will choose to leave enabled. Our moat
is not collecting more company data; it is making useful security decisions without ever needing
to possess it.
