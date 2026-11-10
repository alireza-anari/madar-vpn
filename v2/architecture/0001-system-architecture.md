# ADR 0001 — Madar V2 system architecture

**Status:** Accepted as rewrite baseline; implementation acceptance is separate.

## Non-negotiable guarantees

1. UI must never report “connected” until authenticated tunnel handshake
   **and** representative tunneled traffic both pass.
2. A configuration cannot be issued unless its route has a fresh, protocol-
   specific readiness result and both user-count and byte allocation capacity.
3. An unsuccessful deployment may not affect V1 users: independent script,
   independent D1, staging credentials and provider nodes.
4. Installation is idempotent and desired-state-driven; SSH and VPN keys never
   pass through Telegram messages or public diagnostics.
5. Detect and attribute failure at the layer that produced the evidence.
   DNS, endpoint IP, transport, TLS, WSS, proxy auth, tunnel traffic and
   Cloudflare edge are separate hypotheses.
6. Never require Cloudflare in the VPN *data plane*. HTTPS/WSS via Cloudflare
   is an optional route with a separately verified direct-origin alternative.
7. Per-customer access tokens are revocable, expiring and never reused as
   administrative or node enrollment credentials.

## Components

- **Control plane:** Worker + D1 for Telegram bot, account roles, billing
  decisions, durable command outbox, subscriptions and measured route inventory.
  Use one authoritative entitlement/quota ledger, not two unsynchronized
  databases.
- **Node plane:** isolated agent per VPS. A short-lived, authenticated,
  replay-protected command envelope installs a pinned, signed Xray release,
  verifies listeners and reads proxy/traffic counters. Each lifecycle step
  is reconciled and acknowledged. The agent must not take arbitrary shell
  commands from the public API.
- **Data plane:** authenticated direct REALITY + independent TLS/WSS
  endpoint; UDP alternatives are enabled only after live network proof.
  A second provider and ASN are needed for meaningful failure-domain diversity.
- **Android client:** native Kotlin UI + Android VpnService backed by a
  vetted and license-reviewed engine adapter; route selection uses measured
  carrier/network outcomes, avoids repeated full scans and preserves fallback.
- **Customer access:** subscription endpoint serves only entitled configs
  and can rotate node information without requiring a new purchase.
  Bot and app call shared domain services; no duplicated order rules.
- **Operations:** controlled staging and immutable release; anonymous,
  redacted health telemetry; rollback and budget-aware capacity limits.

## Trust boundaries

Telegram webhook: secret header, replay-resistant update ID uniqueness,
durable outbox; outbound Telegram delivery is at-least-once, not exactly-once.
All privileged operations require role authorization and audit trails.
Node enrollment uses distinct identities and keys per node; signed jobs
carry expiry, nonce, scope and expected revision. Never record plaintext
VPN credentials, tokens, private keys, or customer IPs in logs.

## Database invariants

D1 must enforce subscription uniqueness and node capacity, with atomic
writes and idempotency keys for sales, renewals and provisioning. The initial
migration includes capacity triggers, but product workflows and migration
tests must be built before enabling issuance.

## Cloudflare decision

Keep Worker/D1 for the *management API* because it reduces operational
burden, but do not assume it is required or healthy for all Iranian carriers.
A direct API fallback or independent hosting is a separate availability
decision, not a shortcut around unverified DNS, IP or proxy behavior.
Worker websocket proxying does not by itself make Reality, UDP, or general
TCP proxying possible.

## Reliability targets (acceptance objectives, not current results)

- No configuration issuance for quarantined or unverified routes.
- No quota overselling under concurrent requests.
- Controlled rollback of API without deleting or modifying customer data.
- Record per carrier: success rate, connect time, throughput, 10-minute
  stability and error layer. Agree a minimum acceptable threshold only after
  the first real carrier baseline.
- Never assert universal connectivity or zero defects.
