# ADR 0002 — Safe V2 publication and migration

**V1 remains authoritative until explicit cutover.** Do not delete V1 Worker,
V1 D1, scheduled jobs, active accounts, or existing node processes.

## Environments

| Environment | Worker | Database | Telegram | Nodes |
| --- | --- | --- | --- | --- |
| Existing V1 production | madar-sales-bot | madar-sales-bot-db | existing bot | existing VPS |
| New V2 staging | madar-v2-staging | NEW madar-v2-staging-db | NEW staging bot | dedicated test VPS |
| Future V2 production | madar-v2-api | NEW dedicated production DB | cutover after approval | approved agents |

Every environment has separate credentials. Never point a staging Worker at
the existing sales D1. Production API tokens are confined to GitHub
environments with explicit reviewers and branch restrictions. Avoid
deploy-on-push from a feature branch.

## Gates

1. Schema tests and static security checks pass.
2. Unit and integration tests for customer, reseller, admin, billing,
   idempotent purchase, subscription, capacity, agent and outbox pass.
3. Staging smoke tests prove auth rejection, D1 binding, node onboarding,
   route verification, issuance, revocation and rollback.
4. Real-device tests on Irancell, Hamrah-e Aval, Rightel and fixed-line
   networks, at multiple times and locations. Compare raw IP reachability,
   direct Reality, domain/TLS WSS, and optional UDP separately.
5. Stage commercial data with an explicit mapping from V1 accounts to V2
   entitlements, preserving renewals, byte caps and expiry. Validate counts,
   checksums, ownership and duplicate/idempotency constraints.
6. Canary V2 accounts only, then gradual percentage cutover with measured
   success/failure and user-support readiness.
7. Freeze writes briefly for final ledger synchronization (or implement
   tested dual-write), atomically move the Telegram webhook and DNS/API
   routing, monitor; rollback webhook and API routing if gates fail.
8. Remove V1 only after a defined observation period and verified backup
   restores; do not delete existing customer access as part of an API
   rollback.

## Commands (after creating isolated V2 D1)

`cd v2/control && npm run check && npm test`.

A new `madar-v2-staging-db` was created on 2026-11-10 with UUID
`81e78af9-9740-45da-9e80-9b2d498f4f54`. The two V2 migrations were
applied only to that database via Cloudflare's D1 API and their filenames
registered in the standard `d1_migrations` table. The V1 D1 database was
neither queried for customer content nor modified. Verify this recorded
baseline before applying any future Wrangler migration.
The isolated `madar-v2-staging` Worker was deployed 2026-11-10 using only
the V2 D1 binding. Live probe succeeded, readiness returned 503 because
staging Telegram credentials have not been set. The production webhook was
not modified. Future changes must use the gated staging release pipeline;
use a **different** Telegram test bot before live chatbot testing.

## Explicit rollback criteria

Any incorrect quota issuance, unverifiable routing result, missing audit
event, production-secret leak, migration mismatch, or unexplained jump in
failed connections stops promotion. Roll back control plane without resetting
customer data; investigate from redacted metrics and signed agent results.
