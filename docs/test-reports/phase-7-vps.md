# Phase 7 VPS Integration Report

Date: 2026-10-10
Branch: `impl/phase-1`

## Status

**Phase 7: INCOMPLETE after real-VPS execution and post-field activity/durability implementation. Do not mark PASS.**

A real disposable AWS EC2 Ubuntu VPS already verified installation/enrollment, systemd health, two reboot scenarios, direct external VLESS+REALITY traffic, aggregate online observation, live credential revocation/replacement, and control-plane-outage expiry after a fail-closed fix. The field run also exposed and fixed client-UUID access-log leakage.

After that field run, the branch gained a conservative server-observed activity source based on Xray per-user cumulative uplink/downlink byte counters, a one-second sampler, a durable local SQLite telemetry outbox, exact pending-report retry/acknowledgement semantics, complete telemetry acceptance-response validation, and stronger boot-level stale-Xray fail-closed ordering. Those later changes are fully automated/CI verified but **have not yet been deployed and exercised against real traffic/restart scenarios on the VPS**. Therefore no new live telemetry/debit/durability claim is made here, Phase 7 remains incomplete, and Phase 8 remains unstarted.

Earlier client-identifying journal entries remain on the disposable VPS at the user's explicit request; later fixed logs were separately checked without deleting history.

## Real field environment and scope

- VPS: AWS EC2 `t3.micro`, Stockholm (`eu-north-1`), Ubuntu `24.04`, `x86_64`, Python `3.12.3`; sudo/systemd verified over SSH.
- Baseline checkout for the first field run: branch `impl/phase-1`, commit `12e1f5c754a29da7cdb463db4d378eb56b8d8777`, followed by the documented field fixes through `e0ff90bec6fbd4f13d4a90cdddd48fd3a27e568a`.
- The installer executable Git mode was corrected from `100644` to `100755` and direct wrapper execution was verified.
- No production control plane existed, so the approved disposable field environment hosted the existing API assembly plus real PostgreSQL stores on the VPS. It used the production runtime's Hyperdrive-shaped connection-string binding but did **not** exercise an actual Cloudflare Worker/Hyperdrive deployment.
- A fresh PostgreSQL database used the repository authoritative schema. Disposable auth/admin/user data and a hashed one-time login bootstrap were used to obtain the real CSRF-protected admin enrollment flow. This is not real email-provider acceptance.
- Disposable HTTPS was loopback-only with certificate/hostname verification enabled; PostgreSQL and Xray StatsService were loopback-only.
- Pinned Linux Xray `26.3.27` came from the real installer and repository checksum. The external Windows test client used the official matching release and verified asset digest.
- Direct VLESS+REALITY success used port `443` with ingress restricted to the test computer. Successful probes returned the VPS public egress address.
- Real revisioned PostgreSQL policies were published by the disposable field operator and fetched/ACKed through the node HTTPS API. This proves that field path, not a production scheduler.

## Field observations (UTC, 2026-10-10)

| Check | Actual evidence | Result / limit |
| --- | --- | --- |
| Real installer and enrollment | `./install.sh install`; fresh token through authenticated admin API; replay HTTP `401` | PASS |
| Secret permissions | `node.credential`, `reality.private`, `agent.env` each `0600` | PASS |
| Real policy and service health | Revision ACKed; Node Agent/Xray active; heartbeat healthy/ready/accepting | PASS |
| Reboot | Boot identity changed; control plane, agent, Xray recovered; fresh policy/readiness returned | PASS for observed older unit/runtime behavior |
| Startup with control plane disabled | Second reboot; agent/Xray active with managed clients `0`; external credential denied before control plane re-enabled | PASS for observed post-startup state; newer boot ordering still needs rerun |
| Direct external traffic | Multiple direct VLESS+REALITY probes traversed VPS; public egress matched VPS | PASS |
| Aggregate during transfer | Aggregate online changed from `0` to `1` during valid active-transfer samples | Presence observed; not duration evidence |
| Idle open connection | Aggregate stayed `1` for samples through roughly 62 seconds while controlled HTTP connection remained open without response payload | Proves online != active traffic |
| Disconnect | Aggregate returned to `0` after client termination | Transition observed |
| Live revoke | Active old credential revoked/replaced through real policy propagation; old transfer closed and aggregate became `0` | PASS |
| Old vs replacement credential | Old credential denied; replacement credential succeeded with VPS egress | PASS |
| Baseline outage expiry | Initial run reproduced stale managed access after policy expiry while control plane unavailable | FAIL reproduced; prompted fix |
| Fixed outage expiry | After fix, expired authorization produced managed client count `0` and fresh traffic denial while control plane remained stopped | PASS; cycle/request-bound rather than exact wall-clock timer |
| Control-plane secret audit | Raw node credential and REALITY private key absent from inspected stored control-plane data | PASS for observed snapshot |
| Baseline log privacy | Xray default access logger exposed disposable client UUID | FAIL reproduced; historical journal intentionally retained |
| Fixed log privacy | Bounded post-fix runtime logs contained no node credential, REALITY private key, client UUID, admin session/CSRF secret, bearer pattern, or PEM private key | PASS for bounded post-fix interval |
| Live telemetry/debit at first field run | PostgreSQL contained `0` telemetry reports and `0` reported seconds because no activity source was wired at that time | NOT PASS; branch implementation has since changed but field rerun is pending |
| Durable outbox/new boot ordering | Implemented after first field run | NOT RUN on VPS; automated/CI evidence only |

