# Madar capacity accounting, seller controls, and bot UX design

Date: 2026-10-17
Branch: `impl/telegram-sales-bot`

## 1. Goal

Madar must let the owner safely monetize several bandwidth-limited AWS/free-tier servers without ever selling more traffic than the owner has budgeted for a server, while also making reseller activity easy to audit and settle.

The design has three user-visible goals:

1. **Prevent overselling server bandwidth and account slots.**
2. **Give the admin accurate server and reseller accounting.**
3. **Replace the current text-heavy bot menus with a cleaner, compact, role-specific experience.**

The current AWS servers are finite-bandwidth inventory. Future high-bandwidth VPS nodes may be configured as unlimited-bandwidth without changing the overall architecture.

## 2. Capacity semantics

### 2.1 Node modes

Each node has one of two bandwidth modes:

- **Limited**: a finite byte budget is enforced.
- **Unlimited**: bandwidth is not part of sale eligibility; only health, feature capability, seller limits, and account-count capacity apply.

The existing `max_allocated_bytes` concept remains the configured total budget for a limited node. A null value means unlimited.

### 2.2 Capacity model

For a limited node, three quantities matter:

- **Committed bytes**: quota still reserved for accounts that may continue using service.
- **Finalized used bytes**: traffic already consumed by accounts that are no longer reserving future quota.
- **Sellable bytes**: total node budget minus committed bytes minus finalized used bytes.

The node formula is:

```text
sellable_bytes = max_allocated_bytes
                 - committed_bytes
                 - finalized_used_bytes
```

with a lower bound of zero.

### 2.3 Account-state accounting

An account that can still resume or continue service reserves its full sold quota. An account that is terminal releases only its unused portion.

| Account state | Node accounting |
| --- | --- |
| `preparing` | reserve full sold quota |
| `active` | reserve full sold quota |
| `blocked` | reserve full sold quota |
| `revoked` | count only actual `used_bytes` |
| `expired` | count only actual `used_bytes` |
| `exhausted` | count actual usage, capped at sold quota |
| `failed` before customer activation | no committed quota after the request is terminal and unusable |

This means a 30 GB account that used 8 GB and is then revoked releases 22 GB back to sellable capacity while 8 GB remains permanently charged against that node's finite budget.

A partially consumed active or blocked account does **not** release capacity. The sold quota remains reserved until the account reaches a terminal state.

### 2.4 Account-count capacity

The account-count limit is enforced separately from bandwidth capacity.

- `preparing`, `active`, and `blocked` occupy an account slot.
- terminal states (`revoked`, `expired`, `exhausted`, terminal `failed`) do not occupy a slot.

A sale is accepted only when **both** the account-count limit and the bandwidth limit permit it.

### 2.5 Atomic sale guard

Capacity shown in the UI is informative. The authoritative check happens again during final account creation.

The insert path must atomically verify current node capacity so two simultaneous sellers cannot both consume the same last bytes or last slot.

If a requested quota no longer fits, creation fails with a specific safe error such as `NODE_ALLOCATION_FULL`; if the slot count is full, it fails with `NODE_FULL`.

## 3. Node capacity presentation

Every selectable node should show concise, decision-useful figures.

Example:

```text
🟢 Stockholm
ظرفیت: 200 GB
مصرف قطعی: 32 GB
رزرو فعال: 98 GB
قابل فروش: 70 GB
کانفیگ: 12 / 20
استفاده ظرفیت: 65%
```

For unlimited nodes, bandwidth lines should clearly say `نامحدود` rather than showing fake remaining bytes.

When the seller enters a requested quota, nodes that cannot satisfy that amount must either be hidden from selectable choices or be shown disabled with a clear `ظرفیت کافی ندارد` label. Final confirmation should show before/after sellable capacity.

## 4. Capacity alerts

Only the admin receives server-capacity warnings.

Default thresholds are:

- 80%
- 90%
- 95%

Usage percentage is calculated from:

```text
(committed_bytes + finalized_used_bytes) / max_allocated_bytes
```

Each threshold is emitted once per node crossing so the bot does not spam the admin on every quota report.

If capacity later falls below a threshold because unused committed quota is released, the alert state may be re-armed so a future upward crossing can alert again.

