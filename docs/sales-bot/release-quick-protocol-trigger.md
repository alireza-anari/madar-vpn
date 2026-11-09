# Madar: approve guarded, Worker-only three-step config test UI

This trigger is **only** for the already-tested app code in GitHub commit
`09f044984d946262ddcff8483615654d48447e42` and branch
`feat/bot-quick-config-protocol-chooser-20261109`.

Deploy only Cloudflare Worker `madar-sales-bot` after CI, preserving
production D1, secrets, minute cron, store, subscriptions and existing sales
workflow. The expected previous Worker version is
`d34eb9ec-2b55-4c1c-b87c-53e219359e97`; abort on any mismatch.

Admin UI becomes:
**➕ صدور کانفیگ → انتخاب سرور → VLESS/REALITY or VMess/WSS →
📥 دریافت کانفیگ**.
A one-tap test is 1 GB/30 min and is managed by the existing quota-v2
per-account backend. Missing live ws-metered capability explicitly refuses
WSS issuance; never substitute the REALITY config for WSS.
Ordinary paid-sale workflow stays accessible as **💼 صدور فروش**.

No customer node, AWS EC2, Caddy listener, DNS setting, or Loomera site
will be changed by this Worker-only deployment.
