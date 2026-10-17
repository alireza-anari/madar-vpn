# Madar Telegram Mini App Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a role-aware Telegram Mini App for Madar that matches the approved dark-card dashboard design while reusing the field-tested capacity, seller accounting, lifecycle, delivery, and VPS enrollment backend.

**Architecture:** Add a new `/app` frontend and `/api/app/*` API surface inside the existing `madar-sales-bot` Cloudflare Worker. Generalize Telegram Mini App authentication to resolve admin/seller roles server-side, expose role-safe read models and mutations, reuse the existing atomic `createAccount` path, and keep the legacy bot UI and `/enroll` route as rollback-safe fallbacks until field acceptance.

**Tech Stack:** TypeScript, Cloudflare Workers, D1, Wrangler, Vitest, Node browser-smoke tests, plain HTML/CSS/JavaScript, Telegram WebApp API, existing pnpm workspace.

**Spec:** `docs/superpowers/specs/2026-10-17-telegram-miniapp-dashboard-design.md`

## Global Constraints

- Baseline behavior is the green production source at `6cdb8b841bffe1e8470ee2a2e3d3ef9e2c41d1dd`; do not change shared-443 transport, quota semantics, seller settlement semantics, or node-agent protocol for this feature.
- End customers are not Mini App users; only `admin` and enabled `seller` roles may use the dashboard.
- Seller responses must never contain infrastructure-only fields such as target IP, SSH port, fingerprints, installer details, internal revision/debug values, or other sellers' statistics.
- Every sensitive authorization decision is enforced in the Worker; frontend hiding is never sufficient authorization.
- Final sale creation must continue to use the existing atomic node/seller capacity guard in `createAccount`; preview is informative only.
- Keep the frontend framework-free; do not add React/Vue/Svelte or a separate hosting service.
- Keep the legacy Telegram management flow and `/enroll` available during initial rollout.
- Dashboard/capacity responses are operational data and must be served with `Cache-Control: no-store`.
- Visual acceptance requires dark RTL cards, real progress bars, clear teal/amber/red status states, mobile spacing, and touch-sized controls; a text-heavy Telegram-like layout does not pass.
- No production rollout or destructive production mutation occurs without a separate explicit approval after CI is green.

## Review Focus

1. **Stale or replayed Telegram initData** — expired auth, duplicate query keys, malformed user JSON, or a forged hash must fail closed without exposing role/data; pinned in Task 1.
2. **Seller privilege escalation** — crafted admin requests and object IDs belonging to other sellers must not leak existence or admin fields; pinned in Tasks 2, 6, and 7.
3. **Capacity changes between preview and create** — a valid preview must still fail safely if another sale consumes the last bytes/slot before final submit; pinned in Task 4.
4. **Asynchronous account activation** — create may return `preparing`; the Mini App must poll a safe owned result endpoint until the existing lifecycle/delivery path has an active configuration; pinned in Tasks 4 and 9.
5. **WebView interruption/reopen** — closing/reopening after a successful request must not lose durable bot delivery or duplicate the account when the same request key is retried; pinned in Tasks 4 and 9.

---

### Task 1: Generalize Mini App authentication for admin and seller

**Files:**
- Modify: `apps/sales-bot/src/miniapp-auth.ts`
- Modify: `apps/sales-bot/src/admin-api.ts`
- Create: `apps/sales-bot/test/miniapp-app-auth.test.ts`

**Interfaces:**
- Produces: `verifyMiniAppTelegramId(initData: string, env: Env, now: number): string`
- Produces: `authenticateMiniApp(initData: string, env: Env, now: number): Promise<SalesActor>`
- Keeps compatibility: `verifyMiniApp(initData: string, env: Env, now: number): Promise<Actor>` remains admin-only for the existing `/api/admin/*` enrollment API.

- [ ] **Step 1: Write failing auth tests** for valid admin, valid enabled seller, disabled seller resolving as ordinary, duplicate query keys, malformed user JSON, forged hash, `auth_date > now + 30`, and `now - auth_date > 300`.
- [ ] **Step 2: Run** `pnpm --filter @madar/sales-bot exec vitest run test/miniapp-app-auth.test.ts`; expect FAIL because the generalized interfaces do not exist.
- [ ] **Step 3: Split signature verification from role resolution** in `miniapp-auth.ts`; reuse `resolveSalesActor(env.SALES_DB, telegramId, env)` and preserve constant-time hash comparison and the 300-second age limit.
- [ ] **Step 4: Keep `admin-api.ts` on the admin-only compatibility wrapper** so existing `/enroll` behavior does not broaden access.
- [ ] **Step 5: Re-run the focused test plus existing enrollment/auth tests**; expect PASS.
- [ ] **Step 6: Commit**: `git commit -m "feat: generalize Mini App authentication"`.

