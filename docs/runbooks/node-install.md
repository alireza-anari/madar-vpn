# Madar node installation and lifecycle

This runbook documents the Madar Node Agent installer, pinned Xray/VLESS/REALITY runtime, UTC-aligned server-observed activity sampling, durable bitmap telemetry outbox, and the Phase 7 field gate.

A disposable Ubuntu VPS was exercised on 2026-10-10 for installation/enrollment, systemd health, earlier reboot behavior, direct VLESS+REALITY traffic, credential revoke/replacement, stale-policy behavior, and bounded log privacy. A later exact-head field pass also exercised UTC bitmap accounting, outbox persistence, capability negotiation, and PostgreSQL settlement. It reproduced a startup stop-failure blocker: Agent exit does not stop the independent already-running Xray process. Phase 7 remains incomplete; see the new field section in `../test-reports/phase-7-vps.md`.

Real v2rayNG acceptance is a separate later gate. Premium single-active-client enforcement is also a separate unresolved release gate and must not be inferred from the Free accounting implementation.

## Supported environment

The agent validates Ubuntu LTS `22.04`, `24.04`, or `26.04` on `x86_64`/`amd64` or `aarch64`/`arm64`.

Run the installer as `root`. Madar files live under `/opt/madar-node-agent`, pinned Xray under `/opt/madar-xray`, state under `/etc/madar-node-agent`, and systemd units under `/etc/systemd/system`.

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

`MADAR_REALITY_TARGET` is explicit. Ordinary TLS success alone does not prove REALITY compatibility. During the first real field run, `www.microsoft.com:443` passed ordinary verified TLS but the pinned REALITY clients failed with EOF; the same keys/client worked after switching target/SNI to `www.cloudflare.com`.

Do **not** set a REALITY private key or public key manually. The installer verifies the reviewed pinned Xray release, generates X25519 material locally, keeps the private key VPS-only, and enrolls only public client-safe values.

Never place the one-time enrollment token in an environment variable, command-line argument, shell history, documentation, logs, source control, or chat. The wrapper reads it silently and passes it to Python on file descriptor 3.

## Install

From the checked-out `node-agent` directory:

```bash
sudo -E ./install.sh install
```

Installation stages the Node Agent, verifies pinned Xray, generates REALITY keys locally, enrolls with the one-time token, stores the node credential with restrictive permissions, stages systemd units, and starts the Node Agent only after successful enrollment.

Sensitive/local state:

```text
/etc/madar-node-agent/node.credential
/etc/madar-node-agent/reality.private
/etc/madar-node-agent/agent.env
/etc/madar-node-agent/telemetry-outbox.sqlite3
```

Sensitive files and the telemetry outbox are owner-only `0600`; the state directory is `0700`. `agent.env` contains configuration paths/public runtime values, never the raw node credential or REALITY private key. The outbox rejects an existing symlink or non-regular path.

## Service behavior

Node Agent:

```text
/opt/madar-node-agent/venv/bin/python -m madar_agent.service
```

Managed Xray:

```text
/opt/madar-xray/26.3.27/xray run -c /etc/madar-node-agent/xray-config.json
```

The Agent validates candidate Xray config before atomic promotion and restarts Xray only after valid managed configuration is promoted. Xray access logging is disabled with `log.access = "none"`.

A persisted `xray-config.json` is **not** authorization for a fresh Agent process. The Agent unit depends only on `network-online.target`; it does not `Wants`/`After` the Xray service. Every fresh Agent process first stops managed Xray before runtime/outbox construction. If that stop fails, startup is refused. If later runtime/outbox construction fails, Xray remains stopped and only a generic error is logged. A fresh control-plane policy cycle must re-establish authorized managed state before Xray can be promoted/restarted.

This current boot ordering is repository/CI verified and still requires a real reboot rerun.

The current-head field test additionally proved that a failed startup stop command leaves the prior Xray process and real client access alive while the Agent exits with status 4. Do not treat that exit status as proof of closed access. The field run explicitly stopped both services and applied an empty policy when collecting the test; lifecycle remediation and the complete current-head reboot/failure matrix remain open.

