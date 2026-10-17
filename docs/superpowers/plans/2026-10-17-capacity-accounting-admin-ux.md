# Madar Capacity Accounting, Seller Controls, and Bot UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make finite-bandwidth node inventory impossible to oversell, add admin-only 80/90/95% capacity warnings, add auditable seller limits/settlements/statistics, and replace the current reseller bot screens with a compact role-specific Telegram dashboard.

**Architecture:** Keep the current Worker + D1 + Telegram outbox architecture. Centralize node math in `node-capacity.ts`, add seller accounting in `seller-accounting.ts`, add idempotent threshold notifications in `capacity-alerts.ts`, and keep `reseller-menus.ts` as orchestration/presentation rather than duplicating accounting SQL. Use additive D1 schema changes, stamp every new account with the seller settlement epoch active at creation, and keep the final account insert as the authoritative atomic guard for both node and seller capacity.

**Tech Stack:** TypeScript 5.9, Cloudflare Workers, Cloudflare D1/SQLite, Hono, Telegram Bot API through the existing durable `outbox`, Vitest 4.1, Wrangler 4.148, pnpm.

**Spec:** `docs/superpowers/specs/2026-10-17-capacity-accounting-admin-ux-design.md`

## Global Constraints

- Work on `impl/telegram-sales-bot`; approved design commit: `ee2150736695854188cdd616eb75ea708df8e26e`.
- TDD is mandatory. For each task: add a failing focused test, run it and confirm the intended failure, implement the smallest correct change, rerun to green, then commit.
- Preserve shared-443 and the node-agent protocol. This feature is Worker/D1/Telegram UI work only.
- Never expose bot tokens, node tokens, REALITY keys, UUID-bearing VLESS URIs, AWS credentials, or other secrets in tests, logs, screenshots, commits, or field notes.
- D1 changes are additive. Do not rebuild `managed_accounts` just to add a `failed` state. The existing elapsed pre-activation `preparing` row is the terminal failed-before-activation equivalent.
- Existing account rows survive migration. They receive `seller_settlement_epoch=0` and keep contributing to node accounting from current quota, usage, deadline, and state.
- `max_allocated_bytes IS NULL` means bandwidth-unlimited. Finite nodes enforce byte budget and account slots independently.
- A live commitment is `preparing`, `active`, or `blocked`, with a still-usable service window (`valid_until=0` or `valid_until>now`), and not already exhausted by a finite quota. A live finite account reserves the full sold quota. A live uncapped legacy account makes a finite node unsellable.
- Non-live rows charge finalized traffic only: revoked/expired/deadline-ended rows charge `used_bytes`; exhausted finite rows charge `min(used_bytes, quota_bytes)`. Never add used bytes again on top of a live account's full-quota commitment.
- Seller limits are current-commitment limits, not lifetime punishment. Terminal rows stop consuming seller caps while remaining in settlement/all-time reports.
- Admin-issued configs obey node limits but not reseller-specific caps.
- Capacity-alert failures must never roll back account creation, revocation, node-cap changes, or quota-report acceptance.
- No production D1 migration or Worker deployment occurs without explicit rollout authorization at execution time. Existing production secrets/bindings must be preserved.

## Review Focus

1. **Accounting invariants:** valid blocked/live rows reserve full quota; revoked/expired retain only actual usage; stale blocked rows past deadline do not reserve forever; exhausted node charge is capped at sold quota.
2. **Atomicity:** concurrent sellers cannot consume the same final slot/GB or bypass seller caps.
3. **Settlement exactness:** each sale belongs to exactly one settlement epoch even if a sale and settlement happen concurrently; settlement never changes customer service.
4. **Alert idempotency:** 80/90/95 alerts are admin-only, non-spamming, concurrency-safe, and re-arm after utilization drops.
5. **Authorization/UX:** sellers see only their own accounting/operations; admin mutations remain admin-only and confirmation is retained for settlement/revoke actions.

---

## Task 1: Add additive accounting and settlement persistence

**Files:**
- Create: `apps/sales-bot/migrations/0010-capacity-accounting-resellers.sql`
- Create: `apps/sales-bot/test/capacity-accounting-migration.test.ts`

**Schema contract:**

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

The epoch column is intentional: `created_at` only has second resolution, so timestamps alone cannot unambiguously assign a sale that races a manual settlement. Epoch stamping makes the boundary exact.

