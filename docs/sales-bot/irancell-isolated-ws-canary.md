# Ariant Irancell isolated WebSocket canary — test only

## Scope

Pinned node: Ariant 86.54.42.9, D1 node ID c6683027-498d-40ef-ae97-e5a725f0a86f.

The isolated test uses VMess AES-128-GCM over WebSocket, only on 127.0.0.1:18080 (Xray Stats API on localhost:18081). It never edits or restarts the existing VLESS REALITY port 443 service, the sales agent, any AWS node, Cloudflare Worker, D1 schema, or sales accounts.

The test has one randomly generated private UUID and path, a maximum 15-minute systemd lifetime, and a 200 MiB metering TARGET checked roughly every 5 seconds. The cap is not strictly enforced between meter checks. Never sell this link or add a customer credential; it is outside the commercial quota ledger.

As of 2026-11-07, this assistant has no SSH session to Ariant. The connected Cloudflare account has no managed DNS zone. A stable published hostname cannot yet be configured.

## Verification and safe preparation

The dedicated CI workflow tests the script's safety and fail-closed behavior.

In an authorized SSH session to Ariant ONLY, clone the repository and check out the exact green reviewed commit; run from its root:

    sudo python3 experiments/irancell-ws/irancell_ws_canary.py --preflight
    sudo python3 experiments/irancell-ws/irancell_ws_canary.py --stage

Preflight verifies the exact node identity, that the original services are active, that the loopback ports are free, and that no canary install exists. Stage writes private candidate settings and only three NEW systemd units with the prefix madar-irancell-canary. It validates the candidate against the installed Xray binary. It does not start a listener or change any existing unit.

## Temporary ingress for a test

For a short diagnostic without a domain, an official cloudflared Quick Tunnel may expose the loopback service:

    cloudflared tunnel --url http://127.0.0.1:18080

Use the random trycloudflare.com hostname. Quick Tunnels have no uptime guarantee, are for development/test only, and do not replace a production domain. The Cloudflare terms for public hostname routes also restrict large-file/video delivery on Free/Pro/Business; verify terms and the VPS provider agreement before any commercial proxy traffic.

Activate for at most 15 minutes:

    sudo python3 /opt/madar-irancell-canary/irancell_ws_canary.py --activate

Generate an import URI locally using the Quick Tunnel hostname:

    sudo python3 /opt/madar-irancell-canary/irancell_ws_canary.py --link RANDOM.trycloudflare.com

Keep the URI private. Compare Iranian mobile connections without changing the original 443 profile. After the test, stop cloudflared and remove the test-only canary:

    sudo python3 /opt/madar-irancell-canary/irancell_ws_canary.py --remove

This removal acts only on the owned canary units/config. Systemd bounds the Xray runtime to 900 seconds with Restart=no, MemoryMax=320M and CPUQuota=50%. Meter failure is fail-closed.

## Acceptance and production requirements

This setup is NOT a shipping feature. Production use must separately establish: a stable and contract-compliant ingress, proven Irancell improvement in the same location, safe quota accounting across both transports, audited account provisioning, per-customer expiry, D1 aggregate usage, enforceable hard caps, operational alerting, and client compatibility. Do not add the experimental URI to paying customers' subscriptions.

The original VPS has 1 vCPU and 1 GiB RAM; resource contention is possible even though the two systemd units and config files are isolated. Do not stress test both simultaneously. If either path degrades, stop the canary.