### Task 2: Build role-safe dashboard and list read models

**Files:**
- Create: `apps/sales-bot/src/app-dashboard.ts`
- Create: `apps/sales-bot/src/app-presenters.ts`
- Create: `apps/sales-bot/test/app-dashboard.test.ts`
- Reuse: `apps/sales-bot/src/node-capacity.ts`
- Reuse: `apps/sales-bot/src/seller-accounting.ts`

**Interfaces:**
- Produces: `loadAppDashboard(db: D1Database, actor: SalesActor, now: number): Promise<AppDashboard>`
- Produces: `listAppNodes(db: D1Database, actor: SalesActor, now: number, requestedBytes?: number): Promise<AppNode[]>`
- Produces: `listAppConfigs(db: D1Database, actor: SalesActor, now: number, cursor?: string): Promise<AppConfigPage>`
- Produces: `loadSellerSelfStats(db: D1Database, actor: SalesActor, now: number): Promise<AppSellerStats>`
- Seller `AppNode` contains only safe sale metadata: `id`, `displayName`, `healthy`, `sellableBytes`, `remainingSlots`, `utilizationPercent`, `eligible`, optional `ineligibleReason`, optional `recommended`.

- [ ] **Step 1: Write failing read-model tests** for admin global totals, seller-only totals, finite/unlimited bandwidth display, 80/90/95 alert projection, pagination, and explicit absence of target IP/SSH/fingerprint/revision/debug fields from seller DTOs.
- [ ] **Step 2: Add ownership tests** proving seller config lists and config details cannot return another seller's account.
- [ ] **Step 3: Run** `pnpm --filter @madar/sales-bot exec vitest run test/app-dashboard.test.ts`; expect FAIL.
- [ ] **Step 4: Implement focused query/presenter modules** using `nodeCapacities`, `remainingAllocation`, `utilizationPercent`, `sellerStats`, `sellerNodeStats`, and `sellerLimits`; do not duplicate accounting formulas.
- [ ] **Step 5: Re-run focused tests**; expect PASS.
- [ ] **Step 6: Commit**: `git commit -m "feat: add Mini App dashboard read models"`.

### Task 3: Add `/api/app` read API and `/app` asset routing

**Files:**
- Create: `apps/sales-bot/src/app-api.ts`
- Modify: `apps/sales-bot/src/index.ts`
- Modify: `apps/sales-bot/wrangler.jsonc`
- Create: `apps/sales-bot/public/app.html`
- Create: `apps/sales-bot/public/app.css`
- Create: `apps/sales-bot/public/app.js`
- Create: `apps/sales-bot/test/app-api.test.ts`

**Interfaces:**
- Produces routes: `GET /api/app/me`, `GET /api/app/dashboard`, `GET /api/app/nodes`, `GET /api/app/configs`, `GET /api/app/seller/stats`.
- Produces static routes: `GET /app`, `GET /app.css`, `GET /app.js`.
- Every `/api/app/*` request authenticates from `X-Telegram-Init-Data` via `authenticateMiniApp`.

- [ ] **Step 1: Write failing API tests** for admin/seller `/me`, dashboard shape, seller-safe node/config/stat responses, disabled/ordinary rejection, auth expiry, and `Cache-Control: no-store`.
- [ ] **Step 2: Run** `pnpm --filter @madar/sales-bot exec vitest run test/app-api.test.ts`; expect FAIL.
- [ ] **Step 3: Implement `appApi(request, env, now): Promise<Response>`** with stable JSON errors and no raw internal exceptions.
- [ ] **Step 4: Add Worker routes and Wrangler text-module rules** for `public/app.html`, `public/app.css`, and `public/app.js`; serve correct content types and `no-store` for `/app`.
- [ ] **Step 5: Re-run API tests and `pnpm --filter @madar/sales-bot typecheck`**; expect PASS.
- [ ] **Step 6: Commit**: `git commit -m "feat: add Mini App API and routes"`.

