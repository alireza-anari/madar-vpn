# Active-Second Free Accounting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace aggregate/session-multiplying free-credit debit with durable, globally de-duplicated server-observed UTC active-second buckets while preserving Tehran-day semantics, observed-time Premium semantics, exact telemetry retry identity, and safe mixed-version rollout.

**Architecture:** The Node Agent samples official pinned Xray per-user cumulative byte counters on a UTC-aligned one-second cadence and durably persists exact active-second bits in SQLite. The control plane validates a canonical per-minute bitmap and, in one PostgreSQL transaction, inserts raw telemetry, resolves the credential to its account, de-duplicates seconds globally by `(user_id, UTC minute)`, evaluates Premium history at each observed second, and writes immutable debit evidence only for newly seen billable bits. Legacy aggregate reports remain durably accepted during rollout but never fabricate bitmap positions or create new debit.

**Tech Stack:** Python 3.12+, SQLite, Xray-core v26.3.27 StatsService, TypeScript, Hono, PostgreSQL 17 in CI, `pg`, Vitest, pytest.

**Spec:** `docs/superpowers/specs/2026-10-10-usage-and-premium-single-session-design.md`

## Scope boundary

This plan implements only the **Free active-second accounting** subsystem of the approved specification. Premium single-active-client/device ownership is a separate subsystem whose stable client-instance identity is not yet designed; it requires a separate brainstorming/spike and implementation plan. Nothing here may claim or simulate Premium single-client enforcement.

## Global constraints

- Free usage debits at most one second per account per server-observed UTC second bucket, regardless of concurrent connections, devices, credentials belonging to that account, or Madar nodes.
- Only a positive authenticated Xray uplink/downlink counter delta can mark a bucket active. Idle presence is not billable.
- Missing samples, reset/decrease, query failure, restart, non-monotonic clock, missed boundary, or excessive observation skew create zero inferred activity.
- New telemetry carries fixed 16-character lowercase `activeSecondsHex`. Only bits 0..59 are valid; the high four bits must be zero; all-zero is invalid for a new bitmap report.
- `seconds` equals `popcount(activeSecondsHex)` and masked reports use canonical `xray-traffic:YYYY-MM-DDTHH:MMZ` windows.
- Delivery identity remains `(nodeId, windowId, sequence)`. The same identity with different canonical payload is a conflict, not a duplicate.
- Global debit uniqueness is account-level `(userId, UTC second bucket)`, including overlap across nodes and credential rotations.
- Premium and Tehran-day decisions use observed bucket time, never report-arrival time.
- If Premium overlaps any part of a one-second bucket, that bucket is conservatively non-billable because packet timing inside the bucket is not reconstructed.
- Raw telemetry persistence, second de-duplication, debit evidence, and credit-ledger mutation for a report commit atomically.
- Existing SQLite aggregate rows have no recoverable second positions. Migration preserves them as immutable legacy telemetry with no new debit; it never invents bits.
- Pre-upgrade Agents may continue posting legacy aggregate reports. Those reports are persisted/ACKed but create no active-second debit.
- New Agents must not send masked reports until the authenticated control plane explicitly advertises `activeSecondsV1`; an old server's missing capability endpoint therefore leaves masked reports pending instead of silently losing the new field.
- Complete ACK semantics remain unchanged: only a response where exact integer `accepted + duplicates == batch length` permits local ACK.
- SQLite outbox stays `0600`; parent state directory has no group/other permissions.
- No client UUID, bearer token, node credential, REALITY private key, or raw StatsService output is added to logs.
- Phase 7 remains **INCOMPLETE** until the exact current code is field-proven on a real VPS.

## Review focus

1. **Crash boundary:** any settlement error after raw insert must roll back the raw insert too, so retry can perform full settlement instead of becoming an accepted-but-unbilled duplicate.
2. **Contradictory replay:** same delivery identity with changed `clientId`, bitmap, seconds, timestamp, observed bounds, or session field must return 409 and remain un-ACKed.
3. **60-bit precision:** JS mask arithmetic uses `bigint`; PostgreSQL `bigint` values never round-trip through JS `number`. Bit 59 is explicitly tested.
4. **Observed-time entitlement:** delayed reports after Tehran midnight or Premium expiry use historical state at the bucket, not current state.
5. **Authoritative Premium mutation time:** payment/provider timestamps remain audit evidence, but Premium becomes effective when the control plane authoritatively settles it. Extension remains `max(server settlement now, current premium expiry)`, preventing retroactive Premium from erasing earlier Free usage.
6. **Mixed-version safety:** server-first remains the normal deployment order, while an accidental new-Agent/old-server overlap is mechanically safe because capability negotiation prevents masked POSTs until supported.

