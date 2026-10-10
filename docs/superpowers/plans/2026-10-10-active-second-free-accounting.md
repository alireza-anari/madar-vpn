# Active-Second Free Accounting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace aggregate/session-multiplying free-credit debit with durable, globally de-duplicated server-observed UTC active-second buckets, while preserving safe rolling upgrades, Tehran-day semantics, observed-time Premium semantics, and exact telemetry retry identity.

**Architecture:** The Node Agent samples official pinned Xray per-user cumulative byte counters on a UTC-aligned one-second cadence and persists exact active-second bits in its SQLite outbox. The control plane validates a canonical per-minute bitmap and, in one PostgreSQL transaction, durably inserts raw telemetry, resolves the client credential to its account, de-duplicates active seconds globally by `(user_id, UTC minute)`, evaluates Premium history at each observed second, and writes immutable free-credit debit evidence only for newly seen billable bits. Legacy aggregate reports remain durably accepted during rollout but never fabricate bitmap positions or create new debit.

**Tech Stack:** Python 3.12+, SQLite, Xray-core v26.3.27 StatsService, TypeScript, Hono, PostgreSQL 17 in CI, `pg`, Vitest, pytest.

**Spec:** `docs/superpowers/specs/2026-10-10-usage-and-premium-single-session-design.md`

## Scope boundary

This plan implements the **Free active-second accounting** subsystem of the approved specification. Premium single-active-client/device ownership is a separate subsystem whose stable client-instance identity is not yet designed; it must receive a separate brainstorming/spike and implementation plan. Nothing in this plan may claim or simulate Premium single-client enforcement.

## Global Constraints

- Free usage may debit at most one second per account per server-observed UTC second bucket, regardless of concurrent connections, devices, or Madar nodes.
- Only a positive authenticated Xray uplink or downlink counter delta can mark a bucket active; idle presence is not billable.
- Missing samples, counter reset/decrease, query failure, process restart, non-monotonic clock, missed UTC boundary, or excessive skew are ambiguous and must create zero inferred activity.
- New telemetry carries a fixed 16-character lowercase hexadecimal 64-bit `activeSecondsHex`; only bits 0..59 are valid and the high four bits must be zero.
- For bitmap reports, `seconds` must equal `popcount(activeSecondsHex)` and `windowId` must canonically identify the same UTC minute.
- Delivery idempotency remains `(nodeId, windowId, sequence)`; retry of an identity with a different payload is an error, not a harmless duplicate.
- Global debit uniqueness is account-level `(userId, UTC second bucket)`, including overlap across nodes and credential rotations belonging to the same user.
- Premium and Tehran-day decisions use the observed bucket time, never report-arrival time.
- If Premium overlaps any part of a one-second bucket, that bucket is conservatively non-billable because packet timing inside the bucket is not reconstructed.
- Raw telemetry persistence, second de-duplication, usage-debit evidence, and credit-ledger mutation for a report must commit atomically.
- Existing SQLite aggregate rows have no recoverable second positions. Migration must preserve them as immutable legacy telemetry with no new debit; it must never invent a bitmap.
- Existing pre-upgrade Agents may continue posting legacy reports during rollout. Legacy reports are accepted/persisted, acknowledged normally, and produce no new active-second debit.
- Existing telemetry ACK safety remains: only a complete `accepted + duplicates == batch length` response permits local ACK.
- SQLite outbox file remains mode `0600`; its parent state directory remains owner-only (`0700` or equivalently no group/other bits).
- No client UUID, bearer token, node credential, REALITY private key, or raw StatsService output may be added to logs.
- Phase 7 remains INCOMPLETE until current code is re-run on a real VPS and the real traffic→bitmap→PostgreSQL→debit path is proven.

## Review Focus