### Task 4: Add sale preview, test creation, atomic create, result polling, and shared delivery artifact

**Files:**
- Create: `apps/sales-bot/src/app-sales.ts`
- Modify: `apps/sales-bot/src/account-delivery.ts`
- Modify: `apps/sales-bot/src/app-api.ts`
- Create: `apps/sales-bot/test/app-sales.test.ts`
- Modify: `apps/sales-bot/test/account-delivery.test.ts`

**Interfaces:**
- Produces: `previewSale(db: D1Database, actor: SalesActor, input: AppSaleInput, now: number): Promise<AppSalePreview>`.
- Produces: `createAppSale(env: Env, actor: SalesActor, input: AppSaleInput & { requestKey: string }, now: number): Promise<{ accountId: string; state: string }>` and delegates final authority to existing `createAccount`.
- Produces: `createAppTrial(env: Env, actor: SalesActor, input: { nodeId: string; requestKey: string }, now: number)` with exact 1 GB / 1800-second preset.
- Produces: `buildAccountDeliveryArtifact(env: Env, accountId: string, now: number): Promise<AccountDeliveryArtifact | null>` returning the config/subscription metadata only when the account is truly ready.
- Keeps: `queueAccountDelivery(env, accountId, now)` using the same artifact builder.
- API routes: `POST /api/app/configs/preview`, `POST /api/app/configs/create`, `POST /api/app/configs/test`, `GET /api/app/configs/:id/result`.

- [ ] **Step 1: Write failing preview tests** for input validation, eligible/disabled nodes, remaining slots, before/after sellable bytes, and deterministic recommendation: healthy eligible node with greatest sellable capacity, tie-break by display name then id.
- [ ] **Step 2: Write trial tests** proving 1 GB / 30 minutes is fixed and final creation still passes through the atomic guard.
- [ ] **Step 3: Write the stale-preview test**: preview succeeds; another reservation consumes the last bytes/slot; final create must map to `INSUFFICIENT_NODE_CAPACITY` or `NODE_SLOT_LIMIT` rather than oversell.
- [ ] **Step 4: Write idempotency tests** proving repeated `requestKey` returns the same account and does not charge capacity twice.
- [ ] **Step 5: Write result tests** for `preparing -> pending`, active/deliverable -> exact shared config artifact, and foreign seller account -> safe not-found/forbidden.
- [ ] **Step 6: Run** `pnpm --filter @madar/sales-bot exec vitest run test/app-sales.test.ts test/account-delivery.test.ts`; expect FAIL.
- [ ] **Step 7: Implement preview and API error mapping**: `SELLER_ACCOUNT_LIMIT` -> `SELLER_CONFIG_LIMIT`, `SELLER_ALLOCATION_FULL` -> `SELLER_VOLUME_LIMIT`, `NODE_ALLOCATION_FULL` -> `INSUFFICIENT_NODE_CAPACITY`, `NODE_FULL` -> `NODE_SLOT_LIMIT`; do not alter `createAccount` capacity semantics.
- [ ] **Step 8: Refactor delivery formatting into the shared artifact builder** and keep durable outbox insertion semantics unchanged.
- [ ] **Step 9: Re-run focused tests**; expect PASS.
- [ ] **Step 10: Commit**: `git commit -m "feat: add Mini App sale and result API"`.

### Task 5: Add explicit unlimited account-slot mode without weakening existing nodes

The approved spec includes finite/unlimited account-count mode, but the current schema has `nodes.max_accounts INTEGER NOT NULL CHECK(max_accounts BETWEEN 1 AND 10000)`. Implement this additively rather than rewriting that column.

**Files:**
- Create: `apps/sales-bot/migrations/0011-node-account-slot-mode.sql`
- Modify: `apps/sales-bot/src/node-capacity.ts`
- Modify: `apps/sales-bot/src/accounts.ts`
- Modify: `apps/sales-bot/src/node-settings.ts`
- Create: `apps/sales-bot/test/node-slot-mode.test.ts`
- Modify: `apps/sales-bot/test/capacity-accounting-migration.test.ts`

**Interfaces:**
- Migration adds `nodes.max_accounts_unlimited INTEGER NOT NULL DEFAULT 0 CHECK(max_accounts_unlimited IN (0,1))`.
- Produces: `setNodeUnlimitedAccounts(db: D1Database, actor: SalesActor, nodeId: string, unlimited: boolean, now: number): Promise<void>`.
- `NodeCapacity` gains `max_accounts_unlimited: number`.
- `remainingSlots(n)` returns `null` for unlimited slot mode, otherwise `max(0, max_accounts - reserved_accounts)`.

