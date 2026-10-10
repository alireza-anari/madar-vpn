# Phase 7 VPS Integration Report

Date: 2026-10-10  
Branch: `impl/phase-1`

## Status

**Phase 7: INCOMPLETE after real-VPS execution plus later repository/CI active-second implementation. Do not mark PASS.**

A real disposable AWS EC2 Ubuntu VPS already verified installation/enrollment, systemd health, two reboot scenarios under the then-current runtime/unit behavior, direct external VLESS+REALITY traffic, aggregate online observation, live credential revocation/replacement, and control-plane-outage expiry after a fail-closed fix. The field run also exposed and fixed client-UUID access-log leakage.

After that first field run, the branch evolved substantially. The current repository/CI path now includes:

- Xray per-user cumulative uplink/downlink counters;
- deterministic UTC one-second sampling;
- exact per-minute active-second bitmap evidence;
- SQLite telemetry outbox schema v2 with safe legacy migration;
- immutable retry identity including `activeSecondsHex`;
- complete telemetry ACK validation;
- authenticated active-second capability negotiation for mixed-version rollout;
- authoritative Premium entitlement history for observed-time Free billing;
- atomic PostgreSQL raw telemetry + account-level active-second de-duplication + debit settlement;
- stronger boot-level stale-Xray fail-closed ordering.

Those newer components are repository/CI verified, but **the current exact code has not yet been deployed and exercised end-to-end on the real VPS**. Therefore this report makes no new live bitmap/debit/restart-durability claim. Phase 7 remains incomplete and Phase 8 remains unstarted.

The approved product rule also changed after the first field run: Free usage no longer multiplies by same-credential session count. Free billing is now account-level active traffic time, at most once per account per server-observed UTC second bucket. Premium single-active-client/device enforcement is a separate unresolved release gate and is not implemented by the Free accounting path.

Earlier client-identifying journal entries remain on the disposable VPS at the user's explicit request; later fixed logs were separately checked without deleting history.

## Real field environment and scope

- VPS: AWS EC2 `t3.micro`, Stockholm (`eu-north-1`), Ubuntu `24.04`, `x86_64`, Python `3.12.3`; sudo/systemd verified over SSH.
- Baseline checkout for the first field run: branch `impl/phase-1`, commit `12e1f5c754a29da7cdb463db4d378eb56b8d8777`, followed by documented field fixes through `e0ff90bec6fbd4f13d4a90cdddd48fd3a27e568a`.
- Installer executable mode was corrected from `100644` to `100755`; direct wrapper execution was verified.
- No production control plane existed. The approved disposable field environment hosted the existing API assembly plus real PostgreSQL stores on the VPS. It used the production runtime's Hyperdrive-shaped connection-string binding but **did not** exercise an actual Cloudflare Worker/Hyperdrive deployment.
- A fresh PostgreSQL database used the repository authoritative schema. Disposable auth/admin/user data and a hashed one-time login bootstrap were used to obtain the real CSRF-protected admin enrollment flow. This is not real email-provider acceptance.
- Disposable HTTPS was loopback-only with certificate/hostname verification enabled; PostgreSQL and Xray StatsService were loopback-only.
- Pinned Linux Xray `26.3.27` came from the real installer and repository checksum. The external Windows test client used the official matching release and verified asset digest.
- Direct VLESS+REALITY success used port `443` with ingress restricted to the test computer. Successful probes returned the VPS public egress address.
- Real revisioned PostgreSQL policies were published by the disposable field operator and fetched/ACKed through the node HTTPS API. This proves that field path, not a production scheduler.

## Field observations from the first real pass