1. **Crash boundary after raw insert:** a crash/error anywhere in settlement must roll back the raw telemetry insert too, so a retry can perform the full settlement rather than becoming an accepted-but-unbilled duplicate. Task 4 adds rollback and retry tests.
2. **Same identity, changed payload:** `(nodeId,windowId,sequence)` replay with different client, bitmap, seconds, or timestamps must return conflict and must not be ACKed as duplicate. Tasks 2 and 4 pin canonical comparison behavior.
3. **60-bit precision:** JavaScript `number` cannot safely represent every 60-bit mask; all mask arithmetic uses `bigint`, and PostgreSQL `bigint` values cross the driver boundary as decimal strings/BigInt-safe values. Tasks 2 and 4 test bit 59 explicitly.
4. **Delayed entitlement/day changes:** reports arriving after Tehran midnight or after Premium expiry must use the bucket's observed time. Tasks 3 and 4 test both delayed cases, including a Premium change inside a bucket.
5. **Rolling upgrade with old SQLite/API reports:** legacy aggregate state must survive Agent upgrade and server deployment without fabricated debit or infinite retry. Tasks 1, 6, and 7 test both server-first and Agent-first-compatible behavior.

---

## File map

### PostgreSQL / migration boundary

- Create `scripts/apply-postgres-migrations.sh` — apply authoritative `packages/database/src/migrations/*.sql` in lexical order with `ON_ERROR_STOP`.
- Create `packages/database/src/migrations/0002_active_second_accounting.sql` — bitmap column/status, accounting epoch, Premium entitlement history, global settled-minute state, immutable debit evidence.
- Modify `tests/integration/postgres-schema.sh` — use the migration runner and assert new tables/constraints/baseline invariants.
- Modify `tests/integration/postgres-backup-restore.sh` — preserve/verify a new active-second witness row through destructive backup/restore.

### Control-plane domain / storage

- Create `apps/api/src/usage/index.ts` — canonical bitmap/window parsing, popcount, observed-time Premium billability, telemetry-settlement interface/result types.
- Create `apps/api/src/usage/usage.test.ts` — pure contract tests for bit 59, canonical windows, Premium overlap, epoch/day behavior.
- Create `apps/api/src/usage/postgres.ts` — atomic PostgreSQL telemetry ingest and active-second settlement.
- Create `apps/api/integration/usage.postgres.test.ts` — concurrency, overlap, delayed Premium/Tehran, rollback, identity-conflict integration tests.
- Modify `apps/api/src/nodes/index.ts` — add optional bitmap to `TelemetryReport`, delegate production ingest to `TelemetrySettlement`, preserve legacy validation.
- Modify `apps/api/src/nodes/postgres.ts` — keep raw legacy adapter compatible with the expanded report shape; production runtime will use the atomic usage store.
- Modify `apps/api/src/runtime/postgres.ts` — wire `PostgresUsageSettlementStore` into the node service.
- Modify `apps/api/src/node-routes.test.ts`, `apps/api/integration/nodes.postgres.test.ts` — HTTP/backward-compatibility and raw adapter coverage.

### Premium history writers

- Modify `apps/api/src/credits/postgres.ts`, `apps/api/src/credits/postgres.test.ts`, `apps/api/integration/credits.postgres.test.ts` — serialize admin/manual Premium adjustments on the user row and append resulting-state history.
- Modify `apps/api/src/payments/postgres.ts`, `apps/api/integration/payments.postgres.test.ts` — append resulting Premium state for payment settlement in the existing user-locked transaction.

### Node Agent / local durability

