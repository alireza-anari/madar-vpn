# Madar node installation and lifecycle

This runbook documents the Madar Node Agent installer, Xray/VLESS/REALITY runtime, the Phase 7 server-observed traffic sampler, and the durable local telemetry outbox. Real installation, enrollment, reboot, direct VLESS+REALITY traffic, revoke, and stale-policy fail-closed behavior were exercised on a disposable Ubuntu VPS on 2026-10-10. The newer traffic-to-telemetry sampler, durable outbox, and boot-level stale-Xray protections are automated/CI verified but still require a second real-VPS field pass before Phase 7 can be marked complete. Real v2rayNG compatibility is a separate Phase 8 gate.

## Supported environment

The agent validates Ubuntu LTS `22.04`, `24.04`, or `26.04` on `x86_64`/`amd64` or `aarch64`/`arm64`.

Run the installer as `root`. Madar files live under `/opt/madar-node-agent`, the pinned Xray runtime under `/opt/madar-xray`, state under `/etc/madar-node-agent`, and systemd units under `/etc/systemd/system`.

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

`MADAR_REALITY_TARGET` is explicit; the installer does not invent one. Choose and test it with the pinned runtime. Ordinary TLS success alone does not prove REALITY compatibility. In the 2026-10-10 field run, `www.microsoft.com:443` passed ordinary TLS validation but REALITY failed with EOF, while the same keys/client worked after switching target/SNI to `www.cloudflare.com`.

Do **not** set a REALITY private key or public key manually. The installer downloads the reviewed pinned Xray release, verifies its SHA-256 digest, generates the X25519 keypair locally, keeps the private key VPS-only, and enrolls only public client-safe values.

Never place the one-time enrollment token in an environment variable, command-line argument, shell history, documentation, logs, or source control. The wrapper reads it silently and passes it to Python on file descriptor 3.

## Install

From the checked-out `node-agent` directory:

```bash
sudo -E ./install.sh install
```

Installation:

1. stages the Node Agent;
2. downloads and verifies pinned Xray;
3. generates REALITY key material locally;
4. enrolls with the one-time token;
5. stores the node credential with restrictive permissions;
6. stages Node Agent and Xray systemd units;
7. starts the Node Agent only after successful enrollment.

Sensitive/local state:

```text
/etc/madar-node-agent/node.credential
/etc/madar-node-agent/reality.private
/etc/madar-node-agent/agent.env
/etc/madar-node-agent/telemetry-outbox.sqlite3   # created by the Agent runtime
```

The credential, REALITY private key, environment file, and telemetry outbox are owner-only `0600`; the state directory is restrictive (`0700`). `agent.env` contains configuration paths/public runtime values, never the raw node credential or REALITY private key. Failed enrollment must not leave a persisted credential or falsely-ready service. The outbox rejects a pre-existing symlink or non-regular DB path rather than following it.

## Service behavior

Node Agent:

```text
/opt/madar-node-agent/venv/bin/python -m madar_agent.service
```

Managed Xray:

```text
/opt/madar-xray/26.3.27/xray run -c /etc/madar-node-agent/xray-config.json
```

The Node Agent validates candidate Xray config before atomic promotion and restarts Xray only after a valid config is promoted. Access logging is explicitly disabled with `log.access = "none"`; warning log level by itself is not sufficient to prevent client-identifier access logs.

A persisted `xray-config.json` is **not** authorization for a fresh Agent process. The Agent systemd unit depends only on `network-online.target`; it does not `Wants`/`After` the Xray service. At every Agent process start, the Agent first stops managed Xray **before** runtime/outbox construction. If Xray cannot be stopped, runtime construction is refused. If runtime/outbox construction then fails, Xray remains stopped and only a generic startup error is logged. The first control-plane cycle re-establishes fail-closed managed state and only then can a freshly validated policy promote/restart Xray. This boot ordering is repository/CI verified and still needs a real reboot rerun on the disposable VPS.

The 30-second control-plane cycle performs policy fetch/apply/ack, usage collection/posting, Xray health, authorization freshness, and heartbeat/readiness. Managed access fails closed when authorization is absent/stale, environment validation fails, or managed policy is invalid. Expiry is enforced before a policy request and rechecked when an in-flight request returns or raises, so retry exhaustion cannot preserve stale access. This is cycle/request-bound enforcement, not an exact deadline timer.

