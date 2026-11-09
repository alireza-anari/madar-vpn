# Release trigger: bot support for isolated public-IP VMess/WSS tests

This trigger is approved only for Cloudflare Worker madar-sales-bot.
Verified app/Runner sources at commit d72ed56741b4e2c4effcb9193d29a0b9492b8c4c
must remain unmodified. Verify the active baseline Worker is exactly
9ba5a3a9-1804-45dd-b1dc-867f38a06053 at 100% before deploying.
Preserve D1 identity, all secrets, cron, customer routes and current sales.

The Worker release merely teaches the bot to register validated fresh
Runner public-IP TLS 2087 endpoints and deliver account-scoped VMess/WSS
config only after real quota-v2 ws-metered ACK.

No server Agent/Runner is updated here. The separate provisioning
Runner host must still be upgraded using its checksum-pinned bootstrap,
and the VPS must be freshly enrolled. Existing registered nodes and
Loomera must be untouched. The 6-day certificate currently has no
automated renewal/reload integration and should be used only for
short-term field tests, never commercial customers.
