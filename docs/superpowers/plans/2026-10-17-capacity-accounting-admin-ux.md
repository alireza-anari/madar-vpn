# Madar Capacity Accounting, Seller Controls, and Bot UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make finite-bandwidth node inventory impossible to oversell, add admin-only 80/90/95% capacity alerts, add auditable seller limits/settlements/statistics, and replace the current reseller bot screens with a compact role-specific Telegram dashboard.

**Architecture:** Keep the current Worker + D1 + Telegram outbox architecture. Centralize node accounting in `node-capacity.ts`, add seller accounting in `seller-accounting.ts`, add idempotent threshold notifications in `capacity-alerts.ts`, and keep `reseller-menus.ts` as orchestration/presentation rather than duplicating accounting SQL. Use additive D1 schema changes, stamp each newly created account with the seller settlement epoch active at creation, and keep the final account insert as the authoritative atomic guard for both node and seller capacity.

**Tech Stack:** TypeScript 5.9, Cloudflare Workers, Cloudflare D1/SQLite, Hono, Telegram Bot API via durable `outbox`, Vitest 4.1, Wrangler 4.148, pnpm.

**Spec:** `docs/superpowers/specs/2026-10-17-capacity-accounting-admin-ux-design.md`

## Global Constraints

- Work on `impl/telegram-sales-bot`; the approved design commit is `ee2150736695854188cdd616eb75ea708df8e26e`.
- TDD is mandatory: add/adjust a failing test before each behavior change, run the focused test to prove it fails for the intended reason, implement the minimum change, rerun to green, then commit that task.
- Preserve the shared-443/node-agent protocol. This feature is Worker/D1/Telegram UI work only; no node-agent protocol change is required.
- Never expose bot tokens, node tokens, REALITY keys, UUID-bearing VLESS URIs, AWS credentials, or other secrets in tests, logs, commits, screenshots, or field notes.
- D1 schema changes must be additive. Do not rebuild `managed_accounts` merely to add a `failed` state. The existing expired pre-activation `preparing` behavior remains the terminal failed-before-activation equivalent.
- Existing customer accounts must remain valid through migration. Existing accounts get seller settlement epoch `0` and continue contributing to node accounting from their current quota, usage, deadline, and state.
- `max_allocated_bytes IS NULL` means an unlimited-bandwidth node. Finite nodes always enforce byte budget and account-slot budget independently.
- A live commitment is a `preparing`, `active`, or `blocked` account whose service window can still continue (`valid_until=0` or `valid_until>now`) and whose finite quota is not exhausted. A live finite account reserves its full sold quota. A live uncapped legacy account makes a finite node unsellable.
- Non-live/terminal accounts charge only finalized usage: `revoked`/`expired`/deadline-ended rows charge `used_bytes`; `exhausted` charges `min(used_bytes, quota_bytes)` when the quota is finite. Do not double-count used bytes inside a still-live full-quota commitment.
- Seller limit caps are current-commitment caps, not lifetime punishment: terminal accounts stop consuming the seller's current account/byte limit, while their sales remain in settlement/all-time reports.
- Admins are subject to node limits but not reseller-specific caps unless a future spec explicitly changes that rule.
- Alert delivery must be best-effort and must never make account creation, revocation, or quota-report acceptance fail.
- No production D1 migration or Worker deployment is performed without an explicit rollout authorization at execution time. Preserve existing production bindings/secrets during deploy.

## Review Focus

Reviewers should pay special attention to five risk areas:

1. **Accounting invariants:** blocked/live accounts reserve full sold quota; revoked/expired only retain actual usage; stale blocked rows past deadline do not reserve forever; exhausted usage is capped at sold quota for node budget.
2. **Atomicity:** two simultaneous sellers cannot consume the same final slot/GB, and seller caps cannot be bypassed by concurrent requests.
3. **Settlement boundaries:** a sale belongs to exactly one seller settlement epoch even when settlement and sale happen concurrently; closing a settlement cannot alter customer service.
4. **Alert idempotency:** each 80/90/95 crossing sends only admin notifications, does not spam on repeated quota reports, and can re-arm after utilization drops.
5. **Authorization/UX:** sellers never see global node/seller admin data; admin-only mutations still require admin authorization and destructive actions retain confirmation.

---

## Task 1: Add additive accounting/settlement persistence

**Files:**
- Create: `apps/sales-bot/migrations/0010-capacity-accounting-resellers.sql`
- Create: `apps/sales-bot/test/capacity-accounting-migration.test.ts`
- Modify test migration setup only where the new schema is required: `apps/sales-bot/test/node-allocation.test.ts`, `apps/sales-bot/test/reseller-flows.test.ts`

**Interfaces / schema contract:**