- Modify `node-agent/madar_agent/models.py` — `UsageReport.active_seconds_hex: str | None` and matching observed activity representation.
- Modify `node-agent/madar_agent/activity.py` — deterministic UTC bucket assignment; exact bit aggregation; no inferred activity on skew/gaps/reset.
- Modify `node-agent/madar_agent/service.py` — UTC-boundary scheduling instead of drifting `wait(1.0)` cadence.
- Modify `node-agent/madar_agent/outbox.py` — SQLite schema v2, mask OR, legacy-state migration, immutable masked pending reports.
- Modify `node-agent/madar_agent/api.py` — serialize `activeSecondsHex` when present and preserve complete-ACK validation.
- Modify `node-agent/madar_agent/agent.py` — pass bitmap reports through fallback/outbox paths consistently.
- Modify `node-agent/tests/test_activity_source.py`, `test_activity_runtime.py`, `test_service_runtime.py`, `test_telemetry_outbox.py`, `test_durable_telemetry_runtime.py`, `test_control_plane_api.py` — new cadence/bitmap/durability/rolling-upgrade acceptance.

### Documentation / evidence

- Modify `docs/superpowers/specs/2026-10-10-usage-and-premium-single-session-design.md` — mark written spec Approved after implementation starts; do not change operational claims.
- Modify `docs/superpowers/specs/2026-10-08-madar-clean-start-design.md` and `docs/superpowers/plans/2026-10-08-madar-implementation-plan.md` — replace superseded session-multiplication language with the approved amendment and point to this plan.
- Modify `docs/architecture/xray-session-accounting.md` — mark raw-session multiplicity requirement superseded for free billing; retain stock-Xray device-identity limitation for Premium.
- Modify `docs/runbooks/node-install.md` and `docs/test-reports/phase-7-vps.md` — document masked telemetry rollout and the new real-VPS acceptance gate without rewriting historical evidence.

---

### Task 1: Add sequential PostgreSQL migration support and active-second schema

**Files:**
- Create: `scripts/apply-postgres-migrations.sh`
- Create: `packages/database/src/migrations/0002_active_second_accounting.sql`
- Modify: `tests/integration/postgres-schema.sh`
- Modify: `tests/integration/postgres-backup-restore.sh`

**Interfaces:**
- Produces: authoritative schema applied by lexical migration order.
- Produces tables/columns used by Tasks 3–4:
  - `usage_accounting_config(id=1, active_second_epoch timestamptz)`
  - `premium_entitlement_events(event_order bigint identity, user_id, source_key UNIQUE, effective_at, premium_until)`
  - `usage_active_minutes(user_id, minute_start, settled_mask bigint, updated_at)` with PK `(user_id, minute_start)` and mask range `0..1152921504606846975`.
  - `usage_debit_events(node_id, window_id, sequence, user_id, minute_start, observed_mask, new_mask, debited_mask, debit_seconds, created_at)` with PK/FK to raw report identity.
  - `telemetry_reports.active_seconds_hex text NULL` plus settlement status `legacy|settled|unmapped`.

- [ ] **Step 1: Extend the schema contract first**

Update `postgres-schema.sh` to call `scripts/apply-postgres-migrations.sh` and assert the new tables/columns exist, masks reject `2^60`, bitmap text rejects non-canonical values, and `usage_accounting_config` has exactly one non-null epoch row. Seed a `memberships` row before applying `0002` in an isolated migration fixture and assert a baseline `premium_entitlement_events` row is created at the same epoch with the existing `premium_until`.

- [ ] **Step 2: Run the schema test and verify RED**

Run: `bash tests/integration/postgres-schema.sh` with CI's `TEST_DATABASE_URL`.
Expected: FAIL because the migration runner/0002 tables do not exist.

- [ ] **Step 3: Implement the migration runner and `0002_active_second_accounting.sql`**

The runner must fail on the first SQL error and apply `*.sql` in bytewise lexical order. `0002` runs transactionally. `CURRENT_TIMESTAMP` is the rollout epoch for both the singleton config and migration baseline Premium events. Existing `telemetry_reports` rows remain `active_seconds_hex = NULL` and status `legacy`.

- [ ] **Step 4: Add backup/restore witness coverage and verify GREEN**

Seed one `usage_active_minutes` + `usage_debit_events` witness in `postgres-schema.sh`; after destructive restore, assert its mask/debit values are unchanged.

Run:
`bash tests/integration/postgres-schema.sh && bash tests/integration/postgres-backup-restore.sh`
Expected: PASS.

