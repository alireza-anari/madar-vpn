# Phase 8 — real v2rayNG acceptance

Date: 2026-10-11  
Status: **PASS**

This is the completed acceptance record for Phase 8 Task 28. The detailed field evidence is in `docs/test-reports/phase-8.md`.

## Scope boundary

Phase 8 proves the user subscription contract against real v2rayNG plus the already-proven VLESS+REALITY/active-second data plane. It does **not** prove production email delivery, Premium single-active-client/device enforcement, multi-node operation, final speed-cap field acceptance, real ad/payment/push providers, or Production Ready.

The field run used the real auth request/consume path and PostgreSQL stores with a controlled sender because the production email provider is still unconfigured. No pre-verified user, session, initial-credit event, client UUID, or subscription token was directly created to manufacture acceptance.

## Secret/evidence rules

No magic-link token, session cookie, CSRF token, subscription token/URL, client UUID, node credential, REALITY private key, or raw per-client StatsService output may be committed as evidence. The repository fixture uses sanitized test-only values.

## Tested field head

Exact real-device/API SHA:

`5f82a12a28fdadb38acb750dabbc0f96e977c7e4`

Full CI: `38087073156` — **SUCCESS**.

Client: official v2rayNG `2.2.6` ARM64 on Samsung Galaxy A16 / Android 16.

## Acceptance sequence

### A — brand-new verified account and one-time Free grant

- [x] Requested a magic link for a brand-new field-test email through the real auth service with a controlled sender.
- [x] Consumed the one-time token through the real auth API/store path; replay was rejected.
- [x] `/api/account` showed exactly `1800` Free seconds before VPN traffic.
- [x] Re-reading the account did not create a second grant; exactly one initial ledger event existed.
- [x] No claim of production email-provider delivery was made.

### B — real subscription URL and v2rayNG import

- [x] Real node was healthy/ready and had ACKed the current user policy revision.
- [x] Subscription URL was issued through the authenticated CSRF-protected account API.
- [x] Bearer endpoint returned `Cache-Control: no-store` without storing the token as evidence.
- [x] The real subscription URL was imported into official v2rayNG 2.2.6.
- [x] Refresh succeeded and produced the Madar node entry without forbidden internal fields.

### C — real connect and active-second debit

- [x] Connected through the imported v2rayNG profile rather than a hand-built VLESS config.
- [x] Ordinary public traffic traversed the Madar VPS.
- [x] Bounded traffic produced authoritative telemetry/debit evidence.
- [x] Free decreased only by trusted server-observed active UTC seconds; duplicate telemetry added zero debit.

### D — idle through the imported v2rayNG connection

- [x] Kept the imported connection established while workload-isolated and idle after handshake traffic settled.
- [x] Measured idle interval produced no additional active bits and no additional Free debit.

### E — Client ID rotation with stable subscription URL

- [x] Called `POST /api/account/access/client-id/rotate` as the authenticated user with current CSRF.
- [x] Response exposed only policy revision/version metadata and audit metadata contained no UUID.
- [x] Subscription URL remained unchanged.
- [x] Before the new revision ACK, the node was withheld from the subscription.
- [x] After ACK, the old imported config no longer passed traffic.
- [x] Refreshing the same subscription fetched the new config and restored traffic.
- [x] One-way fingerprints proved the credential changed without recording raw UUIDs.

### F — Subscription URL rotation without Client ID rotation

- [x] Recorded a one-way fingerprint of the current working client credential identity.
- [x] Rotated the subscription URL through the authenticated account API.
- [x] Previous URL immediately returned a non-disclosing `404`.
- [x] New URL refreshed successfully in v2rayNG and yielded the working node.
- [x] Client credential fingerprint remained unchanged across URL rotation.
- [x] Connection through the refreshed subscription continued to work.

### G — renderer compatibility freeze

- [x] Froze a sanitized deterministic fixture at `tests/fixtures/v2rayng-2.2.6-reality-tcp.json` only after A–F passed.
- [x] Added exact renderer/parser shape regression at `apps/api/src/access/v2rayng-compatibility.test.ts`.
- [x] Fixture contains only test-only `.test` hosts, dummy UUID/key/short ID, and a non-secret label.
- [x] Regression freezes the accepted VLESS/TCP/REALITY shape and exact query parameter names/order: `encryption`, `security`, `sni`, `fp`, `pbk`, `sid`, `type`, `flow`.
- [x] TDD RED: commit `9bf42117619ae9f1429e5ba8d9fd60c5d8edcd39`, CI `38117632514` failed exactly because the fixture was intentionally absent.
- [x] GREEN: commit `2cd84c1f0e00692e3c242a1923796cc89620f216`, full CI `38117746970` **SUCCESS**.

### H — cleanup

- [x] Exported test subscription/config material was removed from device/operator scratch paths.
- [x] Temporary sender/harness, bridge and tunnel material were removed.
- [x] End state had zero pending telemetry/activity and zero unexplained `unmapped` reports from this run.
- [x] Field credential/token/session access was revoked and cached client config could no longer pass traffic.
- [x] Historical journals were preserved and the VPS was retained.

## Accounting result

Free balance: **1800 → 1408**.  
Authoritative active-second debit: **392 seconds**.  
Duplicate billed bits: **0**.  
Unexplained `unmapped`: **0**.

## PASS rule

The Phase 8 gate requires real v2rayNG acceptance for A–F and H, followed by the sanitized compatibility fixture/regression in G with full green CI. Those conditions are satisfied.

Phase 8: **PASS**.  
Phase 9: **not started**.  
Production Ready: **not claimed**.