```sql
ALTER TABLE managed_accounts
  ADD COLUMN seller_settlement_epoch INTEGER NOT NULL DEFAULT 0;

CREATE TABLE reseller_controls(
  seller_id TEXT PRIMARY KEY REFERENCES resellers(telegram_id),
  current_settlement_epoch INTEGER NOT NULL DEFAULT 0 CHECK(current_settlement_epoch>=0),
  settlement_started_at INTEGER NOT NULL DEFAULT 0 CHECK(settlement_started_at>=0),
  max_reserved_accounts INTEGER CHECK(max_reserved_accounts IS NULL OR max_reserved_accounts BETWEEN 1 AND 10000),
  max_committed_bytes INTEGER CHECK(max_committed_bytes IS NULL OR (max_committed_bytes>0 AND max_committed_bytes<=1000000000000000)),
  updated_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE reseller_settlements(
  id TEXT PRIMARY KEY,
  seller_id TEXT NOT NULL REFERENCES resellers(telegram_id),
  epoch INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  config_count INTEGER NOT NULL,
  sold_bytes INTEGER NOT NULL,
  used_bytes INTEGER NOT NULL,
  live_count INTEGER NOT NULL,
  blocked_count INTEGER NOT NULL,
  expired_count INTEGER NOT NULL,
  revoked_count INTEGER NOT NULL,
  exhausted_count INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(seller_id, epoch)
);

CREATE TABLE reseller_settlement_nodes(
  settlement_id TEXT NOT NULL REFERENCES reseller_settlements(id),
  node_id TEXT NOT NULL REFERENCES nodes(id),
  config_count INTEGER NOT NULL,
  sold_bytes INTEGER NOT NULL,
  used_bytes INTEGER NOT NULL,
  PRIMARY KEY(settlement_id,node_id)
);

CREATE TABLE node_capacity_alert_state(
  node_id TEXT PRIMARY KEY REFERENCES nodes(id),
  level INTEGER NOT NULL DEFAULT 0 CHECK(level IN (0,80,90,95)),
  sequence INTEGER NOT NULL DEFAULT 0 CHECK(sequence>=0),
  updated_at INTEGER NOT NULL DEFAULT 0
);
```

Why use an account `seller_settlement_epoch` instead of only timestamps: account creation and settlement can happen in the same second. Stamping the epoch at insert time gives an exact, race-safe boundary: every sale belongs to one and only one settlement window.

- [ ] **Step 1: Write the failing migration test.**

Create `capacity-accounting-migration.test.ts` that applies migrations through `0009`, inserts an existing reseller and an existing managed account, then imports/applies `0010`. Assert:
- old account remains present and has `seller_settlement_epoch=0`;
- all four new tables exist;
- nullable caps accept `NULL` and reject invalid zero/negative values;
- alert levels reject values outside `0/80/90/95`.

Run:

```bash
cd apps/sales-bot
npx vitest run test/capacity-accounting-migration.test.ts
```

Expected before implementation: FAIL because `0010-capacity-accounting-resellers.sql` does not exist / schema assertions fail.

- [ ] **Step 2: Add the additive migration.**

Implement the schema above. Add indexes only where query plans need them, specifically:

```sql
CREATE INDEX managed_accounts_seller_settlement
  ON managed_accounts(seller_id,seller_settlement_epoch,created_at);
CREATE INDEX reseller_settlements_seller
  ON reseller_settlements(seller_id,ended_at DESC);
```

Do not change old migration files.

- [ ] **Step 3: Run the migration test and focused existing tests.**

```bash
cd apps/sales-bot
npx vitest run test/capacity-accounting-migration.test.ts test/node-allocation.test.ts test/reseller-flows.test.ts
```

Expected: migration test PASS. Existing tests may still fail only where their old capacity semantics conflict with the approved design; record those failures for Task 2 rather than weakening the migration.

- [ ] **Step 4: Commit.**

```bash
git add apps/sales-bot/migrations/0010-capacity-accounting-resellers.sql apps/sales-bot/test/capacity-accounting-migration.test.ts apps/sales-bot/test/node-allocation.test.ts apps/sales-bot/test/reseller-flows.test.ts
git commit -m "feat: add capacity accounting persistence"
```

---

## Task 2: Replace reservation-only node math with committed + finalized accounting

**Files:**
- Modify: `apps/sales-bot/src/node-capacity.ts`
- Modify: `apps/sales-bot/test/node-allocation.test.ts`

**Interfaces:**

Replace the old `allocated_bytes`-only shape with a single authoritative capacity model:

```ts
export interface NodeCapacity {
  id: string;
  name: string;
  healthy: number;
  last_seen: number;
  agent_capabilities: string;
  max_accounts: number;
  max_allocated_bytes: number | null;
  reserved_accounts: number;
  committed_bytes: number;
  finalized_used_bytes: number;
  uncapped_accounts: number;
}

export const liveCommitmentPredicate: string;
export function chargedBytes(n: NodeCapacity): number;
export function remainingAllocation(n: NodeCapacity): number | null;
export function utilizationPercent(n: NodeCapacity): number | null;
export function canAllocate(n: NodeCapacity, requestedBytes: number): boolean;
export function allocationLabel(n: NodeCapacity): string;
export async function nodeCapacities(
  db: D1Database,
  now: number,
  nodeId?: string | null,
): Promise<NodeCapacity[]>;
```

`liveCommitmentPredicate` must include `blocked`, current deadline validity, and non-exhausted quota. `nodeCapacities` must aggregate over **all** managed accounts on the node, using conditional sums, rather than joining only live rows.

Node charge rules:

```text
live finite account      => committed += quota_bytes
live uncapped account    => uncapped_accounts += 1
non-live exhausted       => finalized += min(used_bytes, quota_bytes)
other non-live account   => finalized += used_bytes
sellable finite          => max(0, max_allocated_bytes - committed - finalized)
unlimited node           => remainingAllocation() returns null
```

- [ ] **Step 1: Rewrite/add failing capacity tests for the approved semantics.**

In `node-allocation.test.ts`, replace the obsolete test that says blocked accounts release reservations. Add cases proving:
- a valid `blocked` 30GB account with 8GB used still charges 30GB;
- a `blocked` account whose `valid_until<=now` charges only 8GB;
- revoked 30GB/8GB charges 8GB and returns 22GB;
- expired 30GB/8GB charges 8GB and returns 22GB;
- exhausted 30GB with 31GB reported charges 30GB, not 31GB;
- an active partial account still charges its full quota;
- an expired pre-activation `preparing` row stops consuming a slot/quota (the existing failed-before-activation equivalent);
- an unlimited node returns `null` remaining bytes and is not byte-blocked;
- a live uncapped legacy account makes a finite node's sellable bytes zero.

Directly assert `nodeCapacities`, `remainingAllocation`, and `utilizationPercent`, not only whether `createAccount` succeeds.

Run:

```bash
cd apps/sales-bot
npx vitest run test/node-allocation.test.ts
```

Expected: FAIL on blocked/finalized-usage assertions under the old query.

- [ ] **Step 2: Implement the centralized node accounting.**

Use one effective-live condition consistently. Do not let raw stale `blocked` state override an elapsed deadline in accounting. Preserve `allocationLabel` but change Persian copy to describe sellable capacity (`قابل فروش`) instead of implying the configured cap is still untouched.

- [ ] **Step 3: Run the focused test to green.**

```bash
cd apps/sales-bot
npx vitest run test/node-allocation.test.ts
```

Expected: PASS for direct capacity calculations. `createAccount` cases that still use the old atomic SQL may remain red until Task 4; isolate direct helper tests if needed so this task has a green checkpoint.

- [ ] **Step 4: Commit.**

```bash
git add apps/sales-bot/src/node-capacity.ts apps/sales-bot/test/node-allocation.test.ts
git commit -m "fix: account for finalized node traffic"
```

---

## Task 3: Add seller statistics, exact settlement epochs, snapshots, and limits

**Files:**
- Create: `apps/sales-bot/src/seller-accounting.ts`
- Create: `apps/sales-bot/test/seller-accounting.test.ts`
- Modify: `apps/sales-bot/src/resellers.ts` only if a small exported validation/admin helper is needed; do not put aggregate SQL back into menu code.

**Interfaces:**

```ts
export interface SellerStats {
  sellerId: string;
  epoch: number | null;
  startedAt: number;
  configCount: number;
  soldBytes: number;
  usedBytes: number;
  liveCount: number;
  blockedCount: number;
  expiredCount: number;
  revokedCount: number;
  exhaustedCount: number;
}

export interface SellerNodeStats {
  nodeId: string;
  nodeName: string;
  configCount: number;
  soldBytes: number;
  usedBytes: number;
}

export interface SellerLimits {
  maxReservedAccounts: number | null;
  maxCommittedBytes: number | null;
  reservedAccounts: number;
  committedBytes: number;
  uncappedAccounts: number;
}

export async function sellerStats(
  db: D1Database,
  sellerId: string,
  scope: "current" | "all",
  now: number,
): Promise<SellerStats>;

export async function sellerNodeStats(
  db: D1Database,
  sellerId: string,
  scope: "current" | "all",
  now: number,
): Promise<SellerNodeStats[]>;

export async function sellerLimits(
  db: D1Database,
  sellerId: string,
  now: number,
): Promise<SellerLimits>;

export async function setSellerLimits(
  db: D1Database,
  actor: SalesActor,
  sellerId: string,
  limits: { maxReservedAccounts: number | null; maxCommittedBytes: number | null },
  now: number,
): Promise<void>;

export async function settleSeller(
  db: D1Database,
  actor: SalesActor,
  sellerId: string,
  now: number,
): Promise<{ settlementId: string; closedEpoch: number }>;
```

