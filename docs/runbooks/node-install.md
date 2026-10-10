# Madar node installation and lifecycle

This runbook documents the current repository behavior for the Madar Node Agent, pinned Xray/VLESS/REALITY runtime, UTC active-second Free accounting, durable telemetry, PostgreSQL settlement, and the Phase 7 field gate.

Repository lifecycle remediation is implemented and CI-verified, but the new lifecycle has **not yet been rerun on the real VPS**. The historical Gate J failure remains valid field evidence. Phase 7 is still INCOMPLETE.

Premium single-active-client/device enforcement is a separate unresolved release gate and must not be inferred from Free accounting or this lifecycle work.

## Supported environment

The Agent validates Ubuntu LTS `22.04`, `24.04`, or `26.04` on `x86_64`/`amd64` or `aarch64`/`arm64`.

Run the installer as `root`.

Managed paths:

```text
/opt/madar-node-agent
/opt/madar-xray
/etc/madar-node-agent
/etc/systemd/system
/run/madar-node-agent
```

The installer intentionally does **not** modify SSH or firewall configuration.

## Required install inputs

```bash
export MADAR_API_BASE_URL='https://control.example.com'
export MADAR_NODE_ADDRESS='203.0.113.10'
export MADAR_NODE_PORT='443'
export MADAR_NODE_SERVER_NAME='edge.example.com'
export MADAR_REALITY_TARGET='origin.example.com:443'
export MADAR_REALITY_SHORT_ID='<public-client-safe-value>'
```

`MADAR_REALITY_TARGET` must be explicitly compatible with REALITY. Ordinary TLS success alone is insufficient; the historical field run observed a target that passed normal TLS but failed REALITY, while another target succeeded.

Do not supply a REALITY private key manually. The installer verifies the pinned Xray release, generates X25519 material locally, keeps the private key VPS-only, and enrolls only public client-safe values.

Never put the one-time enrollment token in an environment variable, command-line argument, shell history, source control, documentation, logs, screenshots, or chat. The install wrapper reads it silently and passes it to Python through a file descriptor.

## Install

From the checked-out `node-agent` directory:

```bash
sudo -E ./install.sh install
```

Installation:

1. stages Node Agent files;
2. verifies/installs pinned Xray;
3. generates REALITY keys locally;
4. enrolls with the one-time token;
5. stores the node credential with restrictive permissions;
6. stages both systemd units;
7. reloads systemd;
8. starts only `madar-node-agent.service`.

Xray is not independently enabled by the installer.

Sensitive/local state:

```text
/etc/madar-node-agent/node.credential
/etc/madar-node-agent/reality.private
/etc/madar-node-agent/agent.env
/etc/madar-node-agent/telemetry-outbox.sqlite3
```

Sensitive files and the telemetry outbox are owner-only `0600`; the persistent state directory is `0700`. `agent.env` contains paths/public runtime values, never the raw node credential or REALITY private key. The outbox rejects an existing symlink/non-regular path.

## Current fail-closed service lifecycle

Node Agent:

```text
/opt/madar-node-agent/venv/bin/python -m madar_agent.service
```

Managed Xray:

```text
/opt/madar-xray/26.3.27/xray run -c /etc/madar-node-agent/xray-config.json
```

### Persisted config is not authorization

A persisted:

```text
/etc/madar-node-agent/xray-config.json
```

is not sufficient to authorize a fresh Xray process.

Each Agent service activation owns an ephemeral runtime directory:

```text
/run/madar-node-agent
```

with restrictive mode and non-preserving restart semantics. Current Xray authorization is represented by:

```text
/run/madar-node-agent/xray-authorized
```

The marker is fixed non-secret content, mode `0600`, and exists only for the current authorized Agent activation.

### Agent systemd unit

The Agent unit:

- depends on `network-online.target`;
- does **not** `Wants=` or `Requires=` Xray;
- owns `RuntimeDirectory=madar-node-agent`;
- sets `RuntimeDirectoryMode=0700`;
- sets `RuntimeDirectoryPreserve=no`.

Restarting/stopping the Agent therefore discards the prior activation's runtime authorization.

### Xray systemd unit

The Xray unit:

- uses `BindsTo=madar-node-agent.service`;
- is ordered after the Agent;
- requires the live Xray config;
- requires `/run/madar-node-agent/xray-authorized` through both a systemd condition and pre-start check;
- has no independent `[Install]` target;
- retains `Restart=on-failure`, bounded stop timeout, and control-group cleanup.

If the Agent becomes inactive/failed/stopped, systemd is expected to pull Xray down independently of application cleanup.

### Verified startup closure

Every fresh Agent process first proves managed Xray inactive before constructing the runtime/outbox or contacting the control plane.

It does **not** trust a stop command exit code. It queries:

```bash
systemctl show madar-xray.service \
  --property=ActiveState \
  --property=SubState \
  --property=MainPID \
  --no-pager
```

Safe closed state requires parseable:

- `ActiveState=inactive` or `failed`; and
- `MainPID=0`.

