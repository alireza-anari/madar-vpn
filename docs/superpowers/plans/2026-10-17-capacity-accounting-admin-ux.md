# Madar Capacity Accounting, Seller Controls, and Bot UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent finite-bandwidth nodes from being oversold, add admin-only 80/90/95% warnings, add auditable seller limits/settlements/statistics, and replace the current reseller bot screens with a compact role-specific Telegram dashboard.

**Architecture:** Keep the Worker + D1 + Telegram outbox architecture. Make `node-capacity.ts` the single source of truth for server inventory, add `seller-accounting.ts` for seller limits/reporting/settlements, add `capacity-alerts.ts` for durable threshold state, and keep `reseller-menus.ts` focused on orchestration and presentation. Use an additive migration and stamp each new account with a seller settlement epoch so settlement boundaries are exact even under concurrency. The final account insert remains the authoritative atomic guard.

**Tech Stack:** TypeScript 5.9, Cloudflare Workers, D1/SQLite, Hono, Telegram Bot API through the durable `outbox`, Vitest 4.1, Wrangler 4.148, pnpm.

**Spec:** `docs/superpowers/specs/2026-10-17-capacity-accounting-admin-ux-design.md`

## Global Constraints

- Branch: `impl/telegram-sales-bot`; approved design commit: `ee2150736695854188cdd616eb75ea708df8e26e`.
- TDD for every task: failing focused test -> verify intended failure -> minimum implementation -> focused green -> commit.
- No shared-443 or node-agent protocol change.
- Never expose bot/node tokens, REALITY keys, UUID-bearing VLESS URIs, AWS credentials, or other secrets.
- Schema changes are additive. Do not rebuild `managed_accounts` to add a `failed` enum value; an elapsed pre-activation `preparing` row is the existing failed-before-activation equivalent.
- Existing accounts survive migration and default to seller settlement epoch `0`.
- `nodes.max_allocated_bytes IS NULL` means bandwidth-unlimited.
- Live commitment: `preparing|active|blocked`, service window still usable (`valid_until=0 OR valid_until>now`), finite quota not already exhausted. Live finite rows reserve full sold quota. A live uncapped legacy row makes a finite node unsellable.
- Non-live charge: revoked/expired/deadline-ended rows charge `used_bytes`; exhausted finite rows charge `min(used_bytes,quota_bytes)`. Do not double-count used bytes inside a live full-quota reservation.
- Seller caps apply to current live commitments, not lifetime sales. Admin-issued configs obey node caps but not seller-specific caps.
- Alert failures never roll back account creation, revocation, quota acceptance, or admin node-cap changes.
- Production D1 migration/deploy requires explicit rollout authorization after exact-green CI; preserve production secrets/bindings.

## Review Focus

1. Node accounting invariant, especially valid blocked vs stale blocked-after-deadline.
2. Atomic node + seller capacity under concurrent sales.
3. Exact, idempotent settlement epochs under sale/settlement races.
4. Alert dedupe/re-arm and admin-only delivery.
5. Seller/admin authorization boundaries and Telegram replay safety.

---

## Task 1: Add additive persistence for settlements, seller caps, and alert state

**Files:**
- Create: `apps/sales-bot/migrations/0010-capacity-accounting-resellers.sql`
- Create: `apps/sales-bot/test/capacity-accounting-migration.test.ts`

**Schema:**

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
  UNIQUE(seller_id,epoch)
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

CREATE INDEX managed_accounts_seller_settlement
  ON managed_accounts(seller_id,seller_settlement_epoch,created_at);
CREATE INDEX reseller_settlements_seller
  ON reseller_settlements(seller_id,ended_at DESC);