Unlimited nodes do not emit bandwidth-threshold alerts.

## 5. Reseller accounting

### 5.1 Two reporting scopes

Each reseller has two parallel views:

- **Current settlement window**: activity since that reseller's last recorded settlement.
- **All-time history**: activity since the reseller was created.

The settlement window is not tied to calendar months and is independent for every reseller.

### 5.2 Settlement action

Admin gets a `ثبت تسویه و شروع حساب جدید` action for each reseller.

This action:

- records a settlement boundary/time,
- snapshots or otherwise preserves the closed window for audit,
- starts a new current settlement window,
- does **not** revoke, modify, or reset any customer account,
- does **not** erase all-time history.

### 5.3 Required reseller metrics

For both current settlement and all-time scopes, report at least:

- number of configs created,
- total sold quota,
- actual traffic used by those customer configs,
- active/preparing count,
- blocked count,
- expired count,
- revoked count,
- exhausted count,
- breakdown by node.

The all-time view is immutable historical accounting. Settlement changes only where the current-window query begins.

### 5.4 Reseller controls

Admin may configure reseller-specific limits independently of node limits:

- enabled/disabled,
- optional maximum currently reserving account count,
- optional maximum currently committed sold bytes.

A new sale must satisfy seller limits **and** node limits.

Disabling a seller prevents new sales but does not silently revoke that seller's existing customer configs.

## 6. Data-model direction

The implementation should introduce a small accounting layer instead of spreading SQL fragments across menu handlers.

Recommended responsibilities:

### `node-capacity.ts`

Owns node capacity calculations and eligibility:

- committed account predicate,
- terminal/finalized usage calculation,
- remaining/sellable bytes,
- remaining account slots,
- utilization percent,
- requested-quota eligibility.

### `seller-accounting.ts`

Owns reseller statistics:

- current settlement boundary,
- current-window aggregates,
- all-time aggregates,
- per-node aggregates,
- seller-limit eligibility.

### `capacity-alerts.ts`

Owns threshold crossing and de-duplication:

- 80/90/95 evaluation,
- alert re-arming after meaningful capacity reduction,
- admin-only outbox notification creation.

### Database additions

Use additive migrations. Exact column/table names may be finalized in implementation, but the model needs persistent equivalents of:

- reseller current settlement start/boundary,
- settlement history records,
- optional seller account-count cap,
- optional seller committed-byte cap,
- per-node alert threshold state or an equivalent idempotency ledger.

No destructive migration should be required for existing accounts or nodes.

Existing historical account rows remain valid and must contribute to the new calculations from their current state, quota, and usage.

## 7. Bot information architecture

### 7.1 Admin home

Admin home should prioritize operational status and accounting.

Suggested structure:

```text
📊 وضعیت کلی مدار
سرورها: N فعال
کانفیگ‌های فعال: N
حجم رزروشده: X GB
مصرف قطعی: Y GB
فروشنده‌های فعال: N
```

Primary actions:

```text
➕ صدور کانفیگ    🎁 تست
🖥 سرورها         👥 فروشنده‌ها
📋 کانفیگ‌ها      📊 گزارش‌ها
⚙️ تنظیمات
```

`افزودن VPS` belongs under server management rather than occupying the top-level home menu.

### 7.2 Seller home

Seller home is intentionally simpler and must not expose global admin data.

Example:

```text
💼 پنل فروش
فعال: 8 کانفیگ
این تسویه: 14 کانفیگ · 280 GB
کل فروش: 91 کانفیگ · 1.7 TB
```

Primary actions:

```text
➕ ساخت کانفیگ
🎁 ساخت تست
📋 کانفیگ‌های من
📊 آمار من
```

### 7.3 Sale flow

Keep the existing short wizard but improve feedback:

1. customer label,
2. quota,
3. duration,
4. server selection with real current sellable capacity,
5. final confirmation.

Final confirmation shows:

- customer,
- requested quota,
- duration,
- node,
- current sellable bytes,
- projected sellable bytes after this sale.

The UI must never imply a sale is guaranteed until the final atomic creation succeeds.

### 7.4 Node detail

Admin node detail includes:

