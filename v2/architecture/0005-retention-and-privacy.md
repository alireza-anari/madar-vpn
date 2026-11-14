# Madar V2 data minimization and safety controls

The staging Worker stores only minimal Telegram events. Message payloads are
trimmed, order purchases do not proceed without a real verified node, and
customer-specific credentials remain encrypted at rest.

## Staging retention implemented

- Consumed/failed Telegram inbox events: 14 days maximum for completed/dead
  states, then purged by daily scheduled processing (current cron cadence is
  one minute; thresholds measured from creation).
- Sent/dead outbound Telegram messages and notifications: 30 days.
- Nonces for signed node requests: 10 minutes.
- Support-message bodies for tickets closed for 90 days: removed.
- Financial records, orders, receipts, route allocations, subscriptions and
  audit events are **not automatically deleted** because renewal, reconciliation
  and accounting retention require a separate, legally reviewed schedule.
- No raw VPN traffic, browsing histories, passwords, or private Xray keys
  are collected by these application tables.

## Security constraints

- No customer payment or configuration issuance while \`SHOP_ENABLED\`,
  \`PROVISIONING_ENABLED\` and \`SUBSCRIPTION_API_ENABLED\` are disabled.
- Owner-only node creation and plan changes; signed node polls; fail-closed
  route selection; no accepted signature or server heartbeat counts as
  carrier connectivity.
- Staging and production must have different Telegram bots, secrets, DBs
  and node signing keys.
- Customer support should not ask for payment passwords, sensitive personal
  data, or secret connection keys.
- A privacy notice and lawful retention schedule are required before
  commercial launch in each target jurisdiction.