- [ ] **Step 5: Commit**

Commit: `feat: add active-second accounting schema`

---

### Task 2: Define canonical bitmap telemetry and immutable duplicate semantics

**Files:**
- Create: `apps/api/src/usage/index.ts`
- Create: `apps/api/src/usage/usage.test.ts`
- Modify: `apps/api/src/nodes/index.ts`
- Modify: `apps/api/src/node-routes.test.ts`

**Interfaces:**
- Produces `parseActiveSecondsHex(value: string): bigint`.
- Produces `formatActiveSecondsHex(mask: bigint): string` for tests/internal canonicalization.
- Produces `parseTrafficWindowId(windowId: string): Date` for exact `xray-traffic:YYYY-MM-DDTHH:MMZ` values.
- Produces `popcount60(mask: bigint): number`.
- `TelemetryReport` gains `activeSecondsHex?: string`.
- Produces `TelemetrySettlement.accept(report: TelemetryReport): Promise<'accepted' | 'duplicate' | 'conflict'>`.
- Legacy report = no `activeSecondsHex`; it retains the existing aggregate validation and is never interpreted as exact bucket evidence.

- [ ] **Step 1: Write bitmap/window validation tests**

Add tests proving:
- `0000000000000001` => bit 0, popcount 1.
- `0800000000000000` => bit 59, popcount 1 without `number` conversion.
- `0000000000000003` => popcount 2.
- uppercase, short/long strings, any first nibble other than `0`, zero mask for a new report, invalid calendar minute, and `seconds !== popcount` are rejected as `TELEMETRY_INVALID`.
- legacy `window-1` without bitmap remains accepted for rolling upgrade and causes no masked interpretation.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `pnpm --filter @madar/api test -- usage.test.ts node-routes.test.ts`
Expected: FAIL on missing usage helpers/field validation.

- [ ] **Step 3: Implement the pure bitmap contract and node-service delegation**

Use `bigint` for every mask operation. For masked reports, derive billable bucket identity only from canonical `windowId + activeSecondsHex`; `timestamp`/`observedFrom`/`observedTo` stay diagnostic. If `TelemetrySettlement.accept()` returns `conflict`, throw `NodeControlError(409, 'TELEMETRY_IDENTITY_CONFLICT', ...)` so the Agent cannot ACK a contradictory replay.

- [ ] **Step 4: Verify focused and existing node tests**

Run: `pnpm --filter @madar/api test -- usage.test.ts node-routes.test.ts nodes/nodes.test.ts`
Expected: PASS, including old no-bitmap route behavior.

- [ ] **Step 5: Commit**

Commit: `feat: define active-second telemetry contract`

---

### Task 3: Persist observed-time Premium entitlement history on every mutation path

**Files:**
- Modify: `apps/api/src/credits/postgres.ts`
- Modify: `apps/api/src/credits/postgres.test.ts`
- Modify: `apps/api/integration/credits.postgres.test.ts`
- Modify: `apps/api/src/payments/postgres.ts`
- Modify: `apps/api/integration/payments.postgres.test.ts`
- Modify: `apps/api/src/usage/index.ts`
- Modify: `apps/api/src/usage/usage.test.ts`

**Interfaces:**
- Premium adjustment history source key: `adjustment:<credit-adjustment-unique-key>`.
- Payment history source key: `payment:<payment-event-source-key>`.
- Each history row stores the **resulting** `premium_until` and the mutation's authoritative `effective_at`.
- Produces pure `billableMaskForMinute(input: { minuteStart: Date; candidateMask: bigint; accountingEpoch: Date; entitlementEvents: PremiumEntitlementEvent[] }): bigint`.

- [ ] **Step 1: Write failing history and observed-time tests**

