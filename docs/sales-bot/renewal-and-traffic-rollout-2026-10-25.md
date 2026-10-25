# Madar customer renewal and extra traffic: guarded rollout

## Scope

Customer buys duration-only, traffic-only, or a complete renewal (when both have expired) inside the native Telegram bot. The buyer pays via the configured bank-transfer instructions and sends a Telegram photo/document receipt. A human admin independently verifies the actual bank transfer, then approves. The original managed-account ID, UUID, node, usage epoch and cumulative usage are preserved: **no second config/slot is created**.

Pricing reuses the published, active customer plans as paid packages. For the same plan price, a renewal adds only its listed duration; a traffic purchase adds only its listed GB; a complete renewal adds both. Package and price are shown before any transfer, and all snapshots remain immutable. No automatic bank settlement or payment-gateway integration.

## Capacity and lifecycle

The upgrade record has states `awaiting_receipt` -> `pending_review` -> `approving` -> `applied` (or `rejected`). The D1 partial unique index prevents multiple open upgrade invoices for one customer. Admin approval uses one capacity-guarded conditional update of the **existing** account, atomically checking all other commitments and finalized usage on the node, its slot limit, seller slot and GB limits, node health, max total quota and valid account status. It marks the account `preparing`, clears `activation_revision`, and inserts an audit event transactionally with the upgrade applied state. Telegram retries cannot increment usage/duration twice.

The existing `buildQuotaPolicy` and `ackQuotaPolicy` distribute the new quota and expiry to the real node; only after a healthy ACK with exactly matching `accountId`, UUID, quota and `validUntil` does the scheduled Worker send the activation confirmation. Until ACK, the buyer can see `در حال آماده‌سازی`, not a ready config.

Paying does **not** reserve future capacity. Admin rechecks all node/seller caps on approval. If a previously purchased paid upgrade cannot be fulfilled, the request remains `pending_review` and a human admin must resolve an alternative/refund; never approve an account beyond caps.

## Schema

New migration: `apps/sales-bot/migrations/0017-customer-upgrades.sql`.

- `managed_accounts.last_customer_upgrade_id` idempotency marker.
- `customer_upgrades` records immutable price and duration/volume deltas, buyer, original account, state, and delivery notification.
- `customer_upgrade_receipts` stores actual Telegram photo/document file IDs.
- A unique partial index limits outstanding upgrade purchases.

## Production gating

1. Confirm CI passes on the exact feature branch head.
2. Read the Cloudflare D1 production ledger and verify migration 0016, plus absence of 0017 before adding anything.
3. Apply only the statements from migration 0017 to D1 production; verify the expected tables, indexes and column exist. Register `id=17,name='0017-customer-upgrades.sql'` in `d1_migrations` **only after every statement succeeds**.
4. Record read-only baseline counts for managed accounts and customer orders and verify they are unchanged after migration. Do not touch nodes or server deployments.
5. Merge exactly green source, update the guarded Cloudflare workflow's reviewed source SHA and existing Worker version. Its preflight now explicitly requires the 0017 ledger and idempotency column. Wrangler deployment must retain `keep_vars=true`.
6. Verify HTTP /health, /customer, /app, /api/customer/upgrades (unsigned returns 403), Cloudflare bindings/secret names, Cron and production D1 ledger after deploy.
7. Field-test Telegram using a known test customer with an active account: navigate renewal menu, inspect price, then stop before transfer. Only a genuine bank transfer with admin approval can exercise the full payment/ACK path on production.

## Safety and rollback

- A Worker rollback never reverses a D1 migration; 0017 is additive and old Worker versions ignore these tables/column.
- Preserve all existing variables/secrets, 1-minute cron, seller controls, AWS Node1 and other VPS configurations.
- If a paid order cannot fit caps, do not silently retry provisioning or create a new account; retain its review state until a person resolves payment/refund.
- Legacy original customer orders and their existing receipt/review/delivery paths remain unchanged.