---

## File map

### PostgreSQL
- Create `packages/database/src/migrations/0002_active_second_accounting.sql`.
- Modify `tests/integration/postgres-schema.sh` to apply all migration files in lexical order to the clean CI database and test `0001 -> 0002` upgrade separately.
- Modify `tests/integration/postgres-backup-restore.sh` for active-second restore witnesses.

### Control plane
- Create `apps/api/src/usage/index.ts`, `apps/api/src/usage/usage.test.ts`.
- Create `apps/api/src/usage/postgres.ts`, `apps/api/integration/usage.postgres.test.ts`.
- Modify `apps/api/src/nodes/index.ts`, `apps/api/src/nodes/postgres.ts`, `apps/api/src/runtime/postgres.ts`.
- Modify `apps/api/src/index.ts`, `apps/api/src/node-routes.test.ts`, `apps/api/integration/nodes.postgres.test.ts`.

### Premium history writers
- Modify `apps/api/src/credits/postgres.ts`, `apps/api/src/credits/postgres.test.ts`, `apps/api/integration/credits.postgres.test.ts`.
- Modify `apps/api/src/payments/index.ts`, `apps/api/src/payments/payments.test.ts`, `apps/api/src/payments/postgres.ts`, `apps/api/integration/payments.postgres.test.ts`.

### Node Agent
- Modify `node-agent/madar_agent/models.py`, `activity.py`, `service.py`, `outbox.py`, `api.py`, `agent.py`.
- Modify `node-agent/tests/test_activity_source.py`, `test_activity_runtime.py`, `test_service_runtime.py`, `test_telemetry_outbox.py`, `test_durable_telemetry_runtime.py`, `test_control_plane_api.py`, `test_agent_core.py`, `test_service.py`.

### Docs/evidence
- Modify the approved 2026-10-10 spec status, the older clean-start design/implementation plan, `docs/architecture/xray-session-accounting.md`, `docs/runbooks/node-install.md`, and `docs/test-reports/phase-7-vps.md` without rewriting historical field evidence.

---

### Task 1: Add the PostgreSQL active-second schema as migration 0002

**Files:** create `packages/database/src/migrations/0002_active_second_accounting.sql`; modify `tests/integration/postgres-schema.sh`, `tests/integration/postgres-backup-restore.sh`.

**Schema contract:**
- `usage_accounting_config(id=1, active_second_epoch timestamptz)`.
- `premium_entitlement_events(event_order bigint identity, user_id, source_key UNIQUE, effective_at, premium_until)`.
- `usage_active_minutes(user_id, minute_start, settled_mask bigint, updated_at)` PK `(user_id, minute_start)`, mask range `0..1152921504606846975`.
- `usage_debit_events(node_id, window_id, sequence, user_id, minute_start, observed_mask, new_mask, debited_mask, debit_seconds, created_at)` keyed/FK'd to raw telemetry identity.
- `telemetry_reports.active_seconds_hex text NULL` and `settlement_status` in `legacy|settled|unmapped`; non-null bitmap must match `^0[0-9a-f]{15}$` and must not be all zero.

- [ ] **Step 1 — RED schema tests:** make the clean-schema CI test apply `packages/database/src/migrations/*.sql` in lexical order, assert the new tables/columns/constraints, assert `2^60` masks fail, and assert invalid/zero bitmap text fails. Add an isolated upgrade fixture that applies `0001`, seeds an existing `memberships` row, then applies `0002`; verify one baseline entitlement event is created at the exact `active_second_epoch` with the existing `premium_until`.
- [ ] **Step 2 — Verify RED:** run `bash tests/integration/postgres-schema.sh`; expect failure because 0002 does not exist.
- [ ] **Step 3 — GREEN migration:** implement transactional 0002 without editing/replaying 0001. `CURRENT_TIMESTAMP` is one consistent rollout epoch for the singleton config and migration baseline events. Existing raw telemetry remains bitmap-null/status `legacy`.
- [ ] **Step 4 — Restore witness:** seed raw telemetry + settled-minute + debit-event witness and prove destructive PostgreSQL 17 backup/restore preserves it exactly.
- [ ] **Step 5 — Verify/commit:** run schema + backup/restore tests; commit `feat: add active-second accounting schema`.

**Deployment note:** the CI lexical loop is a fresh-schema verifier, not a production migration ledger. On an existing 0001 database, apply only `0002_active_second_accounting.sql` after backup/preflight. Task 8 records this explicitly so nobody reruns 0001 against an existing DB.