### Server-observed traffic activity sampler

Managed Xray config exposes `StatsService` only on loopback `127.0.0.1:10085` and enables:

- `statsUserOnline` for aggregate operator diagnosis;
- `statsUserUplink` and `statsUserDownlink` for per-managed-client cumulative byte observation.

The billing sampler is **not** based on `onlineUsers`. The real field test proved an idle open connection can remain online for more than a minute with no response payload.

The Node Agent samples cumulative per-user uplink/downlink counters on a dedicated approximately one-second background worker. The algorithm is deliberately conservative:

- first sample establishes a baseline and charges zero;
- between adjacent valid samples, any positive uplink or downlink byte delta creates exactly **one observed activity second** for that client;
- unchanged counters are idle and create zero activity;
- a new/missing client, decreasing counter (Xray restart/reset), non-monotonic time, observation failure, or sampling gap greater than `2.5s` breaks continuity/rebaselines and creates zero inferred seconds across the ambiguous interval;
- observed activity is grouped by client and UTC-minute window IDs such as `xray-traffic:2026-10-10T07:00Z`;
- no `sessionId` is fabricated from aggregate per-user counters.

The sampler never intentionally emits raw StatsService output. Query failures/malformed output are reduced to generic errors. Raw per-client Xray stats can contain client UUID-derived identifiers and must not be copied to chat, tickets, screenshots, CI, or reports.

### Durable telemetry outbox

Observed activity no longer depends on RAM-only batching. In the production runtime, every active one-second tick is written immediately to:

```text
/etc/madar-node-agent/telemetry-outbox.sqlite3
```

The SQLite outbox:

- durably aggregates unprepared activity by client/window;
- transactionally allocates monotonic per-window `sequence` values;
- converts accumulated activity into immutable pending `UsageReport` rows;
- returns the exact same pending report identity/payload after Agent process or VPS restart until it is acknowledged;
- deletes pending reports only after the control-plane telemetry response accounts for **every** submitted report;
- accepts a report as accounted for when the server classifies it as newly `accepted` or an idempotent `duplicate`;
- requires `accepted` and `duplicates` to be non-negative JSON integers and requires `accepted + duplicates == submitted batch size`;
- treats malformed, partial, contradictory, boolean/string count, or otherwise ambiguous 2xx responses as invalid and leaves the outbox pending;
- keeps the DB `0600` and its parent state directory `0700` and rejects symlink/non-regular DB paths.

Sampling baseline is intentionally **not** persisted. After an Agent restart, the first Xray counter sample is baseline-only and the restart gap is charged as zero rather than inventing usage. Already persisted activity and pending reports do survive the restart.

If the durable activity write itself fails, sampling continuity is invalidated and the error is propagated to the sampler worker; the next successful observation is baseline-only. This avoids pretending an unpersisted interval was safely recorded.

Important current limits:

1. The durable outbox/restart/ACK behavior is automated/CI verified but has **not yet been rerun on the real disposable VPS**. Do not claim live crash/reboot-durable accounting until the field procedure below passes.
2. Xray's counters are aggregate per VLESS client UUID. Two simultaneous sessions using the same UUID cannot currently be distinguished by this sampler, so the product requirement that distinct simultaneous VPN sessions debit their combined actual usage is **not yet proven/solved** by this mechanism.
3. Real transfer -> durable outbox -> telemetry -> PostgreSQL settlement -> free-credit debit, and idle -> no debit, must be demonstrated on the VPS before Phase 7 PASS.

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

Expected file mode is `600`; expected state-directory mode is `700`. The outbox exists only after the current Agent runtime has initialized it.

## Aggregate online-state diagnosis

For controlled diagnosis only:

```bash
sudo ./install.sh observe
```

Example output:

```json
{"onlineUsers":1}
```

This wrapper calls loopback Xray StatsService and emits only the aggregate Madar online count. It intentionally does not print raw `statsgetallonlineusers` output. On failure it emits only `local Xray observation unavailable`.

