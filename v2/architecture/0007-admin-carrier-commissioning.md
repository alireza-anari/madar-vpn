# V2 staging: two-operator administrator acceptance

Adds two explicit buttons inside existing server details: MCI TCP443 and Irancell TCP8443.
Does not change the overall approved bot layout or touch V1.

Admin first-hand mobile-carrier confirmations are recorded as admin_manual, NOT as
independent authenticated traffic field probes. The admin must personally verify
that the actual mobile SIM tunneled bidirectional application traffic.

Readiness requires *all* of the following:
1. Existing installation job completed on that exact V2 node.
2. Node desired revision equals its signed acknowledged revision.
3. A fresh HMAC-authenticated accepted node ACK within 10 minutes, with replay protection.
4. Both MCI and Irancell administrator confirmations for the same revision, made within 24h of initial commissioning.
5. Both expected REALITY variants (443, 8443), one matching parent route.
6. The dedicated staging-only ADMIN_MANUAL_FIELD_ACCEPT_ENABLED flag.

**Ongoing operation:** initial carrier acceptance is stored durably for that exact revision. Once a node is ready, later signed runtime health reports do not require a repeat manual SIM test every 24 hours; they still need valid signed authentication, installed dual variants and healthy loopback stats. Fresh network reachability from either operator is not independently proven by runtime health, and must be monitored separately. New configuration revision requires renewed carrier acceptance.

No admin confirmation can simulate a signed node ACK or customer UUID installation.
Successful ready status is not an independent network audit or a license to enable
commercial purchase flows. Customer feeds are still gated by a recent node-specific
client ACK after Xray really applied a subscription UUID, and by live health reports.

The node must reconnect to receive and ACK its manifest. This is not accomplished
by editing the server lifecycle field in D1. If zero node ACKs remain, SSH onto
the specific authorized V2 test VPS and run read-only diagnostics:

    sudo systemctl status madar-v2-runtime.service --no-pager
    sudo journalctl -u madar-v2-runtime.service -n 45 --no-pager
    sudo systemctl is-active madar-v2-xray.service

Never paste SSH secrets, client UUIDs or node keys. Do not reinstall or delete
other running VPN instances just to satisfy this test.

Release: apply migration 0027 on isolated staging D1, review exact SHA control
tests, upload an unpublished Worker version preserving all existing D1 and
secret bindings, verify commercial flags remain false, deploy V2 staging only,
then verify health and unauthorized requests. Record the prior version ID for rollback.