Pin these cases:
- admin Premium adjustment locks the user, updates `memberships`, and inserts exactly one history row in the same transaction; replay inserts neither a second adjustment nor history row.
- payment settlement appends one resulting-state history row after extending from `max(settledAt,currentPremiumUntil)`; duplicate provider/manual event adds no history row.
- a bucket wholly Free is billable.
- a bucket Premium at its start is not billable.
- Premium starting halfway through a bucket makes the whole bucket non-billable.
- Premium expiring halfway through a bucket makes the whole bucket non-billable.
- a bucket before `active_second_epoch` is non-billable.
- two history events with identical `effective_at` resolve in `event_order` order.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `pnpm --filter @madar/api test -- usage.test.ts credits/postgres.test.ts` plus the PostgreSQL integration tests for credits/payments.
Expected: FAIL on missing history writes/helper.

- [ ] **Step 3: Implement serialized history writes and pure billability**

All Premium mutation paths must lock `users.id FOR UPDATE` before changing membership/history so Task 4 can use the same per-user serialization boundary. Never infer history from current `memberships` during delayed settlement; `memberships` remains the current projection only.

- [ ] **Step 4: Verify tests**

Run: relevant unit + `apps/api/integration/credits.postgres.test.ts` + `apps/api/integration/payments.postgres.test.ts`.
Expected: PASS.

- [ ] **Step 5: Commit**

Commit: `feat: record premium entitlement history`

---

### Task 4: Implement atomic PostgreSQL active-second telemetry settlement

**Files:**
- Create: `apps/api/src/usage/postgres.ts`
- Create: `apps/api/integration/usage.postgres.test.ts`
- Modify: `apps/api/src/runtime/postgres.ts`
- Modify: `apps/api/src/nodes/postgres.ts`
- Modify: `apps/api/integration/nodes.postgres.test.ts`

**Interfaces:**
- Produces `PostgresUsageSettlementStore` implementing `TelemetrySettlement.accept(report)`.
- Client-to-account mapping is `client_credentials.uuid = report.clientId` and intentionally includes revoked credentials so delayed reports remain attributable.
- Account-wide overlap state is keyed by `(user_id, minute_start)`, not credential/client id.
- Exact duplicate = same delivery identity and same canonical raw payload; conflicting duplicate = same delivery identity but different payload.

- [ ] **Step 1: Write PostgreSQL settlement integration tests first**

Add independent tests for:
- one masked report with ten bits produces one raw report, one usage-debit event, `settled_mask` with those ten bits, and `credit_ledger` delta `-10` on the observed Tehran day.
- same report replay returns `duplicate` and changes no debit/state.
- same identity with different bitmap/seconds/client/timestamp returns `conflict` and changes no state.
- node A and node B concurrently report the same ten bits for the same user/minute: both raw reports may be accepted, global settled mask has ten bits, ledger total is `-10`, not `-20`.
- two nodes concurrently report disjoint five-bit masks: global ledger total is `-10`.
- two credentials belonging to the same user overlap: account-level de-duplication still charges each second once.
- revoked credential delayed report still resolves to its user.
- unknown credential persists raw status `unmapped`, creates no ledger debit, and is safely acknowledged as accepted durable evidence.
- legacy no-bitmap report persists status `legacy`, creates no debit.
- observed Premium bucket arriving after Premium expiry creates zero free debit.
- prior Tehran-day bucket arriving after midnight creates debit only on the prior day and cannot consume the new day's grant.
- injected SQL failure after raw insert rolls back raw insert, settled mask, debit event, and ledger so retry can succeed fully.

- [ ] **Step 2: Run integration test and verify RED**

Run: `pnpm --filter @madar/api test:postgres -- usage.postgres.test.ts`
Expected: FAIL because `PostgresUsageSettlementStore` does not exist.

- [ ] **Step 3: Implement one-transaction settlement**

