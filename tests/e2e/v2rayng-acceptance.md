# Phase 8 — real v2rayNG acceptance

Date: 2026-10-11  
Status: **PREPARED — real device/VPS execution pending**

This is the acceptance procedure for Phase 8 Task 28. It must be executed with a real current v2rayNG client against the existing disposable Madar field environment. Repository/unit tests are preparation only and cannot mark Phase 8 PASS.

## Scope boundary

Phase 8 proves the user subscription contract against real v2rayNG plus the already-proven VLESS+REALITY/active-second data plane. It does **not** prove:

- production email delivery;
- Premium single-active-client/device enforcement;
- multi-node operation;
- final speed-cap field acceptance;
- real ad/payment/push providers;
- Production Ready.

The production email sender is still unconfigured. For this VPN compatibility test, a controlled field sender may capture a one-time magic-link token while using the real `createAuthService` request/consume path and real PostgreSQL stores. Direct insertion of a pre-verified user, session, initial-credit ledger entry, client UUID, or subscription token is not acceptable evidence. This proves real auth/account semantics without claiming real email delivery.

## Secret/evidence rules

Never put any of the following in Git history, chat transcripts, screenshots, or test reports:

- magic-link token;
- session cookie or CSRF token;
- subscription token/URL;
- client UUID;
- node credential;
- REALITY private key;
- raw per-client StatsService output.

Record only non-secret booleans/counts, versions, HTTP status, policy/subscription **versions**, safe timestamps, debit deltas, and one-way fingerprints when comparison is necessary. v2rayNG screenshots must crop/redact bearer URLs and UUIDs.

## Required field head

Before execution, record one exact repository SHA with full green CI. The control-plane/API used by the test must contain the authenticated Client ID rotation route introduced in Phase 8 preparation. The deployed Node Agent/Xray files may remain byte-identical to the already accepted Phase 7 runtime when no Agent code changed.

If production runtime code changes during the field test, stop, add TDD coverage, obtain full CI, deploy the new exact SHA, and repeat every affected check.

## Acceptance sequence

### A — brand-new verified account and one-time Free grant

- [ ] Request a magic link for a brand-new field-test email through the real auth service with the controlled field sender.
- [ ] Consume that one-time token through the real auth API/store path; replay is rejected.
- [ ] Read `/api/account` and prove the Tehran-day Free balance is exactly `1800` seconds before VPN traffic.
- [ ] Read the account again and prove no second initial grant is created; exactly one `initial:<userId>` ledger event exists.
- [ ] Do not claim real email-provider delivery from this controlled sender.

### B — real subscription URL and v2rayNG import

- [ ] Wait until the real node is healthy/ready and has ACKed the current user policy revision.
- [ ] Issue the user's subscription URL through the authenticated CSRF-protected account API.
- [ ] Fetch it only through the bearer subscription endpoint and confirm `Cache-Control: no-store` without recording the token.
- [ ] Import the subscription URL into a current official v2rayNG build; record exact app version/source.
- [ ] Refresh succeeds and produces the expected Madar node entry without exposing forbidden internal fields.

### C — real connect and active-second debit

- [ ] Connect using the imported v2rayNG profile, not a separately hand-built VLESS config.
- [ ] Prove ordinary public traffic traverses the Madar VPS.
- [ ] Generate a bounded transfer and record starting/ending Free balance plus safe telemetry/debit counts.
- [ ] Prove Free decreases only by the trusted server-observed active UTC seconds for that interval; retries/duplicate evidence do not add debit.

### D — idle through the imported v2rayNG connection

- [ ] Keep the imported connection established but idle for a bounded interval after handshake activity settles.
- [ ] Prove no additional active bits and no additional Free debit appear during the measured idle interval.

### E — Client ID rotation with stable subscription URL

- [ ] While the original imported config is known-working, call `POST /api/account/access/client-id/rotate` as the authenticated user with current CSRF.
- [ ] Response exposes only policy revision/version metadata; no UUID is returned or audited.
- [ ] The subscription URL remains the same.
- [ ] Before the node ACKs the new required policy revision, that node is not advertised for the rotated credential.
- [ ] After the node ACKs, direct use of the old imported config fails.
- [ ] Refresh the **same** subscription in v2rayNG; it receives the new config and traffic works again.
- [ ] Prove the new working credential fingerprint differs from the old one without recording either raw UUID.

### F — Subscription URL rotation without Client ID rotation

- [ ] Record a one-way fingerprint of the current working client credential/config identity.
- [ ] Issue/rotate the subscription URL through the authenticated account API.
- [ ] The previous URL becomes invalid immediately at the API (`404`/equivalent non-disclosing invalid-token behavior).
- [ ] The new URL refreshes successfully in v2rayNG and yields the working node.
- [ ] The client credential fingerprint remains unchanged across URL rotation.
- [ ] Connection through the refreshed subscription still works.

### G — renderer compatibility freeze

Only after A-F pass:

- [ ] Freeze a sanitized deterministic renderer fixture using test-only UUID/host/key/token values, matching the exact shape successfully consumed by the tested v2rayNG version.
- [ ] Add a parser/shape regression test for the exact query parameters required by the successful import.
- [ ] Do not put field credentials or the real subscription URL in fixtures.

### H — cleanup

- [ ] Remove exported test subscription/config material from the device/operator scratch paths.
- [ ] Ensure every temporary field sender/harness is removed.
- [ ] End with no pending telemetry/activity and no unexplained `unmapped` masked reports created by this run.
- [ ] Make the field test credential unusable on the retained VPS/control plane using the existing safe cleanup mechanism; confirm the old imported config cannot pass traffic.
- [ ] Preserve historical journals/evidence; do not destroy the VPS unless explicitly requested.

## PASS rule

Phase 8 may be marked **PASS** only when A-F and H succeed with real v2rayNG and the successful wire format is then frozen by G with full green CI.

A repository-only parser test, a hand-built Xray client, direct database seeding, or a manually constructed VLESS share link is not a substitute for this gate.

Until then: **Phase 8 INCOMPLETE. Production Ready not claimed.**