The 30-second control-plane cycle performs policy fetch/apply/ack, pending usage delivery, Xray health, authorization freshness, and heartbeat/readiness. Managed access fails closed when authorization is absent/stale, environment validation fails, or policy is invalid. Expiry enforcement is cycle/request-bound, not an exact wall-clock timer.

## Server-observed Free activity sampler

Managed Xray exposes `StatsService` only on loopback `127.0.0.1:10085` and enables:

- `statsUserOnline` only for aggregate operator diagnosis;
- `statsUserUplink` and `statsUserDownlink` for cumulative per-managed-credential traffic observation.

`onlineUsers`, unique online IPs, raw transport-connection count, browser state, and access logs are **not** billing clocks.

The approved Free rule is account-level active traffic time: at most one Free second per account per server-observed UTC second bucket, regardless of how many connections, devices, credentials, or nodes overlap in that bucket.

The Node Agent uses a UTC-aligned one-second sampler:

- first valid sample establishes a baseline and creates zero activity;
- a positive uplink or downlink byte delta across consecutive trusted scheduled boundaries marks exactly the preceding UTC second bucket active;
- unchanged counters mark idle and create zero activity;
- a new/missing client, counter decrease/reset, query failure, non-monotonic time, missed boundary, or observation later than the allowed post-boundary skew breaks continuity and creates zero inferred activity across the ambiguous interval;
- delayed worker execution recomputes the next UTC boundary and skips missed seconds instead of replaying/catching up;
- no `sessionId` is fabricated.

The current default post-boundary observation-skew tolerance is `0.75s`. It is automated-tested and must be field-measured/validated before Phase 7 PASS.

The sampler never intentionally emits raw StatsService output. Raw per-client stats may contain credential-derived identifiers and must not be copied to chat, tickets, screenshots, CI output, or reports.

## Durable telemetry outbox v2

Every trusted active UTC bucket is persisted immediately to:

```text
/etc/madar-node-agent/telemetry-outbox.sqlite3
```

The current local schema uses `PRAGMA user_version = 2`.

For new aligned activity, the outbox stores a per-client/per-UTC-minute low-60-bit bitmap. Bit `0` represents second `:00`; bit `59` represents `:59`. When a pending report is frozen, the bitmap is serialized as exactly 16 lowercase hexadecimal characters in `activeSecondsHex`, and `seconds` equals the bit population count.

The outbox:

- ORs repeated evidence for the same exact bucket idempotently;
- transactionally allocates monotonic per-window `sequence` values;
- freezes immutable pending reports including `activeSecondsHex`;
- returns the exact same pending `(windowId, sequence, seconds, activeSecondsHex, timestamps)` after Agent restart until acknowledgement;
- compares the bitmap as part of ACK identity;
- keeps pending reports until the control plane accounts for the complete submitted batch;
- accepts complete settlement when exact integer `accepted + duplicates == submitted report count`;
- leaves pending data intact for malformed, partial, contradictory, boolean/string count, or otherwise ambiguous responses;
- keeps the DB `0600` and parent state directory `0700`;
- fails closed on unsupported future local schema versions.

### Upgrade from the old local outbox

The deployed older outbox had aggregate `seconds` without exact bucket positions. Migration to v2 preserves existing pending reports with `activeSecondsHex = null` and preserves accumulated old aggregate activity as legacy reports. It **never invents bitmap bits** for historical aggregate seconds.

Legacy reports may still be delivered/ACKed for durability during mixed-version rollout, but they do not create new active-second Free debit in the new authoritative settlement path.

Sampling continuity itself is not persisted. The first Xray counter observation after Agent restart is baseline-only, so an ambiguous restart gap creates zero inferred usage.

If a durable bucket write fails, sampler continuity is invalidated and the next valid observation is baseline-only.

## Telemetry capability negotiation

The new control plane exposes an authenticated node endpoint:

```text
GET /api/node/telemetry/capabilities
```

The current response advertises:

```json
{"activeSecondsV1":true}
```

A new Agent must probe this capability before any batch containing `activeSecondsHex`.

