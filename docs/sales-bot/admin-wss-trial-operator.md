# Per-node VMess/WSS admin trial — Telegram Madar

Only the existing trusted quota-v2 managed agent may receive these tests.
A successful browser WSS upgrade to Xray, or a one-use EC2 VMess canary,
is **NOT** proof of shared quota and is NOT eligible for this button.

## Admin workflow

1. Telegram bot → سرورها → انتخاب سرور → 🧪 تست پروتکل VMess/WSS.
2. If no WSS endpoint is approved, register the node's stable TLS domain
   through «ثبت / اصلاح دامنه». The path is generated uniquely per node.
   Ensure HTTPS/WSS reaches **that node's own** `127.0.0.1:18080`
   through an approved stable ingress. Existing REALITY on TCP 443
   **cannot share the exact same public IP:443 with Caddy**. Do not
   stop or replace production REALITY 443 to make room for Caddy.
3. The bot shows «🧪 صدور تست واقعی WSS همین سرور · ۳۰ دقیقه» only
   when the node is healthy and its current, ACKed QuotaPolicy v2
   has the exact admin-approved WSS hostname and randomized path.
   **For the first account, ws-metered is not yet required to prepare**
   the trial; it will only appear after a live account is attached.
4. The admin creates ONE trial account per node per 30-minute time bucket,
   respecting existing server count/volume ceilings. It uses the managed
   per-account quota-v2 backend, with 1 GB and 30-minute validity.
   No customer account or payment is created.
5. **Delivery requires the Agent to advertise ws-metered** and the
   signed policy to include the exact trial UUID, backend port, quota,
   quota epoch and expiration. The trial's config output contains only
   VMess/WSS: never substitute a REALITY URL and call it WSS.
   A missing, stale or mismatched ACK withholds the config.
6. Test with real mobile internet, then inspect actual metered traffic and
   revocation/expiration. Browser ping/pong and a checkmark in the bot
   are insufficient proof that Instagram or general browsing works.

## Unsupported existing nodes

- A VPS currently serving REALITY on public IPv4:443 cannot simply start
  Caddy on that same socket. Use a separate approved TLS ingress or change
  the topology with an explicit coordinated maintenance window.
- The separate test EC2 `madar-test.loomera.ir` currently runs a one-use,
  sampled-cap Xray canary behind Caddy. It does **not** use the managed
  quota-v2 Agent and cannot claim ws-metered or request this bot trial.
- The feature is per-node, not a global toggle. Default customer delivery
  and existing REALITY accounts remain unchanged.
- Full automatic WSS-only fresh-server enrollment in Runner is **not yet
  implemented**; this PR adds the bot-admin trial workflow for nodes
  which already have managed quota-v2 and stable WSS ingress.

## Rollout safety

Deploy Worker-only after CI. Keep D1 identity, existing secrets and cron.
Do not deploy a new Node agent to any existing VPS as part of this change.
Do not unlock commercial WSS delivery without genuine field acceptance.