- health,
- limited/unlimited mode,
- total budget,
- committed bytes,
- finalized usage,
- sellable bytes,
- used percentage,
- occupied/max account slots,
- assigned/active configs,
- alert status,
- actions for config list and settings.

### 7.5 Reseller detail

Admin reseller detail includes:

- current settlement metrics,
- all-time metrics,
- actual customer usage,
- state counts,
- per-node breakdown,
- current configured seller limits,
- actions for configs, full report, settlement, limits, enable/disable.

## 8. UX and copy rules

The Telegram UI remains message + inline-keyboard based; it should feel dashboard-like without pretending Telegram messages are a full web dashboard.

Rules:

- one clear title per screen,
- short grouped metrics instead of long explanatory paragraphs,
- Persian labels with consistent emoji semantics,
- avoid mixing admin controls with seller workflow,
- use compact numbers and GB/TB formatting,
- important errors explain the next action,
- destructive actions require confirmation,
- capacity and accounting screens should always include a clear back/home path.

The visual direction approved during brainstorming is dark, clean, card-like, and operational, but the production Telegram implementation translates that visual hierarchy into concise messages and inline keyboards rather than adding a large new Mini App for ordinary sales management.

## 9. Error handling

The user-facing layer must distinguish at least:

- node unavailable,
- node account slots full,
- node bandwidth capacity insufficient,
- seller account limit reached,
- seller bandwidth limit reached,
- stale sale confirmation where capacity changed between selection and submit.

No raw SQL or internal exception text is exposed to sellers.

Capacity-alert failures must not break quota reporting or account state transitions; alert delivery is best-effort via the existing outbox pattern.

## 10. Testing strategy

### Unit/integration tests

Add deterministic tests covering:

1. active/preparing/blocked reserve full quota,
2. revoked/expired release unused quota but retain actual usage,
3. exhausted contributes final used amount without double-counting,
4. failed pre-activation requests do not permanently consume capacity,
5. account slots follow the non-terminal/terminal rules,
6. atomic final creation rejects stale over-capacity sales,
7. unlimited nodes ignore bandwidth eligibility,
8. seller limits combine correctly with node limits,
9. settlement boundary changes current-window stats without changing all-time stats,
10. threshold warnings fire once at 80/90/95 and can re-arm after capacity falls,
11. role-specific menus hide admin-only information from sellers,
12. sale confirmation displays correct before/after capacity.

### Regression coverage

Existing shared-443, node health, revoke, expiry, quota cutoff, delivery, and enrollment tests must remain green.

## 11. Migration and rollout

1. Add database migration(s) for settlement state/history, seller limits, and alert state.
2. Introduce accounting helpers behind tests.
3. Change node capacity calculations to the approved committed/finalized model.
4. Add seller statistics and limits.
5. Add alerts.
6. Refactor Telegram menus to the approved admin/seller information architecture.
7. Deploy Worker only after CI is green.
8. Validate live with a limited node by creating, consuming, revoking/expiring, and verifying the displayed sellable capacity changes correctly.

No node-agent protocol change is required solely for this feature because the Worker already receives per-account quota usage and terminal state information needed for the accounting model.

## 12. Non-goals

This change does not:

- reset customer quotas on reseller settlement,
- introduce a common billing period for all customers,
- tie accounting to calendar months,
- require every future VPS to have a finite bandwidth cap,
- replace Telegram sales flows with a full standalone web dashboard,
- alter the shared-443 transport architecture.

## 13. Acceptance criteria

The design is complete when all of the following are true:

- a limited node can never sell beyond its byte budget or slot cap,
- blocked accounts still reserve their sold quota,
- revoked/expired accounts return only their unused quota,
- actual consumed bytes remain charged to the limited node,
- unlimited nodes can be sold without byte-cap checks,
- admin receives de-duplicated 80/90/95 capacity warnings,
- admin can inspect per-reseller current-settlement and all-time statistics,
- admin can close a reseller settlement window without affecting customer service,
- optional reseller caps are enforced together with node caps,
- sellers see only their own operational/accounting view,
- node and sale screens show accurate remaining capacity instead of the full configured cap,
- the resulting Telegram UX is shorter, more structured, and easier to scan than the current menu set.