- [ ] **Step 1: Write migration test** proving existing nodes default to finite mode with their current `max_accounts` untouched.
- [ ] **Step 2: Write failing capacity/create tests** proving finite mode still enforces `max_accounts`, unlimited mode bypasses only the slot check, and bandwidth/seller limits remain enforced.
- [ ] **Step 3: Run** `pnpm --filter @madar/sales-bot exec vitest run test/capacity-accounting-migration.test.ts test/node-slot-mode.test.ts`; expect FAIL.
- [ ] **Step 4: Add the migration and update `nodeCapacities`/presenters** to expose null remaining slots for unlimited mode.
- [ ] **Step 5: Update the atomic `createAccount` SQL** so only the node-slot predicate becomes `(n.max_accounts_unlimited=1 OR nu.slots<n.max_accounts)`; do not change byte or seller predicates.
- [ ] **Step 6: Update `setNodeMaxAccounts`** to set `max_accounts_unlimited=0` when a finite cap is saved, and add `setNodeUnlimitedAccounts` with audit logging.
- [ ] **Step 7: Re-run focused tests**; expect PASS.
- [ ] **Step 8: Commit**: `git commit -m "feat: add unlimited node slot mode"`.

### Task 6: Add admin node/seller/report APIs behind shared domain functions

**Files:**
- Modify: `apps/sales-bot/src/app-api.ts`
- Reuse/modify: `apps/sales-bot/src/node-settings.ts`
- Reuse: `apps/sales-bot/src/seller-accounting.ts`
- Reuse: `apps/sales-bot/src/resellers.ts`
- Create: `apps/sales-bot/test/app-admin-api.test.ts`

**Interfaces:**
- Admin node routes call `setNodeMaxAccounts`, `setNodeUnlimitedAccounts`, and `setNodeMaxAllocatedBytes`; `maxAllocatedBytes=null` means unlimited bandwidth.
- Admin seller routes call `setReseller`, `setSellerLimits`, and `settleSeller`.
- Produces admin read endpoints for node detail, seller current/all-time stats, per-node breakdown, settlement history, and reports required by the spec.

- [ ] **Step 1: Write failing authorization tests** showing an enabled seller gets stable `ADMIN_REQUIRED` for every admin route without target-existence leakage.
- [ ] **Step 2: Write failing node mutation tests** for finite/unlimited volume and finite/unlimited slot mode.
- [ ] **Step 3: Write failing seller tests** for enable/disable, seller config/volume limits, current/all-time detail, per-node breakdown, settlement history, and settlement preserving active states.
- [ ] **Step 4: Run** `pnpm --filter @madar/sales-bot exec vitest run test/app-admin-api.test.ts`; expect FAIL.
- [ ] **Step 5: Implement routes by delegating to domain helpers**; if legacy Telegram code still owns a needed direct SQL mutation, extract one shared helper rather than duplicate it.
- [ ] **Step 6: Re-run focused tests**; expect PASS.
- [ ] **Step 7: Commit**: `git commit -m "feat: add Mini App admin controls"`.

### Task 7: Integrate VPS enrollment under the Mini App admin namespace

**Files:**
- Modify: `apps/sales-bot/src/app-api.ts`
- Reuse: `apps/sales-bot/src/enrollment.ts`
- Keep: `apps/sales-bot/src/admin-api.ts`
- Create: `apps/sales-bot/test/app-enrollment-api.test.ts`

**Interfaces:**
- Admin routes mirror existing enrollment primitives under `/api/app/admin/enrollment/session`, `/probe`, `/enroll`, and `/jobs/:id`.
- Existing `/api/admin/*` routes remain functional for the standalone `/enroll` fallback.

- [ ] **Step 1: Write failing tests** proving only admin can issue session/probe/enroll/job requests and seller denial happens before any credential/job write.
- [ ] **Step 2: Add compatibility tests** proving old `/api/admin/session|probe|enroll|jobs/*` behavior remains unchanged.
- [ ] **Step 3: Run** `pnpm --filter @madar/sales-bot exec vitest run test/app-enrollment-api.test.ts test/enrollment.test.ts`; expect FAIL only for the new routes.
- [ ] **Step 4: Implement thin adapters** over `issueNonce`, `createProbe`, `createEnrollment`, and `enrollmentJobStatus`; preserve encrypted credential handling and validation codes.
- [ ] **Step 5: Re-run focused tests**; expect PASS.
- [ ] **Step 6: Commit**: `git commit -m "feat: integrate enrollment API into Mini App"`.