Ordinary TLS success did not prove REALITY suitability. `www.microsoft.com:443` passed ordinary verified TLS but the pinned REALITY clients failed with EOF; the same keys/client worked when target and SNI were changed to `www.cloudflare.com`. This is consistent with upstream Xray issue 6356 but the field test did not enable raw REALITY debug output or establish an upstream root cause.

## Field fixes from the first real-VPS run

- Restored installer executable mode.
- Set managed Xray `log.access` to `none`; the regression assertion failed against baseline then passed after the narrow fix. Historical logs were not erased.
- Hardened `NodeAgent.fetch_policy` so absent/expired authorization closes access before the request and expiry is rechecked in `finally`, including retry failure. Real outage behavior was rerun and verified.
- The full Python suite passed **58 tests** on the real Ubuntu host for those field fixes.
- Deployed `agent.py`/`xray.py` hashes were matched to the published checkout before the final field rerun.

The field-fix source/evidence commit `7806a1a63f624d593a1c9b25232b72d802aa2435` passed the complete GitHub Actions workflow in run `38030266011`. The later evidence/documentation head `e0ff90b...` also passed full CI in run `38030473290`.

## Post-field server-observed activity implementation

The idle experiment invalidated `onlineUsers` as a billing clock. The branch now uses Xray cumulative per-user traffic bytes instead.

### Implemented activity algorithm

Managed Xray config now enables `statsUserUplink` and `statsUserDownlink` in addition to the existing online diagnostic stat. A redacted adapter query reads only Madar-managed cumulative counters from the loopback StatsService.

A dedicated background sampler runs at approximately one-second cadence:

- first sample: baseline only, zero seconds;
- positive uplink or downlink byte delta across adjacent valid samples: exactly one observed activity second;
- unchanged counters: idle, zero seconds;
- missing/new client, counter decrease/reset, non-monotonic time, query failure, or gap `>2.5s`: continuity is discarded/rebaselined and no seconds are invented across the ambiguous interval;
- observations aggregate by client + UTC-minute window ID;
- no synthetic `sessionId` is created.

### Durable local telemetry semantics

The runtime now writes active sampler ticks directly to `/etc/madar-node-agent/telemetry-outbox.sqlite3` instead of relying on an in-memory-only telemetry batch.

The outbox transactionally stores activity, allocates per-window monotonic sequences, and creates immutable pending `UsageReport` rows. Reopening the DB after process/VPS restart returns the same pending `(windowId, sequence, seconds, timestamps)` until explicit acknowledgement. New activity in the same window receives the next sequence only after the prior pending report has been acknowledged.

The service acknowledges/deletes a pending batch only after `POST /api/node/telemetry` returns a structurally complete response that accounts for every submitted report. Both `accepted` and `duplicates` must be non-negative JSON integers and `accepted + duplicates` must equal the submitted batch size. This permits the intended idempotent retry case—server commit succeeded but response was lost, so the next attempt is classified as duplicate—without deleting local evidence on malformed/partial/contradictory 2xx responses.

Sampling continuity itself is intentionally not persisted. The first Xray counter observation after Agent restart is baseline-only and the ambiguous restart gap is charged as zero. Already persisted activity/pending reports remain durable.