- capability true: send the exact pending masked report;
- authenticated `404` from an older server: treat active-second telemetry as unsupported and keep the masked report pending unchanged;
- missing/invalid capability response: do not downgrade, strip, ACK, or fabricate the bitmap;
- legacy pending reports without a bitmap may still be sent to an older server.

This makes **server-first deployment** the supported rollout order and prevents an accidental Agent-first overlap from silently losing active-second evidence.

## Authoritative PostgreSQL settlement

Migration:

```text
packages/database/src/migrations/0002_active_second_accounting.sql
```

The control plane stores raw telemetry identity, account-level settled minute masks, Premium entitlement history, and immutable usage-debit evidence. New masked settlement is atomic: raw telemetry acceptance, account mapping, unseen-bit de-duplication, observed-time entitlement evaluation, debit evidence, and Free ledger mutation commit or roll back together.

Global Free debit uniqueness is account-level UTC second identity, not connection/session multiplicity. Overlap from two nodes or two credential versions for the same account is charged once.

Telemetry for an unknown managed credential is preserved as `unmapped` evidence with zero debit and blocks Phase 7 acceptance until explained/resolved.

Premium is evaluated at the observed bucket time. A bucket observed while Premium was active cannot debit Free credit merely because telemetry arrives after Premium expiry. Tehran-day attribution also uses the observed bucket, so delayed prior-day evidence cannot debit the new day's Free balance.

## Existing PostgreSQL deployment order

For an existing database that already has migration `0001_core.sql`, **do not rerun 0001**.

Supported rollout order:

1. take and verify a PostgreSQL backup/preflight;
2. apply **only** `0002_active_second_accounting.sql` to the existing database, using the intended schema-owner role; verify that the API role can access the new accounting tables and identity sequence before upgrading Agents. A privileged migration session can otherwise leave new tables owned by a different role and cause telemetry HTTP `500` / PostgreSQL `42501`;
3. deploy the new control plane;
4. authenticate as a node and verify the telemetry-capabilities endpoint reports active-second support;
5. only then upgrade/restart Node Agents;
6. verify no masked field telemetry becomes `unmapped` before proceeding broadly.

The CI migration loop that applies all migration files lexically is a fresh-schema verifier; it is not an instruction to replay `0001` against an existing production database.

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

Before sharing logs, inspect/redact bearer values. Never `cat` `node.credential`, `reality.private`, or the SQLite outbox as evidence.

Permission checks without revealing contents:

```bash
sudo stat -c '%a %U:%G %n' /etc/madar-node-agent/node.credential
sudo stat -c '%a %U:%G %n' /etc/madar-node-agent/reality.private
sudo stat -c '%a %U:%G %n' /etc/madar-node-agent/agent.env
sudo stat -c '%a %U:%G %n' /etc/madar-node-agent/telemetry-outbox.sqlite3
sudo stat -c '%a %U:%G %n' /etc/madar-node-agent
```

Expected file mode is `600`; expected state-directory mode is `700`.

## Aggregate online-state diagnosis

For controlled diagnosis only:

```bash
sudo ./install.sh observe
```

Example output:

```json
{"onlineUsers":1}
```

This uses loopback Xray StatsService and emits only the aggregate Madar online count. It is useful for connect/disconnect/revoke correlation only and is **not** the billing source. Never expose port `10085` publicly.

## Update

```bash
sudo ./install.sh update
```

The lifecycle command refreshes checked-out Agent/service assets and restarts `madar-node-agent.service`. On restart, the Agent first stops managed Xray and re-establishes authorized managed state.

## Remove

```bash
sudo ./install.sh remove
```

Removal stops/disables both Madar services and removes Madar-managed credentials, agent/runtime files, units, and state. It does not change SSH/firewall configuration.

## Historical first field pass

Already field-verified on 2026-10-10 under the then-current code:

- real installer + one-time enrollment;
- original sensitive-file permissions;
- real systemd/Xray health and two reboot scenarios under the older unit/runtime ordering;
- direct external VLESS+REALITY traffic with VPS egress;
- aggregate online presence including the controlled idle-open experiment;
- live credential revoke/replacement;
- stale-policy/control-plane-outage fail-closed after the field fix;
- bounded post-fix log privacy.