Effective state for reports should normalize an elapsed deadline before presenting a stale `active`/`blocked` row as live. `usedBytes` in seller reports is actual reported usage and is not capped merely for presentation. `soldBytes` is the quota originally sold (`COALESCE(quota_bytes,0)`).

Settlement algorithm:
1. lazily ensure a `reseller_controls` row exists, using the reseller `created_at` as first `settlement_started_at`;
2. snapshot the current epoch summary and per-node rows into `reseller_settlements` / `reseller_settlement_nodes`;
3. increment `current_settlement_epoch` exactly once and set `settlement_started_at=now`;
4. add an audit event;
5. perform the write set transactionally/idempotently enough that a retry cannot create two settlements for the same seller+epoch.

- [ ] **Step 1: Write failing seller-accounting tests.**

Cover:
- current scope initially equals all-time for epoch 0;
- after `settleSeller`, old epoch is snapshotted and current stats start at zero;
- all-time totals do not reset;
- old customer configs continue unchanged after settlement;
- a new account stamped with epoch 1 appears only in the new current scope;
- historical settlement rows keep their snapshot even if an old account's `used_bytes` later increases;
- per-node breakdown sums to the current/all totals;
- stale blocked past deadline is reported expired, while a valid blocked account remains blocked;
- seller limits return current live count/full committed quota and ignore terminal rows;
- only admin can set limits or settle a seller.

Run:

```bash
cd apps/sales-bot
npx vitest run test/seller-accounting.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 2: Implement `seller-accounting.ts`.**

Keep the settlement/limit SQL here. Use the same live-commitment semantics from `node-capacity.ts`; do not invent a second contradictory predicate.

`setSellerLimits` must support `null` for unlimited and validate `1..10000` accounts and positive bytes up to `1e15` when non-null.

- [ ] **Step 3: Run focused tests.**

```bash
cd apps/sales-bot
npx vitest run test/seller-accounting.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit.**

```bash
git add apps/sales-bot/src/seller-accounting.ts apps/sales-bot/src/resellers.ts apps/sales-bot/test/seller-accounting.test.ts
git commit -m "feat: add reseller settlement accounting"
```

---

## Task 4: Enforce node budget + seller caps atomically at account creation

**Files:**
- Modify: `apps/sales-bot/src/accounts.ts`
- Modify: `apps/sales-bot/src/node-capacity.ts` only if shared SQL fragments/interfaces need small additions
- Modify: `apps/sales-bot/test/node-allocation.test.ts`
- Modify: `apps/sales-bot/test/seller-accounting.test.ts` or add focused creation cases to `apps/sales-bot/test/reseller-flows.test.ts`

**Behavior / error contract:**

`createAccount` remains idempotent by `(seller_id, request_key)` and the final insert remains authoritative. It must atomically test:

```text
node healthy/capable check (existing explicit-node behavior)
node live slots + 1 <= max_accounts
finite node charged_bytes + requested_quota <= max_allocated_bytes
finite node has no live uncapped legacy commitment
seller enabled (existing requireSeller)
seller max_reserved_accounts, when configured
seller max_committed_bytes, when configured
seller has no live uncapped commitment when a finite seller-byte cap is configured
```

The inserted row must set:

```text
seller_settlement_epoch = current reseller_controls.current_settlement_epoch
                          or 0 when no control row exists
```

Stable user-safe failure codes:
- `NODE_FULL`
- `NODE_ALLOCATION_FULL`
- `SELLER_ACCOUNT_LIMIT`
- `SELLER_ALLOCATION_FULL`
- existing `NODE_UNAVAILABLE`, `NODE_NOT_CONFIGURED`, validation codes remain intact.

Admins skip reseller-specific limits but still pass the same node checks.

- [ ] **Step 1: Add failing atomic enforcement tests.**

Update the existing revocation test so a 100GB node with a 100GB account that used 90GB allows only 10GB after revoke, not another 100GB.

Add tests for:
- 30GB sold / 8GB used / revoke => 22GB becomes sellable, but the 8GB remains permanently charged;
- valid blocked cannot be bypassed by a new sale;
- expired account only leaves actual usage charged;
- two simultaneous sellers cannot over-allocate the final node bytes;
- two simultaneous requests from one seller cannot overrun seller max account count or byte cap;
- seller count cap and seller byte cap produce distinct error codes;
- terminal rows no longer consume seller current caps;
- admin sale bypasses reseller caps but not node caps;
- successful account creation stamps the current settlement epoch;
- replay with the same request key returns the original row and does not consume capacity twice.