### Boot/startup fail-closed hardening

Post-field review found a separate reboot risk: an Agent systemd dependency on `madar-xray.service` could allow persisted `xray-config.json` to start before the fresh Agent process re-established authorization. The current repository no longer gives the Agent unit `Wants`/`After` dependency on Xray. At each Agent process start, managed Xray is stopped before runtime/outbox construction. If that stop fails, runtime construction is refused; if runtime/outbox construction fails, Xray remains stopped and only a generic error is logged. Fresh policy processing is then responsible for safe managed Xray promotion/restart.

This new startup ordering is automated/CI verified only; it has not yet replaced/rerun the earlier real-VPS reboot evidence.

### TDD / CI evidence

1. **Per-user Xray counters**
   - RED: `567c1ff3fefb649a8aebabde8caedb4cb5c75164`, CI `38033610112` failed at Python after preceding gates passed.
   - Implementation: `616aa4fa263b9223a1ad4d33cdbea3fd3c455f54` + `7735ea986340ab6ac7086bddf5bee76c55f5ffbc`.
   - Updated obsolete online-only regression expectation: `1ec1565e75ea34bdc609763c877ba6744f5b0132`.
   - Full CI `38033870204`: **SUCCESS**.

2. **Conservative traffic-delta activity semantics**
   - RED: `d718d1f97f2338d083c68db297473dea4a380ac5`, CI `38034002217` failed at Python after preceding gates passed.
   - Implementation: `62d30c0cb6565127efa6a6a064519c140ce8df9d`.
   - Full CI `38034115187`: **SUCCESS**.

3. **One-second background runtime wiring**
   - RED: `cbd3d2eabfd54c6a11774729ef3017257ec89727`, CI `38034249001` failed at Python after preceding gates passed.
   - Implementation: `fe528bf72e680fdb1f16b3ddb4dc874b4bd86b1d`.
   - Full CI `38034380248`: **SUCCESS**.

4. **Telemetry post-failure retry review fix**
   - Review found that destructively drained reports could be lost if a telemetry POST exhausted retries.
   - RED: `c4f6fdb3040d09e100a01a8fb87ca53c54bad897`, CI `38034563851` failed at Python after preceding gates passed.
   - Interim in-memory retry implementation: `b63ed461d5fb41c69c820cc00509ac1f1cb296b2`.
   - Full CI `38034665943`: **SUCCESS**.
   - This interim RAM-only design has since been superseded by the durable SQLite outbox below.

5. **Durable SQLite outbox primitive**
   - RED: `e409524ff6eb260dbc374b4ede5f2d10dcc64a7e`, CI `38035470225` failed only in the new Python outbox tests; existing gates passed.
   - Implementation: `ebebbb5462b9375a1730cc6c09dbaeffc229e77f`.
   - Full CI `38035598144`: **SUCCESS**.
   - Automated assertions cover secure creation, durable tick aggregation, immutable preparation, reopen/restart retry identity, exact acknowledgement, sequence monotonicity, and symlink/non-regular path rejection.

6. **Sampler -> durable sink**
   - RED: activity-source tests required immediate persistent sink behavior and failure invalidation.
   - Implementation: `2d02e8c51ddf89ce1682af160a43bb861d91f61c`.
   - Full CI `38039743210`: **SUCCESS**.

7. **Durable runtime wiring and restart identity**
   - Acceptance-style Python tests prove the same pending report/sequence survives reopen, ACK advances later same-window sequence, and the same outbox instance is wired to sampler + Agent.
   - Full CI `38040158620`: **SUCCESS** at head `2ed8faf5d00fa510e69b9ee986a8adfba243e23b`.

8. **Startup/outbox failure fails Xray closed**
   - TDD added generic-log/no-secret startup-failure coverage.
   - Implementation head included `63f5a7422fec4049434b1b08bc48e03017938386`.
   - Full CI `38040417941`: **SUCCESS**.

9. **Reboot/systemd stale-Xray ordering**
   - RED proved the older `Wants/After=madar-xray.service` unit ordering violated the desired fresh-authorization boundary.
   - Current Agent unit depends only on network-online; runtime stops Xray before build and refuses startup if that cannot be done.
   - Updated head `1762aaa15e207c5903079a34d18d0f59a30e4080`.
   - Full CI `38040870174`: **SUCCESS**.