---

### Task 2: Define canonical bitmap telemetry and immutable delivery identity

**Files:** create `apps/api/src/usage/index.ts`, `apps/api/src/usage/usage.test.ts`; modify `apps/api/src/nodes/index.ts`, `apps/api/src/node-routes.test.ts`.

**Interfaces:**
- `parseActiveSecondsHex(value: string): bigint`
- `formatActiveSecondsHex(mask: bigint): string`
- `popcount60(mask: bigint): number`
- `parseTrafficWindowId(windowId: string): Date`
- `TelemetryReport.activeSecondsHex?: string`
- `TelemetrySettlement.accept(report): Promise<'accepted'|'duplicate'|'conflict'>`

- [ ] **Step 1 — RED domain tests:** pin `0000000000000001` (bit 0), `0800000000000000` (bit 59), multi-bit popcount, invalid case/length/high nibble/all-zero, impossible calendar minute, and `seconds != popcount`. Legacy reports without bitmap keep existing aggregate validation and may keep noncanonical historical window ids.
- [ ] **Step 2 — Verify RED:** `pnpm --filter @madar/api test -- usage.test.ts node-routes.test.ts`.
- [ ] **Step 3 — GREEN contract:** implement all mask operations with `bigint`. For masked reports, billing identity comes only from canonical `windowId + activeSecondsHex`; timestamps remain diagnostic. `conflict` becomes `NodeControlError(409, 'TELEMETRY_IDENTITY_CONFLICT', ...)`.
- [ ] **Step 4 — Existing behavior:** prove old no-bitmap route requests still return accepted/duplicate and no unknown secret field is persisted.
- [ ] **Step 5 — Commit:** `feat: define active-second telemetry contract`.

---

### Task 3: Add authoritative Premium history and correct settlement-time semantics

**Files:** modify credits/payment files listed above plus `apps/api/src/usage/index.ts` and `usage.test.ts`.

**Interfaces:**
- Premium adjustment history source: `adjustment:<credit-adjustment-key>`.
- Payment history source: `payment:<payment-event-source-key>`.
- History stores the resulting `premium_until` and authoritative server `effective_at`.
- Payment store evolves to preserve **both** provider/source occurrence time and server settlement time: provider time stays in `payment_events.occurred_at`; `orders.settled_at`, membership extension, and entitlement-history `effective_at` use server `now()`.
- Produce `billableMaskForMinute({ minuteStart, candidateMask, accountingEpoch, entitlementEvents }): bigint`.

- [ ] **Step 1 — RED mutation/history tests:** admin Premium adjustment locks the user row, updates membership, appends one history row, and replay appends none. Payment settlement uses `max(serverSettlementNow,currentPremiumUntil)` even when a verified provider callback carries an older `occurredAt`; duplicate provider/manual event creates no second history row.
- [ ] **Step 2 — RED bucket tests:** Free bucket is billable; Premium at bucket start is not; Premium starting midway or expiring midway makes the whole bucket non-billable; pre-epoch bucket is non-billable; equal-time events resolve by `event_order`.
- [ ] **Step 3 — Verify RED:** run focused credits/payment/usage unit tests and PostgreSQL integration tests.
- [ ] **Step 4 — GREEN implementation:** all Premium mutation paths lock `users.id FOR UPDATE` before membership/history changes. Never infer delayed historical state from current `memberships`; it remains only the current projection.
- [ ] **Step 5 — Verify/commit:** commit `feat: record premium entitlement history`.

---

### Task 4: Settle masked telemetry atomically in PostgreSQL

**Files:** create `apps/api/src/usage/postgres.ts`, `apps/api/integration/usage.postgres.test.ts`; modify runtime/nodes PostgreSQL files.

**Rules:** credential mapping is `client_credentials.uuid = clientId` including revoked credentials; global overlap is keyed by user, not credential; exact duplicates compare the complete normalized raw payload (`clientId`, window, sequence, seconds, timestamp, nullable observed bounds/session, bitmap).

