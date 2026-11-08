# Isolated Caddy/WSS field-canary for `madar-test.loomera.ir`

**Experimental only. Not a paid VPN, not a Madar Telegram managed account.**

This optional field experiment is deliberately separate from the **existing**
`sales-runner/installer.py` protocol-v2 provisioning, which requires ownership
of public TCP 443 for REALITY. On the AWS test server public 443 belongs to
Caddy; attempting the existing Runner installation would report `PORT_CONFLICT`.

## Required existing state (fails closed otherwise)

- Independent test instance `13.50.105.202`, Ubuntu 24.04,
  `madar-test.loomera.ir` resolves to it.
- Caddy public HTTPS 443 routing an exact randomized `/madar-<24 hex>`
  path to `127.0.0.1:18080`.
- The isolated `madar-xray-wss-canary.service` with Xray 26.3.27 and
  **zero clients**, **blackhole-only** outbound. Existing 8765 WSS probe
  and Caddy continue to run.
- Installed script must be explicitly transferred from an **immutable,
  verified repository commit**, to
  `/opt/madar-wss-test/field_wss_canary.py`; no arbitrary URL execution.

## Narrow field-only operation

`sudo python3 /opt/madar-wss-test/field_wss_canary.py prepare`:
preflights exact existing config and Caddy route, validates a candidate using
the checksum-pinned Xray already on disk, backs up the old canary Xray config
and systemd unit, and switches **only** this test unit to a one-use,
non-restarting supervisor. Other services, Caddy, DNS, AWS and sales bot are
never touched. It prints a **private** VMess/WSS config for the operator.

The sample account uses a 60-minute expiry and a **sampled 50 MB maximum**.
The program polls Xray StatsService twice per second, stops the child Xray on
expiry, quota sample threshold, process failure or stats-query failure, and
persists observed consumption. After the first run it cannot be restarted
without deliberate rebuilding; a reboot cannot reset the quota. Because the
quota is **sampling-based**, a high-throughput in-flight burst **can exceed**
50 MB before the next poll. This is *not* an exact hard quota. No commercial
account may be issued using this mechanism. All production volume caps remain
dependent on the existing signed Madar policy + per-account metered backend.

## Fix for 2026-11-08 zero-counter crash

Real Xray 26.3.27 stats-query JSON may omit the `value` member for a
valid zero-valued protobuf counter. Earlier field supervisor versions raised
`KeyError: 'value'`, marked state `stopped` with `usedBytes: 0` and killed
the isolated child (expected fail-closed behavior). Newer code treats only
that missing counter value as zero; absent/unrecognized counters still
fail closed. A **single** `retry-zero` operation is allowed only when the
owned test unit is inactive, prior state is `stopped` with exactly zero
recorded bytes, backup of the original zero-client/blackhole canary matches,
and both internal listeners are free. This operation invalidates the previous
VMess UUID and prints a fresh, private link with a new 60-minute window.
The `field-retry-issued` marker prevents further programmatic rearming.
Do not re-use the failed `vmess://` link.

To apply: download the corrected script using an immutable green Git commit
and verify its full SHA-256 before replacing
`/opt/madar-wss-test/field_wss_canary.py`, then run
`sudo python3 /opt/madar-wss-test/field_wss_canary.py retry-zero`.
Leave Caddy/DNS/Security Group unchanged.

## 2026-11-08 expiration / 502 Bad Gateway result

The user provided v2rayNG logs repeatedly showing
`wss://madar-test.loomera.ir/madar-465148f085316815204bb5d7`
returning HTTP `502 Bad Gateway` near 23:54–23:55 Tehran time.
The previous canary expired **23:51:40 Tehran** (`expiresAt=1794169300`).
As expected, the supervisor terminated the internal `127.0.0.1:18080`
listener, leaving Caddy on HTTPS 443 unable to proxy that WS path.
This evidence **does not show that the external domain was blocked**.
It also does **not explain the earlier slow/unstable connection before expiry**,
which must be evaluated separately during a live session.

A controlled `retry-expired` is available exactly once for that same
one-use field canary, and only after it is confirmed `expired`, with
`meterReady: true`, valid recorded use below the 50 MB sample limit,
original service backups, exact owned Xray config, unoccupied internal
listeners and a non-running systemd unit. It invalidates the old VMess UUID,
records the old consumed bytes in `field-expiry-retry-issued`, and generates
a *new* private link for a **60-minute, sampled 50 MB test session**.
Attempting this while still active, unmetered or exhausted fails closed.
Do not use `retry-zero` for a session that transferred traffic.
Neither the original nor the new sample cap is suitable for commercial use.

The test path is still shared with the browser WSS upgrade page. When a field
VMess UUID is installed, unauthorized clients must be rejected. Use client
software to test actual traffic/connection; a green browser upgrade alone is
insufficient evidence of a working VPN.

## Acceptance before any production attachment

1. Confirm test client actually accesses the internet through WSS from Iranian
   mobile data **with its prior VPN disabled**.
2. Inspect `sudo python3 ... status` for increasing `usedBytes`; verify
   expiration and quota termination.
3. Verify Caddy, `/healthz`, existing 8765 diagnostics and Loomera site are
   unaffected.
4. Do **not** mark `ws-metered` in the sales bot based on this field canary.
   Separately implement Caddy-owned-443 onboarding into the actual Node agent,
   signed QuotaPolicy, shared quota, revocation, subscriptions and live ACK
   before offering accounts from this node.

**Rollback:** saved files `/etc/madar-wss-canary/config.before-field-test.json`
and `/etc/madar-wss-canary/unit.before-field-test.service` are local backups.
Switch back only after stopping `madar-xray-wss-canary`, restoring both files,
reloading systemd and restarting the original isolated test unit. Do not
replace Caddy's listener or touch live nodes.

**No deployment has occurred merely because a PR was created.**
