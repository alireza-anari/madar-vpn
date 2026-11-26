# Irancell carrier reachability without VPN service changes

Use on the *disposable Madar V2 test VPS only*. This test never edits any
systemd service, listening port, firewall, domain, Xray config, Caddy config,
private VLESS key or client UUID.

While connected by SSH on the VPS, run:

    cd /root/madar-v2-test &&
    git pull --ff-only &&
    cd v2/node-agent &&
    python3 -m agent.carrier_probe --duration 75

During the 75-second measurement, turn Wi-Fi and VPN **off** on the phone,
keep Irancell cellular data on, and request the origin HTTPS URL
\`https://86-54-42-66.sslip.io/\` once. Then run the same test with
\`http://86.54.42.66/\` (port 80, should redirect via Caddy).

- If inbound SYN counts on 443 and 80 do not increase during the controlled
  window, the host did not see a new IPv4 TCP connection; DNS or network routing
  / filtering remain candidates and cannot be distinguished by server alone.
- If SYN and SYN-ACK appear, at least a TCP handshake started.
- If inbound data segments are present, the client transmitted TCP data,
  potentially including TLS handshake. Packet counts alone cannot prove WSS.
- If a complete authenticated VLESS tunnel works, an actual tunneled HTTPS
  response (not HTTP 101) is needed to qualify the route.

No IP addresses, raw packets, payload contents, passwords or secrets are
captured. Totals may include Internet scanning traffic and background probes.
A separate source-specific diagnostic with consent would be necessary to
attribute a connection to a carrier definitively. No packet capture is
persisted, only count summaries at /root/madar-carrier-probe.json (0600).
