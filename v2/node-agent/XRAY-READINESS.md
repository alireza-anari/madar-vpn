# V2 node Xray compiler — isolated offline preparation

This is a **pure compiler**, not a VPS installer. It produces two independent
listener types:
- REALITY over RAW, externally bound to an explicitly selected port;
- Plain WebSocket **only on 127.0.0.1**, to be reached through a separately
  secured HTTPS reverse proxy (e.g. generated Caddy site).

It refuses missing local REALITY keys, invalid UUIDs, invalid hostnames,
duplicate users, untrusted WebSocket paths and listener-port collisions.

Before any real VPS can be marked Ready:
1. Bind a **test-only** node identity and per-node 0600 secret, never Node1.
2. Pin and independently verify an official Xray release and binary digest.
3. Generate private REALITY keys on the node using the pinned binary; keep the
   private key local; never commit it or send it over Telegram.
4. Retrieve authorized client UUIDs using a separate authenticated, encrypted
   provisioning channel; an ACKed manifest alone is insufficient.
5. Run \`xray run -test -config ...\` and a local Caddy config test; atomically
   switch files with rollback, then start services under restricted users.
6. Complete REAL, end-to-end external tests over each carrier and transport.
7. Only the measured/accepted route transitions from draft to ready.

This offline prototype intentionally performs none of the privileged steps.
Official docs: https://xtls.github.io/en/config/transports/reality.html
https://xtls.github.io/en/config/transports/websocket.html