| Check | Actual evidence | Result / limit |
| --- | --- | --- |
| Real installer and enrollment | `./install.sh install`; fresh token through authenticated admin API; replay HTTP `401` | PASS |
| Secret permissions | `node.credential`, `reality.private`, `agent.env` each `0600` | PASS |
| Real policy and service health | Revision ACKed; Node Agent/Xray active; heartbeat healthy/ready/accepting | PASS |
| Reboot | Boot identity changed; control plane, agent, Xray recovered; fresh policy/readiness returned | PASS for observed older unit/runtime behavior |
| Startup with control plane disabled | Second reboot; agent/Xray active with managed clients `0`; external credential denied before control plane re-enabled | PASS for observed post-startup state; newer boot ordering still needs rerun |
| Direct external traffic | Multiple direct VLESS+REALITY probes traversed VPS; public egress matched VPS | PASS |
| Aggregate during transfer | Aggregate online changed from `0` to `1` during valid active-transfer samples | Presence observed; not duration evidence |
| Idle open connection | Aggregate stayed `1` through roughly 62 seconds while a controlled HTTP connection remained open without response payload | Proves online != active traffic |
| Disconnect | Aggregate returned to `0` after client termination | Transition observed |
| Live revoke | Active old credential revoked/replaced through real policy propagation; old transfer closed and aggregate became `0` | PASS |
| Old vs replacement credential | Old credential denied; replacement credential succeeded with VPS egress | PASS |
| Baseline outage expiry | Initial run reproduced stale managed access after policy expiry while control plane unavailable | FAIL reproduced; prompted fix |
| Fixed outage expiry | After fix, expired authorization produced managed client count `0` and fresh traffic denial while control plane remained stopped | PASS; cycle/request-bound rather than exact timer |
| Control-plane secret audit | Raw node credential and REALITY private key absent from inspected stored control-plane data | PASS for observed snapshot |
| Baseline log privacy | Xray default access logger exposed disposable client UUID | FAIL reproduced; historical journal intentionally retained |
| Fixed log privacy | Bounded post-fix runtime logs contained no node credential, REALITY private key, client UUID, admin session/CSRF secret, bearer pattern, or PEM private key | PASS for bounded post-fix interval |
| Live telemetry/debit at first field run | PostgreSQL contained `0` telemetry reports and `0` reported seconds because no activity source was wired at that time | NOT PASS; current branch is different and field rerun is pending |
| Current bitmap outbox/accounting/current boot ordering | Added after first field run | NOT RUN on VPS; repository/CI evidence only |

Ordinary TLS success did not prove REALITY suitability. `www.microsoft.com:443` passed ordinary verified TLS but the pinned REALITY clients failed with EOF; the same keys/client worked when target/SNI changed to `www.cloudflare.com`. This was consistent with an upstream issue investigated at the time, but the field test did not enable raw REALITY debug output or establish a definitive upstream root cause.

## Field fixes from the first real-VPS run

- Restored installer executable mode.
- Set managed Xray `log.access` to `none`; the regression assertion failed against baseline then passed after the narrow fix. Historical logs were not erased.
- Hardened `NodeAgent.fetch_policy` so absent/expired authorization closes access before the request and expiry is rechecked when the request returns/raises, including retry failure. Real outage behavior was rerun and verified.
- The full Python suite passed **58 tests** on the real Ubuntu host for those field fixes.
- Deployed `agent.py`/`xray.py` hashes were matched to the published checkout before the final field rerun.

The field-fix source/evidence commit `7806a1a63f624d593a1c9b25232b72d802aa2435` passed full CI in run `38030266011`. The later evidence/documentation head `e0ff90b...` passed full CI in run `38030473290`.

These results remain valid only for what was actually exercised then; they are not retroactively evidence for later bitmap accounting or current boot behavior.

## Post-field implementation history before the accounting redesign

The idle experiment invalidated `onlineUsers` as a billing clock. The branch first introduced conservative per-user byte-delta sampling and then durable retry handling.

Historical automated milestones included:

1. per-user Xray counters — full CI `38033870204` SUCCESS;
2. conservative traffic-delta activity semantics — full CI `38034115187` SUCCESS;
3. one-second background sampler wiring — full CI `38034380248` SUCCESS;
4. interim in-memory telemetry retry retention — full CI `38034665943` SUCCESS, later superseded by SQLite;
5. initial durable SQLite outbox — full CI `38035598144` SUCCESS;
6. sampler to durable sink — full CI `38039743210` SUCCESS;
7. durable runtime wiring/restart identity — full CI `38040158620` SUCCESS;
8. startup/outbox failure keeps Xray closed — full CI `38040417941` SUCCESS;
9. stronger systemd/stale-Xray boot ordering — full CI `38040870174` SUCCESS;
10. complete `accepted + duplicates` response validation before outbox ACK — full CI `38041159194` SUCCESS.

The corresponding detailed commit history remains in Git. This section is historical context; the final current design is described below.

## Approved active-second accounting redesign

The approved specification is:

`docs/superpowers/specs/2026-10-10-usage-and-premium-single-session-design.md`

The Free product rule is now:

- a positive authenticated server-observed traffic delta can mark a UTC second bucket active;
- one account can be debited at most once for the same UTC second bucket;
- overlapping connections, devices, credentials, or nodes in that same bucket do not multiply Free usage;
- idle/open presence alone is not billable;
- ambiguous gaps/resets/restarts/missed observations create zero inferred activity;
- Premium-at-observed-time buckets do not debit Free later;
- delayed prior-Tehran-day evidence cannot debit the new day's balance.