### Task 8: Build the visual shell, role dashboards, cards, navigation, and responsive states

**Files:**
- Modify: `apps/sales-bot/public/app.html`
- Modify: `apps/sales-bot/public/app.css`
- Modify: `apps/sales-bot/public/app.js`
- Create: `apps/sales-bot/test/app-browser.node.mjs`
- Modify: `apps/sales-bot/package.json`

**Interfaces:**
- Browser API helper sends `X-Telegram-Init-Data` on every request and maps stable backend error codes to Persian copy.
- Views: admin home/servers/sellers/configs/reports; seller home/configs/stats; loading/empty/error/auth-expired/disabled states.

- [ ] **Step 1: Write browser-smoke assertions** that `/app` contains Telegram WebApp integration, RTL metadata, app-shell anchors, and loads `/app.css` + `/app.js`; CSS contains card/progress/status primitives and a mobile breakpoint.
- [ ] **Step 2: Add DOM tests with stubbed payloads** for role-specific navigation, admin/seller summary cards, real progress width/ARIA values, and amber/red warning/critical state classes.
- [ ] **Step 3: Run** `node --test apps/sales-bot/test/app-browser.node.mjs`; expect FAIL.
- [ ] **Step 4: Implement the dark Madar visual system** with RTL cards, safe-area padding, touch targets, bottom navigation, loading/empty/error states, and LTR wrappers for technical strings.
- [ ] **Step 5: Implement refresh** on initial load, explicit refresh, after mutations, and WebView visibility/foreground return where supported.
- [ ] **Step 6: Update the sales-bot `test` script** to include `test/app-browser.node.mjs` after Vitest.
- [ ] **Step 7: Re-run browser test and package test**; expect PASS.
- [ ] **Step 8: Commit**: `git commit -m "feat: build Mini App dashboard UI"`.

### Task 9: Build sale/test wizard, async result, QR, copy/share, and recovery

