# Xray Traffic Activity Source Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for completed implementation work.

**Goal:** Replace the unimplemented Node Agent activity source with a conservative server-observed Xray traffic sampler that can produce real `ObservedActivity` seconds without treating a merely open/idle connection as active traffic.

**Architecture:** Keep stock pinned Xray `26.3.27` and use its loopback-only StatsService per-user uplink/downlink byte counters. Sample cumulative counters at one-second cadence, count one observed second only when bytes increased between adjacent valid samples, drop ambiguous gaps/resets rather than invent duration, and drain aggregated observations through the existing `ObservedActivity -> UsageReport -> telemetry` path. This is deliberately per-client traffic activity; it does not invent a same-credential session identity or claim exact simultaneous-session multiplicity.

**Tech Stack:** Python 3.12, pytest, systemd Node Agent, pinned Xray-core `26.3.27`, Xray StatsService CLI, existing PostgreSQL telemetry API.

**Spec:** `docs/superpowers/specs/2026-10-08-madar-clean-start-design.md`

## Global Constraints

- No fake or client-reported activity; source must be server-observed from real Xray.
- Minimum telemetry identity remains `nodeId`, `clientId`, `windowId`, `sequence`, `seconds`, `timestamp`.
- Idle open connections must not be promoted to traffic seconds by this algorithm.
- Counter reset, Xray restart, observation failure, or sampling gap must fail conservatively and must not invent usage.
- Raw Xray StatsService output and client UUIDs must never be logged by the sampler.
- Existing policy expiry/revocation fail-closed behavior must remain unchanged.
- Phase 7 stays incomplete until the algorithm and live telemetry/debit path are field-verified on the real VPS.
- Same-credential concurrent-session multiplicity is not claimed solved by aggregate per-user counters.

## Review Focus

1. Counter resets/restarts: a lower cumulative value must reset the baseline without charging time.
2. Sampling gaps/failures: an ambiguous multi-second gap must produce zero inferred seconds across the gap.
3. Idle connections: unchanged byte counters across samples must produce no activity.
4. Secret/log safety: malformed Xray output or CLI errors must raise only generic redacted errors.
5. Window/retry behavior: repeated drains in the same UTC minute emit incremental seconds under the same window ID and sequence-based server idempotency prevents duplicate settlement.
6. Telemetry delivery: a drained batch remains in memory until the control plane accepts it; transient/ambiguous post failures retry the same batch before newly drained usage is sent.

---

### Task 1: Enable and safely read per-user Xray traffic counters

**Files:**
- Modify: `node-agent/madar_agent/models.py`
- Modify: `node-agent/madar_agent/xray.py`
- Add: `node-agent/tests/test_xray_traffic_activity.py`

**Interfaces:**
- Produces: `UserTrafficCounters(uplink_bytes: int, downlink_bytes: int)`.
- Produces: `PinnedXrayAdapter.read_user_traffic_counters() -> dict[str, UserTrafficCounters]`.

- [x] Add failing tests requiring `statsUserUplink` and `statsUserDownlink` in managed config and a parser for cumulative `user>>>madar:<clientId>>>traffic>>>...` counters.
- [x] Verify Python tests fail before implementation.
- [x] Implement generic/redacted StatsService query using the pinned local Xray binary and `127.0.0.1:10085`; fill managed clients with zero when counters are absent.
- [x] Verify focused/full tests pass.
- [x] Commit.

### Task 2: Convert one-second traffic deltas into conservative `ObservedActivity`

**Files:**
- Create: `node-agent/madar_agent/activity.py`
- Create: `node-agent/tests/test_activity_source.py`

**Interfaces:**
- Produces: `XrayTrafficActivitySource(read_counters, now, max_gap_seconds=2.5)`.
- Produces: `sample() -> None`, `invalidate() -> None`, `drain() -> list[ObservedActivity]`.

- [x] Add failing tests for baseline-only first sample, active byte delta, idle zero delta, reset, long gap, multiple clients, aggregation, and destructive drain.
- [x] Verify tests fail before implementation.
- [x] Implement one-second active ticks grouped by stable UTC-minute window IDs; no `session_id` is fabricated.
- [x] Verify focused/full tests pass.
- [x] Commit.

### Task 3: Wire the sampler into the real Node Agent lifecycle

**Files:**
- Modify: `node-agent/madar_agent/service.py`
- Add: `node-agent/tests/test_activity_runtime.py`
- Modify: `node-agent/tests/test_service.py`

**Interfaces:**
- `build_agent_service()` wires `xray.read_user_traffic_counters` into `XrayTrafficActivitySource` and passes `source.drain` as the adapter activity source.
- A background sampler runs at one-second cadence independently of the 30-second control-plane cycle.

- [x] Add failing wiring/lifecycle tests proving the activity source exists, sampling failures do not crash the service, and stop/join behavior is clean.
- [x] Verify failure.
- [x] Implement the minimum sampler lifecycle without changing the existing policy/heartbeat cycle cadence.
- [x] Verify focused Python suite, then full repository CI.
- [x] Commit.

### Task 3.5: Retain drained telemetry across transient post failure

A review after Task 3 found that destructively drained activity could otherwise be lost after the control-plane client's retries were exhausted.

- [x] Add a failing regression proving the exact same `UsageReport` batch is retried before newly collected usage.
- [x] Keep the batch in `AgentService` memory until `post_telemetry` succeeds.
- [x] Verify a later successful retry sends the same window/sequence and then permits new usage collection.
- [x] Run full CI successfully.

This is at-least-once delivery for the running process. It is **not** a crash/reboot-durable on-disk outbox; that remains an explicit production-accounting decision/gate.

### Task 4: Verify repository gates and record field-test requirements

**Files:**
- Modify: `docs/runbooks/node-install.md`
- Modify: `docs/test-reports/phase-7-vps.md`

- [x] Run full CI gates: secret scan, PostgreSQL schema/restore, audits, JS/TS tests, typecheck, build, Python.
- [x] Document that automated tests prove the algorithm only; real VPS must still demonstrate transfer -> telemetry -> PostgreSQL report -> debit and idle -> no debit.
- [x] Record same-credential concurrent-session multiplicity as unresolved unless separately proven.
- [x] Record in-memory telemetry retry and the remaining crash-durable outbox question.
- [x] Do not mark Phase 7 PASS until real field evidence exists.
- [x] Commit documentation only after green implementation CI.

## Implementation result

Repository implementation work in this plan is complete and CI-green. **Phase 7 itself is not complete.** The remaining work is real-VPS field validation of the new activity/telemetry/debit path plus resolution of same-credential concurrent-session accounting (and the crash-durable outbox requirement if production acceptance demands it). Phase 8 remains gated.