Run:

```bash
cd apps/sales-bot
npx vitest run test/node-allocation.test.ts test/seller-accounting.test.ts
```

Expected: FAIL under the old reservation-only insert and because seller caps are not enforced.

- [ ] **Step 2: Replace the atomic `WITH reserved ... INSERT` in `createAccount`.**

Use CTEs that calculate node usage and seller usage with the shared approved semantics inside the same SQL statement that performs the insert. Do not rely on a precomputed UI number.

After a failed insert, classify the error from current authoritative state. For seller actors, report seller-limit failures before generic node-capacity errors when that seller is independently at its cap; admins skip seller classification.

- [ ] **Step 3: Run focused tests to green.**

```bash
cd apps/sales-bot
npx vitest run test/node-allocation.test.ts test/seller-accounting.test.ts
```

Expected: PASS including concurrency cases.

- [ ] **Step 4: Commit.**

```bash
git add apps/sales-bot/src/accounts.ts apps/sales-bot/src/node-capacity.ts apps/sales-bot/test/node-allocation.test.ts apps/sales-bot/test/seller-accounting.test.ts
git commit -m "feat: enforce node and reseller sale caps"
```

---

## Task 5: Add deduplicated admin-only capacity threshold alerts

**Files:**
- Create: `apps/sales-bot/src/capacity-alerts.ts`
- Create: `apps/sales-bot/test/capacity-alerts.test.ts`
- Modify: `apps/sales-bot/src/accounts.ts`
- Modify: `apps/sales-bot/src/node-api.ts`
- Modify: `apps/sales-bot/test/quota-reports.test.ts` or add endpoint-level alert coverage to `capacity-alerts.test.ts`

**Interface:**

```ts
export async function refreshCapacityAlert(
  env: Env,
  nodeId: string,
  now: number,
): Promise<number | null>;
```

Threshold selection:

```text
utilization < 80       => target level 0
80 <= utilization < 90 => target level 80
90 <= utilization < 95 => target level 90
utilization >= 95       => target level 95
unlimited node          => target level 0, no bandwidth alert
```

Idempotency rules:
- store current alert level and sequence in `node_capacity_alert_state`;
- repeated refresh at the same level produces no new outbox row;
- a downward move only re-arms by lowering stored level, without sending a recovery message;
- a future upward crossing may notify again;
- a jump from 79% directly to 96% sends one 95% warning, not three messages;
- enqueue to every valid `ADMIN_TELEGRAM_IDS` entry and never to sellers;
- outbox IDs include node + sequence + admin ID so retries remain idempotent.

Message should include node name, current used/committed/finalized/sellable summary, and threshold. It must not contain credentials or private config data.

- [ ] **Step 1: Write failing alert tests.**

Cover 80 -> duplicate -> 90 -> 95; drop below 80 and cross again; direct jump to 95; unlimited node; multiple admin IDs; seller ID absent; and an outbox write failure not escaping into caller behavior when invoked via a best-effort wrapper.

Run:

```bash
cd apps/sales-bot
npx vitest run test/capacity-alerts.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 2: Implement `capacity-alerts.ts`.**

Use a compare/update sequence so two simultaneous refresh calls cannot both advance the same state and enqueue duplicate alerts.

- [ ] **Step 3: Hook alerts after authoritative state-changing operations, best-effort.**

After successful `createAccount`, after `revokeAccount`, and after successful `/api/node/quota-reports` acceptance in `node-api.ts`, call:

```ts
try {
  await refreshCapacityAlert(env, nodeId, now);
} catch {
  // Accounting/state transition succeeded; alert delivery must not roll it back.
}
```

Because `accounts.ts` currently receives only `db`, either add an optional alert callback/`env` at the orchestration boundary or call alert refresh from `reseller-menus.ts` after create/revoke. Prefer keeping core account functions testable and avoiding an `Env` dependency unless it materially simplifies the code. The chosen implementation must still cover both create and revoke paths.

For quota reports, call the alert helper in `node-api.ts` after `acceptQuotaReports` returns successfully.

- [ ] **Step 4: Run focused tests.**

```bash
cd apps/sales-bot
npx vitest run test/capacity-alerts.test.ts test/quota-reports.test.ts test/node-allocation.test.ts
```

Expected: PASS; quota reporting remains successful even if alert enqueue is forced to fail.

- [ ] **Step 5: Commit.**

```bash
git add apps/sales-bot/src/capacity-alerts.ts apps/sales-bot/src/accounts.ts apps/sales-bot/src/node-api.ts apps/sales-bot/test/capacity-alerts.test.ts apps/sales-bot/test/quota-reports.test.ts apps/sales-bot/test/node-allocation.test.ts
git commit -m "feat: warn admins on node capacity thresholds"
```

---

## Task 6: Redesign seller/admin home and sale flow around real sellable capacity

**Files:**
- Create: `apps/sales-bot/src/sales-format.ts`
- Create: `apps/sales-bot/test/sales-format.test.ts`
- Modify: `apps/sales-bot/src/reseller-menus.ts`
- Modify: `apps/sales-bot/test/reseller-flows.test.ts`

**Presentation helpers:**

```ts
export function formatBytes(bytes: number): string;
export function formatOptionalBytes(bytes: number | null): string;
export function nodeCapacitySummary(n: NodeCapacity): string;
```

Keep formatting pure so menu tests do not duplicate GB/TB logic.

**Telegram information architecture:**

Admin home:

```text
📊 وضعیت کلی مدار
سرورها: N فعال
کانفیگ‌های در حال سرویس: N
حجم رزروشده: X
مصرف قطعی: Y
فروشنده‌های فعال: N
```

Buttons:

```text
➕ صدور کانفیگ | 🎁 تست
🖥 سرورها       | 👥 فروشنده‌ها
📋 کانفیگ‌ها    | 📊 گزارش‌ها
📖 راهنما
```

Seller home:

```text
💼 پنل فروش
فعال/در حال سرویس: N
این تسویه: N کانفیگ · X فروخته‌شده
کل فروش: N کانفیگ · X
```

Buttons:

```text
➕ ساخت کانفیگ | 🎁 ساخت تست
📋 کانفیگ‌های من | 📊 آمار من
📖 راهنما
```

Sale flow remains label -> quota -> days -> server -> final confirmation. After quota is known, server selection must evaluate requested quota:
- selectable: healthy, recent, `quota-v2`, account slot available, seller caps available, requested bytes fit node sellable bytes;
- insufficient nodes may be shown as non-selectable explanatory text, but never as a callback that can imply eligibility;
- final confirmation shows `ظرفیت قبل` and projected `ظرفیت بعد از فروش` for finite nodes; unlimited says `نامحدود`;
- final insert still rechecks atomically.

- [ ] **Step 1: Write failing pure formatting tests.**

Cover readable Persian GB/TB output, zero, finite node summary, and unlimited node label.

Run:

```bash
cd apps/sales-bot
npx vitest run test/sales-format.test.ts
```

Expected: FAIL because helper module does not exist.

- [ ] **Step 2: Add failing reseller-flow UX tests.**

Assert from outbox payloads that:
- seller home does not contain global seller/server admin controls;
- admin home contains the operational summary and admin navigation;
- seller home shows current-settlement + all-time totals;
- a server button shows **current sellable** bytes, not configured max bytes;
- a valid blocked reservation reduces the displayed sellable bytes;
- a revoked/expired account restores only unused bytes;
- a node that cannot satisfy the requested quota is not selectable;
- final confirmation includes before/after finite capacity;
- stale capacity at confirm returns a clear safe Persian message, not raw SQL/internal error;
- `SELLER_ACCOUNT_LIMIT` and `SELLER_ALLOCATION_FULL` have distinct understandable Persian messages.

Run:

```bash
cd apps/sales-bot
npx vitest run test/reseller-flows.test.ts
```

Expected: FAIL on the old home text/server labels/confirmation.

- [ ] **Step 3: Implement formatting and refactor the sale/home screens.**

Use `nodeCapacities()` and `sellerStats()` as data sources. Do not duplicate the capacity formula in `reseller-menus.ts`.

Add `rs:stats` for seller self-statistics and `rs:reports` for an admin aggregate report if the button is present. Do not add an empty `⚙️ تنظیمات` button with no function.

Keep the existing replay-safe conversation/outbox mechanism intact.

- [ ] **Step 4: Run focused UI tests.**

```bash
cd apps/sales-bot
npx vitest run test/sales-format.test.ts test/reseller-flows.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add apps/sales-bot/src/sales-format.ts apps/sales-bot/src/reseller-menus.ts apps/sales-bot/test/sales-format.test.ts apps/sales-bot/test/reseller-flows.test.ts
git commit -m "feat: redesign reseller sales dashboard"
```

---

## Task 7: Add admin node details, seller details, settlement UI, and seller/node controls

**Files:**
- Create: `apps/sales-bot/src/node-settings.ts`
- Create: `apps/sales-bot/test/node-settings.test.ts`
- Modify: `apps/sales-bot/src/reseller-menus.ts`
- Modify: `apps/sales-bot/test/reseller-flows.test.ts`
- Modify: `apps/sales-bot/src/capacity-alerts.ts` only if node-cap updates need alert re-evaluation through a small exported call already defined.

**Node settings interfaces:**

```ts
export async function setNodeMaxAccounts(
  db: D1Database,
  actor: SalesActor,
  nodeId: string,
  maxAccounts: number,
  now: number,
): Promise<void>;