- [ ] **Step 1 — RED integration matrix:** prove: one ten-bit report -> exactly `-10`; exact retry -> zero additional; contradictory retry -> conflict; two nodes same ten bits -> total `-10`; two nodes disjoint five bits -> `-10`; two credentials for same user overlapping -> once; revoked credential delayed report maps; unknown credential persists `unmapped` with zero debit; legacy report persists `legacy` with zero debit; Premium-period report arriving after expiry -> zero free debit; prior Tehran-day report arriving after midnight affects only prior day; injected SQL failure after raw insert leaves no raw/mask/debit/ledger state.
- [ ] **Step 2 — Verify RED:** `pnpm --filter @madar/api test:postgres -- usage.postgres.test.ts`.
- [ ] **Step 3 — GREEN transaction:** for each new report: insert raw or compare existing; resolve user; lock user `FOR UPDATE`; read epoch/history; lock/create `usage_active_minutes`; compute `newMask = incoming & ~settled`; OR **all** incoming bits into settled state, including Premium/non-billable bits; compute billable bits second-by-second; group ledger debit by `tehranDateKey(bucketStart)`; insert immutable debit evidence and one usage-ledger row per non-empty day group; update settlement status; commit. Any error rolls everything back.
- [ ] **Step 4 — Precision:** pass PostgreSQL mask values as BigInt-safe decimal/string values; never cast 60-bit masks through JS `number`. Test bit 59 in PostgreSQL, not only pure code.
- [ ] **Step 5 — Runtime wiring:** production `createPostgresRequestRuntime()` injects `PostgresUsageSettlementStore` into node control. Keep `PostgresNodeControlStore.insertTelemetry()` only as legacy/unit raw adapter; it is not the production debit path.
- [ ] **Step 6 — Verify/commit:** run usage/nodes/runtime PostgreSQL integration; commit `feat: settle active-second usage atomically`.

`unmapped` masked telemetry is durable server evidence, not a successful accounting claim. It must be observable in DB/acceptance checks, and any occurrence on a managed field client blocks Phase 7 PASS until explained/resolved.

---

### Task 5: Align Xray observation to deterministic UTC second buckets

**Files:** modify `node-agent/madar_agent/activity.py`, `service.py`, `models.py` and activity/service tests.

**Interfaces:**
- `next_utc_second_boundary(now: datetime) -> datetime`
- `XrayTrafficActivitySource.sample(*, bucket_end: datetime)`
- exact bucket start is `bucket_end - 1s`
- default allowed post-boundary observation skew: `0.75s` (field-measured later)

- [ ] **Step 1 — RED cadence tests:** `12:00:00.123Z -> 12:00:01Z`; an exact boundary schedules the next second; first sample baseline only; positive delta across consecutive scheduled boundaries marks exactly the preceding bucket; unchanged=zero; reset/decrease=zero+rebaseline; nonconsecutive target, backward clock, query failure, or >0.75s skew breaks continuity and next sample is baseline-only.
- [ ] **Step 2 — RED worker test:** delayed worker iteration recomputes wall-clock target and skips missed buckets rather than catch-up/replay.
- [ ] **Step 3 — Verify RED:** run `test_activity_source.py`, `test_activity_runtime.py`, `test_service_runtime.py`.
- [ ] **Step 4 — GREEN:** scheduled UTC identity determines the bit; actual wake/query time only determines trustworthiness. No sub-second packet reconstruction.
- [ ] **Step 5 — Verify/commit:** commit `feat: align Xray activity to UTC buckets`.

---

### Task 6: Migrate SQLite outbox to bitmap schema v2 without inventing legacy seconds

**Files:** modify `outbox.py`, `models.py`, `test_telemetry_outbox.py`, `test_durable_telemetry_runtime.py`.

**Interfaces:**
- `UsageReport.active_seconds_hex: str | None = None`
- `TelemetryOutbox.record_active_bucket(client_id, bucket_start, timestamp, observed_from, observed_to)`
- accepted local schema `PRAGMA user_version = 2`
- new activity rows store low-60-bit integer `active_mask`; pending reports persist nullable bitmap.

- [ ] **Step 1 — RED v2 tests:** :00 -> `0000000000000001`; :59 -> `0800000000000000`; duplicate same bucket ORs idempotently; multiple buckets produce one mask/popcount; masked pending survives reopen with identical identity/payload; ACK comparison includes bitmap; file/parent permissions remain restrictive; unsupported future schema version fails closed.
- [ ] **Step 2 — RED migration fixtures:** an actual v1 DB with existing pending rows migrates them unchanged with bitmap `None`; v1 aggregate `activity_windows` becomes immutable **legacy** pending report(s) with newly allocated monotonic sequence(s), never guessed bits; `window_sequences` remains monotonic.
- [ ] **Step 3 — Verify RED:** run outbox/durable runtime tests.
- [ ] **Step 4 — GREEN migration:** detect fresh vs v1 before creating v2 tables; perform v1->v2 transactionally; SQLite integer is safe for low 60 bits; encode 16-char hex only when freezing a pending report. Existing pending continues to block preparation of later accumulated activity until ACK.
- [ ] **Step 5 — Verify/commit:** commit `feat: persist active-second telemetry bitmaps`.