Transaction order per new report:
1. insert raw telemetry or compare the existing payload on conflict;
2. for new bitmap evidence, resolve credential→user;
3. lock that user row `FOR UPDATE`;
4. read accounting epoch + Premium history needed for the minute;
5. lock/create the user's `usage_active_minutes` row;
6. compute `newMask = incomingMask & ~settledMask` with `bigint`;
7. mark all accepted incoming bits settled, including Premium/non-billable bits, so they can never be charged later;
8. compute billable bits by observed second and group resulting ledger debit by `tehranDateKey(bucketStart)`;
9. insert immutable `usage_debit_events` evidence and one `credit_ledger` usage row per non-empty Tehran-day group using key `usage:<nodeId>:<windowId>:<sequence>:<freeDay>`;
10. set raw report settlement status and commit.

Any exception rolls the entire transaction back. Never cast a 60-bit mask to JavaScript `number`.

- [ ] **Step 4: Wire production runtime and verify raw legacy adapter tests**

`createPostgresRequestRuntime()` must pass `new PostgresUsageSettlementStore(database)` into `createNodeControlService`. Keep `PostgresNodeControlStore.insertTelemetry()` compatible for legacy/unit callers, but it is not the production debit path.

Run: usage integration + nodes integration + runtime integration tests.
Expected: PASS.

- [ ] **Step 5: Commit**

Commit: `feat: settle active-second usage atomically`

---

### Task 5: Align Xray activity sampling to deterministic UTC second buckets

**Files:**
- Modify: `node-agent/madar_agent/activity.py`
- Modify: `node-agent/madar_agent/service.py`
- Modify: `node-agent/madar_agent/models.py`
- Modify: `node-agent/tests/test_activity_source.py`
- Modify: `node-agent/tests/test_activity_runtime.py`
- Modify: `node-agent/tests/test_service_runtime.py`

**Interfaces:**
- Produces `next_utc_second_boundary(now: datetime) -> datetime`.
- `XrayTrafficActivitySource.sample(*, bucket_end: datetime) -> None` receives the scheduled exact UTC boundary.
- Source callback records `client_id`, exact `bucket_start = bucket_end - 1 second`, and diagnostic observed timestamps.
- Default maximum post-boundary observation skew: `0.75` seconds; excessive skew is ambiguous and records zero.

- [ ] **Step 1: Write failing cadence/activity tests**

Pin:
- `12:00:00.123Z` schedules `12:00:01.000Z`; exact-boundary input schedules the following second, never the same boundary.
- first scheduled sample is baseline only.
- positive byte delta across consecutive scheduled boundaries marks exactly the preceding bucket once.
- unchanged counters = no bucket.
- counter decrease/reset = no bucket and rebaseline.
- non-consecutive scheduled boundaries, clock moving backward, query failure, or actual observation more than `0.75s` late = no inferred bucket; next valid sample is baseline-only where continuity was broken.
- the worker recomputes the next wall-clock boundary after each sample, so a delayed iteration skips missed buckets rather than replaying/catching up fabricated seconds.

- [ ] **Step 2: Run Python focused tests and verify RED**

Run: `python3 -m pytest node-agent/tests/test_activity_source.py node-agent/tests/test_activity_runtime.py node-agent/tests/test_service_runtime.py -q`
Expected: FAIL on missing boundary-aware API.

- [ ] **Step 3: Implement boundary scheduling and conservative source semantics**

Use timezone-aware UTC dates. The scheduled bucket identity, not thread wake timestamp, determines the bit. Actual wake/query time only validates whether the observation is trustworthy. Do not infer sub-second packet timing.

- [ ] **Step 4: Verify focused Python tests**

Expected: PASS.

- [ ] **Step 5: Commit**

Commit: `feat: align Xray activity to UTC buckets`

---

### Task 6: Migrate the durable SQLite outbox to bitmap schema v2 without inventing legacy seconds

**Files:**
- Modify: `node-agent/madar_agent/outbox.py`
- Modify: `node-agent/madar_agent/models.py`
- Modify: `node-agent/tests/test_telemetry_outbox.py`
- Modify: `node-agent/tests/test_durable_telemetry_runtime.py`

