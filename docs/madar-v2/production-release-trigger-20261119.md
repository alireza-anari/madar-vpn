# Madar V2 — guarded same-worker release authorization (2026-11-19)

Authorized release target only:
- Worker: `madar-v2-staging` (same existing Worker, no replacement service)
- V2 D1: `81e78af9-9740-45da-9e80-9b2d498f4f54`
- Branch: `rewrite/madar-v2-20261110`
- Source: merged PR #70, `8950eddfccbf85e7a600d2d790e90527af2622a7`
- New migration: `0030_admin_e2e_checkout_isolation.sql`, without touching customers or quota ledgers
- Previous known Worker version: `b23fa9fd-a847-424c-b3a3-60dc868d2f5b` (workflow reads the latest version at deployment time)

### Restrictions
- V1 Worker `madar-sales-bot` and V1 database are expressly out of scope.
- Keep storefront and provisioning disabled pending verified payment instructions; allow only explicit admin-issued subscriptions or already active customers.
- Preserve node-agent and Xray traffic counters, signed client ACK, per-port carrier checks, route/health freshness, anti-replay and quota limits.
- Do not fabricate client delivery or operator verification.
- Workflow logs contain no credentials; post-deploy failure rolls back V2 Worker code only.
- Existing staging name remains unchanged so the Telegram webhook, node master keys and D1 records are not disrupted.

This one-shot file change intentionally dispatches the existing guarded release workflow on the canonical branch; future pushes do not rerun this workflow unless this exact trigger path changes and the exact message guard matches.

## November 25 staging release

Publish merged PRs #73 and #75 from 0d8c316bbc37645c89c589ef31fa3ee421938b4a. Apply migration 0031 for cancelled internal test orders. The existing allocation remains reserved until the signed removal acknowledgement arrives.
