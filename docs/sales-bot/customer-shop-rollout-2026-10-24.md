# Customer self-service shop rollout (2026-10-24)

**Status:** draft feature; no deployment permitted until tests, migration and field acceptance are green.

## Scope and isolation

Customer storefront `/customer` is separate from the reseller/admin `/app` and the legacy `entitlements` sales mode. The new checkout provisions quota-v2 `managed_accounts` ONLY after receipt and an administrator's approval. The Telegram customer must enter via the bot's Web App button, because the API validates signed Telegram initData. Customer purchases use the currently configured `settings.app_mode='reseller'` and a ready quota-v2 node.

## Pre-deploy gates

1. Confirm exact PR head, all GitHub Actions checks, and production Worker version/source before rollout. Do not deploy from stale base or merge conflicting WIP development branches.
2. Check backup/recovery of Cloudflare D1; verify all existing migrations on production. Apply the **additive** `0016-customer-checkout.sql` migration to **D1** (after existing 0012/0013; ensure any 0014/0015 pending changes are assessed and that numbering is unambiguous). Verify `plans.quota_bytes`, `customer_orders`, `customer_receipts`.
3. Set public base URL and Telegram Web App secure URL to the same existing bot Worker host. No new secrets are required; retain existing Cloudflare settings, `keep_vars`, configured secrets, D1 binding and minute cron.
4. In `/customer` for an admin, configure verified bank transfer instructions and at least one explicit finite quota plan. Old plans with NULL quota must remain unavailable to shop customers.
5. Confirm capacity-safe eligible quota-v2 sales node with healthy ACK and a **real** free account and byte allocation.
6. Check a customer signed Mini App login, plan cards, node selection, checkout idempotency, exact price/volume snapshot, persistence of transfer details, and account-scoped orders.
7. Send a **real Telegram photo/document receipt**, check it reaches the admin and cannot be submitted for another customer's order. Ensure only the verified administrator can approve.
8. Verify that approval **does not exceed** node account/byte limits, that repeated approval creates exactly one account, and a bad/stale-capacity approval remains pending until manually resolved (e.g. refund or reschedule).
9. After actual quota-v2 ACK, verify private VLESS config and usage link are available only to the purchasing Telegram user. Test expired/blocked/revoked/unhealthy node fail closed.
10. Check legacy seller invitation link, owner-only seller configs, existing admin bot and Web App, cron schedules, Node1 connectivity, health and rollback.

## Payment/fulfillment limitations

This is **manual bank transfer**, not a verified payment gateway. Never mark an order paid automatically or take an arbitrary user-supplied receipt as proof; independently verify bank settlement first. Checkout only previews available node capacity; it does **not** reserve inventory until payment approval. A paid order can encounter insufficient capacity and must be handled manually by admin with communication and refund/resolution. Never promise immediate issue before active node ACK.

## Rollback

Stop newly initiated customer checkout by disabling the newly-created plans, revert to the previous verified Worker source/version while keeping Cloudflare vars/secrets and cron intact. Preserve D1 order, receipt and plan data for accounting and refunds; do not drop migration tables or reset quotas. Never modify AWS Node1 or other sales hosts as part of this UI/Worker-only rollout.