- [ ] **Step 1: Write the failing migration test.** Apply migrations through `0009`, insert an existing reseller and account, then import/apply `0010`. Assert that the old account remains and defaults to epoch 0; all new tables exist; nullable caps accept `NULL`; invalid zero/negative caps fail; alert levels outside 0/80/90/95 fail.

Run:

```bash
cd apps/sales-bot
npx vitest run test/capacity-accounting-migration.test.ts
```

Expected before implementation: FAIL because `0010` does not exist.

- [ ] **Step 2: Add `0010-capacity-accounting-resellers.sql` exactly as an additive migration.** Do not edit old migrations.

- [ ] **Step 3: Rerun the focused migration test.** Expected: PASS.

- [ ] **Step 4: Commit.**

```bash
git add apps/sales-bot/migrations/0010-capacity-accounting-resellers.sql apps/sales-bot/test/capacity-accounting-migration.test.ts
git commit -m "feat: add capacity accounting persistence"
```

---

## Task 2: Replace reservation-only node math with committed + finalized accounting

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
export async function nodeCapacities(
  db: D1Database,
  now: number,
  nodeId?: string | null,
): Promise<NodeCapacity[]>;
```

`nodeCapacities` must aggregate across **all** accounts on the node with conditional sums, rather than joining only live rows.

```text
live finite          => committed += quota_bytes
live uncapped        => uncapped_accounts += 1
non-live exhausted   => finalized += min(used_bytes, quota_bytes)
other non-live       => finalized += used_bytes
finite sellable      => max(0, max_allocated_bytes - committed - finalized)
unlimited sellable   => null
```

- [ ] **Step 1: Create failing `node-capacity.test.ts`.** Cover valid blocked full reservation; blocked after deadline charging only actual usage; revoked 30GB/8GB charging 8GB; expired 30GB/8GB charging 8GB; exhausted 30GB/31GB charging 30GB; partial active charging full quota; elapsed pre-activation preparing consuming neither slot nor quota; unlimited node returning `null`; live uncapped legacy account making a finite node unsellable. Directly assert `nodeCapacities`, `remainingAllocation`, `utilizationPercent`, and `canAllocate`.

```bash
cd apps/sales-bot
npx vitest run test/node-capacity.test.ts
```

Expected: FAIL under the current live-reservation-only query.

- [ ] **Step 2: Implement centralized node accounting.** Use one live predicate consistently; deadline must override stale `blocked` for accounting. Change Persian `allocationLabel` wording to `قابل فروش` rather than implying the configured cap is untouched.

- [ ] **Step 3: Rerun only `node-capacity.test.ts`.** Expected: PASS, giving this task an independent green checkpoint without touching `createAccount` yet.

- [ ] **Step 4: Commit.**

```bash
git add apps/sales-bot/src/node-capacity.ts apps/sales-bot/test/node-capacity.test.ts
git commit -m "fix: account for finalized node traffic"
```

---

## Task 3: Add seller statistics, exact settlement epochs, snapshots, and limits

**Files:**
- Create: `apps/sales-bot/src/seller-accounting.ts`
- Create: `apps/sales-bot/test/seller-accounting.test.ts`
- Modify: `apps/sales-bot/src/resellers.ts` only if a small exported authorization/validation helper is genuinely shared.

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

Reporting rules: normalize an elapsed deadline before calling stale active/blocked rows live; `soldBytes=COALESCE(quota_bytes,0)`; `usedBytes` is actual reported traffic and is not capped for seller reporting. Current scope selects the seller's current epoch; all-time has no epoch filter.

Settlement must be transactional: ensure/lazily create `reseller_controls` using seller `created_at` as first start time; snapshot current epoch summary and per-node rows; insert one unique `(seller_id,epoch)` settlement; increment epoch once; set new start time; audit. A retry must not close the same epoch twice.

- [ ] **Step 1: Write failing seller-accounting tests.** Apply `0010` in fixture setup. Cover current initially equal to all-time at epoch 0; settlement snapshots epoch 0 and starts empty epoch 1; all-time unchanged; customer rows/states unchanged; a new epoch-1 account appears only in current; old snapshot stays frozen if an old account later reports more usage; node breakdown sums correctly; stale blocked past deadline reports expired; valid blocked reports blocked; limits count full live quota and ignore terminal rows; only admin can set limits/settle.

```bash
cd apps/sales-bot
npx vitest run test/seller-accounting.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 2: Implement `seller-accounting.ts`.** Reuse the approved live-commitment semantics from `node-capacity.ts`; do not create a contradictory predicate. Validate optional limits as `null` or account 1..10000 / bytes 1..1e15.

