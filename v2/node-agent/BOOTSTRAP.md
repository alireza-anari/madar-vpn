# Madar V2 isolated test VPS bootstrap

This is a TEST-ONLY installer for a clean, dedicated Ubuntu/Debian VPS, never Node1 or the active production system.

It downloads pinned Xray v26.11.9 and Caddy v2.11.9 releases, checks archive SHA-256, generates Reality credentials locally, prepares REALITY (8443) and optional TLS-WSS (443, internal 127.0.0.1:10443), tests configs and starts restricted systemd units. Failures trigger rollback. Service health does not establish external VPN connectivity.

WSS requires a public DNS A record directly resolving to the VPS IPv4. Ports 80 and 443 must be accessible for certificate issuance. If no domain is available, Reality-only testing can proceed and WSS stays pending.

From the pinned v2/node-agent directory on a new test VPS, preview:

    python3 -m agent.bootstrap --test-only --node-id test-eu01 --public-ip YOUR_PUBLIC_IPV4 --wss-domain vpn.example.com

Install explicitly:

    sudo python3 -m agent.bootstrap --test-only --apply --node-id test-eu01 --public-ip YOUR_PUBLIC_IPV4 --wss-domain vpn.example.com

Never treat success as field readiness. Next require external TLS, authenticated VLESS, mobile-carrier traffic, restart and quota tests. Only then enable issuance. No VPS or production node was modified to create these repository changes.