`observe` is **not** the billing source. It is useful for connect/disconnect/revoke correlation only. Do not infer active seconds from it.

Never expose port `10085` publicly.

## Update

```bash
sudo ./install.sh update
```

The lifecycle command refreshes checked-out agent/service assets and restarts `madar-node-agent.service`. The restarted Agent first stops Xray and re-establishes authorized managed state; treat this updated behavior as automated-only until a real-VPS update/restart result is recorded.

## Remove

```bash
sudo ./install.sh remove
```

Removal stops/disables both Madar services and removes Madar-managed credentials, agent/runtime files, units, and state. It does not change SSH/firewall configuration.

## Phase 7 field acceptance

Already field-verified on 2026-10-10:

- real installer + one-time enrollment;
- secret file permissions for the original sensitive state;
- real systemd/Xray health and two reboot scenarios under the then-current unit ordering;
- direct external VLESS+REALITY traffic with VPS egress;
- live credential revoke/replacement;
- stale-policy/control-plane-outage fail-closed after the field fix;
- bounded post-fix log privacy check.

Still required for the current sampler/outbox/startup code before Phase 7 PASS:

- deploy the current branch to the existing disposable VPS and verify `statsUserUplink/downlink` are available from the real pinned Xray process;
- perform a controlled sustained transfer and prove real activity ticks are durably persisted, become telemetry reports in PostgreSQL, and cause the expected free-credit debit exactly once;
- keep a controlled connection idle and prove no additional durable activity/credit debit occurs while byte counters remain unchanged;
- verify sampler failure/Xray reset or restart does not invent seconds across the gap;
- force an ambiguous telemetry-delivery scenario, restart the Agent **before outbox acknowledgement**, and prove the same `(windowId, sequence, seconds)` returns after restart and settles/debits only once; a retry classified by the server as duplicate must safely clear the same pending report;
- verify a malformed/partial 2xx telemetry response leaves the pending outbox report intact;
- verify outbox/state permissions remain `0600`/`0700` and no client identifiers/outbox contents leak to logs;
- reboot/restart the current units and prove persisted stale Xray client access is unavailable before fresh authorization/policy is established;
- resolve/implement the remaining same-credential concurrent-session accounting mechanism required for combined simultaneous usage.

Do not mark Phase 7 PASS from CI alone. Do not start/claim Phase 8 complete until Phase 7's remaining usage-accounting gate is resolved.

## Safety rules

- Enrollment tokens are one-time and short-lived.
- Node credentials are hash-only in the control plane and plaintext only on the node with restrictive permissions.
- REALITY private keys remain VPS-only.
- Never expose raw node credentials, enrollment tokens, REALITY private keys, session/subscription/provider secrets, raw per-client StatsService output, or SQLite outbox contents in shared commands/logs/screenshots/reports.
- Do not weaken key/credential/outbox permissions to bypass validation.
- A systemd-active node is not necessarily ready; readiness requires fresh authorization, valid policy, real Xray health, and acknowledged control-plane state.
- Stale authorization is always fail-closed.

## Verification scope

Automated coverage now includes installer/lifecycle safety, credential permissions, pinned Xray/checksums, REALITY local-key handling, Xray validation/promotion, apply/revoke/fail-closed, policy freshness, telemetry sequencing, enrollment/auth, policy acknowledgements, readiness/capacity, systemd staging, loopback-only StatsService, redacted aggregate observation, per-user uplink/downlink counter parsing, conservative one-second traffic-delta activity semantics, sampler lifecycle/failure invalidation, durable SQLite tick/report persistence, immutable retry identity across reopen/restart, monotonic sequence allocation, exact outbox acknowledgement, complete `accepted + duplicates` telemetry-response validation, startup fail-closed behavior, and systemd ordering that prevents the Agent from auto-starting persisted Xray state before authorization.

Still not established by automation alone: live traffic-derived telemetry/debit correctness on the updated VPS code, live idle no-debit on the deployed sampler, real restart/outage durability of the local outbox and new boot ordering, same-UUID concurrent-session multiplicity, real v2rayNG, actual Cloudflare/Hyperdrive production deployment, and Production Ready status.