- [ ] **Step 3: Rerun focused test.** Expected: PASS.

- [ ] **Step 4: Commit.**

```bash
git add apps/sales-bot/src/seller-accounting.ts apps/sales-bot/src/resellers.ts apps/sales-bot/test/seller-accounting.test.ts
git commit -m "feat: add reseller settlement accounting"
```

---

## Task 4: Enforce node budget and seller caps atomically at account creation

**Files:**
- Modify: `apps/sales-bot/src/accounts.ts`
- Modify: `apps/sales-bot/src/node-capacity.ts` only for a shared SQL fragment if required
- Modify: `apps/sales-bot/test/node-allocation.test.ts`
- Modify: `apps/sales-bot/test/seller-accounting.test.ts` only for creation/epoch integration cases

**Atomic insert contract:**

The final `INSERT ... SELECT`/CTE in `createAccount` must evaluate, in the same statement:

```text
node reserved slots + 1 <= max_accounts
finite node charged_bytes + requested quota <= max_allocated_bytes
finite node has no live uncapped legacy account
seller max_reserved_accounts when configured
seller max_committed_bytes when configured
seller with a finite byte cap has no live uncapped commitment
```

The new row stores:

```text
seller_settlement_epoch = current reseller_controls.current_settlement_epoch
                          or 0 if no controls row exists
```

Admin actors bypass seller-specific caps but not node caps. Existing `(seller_id,request_key)` idempotency remains first-class.

Stable errors:
- `NODE_FULL`
- `NODE_ALLOCATION_FULL`
- `SELLER_ACCOUNT_LIMIT`
- `SELLER_ALLOCATION_FULL`
- retain existing `NODE_UNAVAILABLE`, `NODE_NOT_CONFIGURED`, and validation codes.

- [ ] **Step 1: Update `node-allocation.test.ts` fixture to apply `0010`, then rewrite/add failing creation tests.** Replace the obsolete `blocked releases reservation` assertion. Prove: 100GB node + 100GB account used90/revoked leaves only 10GB sellable; 30GB/8GB revoke releases exactly22; valid blocked cannot be bypassed; expired leaves only actual usage; concurrent sellers cannot over-allocate last node bytes; concurrent requests from one seller cannot overrun count or byte cap; seller caps return distinct errors; terminal rows release seller current caps; admin bypasses seller caps but not node caps; creation stamps current settlement epoch; request replay does not double-consume capacity.

```bash
cd apps/sales-bot
npx vitest run test/node-allocation.test.ts test/seller-accounting.test.ts
```

Expected: FAIL under the old reservation-only insert and absent seller enforcement.

- [ ] **Step 2: Replace `WITH reserved ... INSERT` in `createAccount` with node-usage + seller-usage CTEs.** The same effective-live rule used by `nodeCapacities` must be represented in the atomic SQL. Do not trust UI/precheck capacity.

- [ ] **Step 3: Classify failed insert from current authoritative state.** For seller actors, return a seller-limit error when that seller is independently capped; otherwise return node slot/byte error. Admin skips seller classification.

- [ ] **Step 4: Rerun focused tests.** Expected: PASS including concurrency/idempotency.

- [ ] **Step 5: Commit.**

```bash
git add apps/sales-bot/src/accounts.ts apps/sales-bot/src/node-capacity.ts apps/sales-bot/test/node-allocation.test.ts apps/sales-bot/test/seller-accounting.test.ts
git commit -m "feat: enforce node and reseller sale caps"
```

---

## Task 5: Add concurrency-safe admin-only capacity threshold alerts

**Files:**
- Create: `apps/sales-bot/src/capacity-alerts.ts`
- Create: `apps/sales-bot/test/capacity-alerts.test.ts`
- Modify: `apps/sales-bot/src/reseller-menus.ts`
- Modify: `apps/sales-bot/src/node-api.ts`
- Modify: `apps/sales-bot/test/quota-reports.test.ts`
- Modify: `apps/sales-bot/test/reseller-flows.test.ts` only for create/revoke alert orchestration coverage

**Interface:**

```ts
export async function refreshCapacityAlert(
  env: Env,
  nodeId: string,
  now: number,
): Promise<number | null>;
```

Threshold target:

```text
<80% => 0
80..<90 => 80
90..<95 => 90
>=95 => 95
unlimited => 0, no bandwidth alert
```

