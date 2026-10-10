# Durable Node Telemetry Outbox Implementation Plan

> **Execution:** Use TDD task-by-task. Do not claim crash/reboot-durable accounting until both automated recovery tests and a real VPS restart/outage field test pass.

**Goal:** Make already-observed Xray traffic activity survive Node Agent process/VPS restarts and ambiguous telemetry delivery, while preserving stable `(windowId, sequence)` identities for control-plane idempotency.

**Architecture:** Add a local SQLite outbox under `/etc/madar-node-agent` using Python stdlib `sqlite3`. The one-second Xray activity sampler records observed traffic ticks transactionally as soon as they are observed. A transactional prepare step converts accumulated ticks into immutable `UsageReport` rows with monotonically allocated per-window sequences. Pending reports are returned unchanged after restart until the control plane accounts for every submitted report as accepted or duplicate, then acknowledged/deleted. Sampling continuity itself is intentionally not persisted: the first sample after process restart re-establishes a baseline and charges zero for the ambiguous restart gap.

**Security:** State directory is already systemd-restricted and `UMask=0077`; the outbox DB additionally enforces mode `0600`, never logs row contents/client IDs, and rejects symlink/non-regular paths. A fresh Agent process stops managed Xray before reading runtime/outbox state so persisted Xray config is never treated as fresh authorization; the Agent systemd unit no longer auto-starts Xray as a dependency.

**Important scope boundary:** This closes local durability for the currently accepted per-client activity algorithm at repository/CI level. It does **not** solve exact same-UUID concurrent-session multiplicity; that remains separately blocked by stock Xray limitations recorded in `docs/architecture/xray-session-accounting.md`. The new durability and boot behavior still require real-VPS rerun before Phase 7 can pass.

## Data model

SQLite tables:

- `activity_windows(client_id, window_id, seconds, observed_from, observed_to, timestamp)` — durable unprepared observed ticks, unique `(client_id, window_id)`.
- `window_sequences(window_id PRIMARY KEY, last_sequence)` — durable sequence allocator matching control-plane idempotency identity `(node_id, window_id, sequence)`.
- `pending_reports(client_id, window_id, sequence, seconds, timestamp, observed_from, observed_to, session_id, PRIMARY KEY(window_id, sequence))` — immutable reports waiting for acknowledgement.

## Task 1 — Durable outbox primitive

**Files:**
- Create `node-agent/madar_agent/outbox.py`
- Create `node-agent/tests/test_telemetry_outbox.py`

- [x] RED: tests for secure DB creation, tick aggregation, transactional report preparation, stable retry after reopen/restart, acknowledgement, monotonic sequence after ack, malformed/symlink path rejection.
- [x] Implement minimum SQLite outbox with explicit transactions and owner-only permissions.
- [x] Full Python + repository CI green.

Automated evidence: implementation commit `ebebbb5462b9375a1730cc6c09dbaeffc229e77f`, full CI run `38035598144` SUCCESS.

## Task 2 — Persist activity ticks instead of keeping them only in RAM

**Files:**
- Modify `node-agent/madar_agent/activity.py`
- Modify `node-agent/tests/test_activity_source.py`

- [x] RED: prove active tick calls durable sink; idle/reset/gap do not; sink failure invalidates continuity and propagates so the worker can retry safely.
- [x] Implement optional `record_activity(...)` sink and keep in-memory mode for unit isolation/backward compatibility.
- [x] Full Python + repository CI green.

Automated evidence: durable-sink implementation commit `2d02e8c51ddf89ce1682af160a43bb861d91f61c`, full CI run `38039743210` SUCCESS.

## Task 3 — Wire durable outbox into runtime and telemetry acknowledgement

**Files:**
- Modify `node-agent/madar_agent/agent.py`
- Modify `node-agent/madar_agent/service.py`
- Modify `node-agent/madar_agent/api.py`
- Modify `node-agent/systemd/madar-node-agent.service`
- Modify runtime/control-plane tests.

- [x] RED: restart simulation proves pending reports keep identical sequence/seconds; successful POST acknowledges them; new activity in same window receives next sequence; no new drain occurs while an old report is pending.
- [x] Wire outbox path from `credential_path.parent / telemetry-outbox.sqlite3`.
- [x] Activity source writes ticks directly to outbox.
- [x] Agent prepares/reads immutable pending reports from outbox; service acknowledges only after successful `post_telemetry`.
- [x] Require telemetry response to account for every submitted report: `accepted + duplicates == batch size`, with both counts non-negative integers; malformed/partial 2xx responses do not ACK the outbox.
- [x] Stop managed Xray before fresh Agent runtime/outbox construction and remove the Agent systemd dependency that could auto-start persisted stale Xray config before authorization.
- [x] Remove the now-redundant in-memory-only pending-report reliability assumption without changing 30-second control-plane cadence.
- [x] Full repository CI green.

Automated evidence includes full green CI `38040158620` for durable runtime wiring, `38040417941` for startup fail-closed behavior, `38040870174` for reboot/systemd fail-closed ordering, and `38041159194` for complete telemetry acceptance validation.

## Task 4 — Documentation and real-VPS gate

**Files:**
- Modify `docs/runbooks/node-install.md`
- Modify `docs/test-reports/phase-7-vps.md`

- [x] Record automated crash/reopen, ACK, acceptance-validation, and boot fail-closed evidence without calling the field gate PASS.
- [ ] Real VPS must prove: active transfer -> persisted report -> process restart before POST/ACK -> same report/sequence after restart -> accepted once/debited once.
- [ ] Real VPS must prove idle connection produces no persisted activity/debit and reset/gap behavior invents no seconds.
- [ ] Real VPS must prove DB file remains owner-only and no identifiers leak to logs.
- [ ] Real VPS must prove reboot/startup does not permit stale persisted Xray access before fresh authorization.
- [ ] Keep same-credential concurrency blocker explicit until an approved exact mechanism exists.

## Acceptance

**Repository/CI implementation is complete for the durable telemetry outbox and its fail-closed startup integration.** The latest implementation verification before these documentation updates is CI run `38041159194`, which passed secret scan, PostgreSQL schema/backup/restore and integration gates, dependency audits, JS/TS tests, typecheck, build, and Python tests.

**Phase 7 remains INCOMPLETE.** The current sampler/outbox/startup behavior still needs the real-VPS field tests above, and the exact same-credential concurrent-session accounting requirement remains unresolved unless separately satisfied by an approved mechanism. Do not infer Production Ready or live usage-debit correctness from repository automation alone.