The old Phase 7 blocker requiring exact same-UUID session multiplicity for Free debit is therefore removed. Stock Xray session/IP multiplicity remains insufficient for the **separate Premium one-active-client-instance rule**, which is still unresolved.

## Current repository/CI implementation

### PostgreSQL active-second schema

Migration:

`packages/database/src/migrations/0002_active_second_accounting.sql`

The schema adds accounting rollout configuration, Premium entitlement history, account-level settled UTC-minute masks, immutable usage debit evidence, and bitmap/status fields on raw telemetry.

Fresh-schema and `0001 -> 0002` upgrade tests pass, including PostgreSQL 17 destructive backup/restore witnesses. Existing databases must apply **0002 only** after backup/preflight; `0001` must not be replayed.

### Canonical telemetry contract

New masked reports use:

- canonical window `xray-traffic:YYYY-MM-DDTHH:MMZ`;
- fixed 16-character lowercase `activeSecondsHex`;
- only bits `0..59` valid;
- all-zero invalid for a new masked report;
- `seconds` exactly equals bitmap population count;
- delivery identity `(nodeId, windowId, sequence)`;
- same delivery identity with contradictory normalized payload => conflict, not duplicate.

All mask arithmetic uses integer-safe semantics; bit 59 is covered in pure and PostgreSQL tests.

### Observed-time Premium semantics

Premium history stores authoritative control-plane mutation time and resulting expiry. Payment/provider occurrence time remains audit evidence; a delayed provider callback cannot backdate Premium and erase earlier Free usage. Extension continues from `max(server settlement now, current expiry)`.

For a one-second bucket, any Premium overlap makes the bucket conservatively non-billable because sub-second packet timing is not reconstructed.

### Atomic PostgreSQL settlement

For a new masked report, raw telemetry persistence, credential/account mapping, account-level minute locking, unseen-bit de-duplication, observed-time Premium evaluation, Tehran-day grouping, debit evidence, credit-ledger mutation, and settlement status are one transaction.

A failure after raw insert rolls the raw insert back too, preventing an accepted-but-unbilled duplicate on retry.

Overlapping evidence from two nodes or two credential versions of the same user debits once. Unknown credential evidence is preserved as `unmapped` with zero debit and blocks field acceptance until resolved.

### UTC-aligned sampler

The Node Agent now schedules against deterministic UTC second boundaries rather than relative polling intervals.

- first sample: baseline only;
- positive uplink/downlink delta across consecutive trusted scheduled boundaries: exact preceding bucket active;
- unchanged counters: idle, no active bucket;
- counter decrease/reset, missing/new client, backward/non-monotonic time, query failure, nonconsecutive target, missed boundary, or observation beyond the current `0.75s` post-boundary tolerance: continuity breaks and no ambiguous seconds are inferred;
- delayed worker execution recomputes the wall-clock target and skips missed buckets instead of catching up;
- no fabricated session identity.

The `0.75s` tolerance is automated-tested but still requires real field validation.

### SQLite outbox v2

The local DB remains:

`/etc/madar-node-agent/telemetry-outbox.sqlite3`

Current local schema version is `2`.

For new aligned activity it stores exact per-minute low-60-bit masks. When a pending report is frozen, `activeSecondsHex`, `seconds`, sequence, and timestamps become immutable. Restart/reopen returns that exact pending payload until acknowledgement.

Migration from the older aggregate outbox preserves old pending and accumulated aggregate rows as legacy telemetry with `activeSecondsHex = null`. It never guesses historical bucket positions. Unsupported future local schema versions fail closed.

ACK comparison includes the bitmap. DB mode remains `0600`; state directory remains `0700`; symlink/non-regular path rejection remains enforced.

### Mixed-version rollout capability

The new control plane exposes authenticated node capability discovery and advertises active-second v1 support.

A new Agent probes capability before any batch containing `activeSecondsHex`:

- supported => submit the exact masked report;
- authenticated older-server `404` => keep the masked report pending unchanged, do not strip/downgrade/ACK;
- legacy report without bitmap => may still be delivered to an older server.

Supported rollout is server-first: database migration -> control plane -> capability verification -> Agent upgrade.

### Exact repository/CI evidence for the final code portion

The active-second implementation plan completed Tasks 1-7 at repository/CI level through:

`6636ff407e5636e8a1664a9a10337c4775e4f0cc`

Full workflow:

`38059810580` — **SUCCESS**