```

The epoch is required because `created_at` only has second resolution; timestamp-only settlement boundaries can double-assign or omit a sale racing the settlement action.

- [ ] **Step 1:** Write migration test applying through `0009`, inserting an old reseller/account, then applying `0010`. Assert old data survives with epoch 0; four new tables exist; nullable caps work; invalid zero/negative caps fail; invalid alert levels fail.

```bash
cd apps/sales-bot
npx vitest run test/capacity-accounting-migration.test.ts
```

Expected before implementation: FAIL because `0010` is absent.

- [ ] **Step 2:** Add the migration exactly as additive SQL; do not alter prior migration files.
- [ ] **Step 3:** Rerun focused test; expected PASS.
- [ ] **Step 4:** Commit.

```bash
git add apps/sales-bot/migrations/0010-capacity-accounting-resellers.sql apps/sales-bot/test/capacity-accounting-migration.test.ts
git commit -m "feat: add capacity accounting persistence"
```

---

## Task 2: Make node capacity math account for live commitments and finalized traffic

**Files:**
- Modify: `apps/sales-bot/src/node-capacity.ts`
- Create: `apps/sales-bot/test/node-capacity.test.ts`

**Interfaces:**

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
export async function nodeCapacities(db: D1Database, now: number, nodeId?: string | null): Promise<NodeCapacity[]>;
```

Math:

```text
live finite        -> committed += quota_bytes
live uncapped      -> uncapped_accounts += 1
non-live exhausted -> finalized += min(used_bytes,quota_bytes)
other non-live     -> finalized += used_bytes
finite sellable    -> max(0,max_allocated_bytes-committed-finalized)
unlimited          -> remainingAllocation() = null
```

- [ ] **Step 1:** Add failing direct helper tests for valid blocked full reservation; blocked past deadline actual-only; revoked/expired 30GB sold + 8GB used charging 8GB; exhausted 30GB + 31GB reported charging 30GB; partial active full reservation; elapsed pre-activation preparing releasing slot/quota; unlimited node; finite node with live uncapped legacy account.

```bash
cd apps/sales-bot
npx vitest run test/node-capacity.test.ts
```

Expected: FAIL under current reservation-only query.

- [ ] **Step 2:** Rewrite `nodeCapacities` to aggregate all node accounts with conditional sums and one shared live predicate. Deadline must prevent a stale `blocked` row from reserving forever. Change capacity copy to `قابل فروش` rather than configured-cap wording.
- [ ] **Step 3:** Run only `node-capacity.test.ts`; expected PASS so this task is independently green.
- [ ] **Step 4:** Commit.

```bash
git add apps/sales-bot/src/node-capacity.ts apps/sales-bot/test/node-capacity.test.ts
git commit -m "fix: account for finalized node traffic"
```

---

## Task 3: Add seller accounting, exact settlement epochs, snapshots, and limits