Rules: repeated same-level refresh emits nothing; lower utilization lowers/re-arms stored level without recovery spam; a future upward crossing alerts again; a direct jump 79->96 emits one 95% warning; only valid IDs from `ADMIN_TELEGRAM_IDS` receive the alert.

Use `node_capacity_alert_state.sequence` and deterministic outbox IDs such as `capacity:<nodeId>:<sequence>:<adminId>`. Make the conditional state advance and corresponding `INSERT OR IGNORE ... SELECT` outbox writes a D1 transactional batch so concurrent refreshers cannot both create distinct notifications for the same crossing, and a failed batch does not persist an advanced level without its outbox rows.

- [ ] **Step 1: Write failing alert tests.** Cover 80 -> duplicate -> 90 -> 95; drop below80/re-cross; jump directly to95; unlimited; multiple admins; seller ID absent; concurrent refresh calls produce one alert per admin per crossing.

```bash
cd apps/sales-bot
npx vitest run test/capacity-alerts.test.ts
```

Expected: FAIL because module does not exist.

- [ ] **Step 2: Implement `capacity-alerts.ts`.** Message includes node name, threshold, committed, finalized, and sellable summary only—no private config material.

- [ ] **Step 3: Hook alerts at explicit orchestration boundaries, always best-effort.** In `reseller-menus.ts`, after successful `createAccount`, load the created account/node and call `refreshCapacityAlert` in `try/catch`; after successful revoke, do the same for the revoked account's node. In `node-api.ts`, after `acceptQuotaReports` succeeds, refresh that authenticated node in `try/catch`. Do not add an `Env` dependency to core `createAccount`/`revokeAccount` just for alerts.

- [ ] **Step 4: Add tests that force alert failure while create/revoke/quota acceptance still succeeds.** Quota reports must remain accepted and account state transitions must remain committed.

```bash
cd apps/sales-bot
npx vitest run test/capacity-alerts.test.ts test/quota-reports.test.ts test/node-allocation.test.ts test/reseller-flows.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add apps/sales-bot/src/capacity-alerts.ts apps/sales-bot/src/reseller-menus.ts apps/sales-bot/src/node-api.ts apps/sales-bot/test/capacity-alerts.test.ts apps/sales-bot/test/quota-reports.test.ts apps/sales-bot/test/reseller-flows.test.ts
git commit -m "feat: warn admins on node capacity thresholds"
```

---

## Task 6: Redesign home screens and sale flow around real sellable capacity

**Files:**
- Create: `apps/sales-bot/src/sales-format.ts`
- Create: `apps/sales-bot/test/sales-format.test.ts`
- Modify: `apps/sales-bot/src/reseller-menus.ts`
- Modify: `apps/sales-bot/test/reseller-flows.test.ts`

**Pure presentation helpers:**

```ts
export function formatBytes(bytes: number): string;
export function formatOptionalBytes(bytes: number | null): string;
export function nodeCapacitySummary(n: NodeCapacity): string;
```

Use decimal GB/TB because existing quotas are decimal (`1e9` bytes/GB).

**Admin home:** operational summary (`سرورها`, in-service configs, committed volume, finalized usage, active sellers) with rows for sale/trial, nodes/sellers, configs/reports, help.

**Seller home:** only own in-service count, current-settlement config count/sold quota, all-time count/sold quota, and buttons for new config/trial, own configs/stats, help. Never expose global admin data.

**Sale wizard:** keep label -> quota -> days -> server -> final confirmation. After requested quota is known, only nodes that are healthy/recent/`quota-v2`, have a slot, satisfy seller caps, and can fit requested bytes are selectable. Final confirmation shows node, quota, duration, current finite sellable capacity, and projected capacity after sale; unlimited says `نامحدود`. The atomic insert still decides success.

- [ ] **Step 1: Write failing formatting tests.** Cover zero, GB/TB, finite summary, unlimited label.

```bash
cd apps/sales-bot
npx vitest run test/sales-format.test.ts
```

- [ ] **Step 2: Update `reseller-flows.test.ts` fixture to apply `0010`, then add failing UX assertions.** Seller home excludes admin controls; admin home has operational summary; seller home has current + all-time totals; server selection displays current sellable, not configured max; valid blocked reduces displayed capacity; revoked/expired restores only unused; requested quota that does not fit is not selectable; final confirmation shows before/after; stale confirm gets safe Persian capacity message; seller count vs byte limit errors have distinct Persian messages.

```bash
cd apps/sales-bot
npx vitest run test/reseller-flows.test.ts
```