**Interfaces:**
- `UsageReport.active_seconds_hex: str | None = None`.
- New `TelemetryOutbox.record_active_bucket(*, client_id: str, bucket_start: datetime, timestamp: datetime, observed_from: datetime | None, observed_to: datetime | None) -> None`.
- SQLite `PRAGMA user_version = 2` is the accepted schema version.
- New activity rows store integer `active_mask` (low 60 bits) and OR duplicate bucket writes.
- New pending reports persist `active_seconds_hex`; legacy migrated pending reports keep it `NULL`.

- [ ] **Step 1: Write v2 and migration tests first**

Cover:
- seconds :00 and :59 produce `0000000000000001` and `0800000000000000` in their canonical minute.
- repeated recording of the same bucket is idempotent and popcount remains one.
- two different active buckets produce one masked report with `seconds == popcount`.
- masked pending report survives close/reopen with byte-for-byte logical payload and identical `(windowId,sequence,activeSecondsHex)` until ACK.
- exact ACK comparison includes `activeSecondsHex`; forged mask cannot delete pending state.
- fresh DB is version 2, mode 0600, parent owner-only.
- a real v1 fixture with existing `pending_reports` migrates them unchanged with `activeSecondsHex=None`.
- v1 aggregate `activity_windows` is converted transactionally into immutable legacy pending report(s) with newly allocated monotonic sequence(s), not into guessed bits.
- existing `window_sequences` remains monotonic across migration/reopen.
- unsupported future `user_version` fails closed instead of silently recreating state.

- [ ] **Step 2: Run outbox tests and verify RED**

Run: `python3 -m pytest node-agent/tests/test_telemetry_outbox.py node-agent/tests/test_durable_telemetry_runtime.py -q`
Expected: FAIL on v2 schema/mask field.

- [ ] **Step 3: Implement transactional v1→v2 migration and bitmap accumulation**

Detect fresh-vs-v1 state before creating v2 tables. SQLite integers are safe for the low 60-bit range; encode wire masks only when preparing an immutable report. Preserve the existing rule that any pending report blocks preparation of later accumulated activity until it is acknowledged.

- [ ] **Step 4: Verify durability tests**

Expected: PASS, including v1 fixture migration and restart identity.

- [ ] **Step 5: Commit**

Commit: `feat: persist active-second telemetry bitmaps`

---

### Task 7: Wire masked Agent telemetry end-to-end with rolling-upgrade compatibility

**Files:**
- Modify: `node-agent/madar_agent/activity.py`
- Modify: `node-agent/madar_agent/agent.py`
- Modify: `node-agent/madar_agent/api.py`
- Modify: `node-agent/madar_agent/service.py`
- Modify: `node-agent/tests/test_control_plane_api.py`
- Modify: `node-agent/tests/test_agent_core.py`
- Modify: `node-agent/tests/test_service.py`
- Modify: `apps/api/src/node-routes.test.ts`

**Interfaces:**
- New reports serialize `activeSecondsHex` exactly; migrated legacy reports omit it.
- `seconds` is always popcount for new reports.
- Complete ACK contract remains unchanged.

- [ ] **Step 1: Write transport/route tests**

Prove:
- new Agent payload includes canonical lowercase `activeSecondsHex` and matching `seconds`.
- migrated legacy pending payload omits `activeSecondsHex` and is accepted by the server as legacy.
- server-first rollout accepts old Agent reports.
- Agent-first masked report is rejected by an old-server fixture in test and therefore remains pending; document deployment order as **control plane first, then Agents**.
- malformed/incomplete 2xx settlement response still leaves masked pending report intact.
- valid duplicate response after server commit ACKs and removes the exact masked pending report.

- [ ] **Step 2: Run focused Python + API tests and verify RED**

Run the listed Python tests and `pnpm --filter @madar/api test -- node-routes.test.ts`.
Expected: FAIL until serialization/wiring is complete.