**Files:**
- Create: `apps/sales-bot/src/seller-accounting.ts`
- Create: `apps/sales-bot/test/seller-accounting.test.ts`
- Modify: `apps/sales-bot/src/resellers.ts` only if a small shared auth/validation helper is required.

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
export async function sellerStats(db: D1Database, sellerId: string, scope: "current" | "all", now: number): Promise<SellerStats>;
export async function sellerNodeStats(db: D1Database, sellerId: string, scope: "current" | "all", now: number): Promise<SellerNodeStats[]>;
export async function sellerLimits(db: D1Database, sellerId: string, now: number): Promise<SellerLimits>;
export async function setSellerLimits(db: D1Database, actor: SalesActor, sellerId: string, limits: {maxReservedAccounts:number|null; maxCommittedBytes:number|null}, now: number): Promise<void>;
export async function settleSeller(db: D1Database, actor: SalesActor, sellerId: string, now: number): Promise<{settlementId:string; closedEpoch:number}>;
```

Rules: current stats select `seller_settlement_epoch=current_settlement_epoch`; all-time has no epoch filter. `soldBytes=COALESCE(quota_bytes,0)`. `usedBytes` is actual traffic for seller reporting. Effective state treats elapsed stale active/blocked rows as expired. `liveCount` is preparing+active; blocked is reported separately.

Settlement is one D1 transactional batch: lazily ensure controls (first `settlement_started_at` from reseller `created_at`), snapshot current epoch + node breakdown, insert unique `(seller_id,epoch)`, increment epoch once, update start time, audit. Replay cannot close the same epoch twice.

- [ ] **Step 1:** Write failing tests with `0010`: epoch0 current equals all-time; settlement freezes epoch0 and starts empty epoch1; all-time unchanged; customer rows untouched; new epoch1 sale belongs only to current; old snapshot stays frozen if old usage later rises; node breakdown sums; valid blocked vs stale blocked-after-deadline; terminal rows release seller current limits; only admin can set limits/settle.

```bash
cd apps/sales-bot
npx vitest run test/seller-accounting.test.ts
```

Expected: FAIL because module is absent.

- [ ] **Step 2:** Implement using the same live-commitment semantics as node capacity. Validate caps as `null`, count 1..10000, bytes 1..1e15.
- [ ] **Step 3:** Focused test PASS.
- [ ] **Step 4:** Commit.

```bash
git add apps/sales-bot/src/seller-accounting.ts apps/sales-bot/src/resellers.ts apps/sales-bot/test/seller-accounting.test.ts
git commit -m "feat: add reseller settlement accounting"
```

---

## Task 4: Enforce node and seller limits atomically in `createAccount`

**Files:**
- Modify: `apps/sales-bot/src/accounts.ts`
- Modify: `apps/sales-bot/src/node-capacity.ts` only for a shared SQL fragment if needed
- Modify: `apps/sales-bot/test/node-allocation.test.ts`
- Modify: `apps/sales-bot/test/seller-accounting.test.ts` for epoch-insert integration only

**Atomic insert requirements:**

```text
node reserved slots + 1 <= max_accounts
finite node charged + requested quota <= max_allocated_bytes
finite node has no live uncapped legacy account
seller max_reserved_accounts if configured
seller max_committed_bytes if configured
finite seller cap has no live uncapped seller commitment
new row gets current seller settlement epoch (default 0)
```

Admin bypasses seller caps, never node caps. Keep `(seller_id,request_key)` idempotency.

Stable errors: `NODE_FULL`, `NODE_ALLOCATION_FULL`, `SELLER_ACCOUNT_LIMIT`, `SELLER_ALLOCATION_FULL`, plus existing node/validation errors.

- [ ] **Step 1:** Update `node-allocation.test.ts` fixture to apply `0010`. Replace obsolete blocked-release expectation. Add failing cases: 100GB sold/90GB used/revoked leaves only10GB; 30/8 revoke releases22; valid blocked blocks sale; expired charges actual; concurrent sellers cannot oversubscribe last node bytes; concurrent same-seller requests cannot bypass count/byte cap; seller errors distinct; terminal rows free seller caps; admin bypasses seller caps; success stamps current settlement epoch; request replay does not double-charge.

```bash
cd apps/sales-bot
npx vitest run test/node-allocation.test.ts test/seller-accounting.test.ts
```

Expected: FAIL on old atomic SQL.

- [ ] **Step 2:** Replace the old `WITH reserved ... INSERT` with node-usage + seller-usage CTEs inside the same authoritative insert. Do not trust UI/precomputed capacity.
- [ ] **Step 3:** On insert failure, classify from current authoritative seller/node state. Seller-specific cap error wins when the seller is independently capped; admin skips seller classification.
- [ ] **Step 4:** Focused tests PASS including concurrency/idempotency.
- [ ] **Step 5:** Commit.

```bash
git add apps/sales-bot/src/accounts.ts apps/sales-bot/src/node-capacity.ts apps/sales-bot/test/node-allocation.test.ts apps/sales-bot/test/seller-accounting.test.ts
git commit -m "feat: enforce node and reseller sale caps"
```

---

## Task 5: Add deduplicated admin-only threshold alerts and reliable re-arming

**Files:**
- Create: `apps/sales-bot/src/capacity-alerts.ts`
- Create: `apps/sales-bot/test/capacity-alerts.test.ts`
- Modify: `apps/sales-bot/src/reseller-menus.ts`
- Modify: `apps/sales-bot/src/node-api.ts`
- Modify: `apps/sales-bot/src/index.ts`
- Modify: `apps/sales-bot/test/quota-reports.test.ts`
- Modify: `apps/sales-bot/test/reseller-flows.test.ts`

**Interfaces:**

```ts
export async function refreshCapacityAlert(env: Env, nodeId: string, now: number): Promise<number | null>;
export async function refreshAllCapacityAlerts(env: Env, now: number): Promise<void>;
```

Targets: `<80 =>0`, `80..<90 =>80`, `90..<95 =>90`, `>=95 =>95`, unlimited =>0/no bandwidth alert.

Use `node_capacity_alert_state.sequence` plus deterministic outbox IDs `capacity:<node>:<sequence>:<admin>`. State transition and outbox rows belong to one D1 transactional batch using compare/update + `INSERT OR IGNORE`; concurrent refreshes may attempt the same deterministic IDs but can never create duplicate messages. A direct jump 79->96 sends one 95 warning. Downward refresh only re-arms; no recovery spam.

- [ ] **Step 1:** Write failing alert tests: 80 -> duplicate ->90 ->95; drop below80/re-cross; direct jump to95; unlimited; multiple admins; seller IDs absent; concurrent refresh produces one alert/admin/crossing.

```bash
cd apps/sales-bot
npx vitest run test/capacity-alerts.test.ts
```

- [ ] **Step 2:** Implement `refreshCapacityAlert` and `refreshAllCapacityAlerts`. Alert text includes node name, threshold, committed, finalized, sellable only—no credentials/config secrets. `refreshAllCapacityAlerts` catches failures per node so one bad alert does not stop the sweep.
- [ ] **Step 3:** Re-arm **before** and evaluate **after** every sale in `reseller-menus.ts`: best-effort `refreshCapacityAlert` on the selected node immediately before `createAccount`, then again after successful creation. This handles a silent deadline expiry that lowered utilization since the last alert refresh. After successful revoke, refresh once (downward/re-arm path).
- [ ] **Step 4:** In `node-api.ts`, refresh the authenticated node after successful quota-report acceptance; this captures terminal transitions/re-arm. In `index.ts` scheduled handler, call `refreshAllCapacityAlerts(env,now)` once per cron before outbox delivery so time-only expiries re-arm even when no sale/report occurs.
- [ ] **Step 5:** Add failure-injection tests proving alert errors do not make create/revoke/quota acceptance fail.

```bash
cd apps/sales-bot
npx vitest run test/capacity-alerts.test.ts test/quota-reports.test.ts test/node-allocation.test.ts test/reseller-flows.test.ts
```

Expected: PASS.

- [ ] **Step 6:** Commit.

```bash
git add apps/sales-bot/src/capacity-alerts.ts apps/sales-bot/src/reseller-menus.ts apps/sales-bot/src/node-api.ts apps/sales-bot/src/index.ts apps/sales-bot/test/capacity-alerts.test.ts apps/sales-bot/test/quota-reports.test.ts apps/sales-bot/test/reseller-flows.test.ts
git commit -m "feat: warn admins on node capacity thresholds"
```

---

## Task 6: Redesign admin/seller home and sale flow around true sellable capacity

**Files:**
- Create: `apps/sales-bot/src/sales-format.ts`
- Create: `apps/sales-bot/test/sales-format.test.ts`
- Modify: `apps/sales-bot/src/reseller-menus.ts`
- Modify: `apps/sales-bot/test/reseller-flows.test.ts`

**Helpers:**

```ts
export function formatBytes(bytes: number): string;
export function formatOptionalBytes(bytes: number | null): string;
export function nodeCapacitySummary(n: NodeCapacity): string;
```

Use decimal GB/TB (`1e9` bytes/GB), matching existing quota semantics.

Admin home shows active servers, in-service configs, committed volume, finalized usage, active sellers. Buttons: sale/trial, nodes/sellers, configs/reports, help. Seller home shows only own in-service count, current-settlement count+sold bytes, all-time count+sold bytes, plus own sale/trial/config/stats/help actions.

Wizard remains label -> quota -> days -> server -> confirmation. Once quota is known, selectable nodes must be healthy/recent/`quota-v2`, have slot capacity, fit seller limits, and fit requested bytes. Confirmation shows finite capacity before/after; unlimited says `نامحدود`. Final atomic insert still decides success.

- [ ] **Step 1:** Failing formatting tests for zero, GB/TB, finite summary, unlimited.
- [ ] **Step 2:** Update reseller-flow fixture to apply `0010`, then add failing UI tests: seller hides admin data; admin summary present; seller current+all-time shown; server button uses current sellable not configured max; valid blocked reduces it; revoked/expired restores only unused; non-fitting node not selectable; confirmation includes before/after; stale confirm gets safe Persian capacity error; seller count/byte errors are distinct Persian messages.

```bash
cd apps/sales-bot
npx vitest run test/sales-format.test.ts test/reseller-flows.test.ts
```

- [ ] **Step 3:** Implement formatting and refactor menus using `nodeCapacities`, `sellerStats`, `sellerLimits`; no duplicate accounting formula in menu code. Add `rs:stats` for seller self-statistics. If admin has `rs:reports`, implement a real aggregate report; do not add empty decorative buttons.
- [ ] **Step 4:** Preserve current conversation/outbox replay guards and ownership checks. Focused tests PASS.
- [ ] **Step 5:** Commit.

```bash
git add apps/sales-bot/src/sales-format.ts apps/sales-bot/src/reseller-menus.ts apps/sales-bot/test/sales-format.test.ts apps/sales-bot/test/reseller-flows.test.ts
git commit -m "feat: redesign reseller sales dashboard"
```

---

## Task 7: Add admin node details, seller details, settlement UI, and controls

**Files:**
- Create: `apps/sales-bot/src/node-settings.ts`
- Create: `apps/sales-bot/test/node-settings.test.ts`
- Modify: `apps/sales-bot/src/reseller-menus.ts`
- Modify: `apps/sales-bot/test/reseller-flows.test.ts`

**Node settings interfaces:**

```ts
export async function setNodeMaxAccounts(db: D1Database, actor: SalesActor, nodeId: string, maxAccounts: number, now: number): Promise<void>;
export async function setNodeMaxAllocatedBytes(db: D1Database, actor: SalesActor, nodeId: string, maxAllocatedBytes: number | null, now: number): Promise<void>;
```

Validate slots 1..10000; finite bytes 1..1e15; `null` = unlimited; admin-only; audit every change.

**Callbacks/screens:**
- `rs:nodes`: compact one-button-per-node list.
- `rs:nodedetail:<nodeId>`: health, limited/unlimited, total cap, committed, finalized, sellable, utilization, slots, purposes.
- retain `rs:node:sale:<id>` / `rs:node:trial:<id>` purpose actions.
- `rs:capacity:<id>`: slot edit through `node-settings.ts`.
- `rs:allocation:<id>`: finite GB edit; `rs:unlimit:<id>` sets byte cap NULL.
- `rs:sellers`: enabled state + current settlement summary, each seller selectable.
- `rs:seller:<telegramId>`: current + all-time, actual traffic, effective states, limits, node breakdown.
- `rs:settle:<id>` -> confirmation, `rs:settleok:<id>` -> settle.
- `rs:settlements:<id>` -> recent frozen settlement snapshots.
- `rs:limits:<id>` -> limits, with `rs:limitcount:<id>` and `rs:limitbytes:<id>` numeric conversation actions; input `0` clears that cap.

- [ ] **Step 1:** Write failing `node-settings.test.ts` for admin-only finite/unlimited byte cap, slot cap, validation, audit.
- [ ] **Step 2:** Add failing admin UI tests: node detail metrics; unlimited mode; seller detail current/all-time/node breakdown; set/clear seller caps; settlement confirmation/idempotency; customer state untouched; seller cannot invoke admin callbacks.

```bash
cd apps/sales-bot
npx vitest run test/node-settings.test.ts test/reseller-flows.test.ts
```

- [ ] **Step 3:** Implement `node-settings.ts` and remove direct cap-update SQL from menus.
- [ ] **Step 4:** Implement node/seller detail, settlement history, and limit screens using accounting modules.
- [ ] **Step 5:** Around a node byte-cap change, best-effort refresh alerts **before and after** the mutation. This preserves crossing semantics when an old alert level was stale because capacity had fallen since the last refresh. Alert failure cannot fail the setting update.

```bash
cd apps/sales-bot
npx vitest run test/node-settings.test.ts test/seller-accounting.test.ts test/reseller-flows.test.ts test/capacity-alerts.test.ts
```

Expected: PASS.

- [ ] **Step 6:** Commit.

```bash
git add apps/sales-bot/src/node-settings.ts apps/sales-bot/src/reseller-menus.ts apps/sales-bot/test/node-settings.test.ts apps/sales-bot/test/reseller-flows.test.ts
git commit -m "feat: add admin capacity and reseller controls"
```

---

## Task 8: Full regression, CI, production gate, and field acceptance

- [ ] **Step 1: Full app verification.**

```bash
cd apps/sales-bot
npm test
npm run typecheck
npm run build
```

Expected: all PASS / dry-run build succeeds.

- [ ] **Step 2: Repo-level targeted verification matching CI.**

```bash
pnpm --filter @madar/sales-bot types
pnpm --filter @madar/sales-bot typecheck
pnpm --filter @madar/sales-bot test
pnpm --filter @madar/sales-bot build
python scripts/verify_sales_quota_probe.py
```

The `Telegram sales bot` workflow also runs runner/node regressions. No unrelated node/runner change is expected.

- [ ] **Step 3:** Push exact implementation SHA and wait for relevant GitHub Actions to be green; record exact SHA/run IDs. Never roll out on red/pending checks.
- [ ] **Step 4:** Obtain explicit production authorization, stating exact mutations: additive D1 `0010`, exact-green Worker deploy, no node-agent rollout, preserve secrets/bindings.
- [ ] **Step 5:** After authorization inspect remote pending migrations:

```bash
cd apps/sales-bot
npx wrangler d1 migrations list madar-sales-bot-db --remote
```

Expected: only intended `0010` pending. Then:

```bash
npx wrangler d1 migrations apply madar-sales-bot-db --remote
```

Verify new tables/column read-only and existing node/account counts unchanged.

- [ ] **Step 6:** Deploy exact-green Worker through the established production method that preserves current bindings/secrets. Do not deploy through a path that writes empty `wrangler.jsonc` placeholders over production vars. Record Worker version/deployment ID.
- [ ] **Step 7: Field acceptance on a dedicated/low-impact finite test node/account.** Never induce a global frontend failure on a node carrying real customers merely to manufacture blocked state. Validate: server detail numbers; sale reduces sellable by full sold quota; partial usage does not release while live; 30GB/8GB revoke leaves8 charged/returns22; expiry same; safe blocked setup holds full until deadline then actual-only; 80/90/95 admin-only non-spam + re-arm; seller detail/current/all-time; temporary seller caps and distinct refusal; settlement starts a new current epoch without touching configs; non-production/test node unlimited mode.
- [ ] **Step 8:** Final read-only checks: unique `(seller_id,epoch)` settlements; alert levels only 0/80/90/95; no seller chat has capacity-alert outbox IDs; no negative accounting exposed as positive sellable; production nodes remain healthy/recent/shared-443; no port/protocol change.
- [ ] **Step 9:** Record evidence only after observed: green SHA, CI run IDs, migration result, Worker deployment/version, non-secret field results. Do not claim completion with an unverified item.

---

## Final Definition of Done

- Finite sellable bytes = configured budget - live full-quota commitments - terminal finalized traffic.
- Valid blocked rows reserve fully; stale blocked rows past deadline do not reserve forever.
- Revoked/expired rows release only unused quota.
- Node slot/byte limits and seller current limits are atomically enforced under concurrency.
- Unlimited nodes skip byte eligibility while preserving health/slot checks.
- Current and all-time seller reports are correct; settlement is exact/idempotent and never affects customer service.
- Admin-only 80/90/95 warnings are deduplicated and reliably re-arm.
- Telegram admin/seller screens show the approved compact hierarchy and true current sellable capacity.
- Existing quota cutoff, expiry, revoke, delivery, shared-443, runner, and enrollment regressions stay green.
- Additive production migration + exact-green Worker deployment pass field acceptance without exposing or rotating secrets.