Active/transitioning state, nonzero PID, malformed/missing properties, or unqueryable state are not accepted as closed.

If ordinary stop does not produce verified inactivity, the lifecycle performs bounded systemd control-group force-stop recovery and verifies state again. If inactivity still cannot be proven, Agent exits before normal runtime construction with a generic non-secret error.

### Fresh policy authorization

For a fresh valid policy, Xray activation order is:

1. render candidate config;
2. validate candidate with pinned Xray;
3. atomically promote to live config;
4. create current authorization marker;
5. controlled authorized Xray restart;
6. verify Xray active;
7. validate live config for health;
8. only then treat managed state as healthy/ready.

If marker grant, restart, or health verification fails, authorization is revoked and Xray is driven inactive. The live config may remain on disk, but it is not authorization by itself.

### Stale/no authorization versus fresh empty policy

These cases are intentionally different:

- stale/missing/invalid authorization => clear managed-client state, revoke marker, stop Xray;
- fresh explicit empty policy => validate/promote a zero-client config, create marker, start and health-check Xray.

Do not use a zero-client config as a substitute for closing stale authorization.

### Agent shutdown and failure

Normal stop, fatal API exit, and sampler-cleanup failure all reach best-effort lifecycle disable. Sampler cleanup errors cannot skip marker revocation/Xray stop. The systemd `BindsTo` relationship remains the independent safety layer if application cleanup itself fails.

## Xray logging and local observation

Xray access logging is disabled:

```text
log.access = "none"
```

Managed `StatsService` is loopback-only at:

```text
127.0.0.1:10085
```

Enabled managed-user stats:

- `statsUserOnline` only for aggregate diagnosis;
- `statsUserUplink`;
- `statsUserDownlink`.

Raw per-client StatsService output must not be copied into tickets, chat, screenshots, CI logs, or reports.

## Approved Free accounting rule

Free usage is account-level server-observed active traffic time:

- at most one Free second per account per UTC second bucket;
- overlapping connections/devices/credentials/nodes do not multiply debit for the same bucket;
- positive authenticated Xray uplink/downlink delta can mark a bucket active;
- unchanged counters are idle and bill zero;
- reset/decrease, missing/new client, query failure, non-monotonic time, missed boundary, restart gap, or excessive observation skew create zero inferred usage across ambiguity;
- no `sessionId` is fabricated.

`onlineUsers`, public IP count, raw transport-connection count, browser state, and access logs are not billing clocks.

The sampler uses UTC-aligned one-second boundaries. The current automated post-boundary skew tolerance is `0.75s`; real field validation remains required.

## Durable telemetry outbox v2

Outbox:

```text
/etc/madar-node-agent/telemetry-outbox.sqlite3
```

Current local schema version:

```text
PRAGMA user_version = 2
```

For new aligned activity the outbox stores per-client/per-UTC-minute low-60-bit masks. Pending reports freeze:

- `windowId`;
- `sequence`;
- `seconds`;
- `activeSecondsHex`;
- observation timestamps.

Pending identity survives Agent restart until complete acknowledgement.

`activeSecondsHex` is exactly 16 lowercase hex characters for new bitmap reports and `seconds` equals the bit population count. ACK identity includes the bitmap.

The outbox:

- ORs repeated evidence for the same exact bucket idempotently;
- allocates monotonic sequence numbers transactionally;
- keeps pending rows on malformed/partial/ambiguous responses;
- only ACKs after exact integer `accepted + duplicates == submitted count`;
- keeps DB `0600` and state directory `0700`;
- rejects symlink/non-regular DB paths;
- fails closed on unsupported future local schema versions.

Migration from older aggregate outbox state preserves historical pending/aggregate rows as legacy telemetry without inventing active-second bit positions.

Sampling continuity itself is not persisted. First counter sample after Agent restart is baseline-only.

## Telemetry capability negotiation

Authenticated endpoint:

```text
GET /api/node/telemetry/capabilities
```

Current capability:

```json
{"activeSecondsV1":true}
```

A new Agent does not send bitmap telemetry until support is explicitly advertised.

- supported => submit exact pending bitmap report;
- authenticated old-server `404` => keep masked report pending unchanged;
- invalid/missing capability => no downgrade/strip/fabricated ACK;
- legacy no-bitmap report may still be delivered to an older server.

Supported deployment order remains server-first.

## PostgreSQL settlement

Migration:

```text
packages/database/src/migrations/0002_active_second_accounting.sql
```

On an existing database with `0001_core.sql`, do **not** replay `0001`. Take a verified backup/preflight and apply only `0002_active_second_accounting.sql` using the intended schema-owner role. Verify the API role can access the new tables/identity sequence before upgrading Agents.

Masked settlement atomically covers raw telemetry, credential/account mapping, account-level UTC-second de-duplication, observed-time Premium evaluation, Tehran-day grouping, debit evidence and Free-ledger mutation.

Unknown managed credential telemetry is preserved as `unmapped` with zero debit and blocks acceptance until explained.

