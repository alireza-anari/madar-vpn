# Reversible REALITY 443 + 8443 cutover: disposable Aria VPS

Only on test-aria01 at 86.54.42.66 after the previously documented
staging bootstrap. Do not run on Node1 or production. This cutover
disables the old WSS service on 443, briefly restarts Xray, and uses a
restricted systemd capability drop-in so the unprivileged Xray process
may bind 443. It copies the working 8443 REALITY inbound unchanged,
retains all client UUIDs and private key, and stages a second 443 inbound.

Preview from existing SSH session:

    cd /root/madar-v2-test/v2/node-agent
    python3 -m agent.dual_reality --test-only --node-id test-aria01 --public-ip 86.54.42.66

Apply:

    python3 -m agent.dual_reality --test-only --apply --node-id test-aria01 --public-ip 86.54.42.66

Rollback to original WSS 443 and REALITY 8443:

    python3 -m agent.dual_reality --test-only --rollback --node-id test-aria01 --public-ip 86.54.42.66

The original root-only config backup is retained as
/etc/madar-v2/config.pre-carrier443.json until an explicit rollback.
Failure should automatically restore both original services; if rollback
is incomplete do not delete the backup. No keys are printed.
Do not run the legacy staging WSS deploy CLI after cutover: it still
assumes Caddy owns TCP 443. This procedure does NOT establish real
carrier connectivity or approve sale of subscriptions.