- [ ] **Step 3: Wire source→outbox→UsageReport→HTTP and backend validation**

Do not add session IDs. Do not change the 30-second control-plane posting cadence. The one-second sampler only creates durable evidence; batching/posting remains independent.

- [ ] **Step 4: Run full repository verification**

Run the same gates as CI:
- PostgreSQL schema + destructive backup/restore;
- PostgreSQL runtime/integration tests;
- `pnpm audit --audit-level high`;
- Python dependency audit;
- `pnpm test`;
- `pnpm typecheck`;
- `pnpm build`;
- `pnpm test:python`;
- secret scan.

Expected: all green.

- [ ] **Step 5: Commit**

Commit: `feat: wire active-second telemetry end to end`

---

### Task 8: Reconcile superseded docs and prepare the real Phase 7 field gate

**Files:**
- Modify: `docs/superpowers/specs/2026-10-10-usage-and-premium-single-session-design.md`
- Modify: `docs/superpowers/specs/2026-10-08-madar-clean-start-design.md`
- Modify: `docs/superpowers/plans/2026-10-08-madar-implementation-plan.md`
- Modify: `docs/architecture/xray-session-accounting.md`
- Modify: `docs/runbooks/node-install.md`
- Modify: `docs/test-reports/phase-7-vps.md`
- Modify: this plan to mark completed repository/CI tasks.

**Interfaces:**
- Produces one unambiguous field checklist for the current exact commit.
- Preserves all historical real-VPS evidence as historical evidence; no retrospective claim that bitmap billing was already field-tested.

- [ ] **Step 1: Update source-of-truth wording**

Mark the 2026-10-10 spec Approved. Replace the old “distinct simultaneous sessions multiply free usage” rule in the clean-start design/old implementation plan with account-level active-second semantics and an explicit pointer to the amendment. Keep Premium single-client enforcement explicitly unresolved.

- [ ] **Step 2: Update ADR/runbook without erasing history**

Record that stock-Xray session multiplicity is no longer a free-accounting blocker, while stock Xray still lacks trustworthy device identity for Premium locking. Document deployment order: database/control-plane migration first, then Node Agents; legacy aggregate reports are durable/no-debit during the transition.

- [ ] **Step 3: Add exact real-VPS acceptance checklist**

The Phase 7 report/runbook must require, on the current exact head:
- pinned Xray per-user counters under managed config;
- sustained direct VLESS+REALITY traffic produces expected UTC bitmap bits and exactly-once PostgreSQL debit;
- idle open connection produces no bits/debit;
- two simultaneous connections overlapping the same seconds do not multiply debit;
- reset/restart/gap produces no inferred bits;
- restart Agent before local ACK preserves identical `(windowId,sequence,seconds,activeSecondsHex)` and server duplicate settlement debits once;
- malformed/incomplete acceptance response leaves pending bitmap intact;
- outbox file/state permissions and bounded logs remain clean;
- current boot ordering proves stale Xray access never opens before fresh policy;
- delayed observed-time Premium/day cases are exercised at control-plane integration level and, where practical, in the field.

Cross-node overlap remains a later multi-node gate unless a second real node is available during this run.

- [ ] **Step 4: Run final CI and record evidence**

Run full CI. Record exact head SHA and workflow run id only after success. Do **not** mark Phase 7 PASS until the real VPS checklist itself passes.

- [ ] **Step 5: Commit**

Commit: `docs: reconcile active-second accounting acceptance`

---

## Completion gates

Repository/CI implementation is complete only when Tasks 1–8 pass with a green full CI on one exact head and the docs correctly distinguish automated evidence from field evidence.

Phase 7 is complete only after the exact deployed head additionally passes the real-VPS checklist in Task 8. A green CI does not make Phase 7 PASS.

Premium single-active-client enforcement is explicitly out of scope for this plan and remains a separate unresolved design/release gate. No work in this plan may be used to claim that Premium device locking is operational.