These are historical observations. They do **not** prove the later UTC-bitmap sampler, v2 outbox, capability negotiation, atomic debit settlement, or current boot ordering on the real VPS.

Historical identifier-bearing journal entries remain preserved by explicit user decision. Do not erase or reinterpret them as clean history.

## Current Phase 7 field acceptance

The next real-VPS pass must deploy one exact current head and prove all of the following before Phase 7 can become PASS:

1. the pinned Xray managed configuration exposes the expected per-user uplink/downlink cumulative counters;
2. sustained direct VLESS+REALITY traffic creates the expected UTC active-second bitmap, durable local report, accepted PostgreSQL telemetry, and exactly-once Free debit;
3. an idle open connection with unchanged counters creates no new bitmap bits or debit;
4. multiple overlapping connections in the same UTC seconds do not multiply Free debit;
5. Xray reset/restart, missed boundary, observation failure, or excessive skew creates no inferred active seconds across the ambiguous interval;
6. restart the Agent before local ACK in an ambiguous-delivery scenario and prove the exact same `(windowId, sequence, seconds, activeSecondsHex)` returns and settles/debits once; server duplicate classification must safely clear that same report;
7. a malformed/incomplete telemetry acceptance response leaves the pending report intact;
8. outbox/state permissions remain `0600`/`0700` and no client identifiers, secrets, raw stats, or outbox contents leak to logs;
9. reboot/restart the **current** Agent/systemd code and prove persisted stale Xray client access never becomes available before fresh authorization/policy;
10. no masked field report is left `unmapped`;
11. delayed Premium-period and Tehran-day behavior is proven at least against the real disposable control-plane/PostgreSQL integration used for the field pass.

Cross-node overlap de-duplication remains a later multi-node field gate unless a second real node is available during this rerun.

The former blocker requiring combined Free debit for same-UUID simultaneous sessions is removed because that is no longer the approved Free product rule.

## Premium concurrency remains separate

Premium still requires one active client instance/device per copied configuration. Stock Xray transport/session count and public IP are not sufficient device identity. This is not implemented by the Free accounting path and must receive a separate approved design plus real v2rayNG acceptance before Production Ready.

Do not advertise or claim Premium single-device enforcement until that gate is solved.

## Safety rules

- Enrollment tokens are one-time and short-lived.
- Node credentials are hash-only in the control plane and plaintext only on the node with restrictive permissions.
- REALITY private keys remain VPS-only.
- Never expose raw node credentials, enrollment tokens, REALITY private keys, session/subscription/provider secrets, raw per-client StatsService output, or SQLite outbox contents in shared commands/logs/screenshots/reports.
- Do not weaken key/credential/outbox permissions to bypass validation.
- A systemd-active node is not necessarily ready; readiness requires fresh authorization, valid policy, real Xray health, and acknowledged control-plane state.
- Stale authorization is always fail-closed.

## Verification scope

Repository/CI coverage now includes installer/lifecycle safety, credential permissions, pinned Xray/checksums, REALITY local-key handling, Xray validation/promotion, apply/revoke/fail-closed, policy freshness, telemetry sequencing, enrollment/auth, policy acknowledgements, readiness/capacity, loopback-only StatsService, per-user traffic-counter parsing, deterministic UTC one-second sampling, ambiguous-gap zero inference, local bitmap outbox v2 and v1 migration, immutable bitmap retry identity, complete ACK response validation, authenticated capability negotiation, safe old-server behavior, atomic PostgreSQL active-second settlement, cross-node/account-level overlap de-duplication, observed-time Premium evaluation, Tehran-day attribution, startup fail-closed behavior, and systemd ordering.

Automation still does **not** establish live updated-VPS traffic/debit correctness, live idle no-debit, real crash/reboot durability of the bitmap outbox/current boot ordering, real multi-node overlap, Premium single-client enforcement, real v2rayNG E2E, actual Cloudflare/Hyperdrive production deployment, or Production Ready status.
