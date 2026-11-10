# Madar V2 — separate test VPS acceptance

This stage is **not yet installed on any real VPS**. It is deliberately not
allowed to touch V1's existing Node1 or production Cloudflare Worker.

## Node deployment safety

The staging-only installer has these gates:

1. A dedicated, disposable VPS with supported Linux/systemd.
2. Explicit \`STAGING-ONLY\` marker under a safe owner-controlled directory,
   containing exactly \`MADAR_V2_DISPOSABLE_TEST_NODE\` and a trailing newline.
3. Locally provisioned \`local-secrets.json\` with mode 0600. Never put
   private REALITY keys, client UUIDs or node master keys in Telegram, GitHub
   or command-line arguments.
4. Operator-approved, already-installed Xray and Caddy binaries, each checked
   byte-by-byte against their expected SHA256 digests (no latest-version
   auto-downloads or shell pipelines).
5. Separate systemd units named \`madar-v2-xray.service\` and
   \`madar-v2-caddy.service\`. The installer executes only these allowlisted
   units; never restarts \`xray\`, \`caddy\`, \`madar-sales-bot\`, or Node1's
   existing service.
6. A real public IPv4 address and a DNS A record pointing the selected WSS
   hostname to **that same isolated VPS**. Caddy requests TLS automatically;
   DNS resolution alone does **not** prove a valid certificate or HTTPS.
7. Reality and WSS must use non-colliding publicly bound ports. For the test,
   choose Reality on TCP 8443, Caddy HTTPS WSS on TCP 443, and Xray's
   **loopback-only** WebSocket ingress on TCP 10443.

## Tested offline action

The Python staging command \`python3 -m agent.stage_cli --help\` shows the
single supported deployment workflow. It reads credentials only from a
root-owned 0600 JSON file, compiles Xray and Caddy configurations, validates
**both** candidates with pinned binaries, stages the files atomically,
restarts only named V2 units and restores the previous files and services if
either validation or restart fails. The result is **services_configured**,
never ready for sale.

Required JSON keys:

\`\`\`json
{
  "clients": ["123e4567-e89b-42d3-a456-426614174000"],
  "reality": {
    "port": 8443,
    "target": "www.example.com",
    "server_name": "www.example.com",
    "private_key": "<node-local-generated-real-X25519-private-key>",
    "short_ids": ["0123456789abcdef"]
  },
  "websocket": {"path": "/madar-v2", "loopback_port": 10443},
  "wss_hostname": "vpn.example.com"
}
\`\`\`

The UUID and domain above are examples, not functioning customer credentials.
The private key must be generated on the disposable VPS and kept there.

## Mandatory before enabled/ready status

- Apply a pinned, secure systemd service/user setup and a firewall rule review
  on the disposable VPS only. The current installer does **not** install
  systemd units or modify firewall settings.
- DNS A record, external TLS certificate chain and hostname validation.
- Confirm active local port and WebSocket 101 upgrade, then a REALITY
  handshake, authenticated VLESS tunnel and tunneled HTTPS response from a
  separate device. A service restart or port-open probe is insufficient.
- Test actual carrier networks, bandwidth, reconnection, expired tokens,
  quota exhaustion, rollback and logs free of secrets.
- Only then expose a test route to the Android client; only after further
  accounting acceptance enable shop/provisioning. No V2 commercial
  entitlements may be sold before acceptance.

This stage intentionally never guarantees that mobile ISP filtering will
allow a particular IP address or protocol. It provides measurable fallback
and diagnostic evidence rather than a false "ready" state.

References:
- https://xtls.github.io/en/config/transport.html
- https://xtls.github.io/en/config/transports/reality.html
- https://xtls.github.io/en/config/transports/websocket.html
- https://caddyserver.com/docs/automatic-https
