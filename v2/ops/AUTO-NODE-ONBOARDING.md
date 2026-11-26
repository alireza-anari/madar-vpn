# Automatic V2 server onboarding (staging only)

The bot's "Add server" wizard accepts:
node-id | provider | region | max-users | max-GB | public IPv4

The node is enqueued with a unique job identifier. After an approved
remote deployment runner reports success over HTTPS, an administrator may
request "Issue test config" in the same bot to receive ONE short-lived
subscription URL containing:
- Madar | Hamrah Aval (REALITY TCP 443)
- Madar | Irancell (REALITY TCP 8443)

Trial-only routes stay unpublished and unverified for commercial issuance.
They cannot count as live field-carrier acceptance. The admin trial link lasts
one hour and is a bearer secret; do not post it publicly.

Remote runner prerequisites (set ONCE outside Telegram):
- A separate GitHub Actions deployment identity, allowed to SSH into only
  approved disposable VPS hosts.
- GitHub encrypted secrets MADAR_V2_SSH_PRIVATE_KEY and MADAR_V2_KNOWN_HOSTS.
  Every new node's trusted SSH host key must be pinned.
- GitHub encrypted secret MADAR_V2_CALLBACK_SECRET. Set the SAME random
  secret as NODE_PROVISION_CALLBACK_SECRET on the staging Cloudflare Worker.
- On the staging Worker, NODE_AUTO_GH_TOKEN (GitHub Actions:write only),
  NODE_AUTO_ENABLED=true, NODE_PROVISION_CALLBACK_SECRET,
  SUBSCRIPTION_CREDENTIAL_KEY, SUBSCRIPTION_PUBLIC_ORIGIN, BOT_TOKEN,
  ADMIN_TELEGRAM_IDS, TELEGRAM_WEBHOOK_SECRET. No production credentials.
- The provision workflow must exist on the GitHub default branch and pin
  an exact green V2 code commit.
- For an existing VPS: private SSH key must already be authorized there.
  Provider API provisioning may install the key when the VPS is created;
  adding an arbitrary IP alone cannot grant root access.

Never send passwords/private keys in Telegram. A successful job installs
Xray but does NOT mark the node ready for paying subscribers. Capacity,
users and shared quota remain enforced by V2; external Iran carrier tests are
independent approval gates.

Workflow must not use ssh-keyscan without pinning, StrictHostKeyChecking=no,
or any GitHub secret directly on an untrusted pull-request checkout.