10. **Complete telemetry acceptance before outbox ACK**
    - RED: `2e75a86c3d7c2a23294c6297f8e2b3e6dcc39208`, CI `38040986965` had **90 PASS / 6 intentional FAIL** in Python; all six failures were malformed/incomplete acceptance-response cases that were not yet rejected.
    - Implementation: `88622a1211094ff3bf553247b823b9150e416b7d`.
    - Full CI `38041159194`: **SUCCESS**.
    - Valid server duplicate classification is accepted as complete idempotent settlement; missing, mismatched, negative, boolean, or string counts are rejected and cannot authorize outbox deletion.

Each successful full workflow includes repository secret scan, PostgreSQL schema + destructive backup/restore, restored Worker smoke, PostgreSQL integration suite, JavaScript/Python dependency audits, full JS/TS tests, typecheck, production build, and Python tests.

## What the new automated evidence does NOT prove

The current implementation is deliberately more durable and conservative, but it is not yet a field PASS:

- The current per-user byte-counter sampler + SQLite outbox has not yet been deployed to the disposable VPS and correlated with real transfer/idle behavior.
- No real post-field telemetry row or free-credit debit has yet been produced by this sampler/outbox path.
- The automated restart tests prove local SQLite identity durability, not actual VPS crash/reboot persistence under the deployed filesystem/systemd/runtime.
- The new boot ordering that keeps persisted Xray state stopped until Agent-controlled authorization/policy handling has not yet been rerun on the VPS.
- Xray's traffic counters are aggregate per VLESS client UUID. If two simultaneous connections use the same UUID, this sampler cannot distinguish their individual durations and currently counts at most one activity tick per client per sampling interval. Therefore the product rule requiring combined debit for simultaneous same-credential sessions remains unresolved.
- Real v2rayNG, Cloudflare/Hyperdrive target deployment, providers, PWA devices, and Production Ready are outside this evidence.

## Safe end-of-first-field-test state

The first field run ended with an empty client policy that was ACKed through the real node API. Managed client count and aggregate online count were both `0`. The disposable EC2 instance remained allocated/running for inspection, historical journals were preserved, and Phase 8 was not started.

## Remaining Phase 7 acceptance

The next real-VPS pass must use the current branch and prove all of the following before Phase 7 can become PASS:

1. Real pinned Xray exposes the expected Madar per-user uplink/downlink counters under the deployed managed config.
2. A controlled sustained direct VLESS+REALITY transfer causes positive server-observed activity ticks, durable local outbox state, real telemetry POSTs, accepted PostgreSQL telemetry rows, and the expected free-credit debit exactly once.
3. A controlled idle open connection with unchanged byte counters causes no new durable activity report/debit.
4. Xray reset/restart or an observation gap does not create inferred seconds across the ambiguous interval.
5. Create an ambiguous telemetry-delivery case, restart the Agent before local acknowledgement, and prove the same `(windowId, sequence, seconds)` is returned after restart and settles/debits exactly once. A server-side duplicate response must safely acknowledge the already-settled report.
6. Return/induce a malformed or incomplete telemetry acceptance response in a controlled test and prove the local pending report is not removed.
7. Verify `/etc/madar-node-agent/telemetry-outbox.sqlite3` stays `0600`, the state directory stays `0700`, SQLite/outbox contents are not exposed in logs, and no new client identifier leakage occurs.
8. Reboot/restart the current Agent/systemd code and prove stale persisted Xray client access cannot become available before fresh authorization/policy handling.
9. Same-credential concurrent-session accounting is resolved or explicitly proven with a mechanism capable of combined actual usage; aggregate per-user byte counters alone are insufficient.
10. Historical identifier-bearing journal retention remains documented; do not silently erase those logs against the user's instruction.

## Release gate

**Phase 7 remains INCOMPLETE.** Direct VLESS+REALITY transport, revoke, the earlier reboot behavior, and corrected stale-policy behavior have genuine field evidence. The current traffic-derived activity algorithm, durable telemetry outbox, complete ACK semantics, and stronger boot fail-closed ordering have strong automated evidence but still need the real-VPS rerun above. Same-credential concurrent-session multiplicity also remains unresolved. Do not start Phase 8 or claim live usage-debit correctness, live crash-durable accounting, or Production Ready from this state.
