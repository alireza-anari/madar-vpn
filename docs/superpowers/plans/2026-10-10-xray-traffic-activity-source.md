# Xray Traffic Activity Source Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

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
5. Window/retry behavior: repeated drains in the same UTC minute must emit incremental seconds under the same window ID and rely on existing sequence idempotency, never replay already-drained seconds.

---

### Task 1: Enable and safely read per-user Xray traffic counters

**Files:**
- Modify: `node-agent/madar_agent/models.py`
- Modify: `node-agent/madar_agent/xray.py`
- Modify: `node-agent/tests/test_xray_adapter.py`

**Interfaces:**
- Produces: `UserTrafficCounters(uplink_bytes: int, downlink_bytes: int)`.
- Produces: `PinnedXrayAdapter.read_user_traffic_counters() -> dict[str, UserTrafficCounters]`.

- [ ] Add failing tests requiring `statsUserUplink` and `statsUserDownlink` in managed config and a parser for cumulative `user>>>madar:<clientId>>>traffic>>>...` counters.
- [ ] Verify Python tests fail before implementation.
- [ ] Implement generic/redacted StatsService query using the pinned local Xray binary and `127.0.0.1:10085`; fill managed clients with zero when counters are absent.
- [ ] Verify focused tests pass.
- [ ] Commit.

### Task 2: Convert one-second traffic deltas into conservative `ObservedActivity`

**Files:**
- Create: `node-agent/madar_agent/activity.py`
- Create: `node-agent/tests/test_activity_source.py`

**Interfaces:**
- Produces: `XrayTrafficActivitySource(read_counters, now, max_gap_seconds=2.5)`.
- Produces: `sample() -> None`, `invalidate() -> None`, `drain() -> list[ObservedActivity]`.

- [ ] Add failing tests for baseline-only first sample, active byte delta, idle zero delta, reset, long gap, multiple clients, aggregation, and destructive drain.
- [ ] Verify tests fail before implementation.
- [ ] Implement one-second active ticks grouped by stable UTC-minute window IDs; no `session_id` is fabricated.
- [ ] Verify focused tests pass.
- [ ] Commit.

### Task 3: Wire the sampler into the real Node Agent lifecycle

**Files:**
- Modify: `node-agent/madar_agent/service.py`
- Modify: `node-agent/tests/test_service_runtime.py`
- Modify: `node-agent/tests/test_service.py`

**Interfaces:**
- `build_agent_service()` wires `xray.read_user_traffic_counters` into `XrayTrafficActivitySource` and passes `source.drain` as the adapter activity source.
- A background sampler runs at one-second cadence independently of the 30-second control-plane cycle.

- [ ] Add failing wiring/lifecycle tests proving the activity source exists, sampling failures do not crash the service, and stop/join behavior is clean.
- [ ] Verify failure.
- [ ] Implement the minimum sampler lifecycle without changing the existing policy/heartbeat cycle cadence.
- [ ] Verify focused Python suite, then full Python suite.
- [ ] Commit.

### Task 4: Verify repository gates and record field-test requirements

**Files:**
- Modify: `docs/runbooks/node-install.md`
- Modify: `docs/test-reports/phase-7-vps.md`

- [ ] Run full CI gates: secret scan, PostgreSQL schema/restore, audits, JS/TS tests, typecheck, build, Python.
- [ ] Document that automated tests prove the algorithm only; real VPS must still demonstrate transfer -> telemetry -> PostgreSQL report -> debit and idle -> no debit.
- [ ] Record same-credential concurrent-session multiplicity as unresolved unless separately proven.
- [ ] Do not mark Phase 7 PASS until real field evidence exists.
- [ ] Commit documentation only after green implementation CI.
