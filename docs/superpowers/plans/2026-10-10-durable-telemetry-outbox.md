# Durable Node Telemetry Outbox Implementation Plan

> **Execution:** Use TDD task-by-task. Do not claim crash/reboot-durable accounting until both automated recovery tests and a real VPS restart/outage field test pass.

**Goal:** Make already-observed Xray traffic activity survive Node Agent process/VPS restarts and ambiguous telemetry delivery, while preserving stable `(windowId, sequence)` identities for control-plane idempotency.

**Architecture:** Add a local SQLite outbox under `/etc/madar-node-agent` using Python stdlib `sqlite3`. The one-second Xray activity sampler records observed traffic ticks transactionally as soon as they are observed. A transactional prepare step converts accumulated ticks into immutable `UsageReport` rows with monotonically allocated per-window sequences. Pending reports are returned unchanged after restart until the control plane accepts them, then acknowledged/deleted. Sampling continuity itself is intentionally not persisted: the first sample after process restart re-establishes a baseline and charges zero for the ambiguous restart gap.

**Security:** State directory is already systemd-restricted and `UMask=0077`; the outbox DB must additionally enforce mode `0600`, never log row contents/client IDs, and must reject symlink/non-regular paths.

**Important scope boundary:** This closes local durability for the currently accepted per-client activity algorithm. It does **not** solve exact same-UUID concurrent-session multiplicity; that remains separately blocked by stock Xray limitations recorded in `docs/architecture/xray-session-accounting.md`.

## Data model

SQLite tables:

- `activity_windows(client_id, window_id, seconds, observed_from, observed_to, timestamp)` — durable unprepared observed ticks, unique `(client_id, window_id)`.
- `window_sequences(window_id PRIMARY KEY, last_sequence)` — durable sequence allocator matching control-plane idempotency identity `(node_id, window_id, sequence)`.
- `pending_reports(client_id, window_id, sequence, seconds, timestamp, observed_from, observed_to, session_id, PRIMARY KEY(window_id, sequence))` — immutable reports waiting for acknowledgement.

## Task 1 — Durable outbox primitive

**Files:**
- Create `node-agent/madar_agent/outbox.py`
- Create `node-agent/tests/test_telemetry_outbox.py`

- [ ] RED: tests for secure DB creation, tick aggregation, transactional report preparation, stable retry after reopen/restart, acknowledgement, monotonic sequence after ack, malformed/symlink path rejection.
- [ ] Implement minimum SQLite outbox with explicit transactions and owner-only permissions.
- [ ] Full Python + repository CI green.

## Task 2 — Persist activity ticks instead of keeping them only in RAM

**Files:**
- Modify `node-agent/madar_agent/activity.py`
- Modify `node-agent/tests/test_activity_source.py`

- [ ] RED: prove active tick calls durable sink; idle/reset/gap do not; sink failure invalidates continuity and propagates so the worker can retry safely.
- [ ] Implement optional `record_activity(...)` sink and keep in-memory mode for unit isolation/backward compatibility.
- [ ] Full Python + repository CI green.

## Task 3 — Wire durable outbox into runtime and telemetry acknowledgement

**Files:**
- Modify `node-agent/madar_agent/agent.py`
- Modify `node-agent/madar_agent/service.py`
- Modify `node-agent/tests/test_agent_core.py`
- Modify `node-agent/tests/test_service.py`
- Modify `node-agent/tests/test_activity_runtime.py`

- [ ] RED: restart simulation proves pending reports keep identical sequence/seconds; successful POST acknowledges them; new activity in same window receives next sequence; no new drain occurs while an old report is pending.
- [ ] Wire outbox path from `credential_path.parent / telemetry-outbox.sqlite3`.
- [ ] Activity source writes ticks directly to outbox.
- [ ] Agent prepares/reads immutable pending reports from outbox; service acknowledges only after successful `post_telemetry`.
- [ ] Remove the now-redundant in-memory-only pending-report reliability assumption without changing 30-second control-plane cadence.
- [ ] Full repository CI green.

## Task 4 — Documentation and real-VPS gate

**Files:**
- Modify `docs/runbooks/node-install.md`
- Modify `docs/test-reports/phase-7-vps.md`

- [ ] Record automated crash/reopen evidence without calling the field gate PASS.
- [ ] Real VPS must prove: active transfer -> persisted report -> process restart before POST -> same report/sequence after restart -> accepted once/debited once.
- [ ] Real VPS must prove idle connection produces no persisted activity/debit.
- [ ] Real VPS must prove DB file/sidecars remain owner-only and no identifiers leak to logs.
- [ ] Keep same-credential concurrency blocker explicit.

## Acceptance

Repository implementation can be marked complete only when all automated gates pass. **Phase 7 remains incomplete** until the current sampler/outbox is field-tested on the existing disposable VPS and the exact concurrent-session requirement is resolved or otherwise satisfied by an approved mechanism.
