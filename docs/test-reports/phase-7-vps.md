# Phase 7 VPS Integration Report

Date: 2026-10-10
Branch: `impl/phase-1`

## Status

**Phase 7: INCOMPLETE after real-VPS execution and post-field activity-source implementation. Do not mark PASS.**

A real disposable AWS EC2 Ubuntu VPS already verified installation/enrollment, systemd health, two reboot scenarios, direct external VLESS+REALITY traffic, aggregate online observation, live credential revocation/replacement, and control-plane-outage expiry after a fail-closed fix. The field run also exposed and fixed client-UUID access-log leakage.

After that field run, the branch gained a conservative server-observed activity source based on Xray per-user cumulative uplink/downlink byte counters, a one-second sampler, and in-memory telemetry-batch retry. Those changes are fully automated/CI verified but **have not yet been deployed and exercised against real traffic on the VPS**. Therefore no new live telemetry/debit claim is made here, Phase 7 remains incomplete, and Phase 8 remains unstarted.

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
| Reboot | Boot identity changed; control plane, agent, Xray recovered; fresh policy/readiness returned | PASS for observed environment |
| Startup with control plane disabled | Second reboot; agent/Xray active with managed clients `0`; external credential denied before control plane re-enabled | PASS for observed post-startup state |
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

### Implemented algorithm

Managed Xray config now enables `statsUserUplink` and `statsUserDownlink` in addition to the existing online diagnostic stat. A redacted adapter query reads only Madar-managed cumulative counters from the loopback StatsService.

A dedicated background sampler runs at approximately one-second cadence:

- first sample: baseline only, zero seconds;
- positive uplink or downlink byte delta across adjacent valid samples: exactly one `ObservedActivity` second;
- unchanged counters: idle, zero seconds;
- missing/new client, counter decrease/reset, non-monotonic time, query failure, or gap `>2.5s`: continuity is discarded/rebaselined and no seconds are invented across the ambiguous interval;
- observations aggregate by client + UTC-minute window ID;
- no synthetic `sessionId` is created.

The Node Agent's existing `ObservedActivity -> UsageReport -> POST /api/node/telemetry` route is now wired to this sampler. If posting a telemetry batch fails, the same report objects/sequences are retained **in memory** and retried before newly drained activity is sent, so an ambiguous retry can rely on existing server-side idempotency rather than generating a second sequence/debit.

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

4. **Telemetry batch retention across post failure**
   - Review found that destructively drained reports could be lost if a telemetry POST exhausted retries.
   - RED: `c4f6fdb3040d09e100a01a8fb87ca53c54bad897`, CI `38034563851` failed at Python after preceding gates passed.
   - Implementation: `b63ed461d5fb41c69c820cc00509ac1f1cb296b2`.
   - Full CI `38034665943`: **SUCCESS**.

Each successful workflow includes repository secret scan, PostgreSQL schema + destructive backup/restore, restored Worker smoke, PostgreSQL integration suite, JavaScript/Python dependency audits, full JS/TS tests, typecheck, production build, and Python tests.

## What the new automated evidence does NOT prove

The current implementation is intentionally conservative, but it is not yet a field PASS:

- The new per-user byte-counter sampler has not yet been deployed to the real VPS and correlated with real transfer/idle behavior.
- No real post-field telemetry row or free-credit debit has yet been produced by this sampler.
- Pending activity/reports are retained in memory only; a Node Agent/VPS restart can still discard unsent in-memory evidence. Crash-durable accounting is not claimed.
- Xray's traffic counters are aggregate per VLESS client UUID. If two simultaneous connections use the same UUID, this sampler cannot distinguish their individual durations and currently counts at most one activity tick per client per sampling interval. Therefore the product rule requiring combined debit for simultaneous same-credential sessions remains unresolved.
- Real v2rayNG, Cloudflare/Hyperdrive target deployment, providers, PWA devices, and Production Ready are outside this evidence.

## Safe end-of-first-field-test state

The first field run ended with an empty client policy that was ACKed through the real node API. Managed client count and aggregate online count were both `0`. The disposable EC2 instance remained allocated/running for inspection, historical journals were preserved, and Phase 8 was not started.

## Remaining Phase 7 acceptance

The next real-VPS pass must use the current branch and prove all of the following before Phase 7 can become PASS:

1. Real pinned Xray exposes the expected Madar per-user uplink/downlink counters under the deployed managed config.
2. A controlled sustained direct VLESS+REALITY transfer causes positive server-observed activity ticks, real telemetry POSTs, accepted PostgreSQL telemetry rows, and the expected free-credit debit exactly once.
3. A controlled idle open connection with unchanged byte counters causes no new activity report/debit.
4. Xray reset/restart or an observation gap does not create inferred seconds across the ambiguous interval.
5. A transient/ambiguous telemetry POST retry sends the same window/sequence batch and does not double debit.
6. Same-credential concurrent-session accounting is resolved or explicitly proven with a mechanism capable of combined actual usage; aggregate per-user byte counters alone are insufficient.
7. Decide whether a crash/reboot-durable local telemetry outbox is required by the production accounting gate; if required, implement and field-test it.
8. Historical identifier-bearing journal retention remains documented; do not silently erase those logs against the user's instruction.

## Release gate

**Phase 7 remains INCOMPLETE.** Direct VLESS+REALITY transport, revoke, reboot, and corrected stale-policy behavior have genuine field evidence. The new traffic-derived activity algorithm has strong automated evidence but still needs real telemetry/debit validation and does not yet solve same-credential concurrent-session multiplicity or crash-durable unsent telemetry. Do not start Phase 8 or claim live usage-debit correctness / Production Ready from this state.