Expected: FAIL on the current home/server/confirmation copy.

- [ ] **Step 3: Implement `sales-format.ts` and refactor home/server/confirmation screens.** Use `nodeCapacities`, `sellerStats`, and `sellerLimits`; never duplicate the accounting formula in menu code. Add `rs:stats` for seller self-statistics. If `rs:reports` exists on admin home, implement a real aggregate screen; do not add empty decorative buttons.

- [ ] **Step 4: Preserve current replay-safe `users.conversation` + outbox behavior and existing ownership rules.** Run:

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

## Task 7: Add admin node details, seller details, settlement UI, and controls

**Files:**
- Create: `apps/sales-bot/src/node-settings.ts`
- Create: `apps/sales-bot/test/node-settings.test.ts`
- Modify: `apps/sales-bot/src/reseller-menus.ts`
- Modify: `apps/sales-bot/test/reseller-flows.test.ts`

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

Validation: slots 1..10000; finite bytes 1..1e15; `null` means unlimited; admin only; every mutation audited.

**Callbacks/screens:**
- `rs:nodes`: compact node list, one detail button per node; move the existing four-per-node controls off this crowded list.
- `rs:nodedetail:<nodeId>`: health, limited/unlimited mode, configured cap, committed, finalized, sellable, utilization, slots, purposes.
- Keep existing `rs:node:sale:<nodeId>` / `rs:node:trial:<nodeId>` purpose actions.
- `rs:capacity:<nodeId>`: slot-cap numeric conversation routed through `node-settings.ts`.
- `rs:allocation:<nodeId>`: finite-GB numeric conversation; separate `rs:unlimit:<nodeId>` sets byte cap to `NULL`.
- `rs:sellers`: enabled status + concise current settlement summary, seller IDs selectable.
- `rs:seller:<telegramId>`: current settlement + all-time totals, actual traffic, effective state counts, limits, node breakdown.
- `rs:settle:<id>` -> confirmation; `rs:settleok:<id>` -> `settleSeller`.
- `rs:settlements:<id>`: recent closed snapshots for audit.
- `rs:limits:<id>` -> limit summary; `rs:limitcount:<id>` and `rs:limitbytes:<id>` start numeric conversations. Input `0` clears that seller cap.

- [ ] **Step 1: Write failing `node-settings.test.ts`.** Prove admin-only finite/unlimited byte cap, slot cap, validation, and audit events.

```bash
cd apps/sales-bot
npx vitest run test/node-settings.test.ts
```

- [ ] **Step 2: Add failing admin flow tests.** Node detail shows committed/finalized/sellable; unlimited changes detail and byte eligibility; seller detail shows current/all-time/node breakdown; seller caps set/clear and are hidden from sellers; settlement requires confirmation and is replay-safe; settlement leaves customer service untouched; sellers cannot invoke node settings/limits/settlement.

```bash
cd apps/sales-bot
npx vitest run test/node-settings.test.ts test/reseller-flows.test.ts
```

Expected: FAIL before implementation.

- [ ] **Step 3: Implement `node-settings.ts` and move the existing direct node-cap SQL out of `reseller-menus.ts`.** Keep audit action names stable or deliberately migrate tests if renamed.

- [ ] **Step 4: Implement node/seller detail, settlement-history, and limit screens using the accounting modules.** Destructive/financial boundary actions keep confirmation.

- [ ] **Step 5: After a node byte-cap change, best-effort call `refreshCapacityAlert(env,nodeId,now)` from the menu orchestration layer.** Raising cap can re-arm; lowering cap can move to the appropriate warning level. Alert failure never fails the setting change.

- [ ] **Step 6: Run focused tests.**