Premium is evaluated at the observed bucket time; delayed Premium-period evidence cannot later debit Free simply because the report arrived after expiry. Tehran-day attribution also uses observed bucket time.

## Status and non-secret diagnosis

```bash
sudo ./install.sh status
sudo systemctl status madar-node-agent.service --no-pager
sudo systemctl status madar-xray.service --no-pager
sudo systemctl is-active madar-node-agent.service
sudo systemctl is-active madar-xray.service
sudo journalctl -u madar-node-agent.service --since '15 minutes ago' --no-pager
sudo journalctl -u madar-xray.service --since '15 minutes ago' --no-pager
```

Do not `cat` secrets or the outbox as evidence.

Permission checks without exposing contents:

```bash
sudo stat -c '%a %U:%G %n' /etc/madar-node-agent/node.credential
sudo stat -c '%a %U:%G %n' /etc/madar-node-agent/reality.private
sudo stat -c '%a %U:%G %n' /etc/madar-node-agent/agent.env
sudo stat -c '%a %U:%G %n' /etc/madar-node-agent/telemetry-outbox.sqlite3
sudo stat -c '%a %U:%G %n' /etc/madar-node-agent
sudo stat -c '%a %U:%G %n' /run/madar-node-agent/xray-authorized
```

Expected persistent sensitive-file/outbox mode is `600`; persistent state-directory mode is `700`. The runtime marker, when current authorization exists, is also owner-only.

## Aggregate diagnosis

For controlled diagnosis only:

```bash
sudo ./install.sh observe
```

Example:

```json
{"onlineUsers":1}
```

This is aggregate presence diagnosis only, not billing evidence. Never expose port `10085` publicly.

## Update

```bash
sudo ./install.sh update
```

Current updater ordering is regression-tested:

1. refresh Agent files;
2. stage Agent unit;
3. stage Xray unit;
4. `daemon-reload`;
5. restart **Agent only**.

It never independently enables/starts/restarts Xray. Agent restart invalidates the old runtime marker, the bound Xray lifetime closes with the old activation, and the replacement Agent must obtain fresh authorization before Xray may serve again.

## Remove

```bash
sudo ./install.sh remove
```

Removal stops/disables Madar services and removes Madar-managed credential/runtime/unit/state paths. It does not modify SSH or firewall configuration.

## Repository evidence for Gate J remediation

Repository code head before documentation reconciliation:

```text
1b7dee80fd068b76beaaf1ac27d9dbd0cd531c94
```

Full CI:

```text
38070242737 — SUCCESS
```

Coverage includes lifecycle marker/state handling, Xray authorization order/failure cleanup, systemd lifetime binding, Agent startup/shutdown matrix, updater ordering, secret scan, database gates, dependency audits, full application tests, typecheck, build and Python tests.

This evidence does **not** prove the new lifecycle on the real VPS.

Companion repository remediation report:

```text
docs/test-reports/phase-7-vps-gate-j-remediation.md
```

Historical real field evidence remains in:

```text
docs/test-reports/phase-7-vps.md
```

## Real Phase 7 / Gate J rerun

The next lifecycle field pass must deploy one exact final head and prove:

1. original controlled startup stop-command failure no longer leaves serving Xray;
2. repeated direct external VLESS+REALITY probes fail while Agent is failed/unfresh;
3. manual Xray start with Agent inactive/no marker cannot serve;
4. Agent crash/kill pulls Xray down through systemd binding;
5. Agent restart with control plane unavailable leaves old marker gone/Xray down;
6. fresh policy can authorize a new marker and restore healthy access;
7. runtime/outbox initialization failure leaves Xray down;
8. reboot exposes no stale access before fresh authorization;
9. marker is ephemeral across stop/restart/reboot and restrictive while present;
10. bounded logs/privacy and existing state-file permissions remain intact.

Only that real pass can close Gate J.

## Historical evidence boundary

The 2026-10-10 real field pass already proved substantial transport/accounting behavior but also reproduced Gate J: injected startup stop failure caused Agent exit while the previously running Xray process remained active and two direct external probes still succeeded. That historical failure is intentionally preserved and is not overwritten by repository automation.

Historical identifier-bearing journal entries also remain preserved by explicit user decision.

## Premium concurrency remains separate

Premium still requires one active client instance/device per copied configuration. Stock Xray transport-session count and public IP are not trustworthy device identity and are not approved substitutes. This is not implemented by Free accounting or the Gate J lifecycle work.

Do not advertise Premium single-device enforcement until a separate design plus real client acceptance passes.

## Safety/release status

- enrollment tokens are one-time and short-lived;
- node credentials are hash-only in control plane and plaintext only on node with restrictive permissions;
- REALITY private keys remain VPS-only;
- stale authorization is fail-closed;
- systemd-active does not automatically mean ready;
- repository lifecycle remediation is implemented/CI-verified;
- real Gate J rerun is still required;
- Phase 7 is **INCOMPLETE**;
- Phase 8 is unstarted;
- Production Ready is not claimed.
