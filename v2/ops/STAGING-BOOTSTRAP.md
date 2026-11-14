# Madar V2 staging bootstrap

This procedure is deliberately separate from the live Madar bot and production
Worker. Do not reuse the production bot token, webhook secret, D1 database,
node master key, or any production VPS credential.

## 1. Create a dedicated Telegram staging bot

In Telegram, open **@BotFather**, run \`/newbot\`, and create a bot named for
Madar staging. Keep its token private. Do not paste it into this repository,
GitHub issues, or ChatGPT.

Get the numeric Telegram user ID that will be the staging owner. Add it to
\`ADMIN_TELEGRAM_IDS\` in this file's \`vars\` object before deploying; multiple
IDs are comma-separated. \`BOT_USERNAME\` may also be added for referral links.

## 2. Add Worker secrets through Wrangler's hidden prompt

From the repository root, use the Wrangler version already pinned by
\`apps/sales-bot\` (4.148.0). Do not put secret values in command arguments:

\`\`\`bash
cd v2/control
../../apps/sales-bot/node_modules/.bin/wrangler secret put BOT_TOKEN --config wrangler.jsonc
../../apps/sales-bot/node_modules/.bin/wrangler secret put TELEGRAM_WEBHOOK_SECRET --config wrangler.jsonc
../../apps/sales-bot/node_modules/.bin/wrangler secret put NODE_MASTER_KEY --config wrangler.jsonc
../../apps/sales-bot/node_modules/.bin/wrangler secret put SUBSCRIPTION_CREDENTIAL_KEY --config wrangler.jsonc
\`\`\`

For each secret, Wrangler prompts for the value without storing it in the
repository. Generate three independent 32-byte base64url keys (one each for
the webhook, node master, and subscription encryption):

\`\`\`bash
openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
\`\`\`

The Telegram bot token is supplied by BotFather; it is not one of these
random keys. Never reuse the same key for multiple purposes.

## 3. Register the staging webhook

After the two Telegram secrets are stored, run this locally. It reads secrets
silently, sends them directly to Telegram, and does not print them:

\`\`\`bash
read -rsp "Staging BOT_TOKEN: " BOT_TOKEN; echo
read -rsp "TELEGRAM_WEBHOOK_SECRET: " WEBHOOK_SECRET; echo
export BOT_TOKEN WEBHOOK_SECRET
python3 - <<'PY'
import json, os, urllib.parse, urllib.request
token = os.environ["BOT_TOKEN"]
secret = os.environ["WEBHOOK_SECRET"]
url = "https://madar-v2-staging.alirezaanari117.workers.dev/telegram/webhook"
data = urllib.parse.urlencode({
    "url": url,
    "secret_token": secret,
    "allowed_updates": json.dumps(["message", "callback_query"]),
    "drop_pending_updates": "true",
}).encode()
req = urllib.request.Request(
    f"https://api.telegram.org/bot{token}/setWebhook", data=data
)
with urllib.request.urlopen(req, timeout=20) as response:
    result = json.load(response)
    print({"ok": result.get("ok"), "description": result.get("description")})
PY
unset BOT_TOKEN WEBHOOK_SECRET
\`\`\`

Then verify:

- \`GET https://madar-v2-staging.alirezaanari117.workers.dev/health/ready\`
  returns \`200 {"status":"ready"}\`.
- Telegram's \`getWebhookInfo\` shows the staging URL and no recent errors.
- The staging bot responds to \`/start\` and the configured owner can open
  \`/admin\`.

## 4. Safety flags — intentionally disabled

The current config explicitly sets:

- \`SHOP_ENABLED=false\`
- \`PROVISIONING_ENABLED=false\`
- \`SUBSCRIPTION_API_ENABLED=false\`

Do not enable these flags yet. No real payments, customer credentials, or
production subscriptions should be accepted from staging.

## 5. Live node acceptance still requires a separate test VPS

The owner can register a draft node with
\`/node_add ID|provider|region|users|capacityGB\` and a draft transport with
\`/node_route ID|reality|443\` or
\`/node_route ID|wss|443|vpn.example.com|/ws\`.

This only records desired state. It does not install anything. A separate
disposable VPS, a node-local key, pinned Xray binary, agent ACK, external
carrier tests, and actual metering are required before a route can be marked
ready. **Node1 and all V1 production infrastructure remain out of scope.**

Only after a test node passes external traffic tests should the owner enable
provisioning for staging. Enable subscription delivery only after encrypted
credentials and quota accounting have been tested. Enable shop last, after
manual receipt review, duplicate-payment handling, refunds, and settlement
have passed end-to-end tests.
