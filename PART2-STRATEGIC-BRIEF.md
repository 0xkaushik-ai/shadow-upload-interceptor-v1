# From Individual Pro to Enterprise Teams

SecureIntent inspects only when work leaves toward a governed destination, decides on-device, and
sends the cloud configuration and counts — never the work. Individual Pro is a firewall a developer
will leave on. Enterprise is the same engine with org destinations, signed rules, and fleet posture.

## 1. BYOD: missing capability, not a privacy policy

A personal laptop is usually one browser; separate work and personal profiles are extra defense,
not the privacy boundary. Bank passwords stay private because they never become scanner input.

The extension is injected only on an org destination allowlist (Claude, ChatGPT, Cursor, internal
AI). A bank tab does not get a content script, so it cannot capture or forward anything. The daemon
has no disk crawl, keylogger, TLS intercept, or “scan this tab” API. Only the pinned extension can
ask Chrome to launch the Native Messaging broker; the daemon accepts strictly validated frames over
a private same-user socket. It returns a decision and rule identifier — never content, paths, or
prompts.

Developers see which destinations are governed, why a transfer was blocked, and that personal
browsing is out of scope. Emergency bypasses are time-bounded, policy-controlled, and visible.

## 2. Policy in Rust, console in React, no live socket

React is the CISO console: destinations, rules, rollout, posture. Rust on the laptop is the
offline evaluator. The cloud stores signed configuration, not files.

At startup, on a jittered poll, or on explicit refresh, the daemon pulls a versioned bundle, verifies
its organization binding, signature, and monotonic version, then activates it atomically. Offline,
or after failed verification, last-known-good stays active. Enforcement never needs a live cloud
connection.

Year-one custom signatures are org-supplied literals, regexes, and fingerprints of internal marks,
evaluated on-device. Source is never uploaded for matching. Sandboxed richer detectors come after
the seed architecture.

For 1,000 seats, bundles roll canary → 10% → 50% → all. A bad rule reverts to last-known-good. A
separately signed kill switch can disable one rule without a full republish. If last-known-good
expires, we fail closed only on governed destinations.

Telemetry is queued locally, flushed when online, and deleted after acknowledgement: anonymous
install ID, policy version, rule ID, destination category, decision, size bucket, latency, and
daemon health. Never bytes, filenames, paths, matched text, prompts, user identity, or content
hashes. The console can report adoption and rule counts but cannot reconstruct the work.

## 3. Why local-first, right now

Today’s leak is often a file drop into an AI tool the firewall already allows. Assistants have made
pasting production context routine.

Network DLP is blind inside HTTPS to an approved vendor. Cloud DLP must take a copy to inspect it,
creating another store of the crown jewels. Domain blocks cannot distinguish “parse this error”
from a kubeconfig.

Local-first is the design a CISO can mandate and a developer will leave enabled: inspect at the last
responsible moment, keep content on-device, explain the block, and let safe work through. Legacy DLP
is either blind to shadow AI or hostile to the people doing the work.

## 12 months: the bridge is enrollment, not a second product

Pro users who join an org keep the same daemon. They start receiving org destinations and org rules.

- **Q1 — Pro, enterprise-shaped.** Harden the local slice, signed installers, and destination
  allowlists. No cloud content.
- **Q2 — Join.** Corp-owned fleets: MDM / managed extension policy. BYOD: explicit join code with
  visible scope. Signed rule pull and last-known-good; enrollment never widens machine-wide hooks.
- **Q3 — Control, still local.** CISO console publishes custom rule bundles. Windows daemon.
  100-seat pilot. Telemetry is health, version, and decision counts.
- **Q4 — Phase 3 without a content lake.** SSO/RBAC, staged 1,000, posture view. Seed enterprise is
  control of policy and fleet, not content collection.
