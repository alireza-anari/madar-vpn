# Madar V2 — dual-REALITY backend parity / release evidence

## Scope
This branch changes backend, runner, node agent, D1 migrations, and automated
tests only. **No approved Telegram bot UI/UX/menus, Android UI, or V1 source files
are changed.** The implementation builds on the V1 seller/managed-node model,
with REALITY TCP 443 (MCI) + 8443 (Irancell), sharing ONE customer UUID, ONE quota,
and ONE expiration across the two ports.

## Automated fresh-node provisioning

1. The existing verified V2 enrollment WebApp/Runner keeps SSH credentials
   transient and confirms the SSH host fingerprint. It stages the pinned Xray
   release on an isolated fresh VPS, first 8443 then also 443, preserving the
   original test credential. Installed does not mean field-ready.
2. With NODE_RUNTIME_AUTO_ENABLED=true **on a separately tested staging Worker**,
   the already-authenticated runner requests a short-lived, installation-lease-
   bound node-specific HKDF key; the Worker master key is never transported.
   A host-key-pinned SSH package transfers that key and reviewed Python modules,
   installs the isolated madar-v2-runtime.service and its independent quota
   watchdog timer. This does NOT touch V1's Xray, agent, DB, UI, or services.
3. The runtime receives signed desired-state manifests and customer policies.
   A short-lived policy is bound to node ID, revision and HMAC. It compiles a
   REALITY Xray config with the *same customer UUID* on 443 and 8443 and a
   loopback-only StatsService on 127.0.0.1:10085. Xray's pinned binary validates
   the replacement; guarded atomic apply + service restart/rollback are reused.
4. The runtime only sends the signed per-customer /clients/ack after the
   per-customer config has been applied and listeners and local stats API pass
   checks. Until then a pending commercial subscription is not activated.
5. A local SQLite ledger observes Xray's per-user counters every ~1 second,
   retains cumulative totals across a managed process generation, and enforces
   quota and expiry locally by removing exhausted users. A separate signed
   usage report is sent to Worker D1 at the slower policy sync cadence (~30s).
   D1 rejects regressed usage and clamps customer-visible used_bytes to quota.
   The node watchdog stops the isolated Xray on an orphaned/expired signed
   policy lease (approx 120s); it does not affect V1.
6. Expired/exhausted subscriptions are removed from active entitlements. Their
   node allocation is released only after the signed node confirms removal.
7. Customer trial issuance creates a distinct UUID plus 1 GiB/one-hour quota
   for each Telegram account; one lifetime trial per Telegram ID remains.
   The customer subscription link is withheld until its own UUID has been
   installed on the two listeners. The admin's original test UUID is separate.

## Independent network acceptance remains a prerequisite

Both MCI (TCP443) and Irancell (TCP8443) must be proven through real
**authenticated bidirectional mobile-carrier traffic** by an independent
controlled field harness using HMAC-signed field observations. Listener checks,
VPS-side TCP probes, unit tests, and a runner reporting installed are NOT proof
of connectivity on a mobile network. First acceptance is stored durably.
Subsequent signed node health reports renew *technical runtime freshness*
only when the approved carrier evidence still matches the same configuration
revision and both published variants remain valid. First acceptance persists;
administrators are not required to retest SIMs for every subscription or every
24 hours. However a fresh on-VPS health report is **not** an independent proof
that either mobile operator is currently reachable; periodic external network
monitoring is a separate operational release gate. Any configuration revision
change invalidates the prior carrier approval.
Neither the VPS runtime nor the Worker can independently identify what SIM was
used without the external field harness.

The field observations must be made externally from real mobile networks.
This branch does not claim such observations were performed.

## Verification and release boundary

- GitHub isolated control-plane and pinned-Xray disposable-host systemd tests
  cover HMAC authorization/replay, unique user provisioning, monotonic usage,
  quota caps, expiry, protected credentials, dual ports, and live systemd
  installation. Check the **latest PR head** CI before promotion.
- GitHub CI has no physical customer VPS, real carrier SIM or direct commercial
  traffic. CI cannot establish carrier compatibility, billing accuracy during
  crashes/restarts, or all edge cases of single-device concurrent use.
- A production release still requires installing this exact commit on a
  **disposable externally reachable** staging VPS, real VLESS tunnel samples
  on both mobile operators, measuring data limits & expiry under active
  traffic, restart/rollback, link revocation, user removal, and field evidence.
- Restrict NODE_RUNTIME_AUTO_ENABLED, FIELD_PROBE_ENABLED,
  PROVISIONING_ENABLED, SHOP_ENABLED, and SUBSCRIPTION_LINKS_ENABLED to
  staging until the live acceptance matrix passes. Never turn these on in
  production solely because GitHub CI passes.
- Single-device concurrency enforcement is not demonstrated by the two
  shared-quota routes; a stricter device-binding policy needs its own live
  validation. Do not advertise it as guaranteed.

The patch is **Draft / not deployed**, intentionally. It adds migrations only
to the *separate isolated V2 D1* database. Never apply these to V1 production.
