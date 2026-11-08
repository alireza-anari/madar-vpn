# Experimental Cloudflare WSS edge release (not a VPN)

Owner requested trial use of Cloudflare's own workers.dev instead of buying a
domain before confirming Irancell connectivity.

The deployment script creates ONLY the distinct Worker:
`madar-wss-lab.alirezaanari117.workers.dev`.

Safe production boundaries:
- No modification to `madar-sales-bot` Worker, its D1 database or secrets
  in this release.
- No SSH or restart on the live Ariant (MCI REALITY 443) or AWS Node1.
- Test page `/test` uses an actual WSS ping/pong round-trip to Cloudflare.
- `/healthz` reports that the VPN path is NOT ready.
- The VMess WS relay path remains disabled unless an operator later installs
  a real quota-metered Xray WS backend and configures an approved temporary
  trycloudflare origin for lab use; it is never an open arbitrary proxy.
- Nothing is added to customer subscriptions before metered backend ACK.
- A successful edge WSS probe is **not** proof that an end-to-end VPN tunnel works.
- Quick Tunnel routes are temporary, for experiments only (not for sales).

After successful deployment, the bot's admin-only WSS menu can link to
`https://madar-wss-lab.alirezaanari117.workers.dev/test`.
