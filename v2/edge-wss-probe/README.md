# Madar V2 staging-only Cloudflare WSS path probe

This standalone Worker forwards only `GET /madar-ws` with
`Upgrade: websocket` to the already installed disposable test node at
`https://86-54-42-66.sslip.io/madar-ws`. It has no D1 database, no Telegram
bot token, no route discovery and no production Worker dependency.

Expected Worker hostname: `madar-v2-wss-probe.alirezaanari117.workers.dev`.

A client may use:

- Address: `madar-v2-wss-probe.alirezaanari117.workers.dev`
- Port: 443; TLS: enabled; SNI/Host: same as address
- Transport: ws; path `/madar-ws`; flow: empty
- VLESS UUID: unchanged from *existing private WSS test configuration*.
  Do not copy or share UUIDs/keys in tickets or chats.

This is an experiment to distinguish direct-origin carrier routing from
Cloudflare-edge carrier routing. Never call a successful HTTP 101 a
functioning tunnel; confirm actual tunneled HTTPS through a separate carrier.
An unsuccessful test may be caused by workers.dev reachability or by
Cloudflare-to-origin behavior. This relay is not approved for sales or
long-term usage; disable it after testing to avoid unmanaged cost/abuse.

Only deploy the new script name; never update `madar-sales-bot` or
`madar-v2-staging` while running this experiment.