```bash
cd apps/sales-bot
npx vitest run test/node-settings.test.ts test/seller-accounting.test.ts test/reseller-flows.test.ts test/capacity-alerts.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit.**

```bash
git add apps/sales-bot/src/node-settings.ts apps/sales-bot/src/reseller-menus.ts apps/sales-bot/test/node-settings.test.ts apps/sales-bot/test/reseller-flows.test.ts
git commit -m "feat: add admin capacity and reseller controls"
```

---

## Task 8: Full regression, CI, production gate, and field acceptance

**Files:**
- Modify tests only for genuine regressions discovered during verification; never weaken assertions just to make CI green.
- Do not edit production config placeholders merely to deploy.

- [ ] **Step 1: Run complete app verification.**

```bash
cd apps/sales-bot
npm test
npm run typecheck
npm run build
```

Expected: all PASS / dry-run build succeeds.

- [ ] **Step 2: Run repo-level targeted verification matching CI.**

```bash
pnpm --filter @madar/sales-bot types
pnpm --filter @madar/sales-bot typecheck
pnpm --filter @madar/sales-bot test
pnpm --filter @madar/sales-bot build
python scripts/verify_sales_quota_probe.py
```

The branch `Telegram sales bot` workflow also runs runner/node regressions. No unrelated node/runner change is expected.

- [ ] **Step 3: Push exact implementation commit and wait for both relevant GitHub Actions workflows to be green.** Do not roll out on red or pending required checks. Record exact green SHA and run IDs.

- [ ] **Step 4: Obtain explicit production rollout authorization.** State the exact planned mutations: one additive D1 migration (`0010`) plus one Worker deployment from the exact green commit; no node-agent rollout; preserve all existing secrets/bindings.

- [ ] **Step 5: After authorization, inspect pending remote migrations before applying.** From `apps/sales-bot` in the approved Cloudflare production context:

```bash
npx wrangler d1 migrations list madar-sales-bot-db --remote
```

Expected: only the intended new migration is pending. Then apply:

```bash
npx wrangler d1 migrations apply madar-sales-bot-db --remote
```

Immediately verify the new tables/column with read-only D1 queries and verify existing node/account counts are unchanged.

- [ ] **Step 6: Deploy the exact green Worker through the project's established production method while preserving bindings/secrets.** Do not use a path that overwrites production vars with the empty placeholders in `wrangler.jsonc`. Record Worker version/deployment ID.

- [ ] **Step 7: Field-accept the accounting on a dedicated/low-impact finite test node or test account.** Never induce a global frontend failure on a production node that carries real customers merely to create `blocked` state.

Validate, without exposing customer secrets:
1. Admin server detail shows configured budget, committed, finalized, sellable, slots, utilization.
2. Create a finite test sale; sellable drops by sold quota.
3. Generate normal measured usage; while account remains live, partial use does not release capacity.
4. Revoke after measured use; only unused quota returns (e.g. 30GB sold/8GB used => 8GB remains charged, 22GB returns).
5. Expire a dedicated test account and verify the same release-only-unused invariant.
6. Validate blocked semantics on a dedicated test setup that does not disrupt unrelated customers: valid blocked holds full quota; once its deadline is effectively elapsed, only actual usage remains charged.
7. Exercise 80/90/95 on a safe low-cap test node/data set; only admins receive one alert per crossing; repeated reports do not spam; utilization drop/re-cross re-alerts.
8. Seller detail shows current + all-time; temporarily set seller count/byte cap and prove distinct refusal; clear it.
9. Close a seller settlement; configs continue working, current resets to new epoch, all-time remains unchanged, closed snapshot is visible.
10. On a non-production/test node, switch byte mode to unlimited and verify `نامحدود`/eligibility, then restore intended setting if needed.

- [ ] **Step 8: Final read-only acceptance checks.** Confirm no duplicate `(seller_id,epoch)` settlement; alert levels only 0/80/90/95; no seller chat received admin-alert outbox IDs; no negative charged math is exposed as positive sellable capacity; production nodes remain healthy/recent with shared-443 capability; no public-port or node-protocol change occurred.

- [ ] **Step 9: Record evidence only after it exists.** Include green commit, CI run IDs, migration result, Worker deployment/version ID, and non-secret field observations. Do not claim completion with any unverified acceptance item.

---

## Final Definition of Done

- Finite node sellable traffic equals configured budget minus live full-quota commitments minus terminal finalized traffic.
- Valid blocked rows cannot hide overselling; stale blocked rows past deadline do not reserve forever.
- Revoked/expired configs release only their unused sold quota.
- Slot and byte limits are independently and atomically enforced.
- Unlimited nodes skip byte eligibility while preserving health/slot checks.
- Seller current caps are independently and atomically enforced; admin is not accidentally seller-capped.
- Current-settlement and all-time seller reports are exact; settlement is idempotent and never affects customer service.
- Admin receives deduplicated 80/90/95 warnings; sellers never receive them.
- Telegram admin/seller screens match the approved compact hierarchy and display true current sellable capacity.
- Existing quota cutoff, expiry, revoke, delivery, shared-443, runner, and enrollment regressions stay green.
- The additive production migration and exact-green Worker rollout pass field acceptance without exposing or rotating secrets.
