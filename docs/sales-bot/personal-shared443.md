# Personal adoption over existing REALITY443

Owner approved using Personal while preserving its working credential. Instance identity was confirmed as `i-002a965e30ef88b2f`; observed current hostname/private IP is `ip-172-31-35-119`. Existing Xray26.3.27 runs as xray from `/usr/local/bin/xray run -c /usr/local/etc/xray/config.json`. A root backup was created at `/root/madar-backup-20261016-091338`. The unit has NeedDaemonReload=yes; this alone is not a connection failure.

## Implementation

Keep existing inbound clients, REALITY key, short IDs, SNI, transport and default outbounds. Add loopback-only HandlerService19999, fixed user-email routing and loopback VLESS outbounds20000–20999. Managed users are inserted/removed through HandlerService without restarting the shared frontend. Each account still has its own metered Xray backend (plaintext VLESS only over loopback, private bridge credential), so stopping it terminates its existing TCP streams without interrupting Personal. Backend stats21000–21999 and all bridge listeners are loopback only. Public deliveries use443 only for nodes advertising shared-443; legacy nodes retain their public account ports.

A frontend PID/start-time change blocks managed accounts instead of silently losing dynamic users or resetting accounting. Agent/watchdog never stops xray.service. Persistent quota continuity rules remain unchanged; unproven restarts block previously observed managed accounts for support/reissue.

The existing sale/trial uniqueness constraint on node_id is removed additively by migration0005 while preserving assignments. Only one node per purpose remains enforced.

## Explicit installation

`install_personal.py` verifies IMDSv2 instance identity, exact Xray version, active unit command, fresh namespaced directories/units, unused local ports, checksum-pinned immutable source and candidate readability/config validity under user xray. It copies the existing binary, generates agent secrets locally, derives only the public REALITY key with OpenSSL over stdin, and registers with an owner-issued256-bit, hashed, scoped, expiring, one-use grant. The grant endpoint cannot change an existing registered node credential. No SSH/firewall/Xray unit changes are made. No credentials are logged.

Frontend config application entails one brief restart. Original credentials are preserved, but uninterrupted initial streams are not promised. Backup/rollback retain file ownership and mode, use atomic replace and persist an absolute ten-minute confirmation deadline. Enabled regular rollback units check the deadline after reboot too. The owner must verify their original Personal credential and run `/opt/madar-sales-node/confirm-personal.sh` within ten minutes. Otherwise the original config is restored and managed services disabled. Manual rollback: `sudo python3 /opt/madar-sales-node/rollback-personal.py --force`.

## Evidence and limits

Local real pinned Xray probe passed mixed Personal Vision plus managed empty-flow REALITY traffic on one frontend, positive managed counters, live managed stream cutoff and continued Personal transfer without frontend restart. Unit/Worker tests cover preservation, loopback binding, scoped registration, replay rejection, delivery443 and rollback write failure. This does not prove deployment or Iranian ISP connectivity. Live installation, original Personal reconnection, device internet, actual cap and1800-second expiry remain field gates. Do not activate seller menus or claim ready for sale until those pass. No other VPS, Elastic IP or Runner is changed by this rollout.
