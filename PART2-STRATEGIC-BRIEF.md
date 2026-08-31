# From Individual Pro to Enterprise Teams

SecureIntent inspects only the moment work is leaving toward a governed destination, decides on
the device, and sends the cloud configuration and counts — never the work. Individual Pro is that
firewall a developer will leave on. Enterprise is the same engine with an org allowlist, signed
rules, and fleet posture. We do not insert a content cloud in between.

## 1. BYOD: missing capability, not a privacy policy

A personal laptop is usually one browser. Separate work and personal Chrome profiles are extra
defense, not the guarantee. Bank passwords stay private because they never become an input.

The extension is injected only on an org destination allowlist (Claude, ChatGPT, Cursor, internal
AI). A bank tab does not get a content script, so it cannot capture or forward anything. The daemon
has no disk crawl, keylogger, TLS intercept, or “scan this tab” API. It accepts a buffer only from
the pinned Native Messaging host, and only for paste or file-upload events the extension already
scoped. It returns a decision and a rule identifier — not the secret, file, path, or prompt.

Developers see which destinations are governed, why a transfer was blocked, and that personal
browsing is out of scope. Any emergency bypass is time-bounded, policy-controlled, and visible.

## 2. Policy in Rust, console in React, no live socket

React is the CISO console: destinations, rules, rollout, posture. Rust on the laptop is the
offline evaluator. The cloud stores signed configuration, not files.

When the machine has network — startup, a jittered poll, or an explicit refresh — the daemon pulls
a versioned bundle, checks organization binding, signature, and monotonic version, then activates
it atomically. Offline, or if a candidate fails verification, last-known-good stays in force.
Enforcement does not need our servers.

Year-one custom “proprietary signatures” are the same shape as today’s mock registry: org-supplied
literals, regexes, and fingerprints of internal marks, evaluated on-device. We do not upload source
to match it in the cloud. Sandboxed richer detectors are a post-pilot increment, not the seed
architecture.

For 1,000 seats, bundles roll canary → 10% → 50% → all. A bad rule reverts to last-known-good. A
separately signed kill switch can disable one rule without a full republish. If last-known-good
passes its declared expiry, we fail closed on governed destinations only — not on the rest of the
personal machine.

Telemetry is a local queue, flushed when online, deleted after ack: anonymous install id, policy
version, rule id, destination category, allow/block, size bucket, latency, daemon health. Never
bytes, filenames, paths, matched text, prompts, user identity, or content hashes. The console can
say how many devices are on v12 and how often a rule fired. It cannot reconstruct the work.

## 3. Why local-first, right now

The leak is no longer a USB stick or a blocked domain. It is a file drop into an AI box the
firewall already allows — Claude, ChatGPT, Copilot, Cursor. Developers do that to move. Assistants
made pasting production context normal.

Network DLP is blind inside HTTPS to an approved vendor. Cloud DLP has to take a copy of the source
to inspect it: a second store of the crown jewels, and an engineer who will turn the agent off.
Domain blocks cannot tell “parse this error” from a kubeconfig.

Local-first is the design a CISO can mandate and a developer will leave enabled: inspect at the last
responsible moment, on the device, no vendor copy, explain the block, let safe work through. Shadow
AI is already the working path. Legacy DLP is either blind to it or hostile to the people doing the
work.

## 12 months: the bridge is enrollment, not a second product

Pro users who join an org keep the same daemon. They start receiving org destinations and org rules.

- **Q1 — Pro, enterprise-shaped.** Harden the local slice and signed installers. Destination
  allowlists even before an org exists. No cloud content.
- **Q2 — Join.** Corp-owned fleets: MDM / managed extension policy. BYOD: explicit join code with
  visible scope. Signed rule pull and last-known-good. Enrollment must not widen hooks to the whole
  machine.
- **Q3 — Control, still local.** CISO console publishes custom rule bundles. Windows daemon.
  100-seat pilot. Telemetry is health, version, and decision counts.
- **Q4 — Phase 3 without a content lake.** SSO/RBAC, staged 1,000, posture view. Seed enterprise is
  control of policy and fleet. The dashboard is last because untrusted enforcement makes graphs
  useless.