---

### Task 7: Add capability negotiation and wire masked telemetry end-to-end

**Files:** modify `apps/api/src/index.ts`, `node-routes.test.ts`; modify Agent `api.py`, `agent.py`, `service.py`, `activity.py`; modify control-plane/agent service tests.

**Interfaces:**
- Authenticated `GET /api/node/telemetry/capabilities` -> `{ activeSecondsV1: true }` on the new control plane.
- `ControlPlaneClient.supports_active_second_telemetry() -> bool`; authenticated 404 means `False`, not a fatal Agent error.
- New reports serialize `activeSecondsHex`; migrated legacy reports omit it.

- [ ] **Step 1 — RED capability tests:** new endpoint requires node bearer auth and returns the capability. Old-server fixture returns 404; new Agent must not POST a pending masked report and must leave it byte-for-byte intact. Once capability becomes true, it posts that exact report. Legacy pending reports may still be posted to an old server.
- [ ] **Step 2 — RED transport tests:** new payload carries lowercase bitmap with matching popcount; server-first rollout accepts old Agent reports; malformed/incomplete 2xx response leaves pending masked report; duplicate response after committed server settlement ACKs/removes it.
- [ ] **Step 3 — Verify RED:** run listed Python tests + `node-routes.test.ts`.
- [ ] **Step 4 — GREEN wiring:** source -> outbox -> `UsageReport` -> HTTP -> validated PostgreSQL settlement. Do not add session IDs. Keep 30-second posting cadence; one-second sampler only creates durable evidence. Probe capability before any batch containing a bitmap; if capability is absent/unavailable, do not ACK or downgrade/strip the bitmap.
- [ ] **Step 5 — Full repository verification:** PostgreSQL schema/backup/restore/runtime/integration, JS/Python dependency audits, `pnpm test`, `pnpm typecheck`, `pnpm build`, `pnpm test:python`, secret scan.
- [ ] **Step 6 — Commit:** `feat: wire active-second telemetry end to end`.

---

### Task 8: Reconcile superseded docs and prepare the real Phase 7 field gate

**Files:** update the approved spec status, older clean-start spec/plan, Xray accounting ADR, node-install runbook, Phase 7 report, and this plan completion boxes.

- [ ] **Step 1 — Source-of-truth reconciliation:** mark 2026-10-10 spec Approved. Replace old “distinct simultaneous sessions multiply free usage” text with account-level active-second semantics and point to the amendment. Keep Premium single-client enforcement unresolved.
- [ ] **Step 2 — ADR/runbook:** state stock-Xray session multiplicity is no longer a free-billing blocker but still does not solve Premium device identity. Document existing-DB migration as backup/preflight -> apply **0002 only** -> deploy control plane -> verify capability -> upgrade Agents. Do not rerun 0001 against an existing DB.
- [ ] **Step 3 — Preserve history:** never rewrite earlier field evidence as though bitmap billing was tested then. Historical identifier-bearing journals remain preserved per the existing user decision.
- [ ] **Step 4 — Exact real-VPS checklist on one current head:** pinned Xray managed counters; sustained direct VLESS+REALITY traffic creates expected UTC bitmap and exactly-once PG debit; idle open connection creates no bits/debit; simultaneous overlapping connections do not multiply debit; reset/restart/gap creates no inferred bits; restart Agent before local ACK preserves exact `(windowId,sequence,seconds,activeSecondsHex)` and retry debits once; malformed acceptance leaves pending; outbox permissions/log privacy remain correct; current boot ordering proves no stale Xray authorization; no masked report is `unmapped`; delayed Premium/day behavior is proven at least at real control-plane integration level. Cross-node overlap remains a later multi-node gate unless a second real node is available.
- [ ] **Step 5 — Final CI evidence:** record exact head SHA/run only after full success. Do **not** mark Phase 7 PASS until the real VPS checklist passes.
- [ ] **Step 6 — Commit:** `docs: reconcile active-second accounting acceptance`.

---

## Completion gates

Repository/CI implementation is complete only after Tasks 1-8 are green on one exact head and documentation cleanly separates automated evidence from field evidence.

Phase 7 completes only after that exact deployed head passes the real-VPS checklist. Green CI alone is not Phase 7 PASS.

Premium single-active-client enforcement remains explicitly out of scope and is a separate unresolved design/release gate; no work in this plan may be used to claim that Premium device locking is operational.
