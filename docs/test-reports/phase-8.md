# Phase 8 — real v2rayNG E2E

Date: 2026-10-11  
Status: **INCOMPLETE — repository preparation green; real v2rayNG execution pending**

## Purpose

Phase 8 freezes Madar's subscription compatibility only after a real current v2rayNG client imports the server-issued subscription, traverses the real VPS, observes correct Free active-second accounting, and survives both independent rotation flows.

The executable acceptance checklist is `tests/e2e/v2rayng-acceptance.md`.

## Repository preparation

Phase 7 is already PASS and is not reopened by this preparation.

A Phase 8 preflight found one product-boundary gap: client credential rotation existed in the domain/PostgreSQL store but had no authenticated user HTTP mutation. TDD evidence:

- RED contract commit: `72d91eeeb3d25ae297b1d30704490bdca9b98088`;
- RED CI: `38086557955` — expected failure, only because `POST /api/account/access/client-id/rotate` returned `404`;
- GREEN implementation commit: `2c842b6486e5ef1aabacb5023c766ff937165a5c`;
- GREEN CI: `38086869526` — SUCCESS.

The new mutation:

- requires the existing authenticated + CSRF mutation boundary;
- rotates through the existing transactional access service;
- increments policy revision and credential version;
- does not rotate the subscription token;
- returns only `{policyRevision, version}`;
- writes audit metadata without either old or new UUID;
- relies on existing subscription eligibility logic to withhold a node until the required new policy revision is ACKed.

No Node Agent, Xray, active-second sampler/outbox, PostgreSQL usage settlement, Premium accounting, or Phase 7 lifecycle code changed in this preparation.

## Existing automated evidence carried into the field test

Repository tests already cover:

- old subscription URL invalidation after token rotation;
- subscription token and client UUID independent state machines;
- transactional PostgreSQL client credential rotation;
- node subscription eligibility gated by per-user policy-revision ACK;
- VLESS+REALITY share-link rendering with bearer-secret `no-store` delivery;
- first verified account Free grant of exactly 1800 seconds with idempotent initial ledger key;
- account reads using authoritative entitlement state.

These tests do **not** establish v2rayNG compatibility. Renderer/parser fixtures remain intentionally unfrozen until the real client accepts the format.

## Email boundary for this phase

Production email delivery is still not configured and is not promoted to verified by Phase 8.

For the VPN compatibility field run, a controlled field sender may capture the one-time magic-link token while still exercising the real auth request/consume service and real PostgreSQL stores. The field run must not create a verified user/session/initial grant directly in SQL. The resulting evidence proves the account/auth semantics needed by the v2rayNG test, while real production email delivery stays an explicit later integration gate.

## Real field evidence

Pending. Record after execution without bearer URLs, UUIDs, cookies, CSRF values, private keys, or raw per-client StatsService output.

Required result summary:

- brand-new verified account and exactly-once 1800-second initial grant;
- real subscription import/refresh in a recorded current official v2rayNG version;
- real VPS egress through the imported profile;
- trusted active-second debit and bounded idle no-debit;
- Client ID rotation: old config denied, same URL refresh yields new working config after ACK;
- subscription URL rotation: old URL invalid immediately, new URL refresh works with unchanged client credential;
- sanitized compatibility fixture frozen only after the real pass;
- safe cleanup with no usable field credential left behind.

## Release boundary

Until the field run and post-pass fixture/CI are complete:

- Phase 8: **INCOMPLETE**;
- Phase 9: not started by this work;
- Premium single-active-client/device: still separate and unresolved;
- Production Ready: not claimed.
