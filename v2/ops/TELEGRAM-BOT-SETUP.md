# Madar V2 Telegram bot activation and VPS provisioning

This is a **separate Telegram bot**, NOT the existing \`@Madar_vpn_bot\`!

The V2 Worker refuses to claim the legacy bot ID 8905373112 or move a
third-party webhook. \`GET /health/bot\` exposes only public Telegram bot
identity and webhook category, never the token or webhook URL.

## One-time prerequisites for a working V2 bot

1. Create a dedicated Telegram bot in \`@BotFather\`. Set its token only in
   Cloudflare > Workers > **madar-v2-staging** > secret \`BOT_TOKEN\`.
   Do not send it as a Telegram message or put it into Git/GitHub Actions.
   This must NOT be the already-installed legacy token.
2. \`ADMIN_TELEGRAM_IDS\` must contain the existing operator's numeric ID.
   This value is copied securely from the old bot; it is not a secret.
3. Staging must have a randomly generated
   \`TELEGRAM_WEBHOOK_SECRET\` (32+ characters).
4. With \`V2_BOT_AUTO_ACTIVATE=true\`, the V2 cron will verify bot identity,
   refuse legacy bot 8905373112 and any pre-existing unrelated webhook,
   and call Telegram's \`setWebhook\` **only if unset**.
5. \`/health/ready\` is green only when the V2 bot uses its own Telegram
   webhook, D1 is healthy, and an admin ID + webhook secret are configured.

## Server installation (separate privilege)

A valid Telegram bot alone cannot gain SSH access to arbitrary VPS IPs.
For \`Add server\` to start real work, configure the isolated GitHub Actions
V2 runner environment with pinned known_hosts and a dedicated SSH key or
disposable Aria test-node password; use encrypted GitHub environment secrets.
Cloudflare \`NODE_AUTO_GH_TOKEN\` (Actions dispatch only), matching
\`NODE_PROVISION_CALLBACK_SECRET\` (in V2 Worker and GitHub runner) and
\`SUBSCRIPTION_CREDENTIAL_KEY\` (base64url 32 random bytes) are required.
\`NODE_AUTO_ENABLED=true\` must be set only after these credentials exist.

Enrollment fails before writing D1 if this runner configuration is missing,
instead of recording a server that can never install. A successful installation
enables an **admin-only 1-hour test link** containing two VLESS REALITY
routes (443 and 8443) for the same trial identity; it does not activate
sales or claim live Iranian-carrier reachability.

V1 production Worker and AWS Node1 are not part of this workflow.
