# Telegram activation — 2026-10-15

- Owner entered BOT_TOKEN directly as a Cloudflare Secret; its value was not read or printed.
- Admin allowlist configured and verified for the Telegram ID explicitly supplied by the owner.
- TELEGRAM_WEBHOOK_SECRET was generated cryptographically and stored as a separate Secret.
- Temporary scheduled activation ran inside the existing Worker so BOT_TOKEN stayed inside Cloudflare. Telegram getMe confirmed bot username Madar_vpn_bot; setWebhook succeeded; getWebhookInfo verified the exact Worker /webhook URL and zero pending updates at activation.
- Temporary activation module was removed by restoring the canonical source bundle. Active version a0ac6d42-2f3b-4f5d-867a-d191ffdc3ee4, deployment 8853726c-af0c-48ef-87a4-70cdc5b2720d, traffic 100 percent. Admin, D1 and both secrets were preserved. HTTPS health returned prepared / telegram configured.
- Existing source checkpoint 6995385565f0fd941eb729bfcf54fc2e99ed53e4 full CI 38685519987 succeeded; bot CI 38685519986 succeeded.
- Real /start admin-menu witness is still pending. Runner host, encryption key, Runner/policy secrets, actual Ubuntu installation and customer VPN acceptance remain pending. No prior VPS or website runtime was changed.

The activation result stored in D1 settings contains only safe status, bot username, pending-update count and timestamp. No bot token, webhook secret, SSH credentials, UUID or subscription URL is included in evidence.
