# Madar automatic VMess/WSS test on newly enrolled VPS — 2026-11-09

The intended administrator experience remains:
**➕ صدور کانفیگ → choose server → VMess/WSS → 📥 دریافت کانفیگ.**

New *unregistered* Ubuntu 22.04/24.04 VPS targets installed by the
**upgraded separate Runner** attempt the following automatically:

- Public REALITY 443 and managed ports 2053/8443 remain unchanged.
- Check public IPv4, absent foreign services on 80 and 2087, and scoped
  AWS Security Group access (AWS targets only). Provider firewalls on
  non-AWS VPS still require operator-controlled inbound access.
- Obtain a publicly trusted Let's Encrypt **IP SAN** certificate with
  Certbot >=5.4 via standalone HTTP-01 on TCP 80, short-lived profile.
  Certbot issues certificates valid for only about **six days**.
  Cert/key paths are checked under /etc/letsencrypt/live/<public-ip>/.
- Save certificate paths in this node's private managed configuration.
- Only on the fresh install's **exact matching** successful Runner report,
  register the node IP, independently randomized VMess WS path and TCP
  **2087** in D1. The IP's A record / Loomera DNS is NOT touched.
- Node starts a TLS/WS VMess frontend on :2087 solely when its signed
  QuotaPolicy v2 includes this endpoint. Xray's default outbound denies
  unmatched users; authenticated requests route only to their
  per-account shared quota backend.
- Only the live node's real `ws-metered` ACK permits delivery of a private
  30-minute / 1 GB VMess/WSS test URI.

### Crucial deployment boundaries

- Installing *this GitHub code* or *updating the Worker* is insufficient:
  the actual **separate Runner host** must be upgraded using the pinned
  code so future enrollment jobs use its new installer. Its existing RSA
  identity and Worker secret must be preserved.
- **Previously enrolled nodes cannot be automatically mutated** by this
  feature. Do not register the same VPS twice or run a new installer over
  a currently running REALITY service; preflight must reject it.
- **The older AWS WSS canary on a different instance is unaffected.**
  Other customers, DNS, Cloudflare ingress, Caddy and the Loomera site
  remain unchanged.
- If the IP certificate issuance fails (blocked 80, ACME errors, missing
  Certbot) or 2087 is occupied, REALITY can still install but WSS stays
  disabled. Neither a browser WebSocket check nor an HTTP 200 is enough
  to claim VPN service.
- **Do not use for commercial WSS service yet:** six-day certificate
  auto-renewal + Xray reload on renewal and public mobile-network field
  acceptance have not been implemented or verified. The bot must never
  label the WSS test as ready merely because an IP cert was issued.
- The user must independently test the config over actual IranCell
  network to determine carrier reachability and performance.

Source: https://letsencrypt.org/2026/03/11/shorter-certs-certbot.html