That workflow passed secret scan, PostgreSQL schema and destructive backup/restore, restored Worker smoke, PostgreSQL runtime/integration tests, JavaScript and Python dependency audits, full JavaScript/TypeScript tests, typecheck, production build, and the full Python suite.

This is repository/CI evidence only. It is **not** a Phase 7 real-VPS PASS.

## What the current automated evidence does NOT prove

- The current UTC-aligned bitmap sampler/outbox has not yet been deployed to the disposable VPS and correlated with real transfer/idle behavior.
- No current-head real `activeSecondsHex` report or Free debit has yet been produced on the VPS field environment.
- Automated reopen/restart tests prove local SQLite semantics, not actual VPS crash/reboot persistence under the deployed filesystem/systemd runtime.
- Current boot ordering has not yet been rerun on the VPS.
- The current `0.75s` observation-skew tolerance has not been field-measured/validated.
- Cross-node de-duplication is automated-tested but has not yet been proven with two real nodes.
- Premium single-active-client/device locking remains unimplemented/unverified; Xray public IP or raw transport-session count is not an approved substitute.
- Real v2rayNG E2E, actual Cloudflare/Hyperdrive target deployment, real email/ad/payment providers, real PWA devices, real Web Push, and Production Ready remain outside this evidence.

## Safe end-of-first-field-test state

The first field run ended with an empty client policy ACKed through the real node API. Managed client count and aggregate online count were both `0`. The disposable EC2 instance remained allocated/running for inspection, historical journals were preserved, and Phase 8 was not started.

No later repository/CI work changes that historical end state.

## Remaining Phase 7 acceptance

The next real-VPS pass must deploy **one exact current head** and prove all of the following before Phase 7 can become PASS:

1. real pinned Xray exposes the expected managed per-user uplink/downlink cumulative counters;
2. sustained direct VLESS+REALITY traffic creates the expected UTC `activeSecondsHex`, durable local pending report, accepted PostgreSQL telemetry, and exactly-once Free debit;
3. a controlled idle open connection with unchanged counters creates no new bitmap bits or debit;
4. multiple overlapping connections in the same UTC second buckets do not multiply Free debit;
5. Xray reset/restart, query failure, missed boundary, observation gap, or excessive skew creates no inferred active seconds across the ambiguous interval;
6. in an ambiguous-delivery scenario, restart the Agent **before local ACK** and prove the exact same `(windowId, sequence, seconds, activeSecondsHex)` returns and settles/debits once; a server `duplicate` classification must safely clear that same already-settled pending report;
7. a malformed/incomplete telemetry acceptance response leaves the pending local report intact;
8. outbox mode remains `0600`, state directory remains `0700`, and no client identifier, credential, secret, raw StatsService payload, or SQLite contents leak into bounded current logs;
9. reboot/restart the **current** Agent/systemd code and prove persisted stale Xray client access never becomes available before fresh authorization/policy;
10. no masked field report remains unexplained with settlement status `unmapped`;
11. delayed Premium-period and Tehran-day behavior is proven against the real disposable control-plane/PostgreSQL integration at least at the field-control-plane level;
12. historical identifier-bearing journal retention remains documented and unchanged per the user's instruction.

If a second real node is available during the rerun, additionally prove same-account cross-node overlapping buckets debit once. Otherwise that real cross-node proof remains a Phase 9 multi-node gate and does not by itself block the single-node Phase 7 rerun.

## Separate Premium concurrency gate

Premium product semantics require one active client instance/device per copied configuration. The first distinct client instance must own the slot; a second distinct client instance must be denied until safe release, while multiple normal transport connections from the owning client must continue to work.

Stock Xray does not expose a trustworthy privacy-safe device identity for this rule. Public IP, unique-IP count, raw connection count, or Xray transport-session identity are explicitly rejected shortcuts.

This gate is **not solved by the Free active-second implementation**. It requires a separate approved design/provisioning/identity mechanism and real v2rayNG acceptance, including two devices behind the same NAT, before Production Ready.

## Release gate

**Phase 7 remains INCOMPLETE.**

Direct VLESS+REALITY transport, revoke/replacement, earlier reboot observations, and corrected stale-policy behavior have genuine historical field evidence. The current UTC active-second bitmap accounting path, outbox v2, capability negotiation, atomic settlement, and stronger boot behavior have strong repository/CI evidence but still require the real-VPS checklist above.

Do not start/claim Phase 8 complete, do not claim live current-head Free debit correctness or live crash-durable bitmap accounting, do not claim Premium single-client enforcement, and do not use `Production Ready` from this state.