export async function setNodeMaxAllocatedBytes(
  db: D1Database,
  actor: SalesActor,
  nodeId: string,
  maxAllocatedBytes: number | null,
  now: number,
): Promise<void>;
```

Validation:
- account cap `1..10000`;
- finite byte cap `1..1e15`;
- `null` means unlimited;
- admin only;
- every mutation gets an audit event.

**Callbacks/screens:**
- `rs:nodes` => compact server list, one button per node rather than four controls crammed into a row.
- `rs:nodedetail:<nodeId>` => health, limited/unlimited mode, total cap, committed, finalized, sellable, utilization, slots, purpose.
- retain purpose actions using existing `rs:node:sale:<nodeId>` / `rs:node:trial:<nodeId>`.
- `rs:capacity:<nodeId>` => edit slot cap through existing numeric conversation flow, routed through `node-settings.ts`.
- `rs:allocation:<nodeId>` => edit finite GB cap; offer a separate `♾ نامحدود` callback such as `rs:unlimit:<nodeId>`.
- `rs:sellers` => seller list with enabled state plus a concise current-window sales summary; seller IDs are selectable.
- `rs:seller:<telegramId>` => current settlement, all-time totals, actual usage, effective state counts, current limits, node breakdown.
- `rs:settle:<telegramId>` => confirmation screen; `rs:settleok:<telegramId>` => call `settleSeller`.
- `rs:settlements:<telegramId>` => most recent closed settlements for audit (compact pagination/limit is sufficient).
- `rs:limits:<telegramId>` => limits summary with `rs:limitcount:<id>` and `rs:limitbytes:<id>` conversation actions; numeric `0` clears that cap (unlimited).
- existing seller enable/disable remains admin-only and must not revoke customer configs.

- [ ] **Step 1: Write failing node-settings tests.**

Prove admin-only validation, finite cap update, unlimited (`NULL`) update, slot cap update, and audit rows.

Run:

```bash
cd apps/sales-bot
npx vitest run test/node-settings.test.ts
```

Expected: FAIL because module does not exist.

- [ ] **Step 2: Add failing admin UI flow tests.**

Cover:
- node list -> node detail shows committed/finalized/sellable rather than only configured max;
- changing finite cap to unlimited changes the detail to `نامحدود` and no byte-eligibility block remains;
- seller list -> seller detail shows current + all-time counts/GB and node breakdown;
- setting/clearing seller count and byte caps works and is hidden from sellers;
- settlement requires admin confirmation, creates one closed snapshot, starts a new current epoch, and leaves customer state untouched;
- replaying the settlement confirmation does not create a second settlement for the same epoch;
- sellers cannot invoke node settings, seller limits, or settlement callbacks.

Run:

```bash
cd apps/sales-bot
npx vitest run test/node-settings.test.ts test/reseller-flows.test.ts
```

Expected: FAIL before implementation.

- [ ] **Step 3: Implement `node-settings.ts` and refactor admin menu actions.**

Move the existing direct `UPDATE nodes SET max_accounts...` and `max_allocated_bytes...` SQL out of `reseller-menus.ts` into the validated/audited helper.

After a node byte-cap change, best-effort refresh its capacity alert state so raising the cap can re-arm thresholds and lowering it can correctly reflect the new level. Do not make the setting update fail only because a Telegram alert cannot be queued.

- [ ] **Step 4: Implement seller detail/settlement/limit screens.**

Use `seller-accounting.ts` for every aggregate and mutation. Keep destructive/financial boundary actions behind confirmation. Do not expose another seller's stats to a seller actor.

- [ ] **Step 5: Run focused tests.**

```bash
cd apps/sales-bot
npx vitest run test/node-settings.test.ts test/seller-accounting.test.ts test/reseller-flows.test.ts test/capacity-alerts.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add apps/sales-bot/src/node-settings.ts apps/sales-bot/src/reseller-menus.ts apps/sales-bot/src/capacity-alerts.ts apps/sales-bot/test/node-settings.test.ts apps/sales-bot/test/reseller-flows.test.ts
git commit -m "feat: add admin capacity and reseller controls"
```

---

## Task 8: Full regression, CI, migration gate, and live field acceptance

**Files:**
- Modify tests only if a genuine uncovered regression is discovered. Do not weaken assertions to make CI green.
- No production config file should be edited just to deploy.

**Release gates:**

- [ ] **Step 1: Run the complete sales-bot verification locally/in the implementation environment.**

```bash
cd apps/sales-bot
npm test
npm run typecheck
npm run build
```

Expected: all PASS / build dry-run succeeds.

- [ ] **Step 2: Run repo-level targeted verification consistent with CI.**

From repo root:

```bash
pnpm --filter @madar/sales-bot types
pnpm --filter @madar/sales-bot typecheck
pnpm --filter @madar/sales-bot test
pnpm --filter @madar/sales-bot build
python scripts/verify_sales_quota_probe.py
```

If node/runner files were not changed, still rely on the branch workflow to run their regression suites. Do not introduce unrelated node changes.

- [ ] **Step 3: Commit any final test-only fixes and push; wait for both relevant GitHub Actions workflows to be green.**

The existing `Telegram sales bot` workflow runs sales-bot types/typecheck/test/build plus runner/node regressions. General CI must also remain green.

Do not proceed to production migration/deploy on a red or pending required run.

- [ ] **Step 4: Obtain explicit rollout authorization before any production D1 write or Worker deployment.**

The implementation agent must state exactly what will change:
- one additive D1 migration (`0010`);
- one Worker deployment from the exact green commit;
- no node-agent binary rollout;
- existing Worker secrets/bindings must be preserved.

- [ ] **Step 5: After authorization, inspect pending remote migrations before applying.**

From `apps/sales-bot` with the approved Cloudflare production context:

```bash
npx wrangler d1 migrations list madar-sales-bot-db --remote
```

Expected: `0010-capacity-accounting-resellers.sql` is pending and no unexpected migration appears.

Apply only after that inspection:

```bash
npx wrangler d1 migrations apply madar-sales-bot-db --remote
```

Expected: migration succeeds. Immediately verify the new tables/column with read-only D1 queries and verify existing account/node counts are unchanged.

- [ ] **Step 6: Deploy the exact green Worker while preserving production secrets/bindings.**

Use the project's already-established production deployment method. Do **not** deploy with a command/config path that overwrites production vars with the empty placeholders in `wrangler.jsonc`. Record the exact source commit and returned Worker version/deployment ID.

- [ ] **Step 7: Perform field acceptance on one finite node without exposing customer secrets.**

Validate in this order:
1. Admin home/server detail shows the node's configured budget, committed bytes, finalized used bytes, sellable bytes, slot usage, and correct utilization.
2. Seller creates a finite test sale; sellable bytes decrease by the sold quota.
3. Record some real quota usage through the normal agent path; while account remains active, sellable bytes do not rise just because it is partially consumed.
4. Revoke a test account after measured usage; only the unused quota returns. Example invariant: 30GB sold / 8GB used leaves 8GB permanently charged and releases 22GB.
5. Validate an expired test account has the same release-only-unused behavior.
6. Keep/create a valid blocked test row through the normal fail-closed path and verify its full quota remains reserved; after its deadline is effectively expired, verify only actual usage remains charged.
7. Exercise the 80/90/95 alert logic with safe controlled data or a dedicated low-cap test node; verify only admin chats receive each crossing and duplicates do not spam.
8. Verify seller detail shows current-settlement and all-time metrics, set a temporary seller cap, prove a new sale is refused with the correct safe message, then clear the cap.
9. Close a seller settlement window and verify customer configs continue to work and all-time totals remain unchanged.
10. Switch only a non-production/test node to unlimited and verify byte labels/eligibility change to `نامحدود`; restore the intended setting afterward if appropriate.

- [ ] **Step 8: Final read-only acceptance queries.**

Confirm:
- no node has negative computed sellable capacity exposed as a positive value;
- no duplicate settlement exists for `(seller_id,epoch)`;
- node alert state levels are only 0/80/90/95;
- no seller received an admin alert outbox row;
- all production nodes are healthy/recent and shared-443 capability remains intact;
- no unexpected public ports/node protocol changes occurred.

- [ ] **Step 9: Write the acceptance result into the project notes/commit history only after evidence is collected.**

Include exact green commit, CI run IDs, migration result, Worker deployment/version ID, and non-secret field observations. Do not claim completion if any acceptance item remains unverified.

---

## Final Definition of Done

Implementation is complete only when:

- finite nodes calculate sellable traffic as configured budget minus live full-quota commitments minus terminal finalized usage;
- blocked/current accounts cannot cause hidden overselling, and stale blocked rows past deadline do not reserve forever;
- revoked/expired accounts release only unused sold quota;
- account slots and byte budget are independently enforced atomically;
- unlimited nodes skip byte-cap eligibility while keeping slot/health checks;
- seller current caps are independently and atomically enforced;
- seller current-settlement and all-time reports are correct and settlement is exact/idempotent;
- admin receives deduplicated 80/90/95 warnings and sellers never receive them;
- Telegram admin/seller screens show the approved compact hierarchy and accurate current capacity;
- existing quota cutoff, expiry, revoke, delivery, shared-443, runner, and enrollment regressions remain green;
- the additive production migration and exact-green Worker rollout pass field acceptance without exposing or rotating secrets.