**Files:**
- Modify: `apps/sales-bot/public/app.js`
- Modify: `apps/sales-bot/public/app.css`
- Modify: `apps/sales-bot/test/app-browser.node.mjs`
- Modify: `apps/sales-bot/package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `apps/sales-bot/src/app-sales.ts`

**Interfaces:**
- Wizard steps: label -> quota -> duration -> server -> confirmation -> result.
- Trial preset: exactly 1 GB / 30 minutes.
- QR is generated locally/server-side from the authorized config using the `qrcode` package; no third-party QR HTTP service receives the VPN config.

- [ ] **Step 1: Extend browser tests** for wizard progression, custom quota/duration, trial preset, disabled insufficient node, `پیشنهادی` badge, before/after confirmation, stale-preview refresh, and double-submit prevention.
- [ ] **Step 2: Add async-result tests**: create returns `preparing`; UI polls the owned result endpoint; active result renders config; reopening with stored account/request identifiers must not create a duplicate.
- [ ] **Step 3: Add result-control tests** for QR presence, copy, Web Share fallback, and pending durable-delivery status.
- [ ] **Step 4: Run focused browser/API tests**; expect FAIL.
- [ ] **Step 5: Add QR dependency** with `pnpm --filter @madar/sales-bot add qrcode`; the lockfile pins the resolved version. If the package does not ship TypeScript declarations, add `@types/qrcode` in the same commit before typecheck.
- [ ] **Step 6: Implement wizard/result UI**; persist only non-secret recovery identifiers in session/local storage, never raw configuration as durable browser storage.
- [ ] **Step 7: Re-run focused tests and typecheck**; expect PASS.
- [ ] **Step 8: Commit**: `git commit -m "feat: add Mini App sale wizard and result"`.

### Task 10: Build admin server, seller, report, and integrated enrollment pages

**Files:**
- Modify: `apps/sales-bot/public/app.js`
- Modify: `apps/sales-bot/public/app.css`
- Modify: `apps/sales-bot/test/app-browser.node.mjs`

**Interfaces:**
- Server page: cards -> detail -> finite/unlimited volume -> finite/unlimited slots -> related configs -> add VPS wizard.
- Seller page: cards -> detail -> limits -> enable/disable -> settlement confirmation/history.
- Enrollment wizard: identity/caps -> target/SSH -> probe -> fingerprint -> credentials -> install progress -> result.

- [ ] **Step 1: Add browser tests** for server cards/details, admin-only technical fields, cap/unlimited confirmations, seller cards/current/all-time/history, settlement confirmation, and seller-limit controls.
- [ ] **Step 2: Add enrollment UI tests** for all seven wizard states, fingerprint confirmation gate, key/password mode switching, progress polling, ready result, and safe failure copy.
- [ ] **Step 3: Run** `node --test apps/sales-bot/test/app-browser.node.mjs`; expect FAIL.
- [ ] **Step 4: Implement admin pages** using only `/api/app/admin/*`; browser code never calls D1 or legacy callback routes directly.
- [ ] **Step 5: Integrate enrollment UI** while leaving `/enroll` untouched as fallback for this rollout.
- [ ] **Step 6: Re-run browser/API tests**; expect PASS.
- [ ] **Step 7: Commit**: `git commit -m "feat: add Mini App admin management pages"`.

### Task 11: Add the bot entry point, preserve fallback, and complete regression verification

**Files:**
- Modify: `apps/sales-bot/src/reseller-menus.ts`
- Modify as needed: `apps/sales-bot/src/reseller-menus-dashboard.ts`
- Modify: `apps/sales-bot/test/dashboard-design-regressions.test.ts`
- Modify: `apps/sales-bot/test/flows.test.ts`

**Interfaces:**
- Admin and enabled seller home replies expose one prominent `web_app` button labeled `باز کردن پنل مدار` pointing to `${PUBLIC_BASE_URL}/app`.
- Legacy inline-keyboard management actions remain available during the initial rollout.

- [ ] **Step 1: Write failing bot-menu tests** asserting both roles receive the `/app` Web App entry, ordinary users do not, and fallback actions remain reachable.
- [ ] **Step 2: Run** `pnpm --filter @madar/sales-bot exec vitest run test/dashboard-design-regressions.test.ts test/flows.test.ts`; expect FAIL.
- [ ] **Step 3: Implement the entry button** without restoring standalone `/enroll` as a top-level primary action; enrollment belongs inside Mini App server management.
- [ ] **Step 4: Run full sales-bot suite**: `pnpm --filter @madar/sales-bot test`; expect all Vitest and browser-smoke tests PASS.
- [ ] **Step 5: Run repository verification**: `pnpm typecheck && pnpm test && pnpm build`; expect all workspaces PASS and Worker dry-run build succeeds.
- [ ] **Step 6: Inspect diff against baseline** and verify no unplanned shared-443, quota-policy, or node-agent changes.
- [ ] **Step 7: Commit**: `git commit -m "feat: expose Madar Mini App from bot"`.

### Task 12: CI, review, and production rollout gate

**Files:**
- No product file required unless CI exposes a defect; fixes must return to the owning task's failing test first.

**Interfaces:**
- Produces one exact green commit SHA eligible for production rollout.

- [ ] **Step 1: Push the branch and wait for complete GitHub Actions**; local-only success is not release evidence.
- [ ] **Step 2: Review CI jobs/logs and fix failures test-first.**
- [ ] **Step 3: Perform whole-branch review** focused on seller data leakage, auth failure behavior, stale preview atomicity, unlimited slot semantics, async result recovery, and visual acceptance hooks.
- [ ] **Step 4: Re-run verification on the final reviewed SHA** and record exact SHA + CI run id.
- [ ] **Step 5: Stop and request explicit production rollout approval.** Do not deploy merely because CI is green.
- [ ] **Step 6: After approval, apply migration `0011` once, then deploy the Worker additively with existing bindings/secrets preserved; do not remove legacy bot flow or `/enroll` in the same rollout.
- [ ] **Step 7: Field acceptance on real Telegram mobile** in order: admin dashboard read-only -> server cards/capacity -> seller dashboard -> controlled sale preview/create/result/durable bot delivery -> seller limits/settlement controlled checks -> integrated enrollment UI without unnecessary infrastructure mutation.
- [ ] **Step 8: Only after explicit visual/functional acceptance, make Mini App the primary management path; legacy cleanup is a later separately approved change.**
