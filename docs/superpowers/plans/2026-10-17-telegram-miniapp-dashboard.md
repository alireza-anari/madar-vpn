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

1. **Stale or replayed Telegram initData** — expired auth, duplicate query keys, malformed user JSON, or a forged hash must fail closed without exposing role/data; pinned in Task 1 auth tests.
2. **Seller privilege escalation** — crafted requests to every admin route and object IDs belonging to other sellers must return a stable authorization/not-found response and never leak admin fields; pinned in Tasks 2, 5, and 6.
3. **Capacity changes between preview and create** — a preview that was valid must still fail safely if another sale consumes the last bytes/slot before final submit; pinned in Task 4.
4. **Asynchronous account activation** — create may return `preparing`; the Mini App must poll a safe result endpoint until the existing lifecycle/delivery path has an active configuration, without inventing browser-only delivery; pinned in Tasks 4 and 8.
5. **WebView interruption/reopen** — closing/reopening the Mini App after a successful request must not lose the durable bot delivery or create a duplicate account when the same request key is retried; pinned in Tasks 4 and 8.

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

- [ ] **Step 1: Write failing auth tests** for valid admin, valid enabled seller, disabled seller resolving as ordinary/not authorized for app use, duplicate query keys, malformed user JSON, forged hash, `auth_date > now + 30`, and `now - auth_date > 300`.
- [ ] **Step 2: Run the focused test**: `pnpm --filter @madar/sales-bot exec vitest run test/miniapp-app-auth.test.ts`; expect FAIL because the generalized interfaces do not exist.
- [ ] **Step 3: Split signature verification from role resolution** in `miniapp-auth.ts`; reuse `resolveSalesActor(env.SALES_DB, telegramId, env)` and preserve the existing constant-time hash comparison and 300-second age limit.
- [ ] **Step 4: Keep `admin-api.ts` on the admin-only compatibility wrapper** so existing `/enroll` behavior does not broaden access.
- [ ] **Step 5: Re-run the focused test and existing enrollment auth tests**; expect PASS.
- [ ] **Step 6: Commit** with `git commit -m "feat: generalize Mini App authentication"`.

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
- `AppNode` seller shape includes only `id`, `displayName`, `healthy`, `sellableBytes`, `remainingSlots`, `utilizationPercent`, `eligible`, and optional `ineligibleReason`/`recommended`.
- Admin node shape may additionally include capacity mode, totals, health/revision data, and alert level.

- [ ] **Step 1: Write failing read-model tests** asserting admin global totals, seller-only totals, Persian-display-ready numeric values, finite/unlimited node handling, 80/90/95 alert state projection, pagination, and explicit absence of `target_ip`, SSH/fingerprint/revision/debug fields from seller DTOs.
- [ ] **Step 2: Add ownership tests** proving a seller config page cannot return another seller's managed accounts even when a foreign cursor/id is supplied.
- [ ] **Step 3: Run** `pnpm --filter @madar/sales-bot exec vitest run test/app-dashboard.test.ts`; expect FAIL.
- [ ] **Step 4: Implement focused query/presenter modules** using `nodeCapacities`, `remainingAllocation`, `utilizationPercent`, `sellerStats`, `sellerNodeStats`, and `sellerLimits`; do not duplicate capacity formulas.
- [ ] **Step 5: Re-run the focused tests**; expect PASS.
- [ ] **Step 6: Commit** with `git commit -m "feat: add Mini App dashboard read models"`.

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
- Produces routes: `GET /api/app/me`, `GET /api/app/dashboard`, `GET /api/app/nodes`, `GET /api/app/configs`.
- Produces static routes: `GET /app`, `GET /app.css`, `GET /app.js`.
- Every `/api/app/*` request authenticates from `X-Telegram-Init-Data` via `authenticateMiniApp`.

- [ ] **Step 1: Write failing API tests** for admin/seller `/me`, dashboard role shape, seller-safe node/config responses, ordinary/disabled user rejection, auth expiry, and `Cache-Control: no-store` on API responses.
- [ ] **Step 2: Run** `pnpm --filter @madar/sales-bot exec vitest run test/app-api.test.ts`; expect FAIL.
- [ ] **Step 3: Implement `appApi(request, env, now): Promise<Response>`** with stable JSON errors and no raw internal exceptions.
- [ ] **Step 4: Add Worker routes and Wrangler text-module rules** for `public/app.html`, `public/app.css`, and `public/app.js`; serve correct content types and `no-store` for `/app` HTML.
- [ ] **Step 5: Re-run API tests and `pnpm --filter @madar/sales-bot typecheck`**; expect PASS.
- [ ] **Step 6: Commit** with `git commit -m "feat: add Mini App API and routes"`.

### Task 4: Add sale preview, atomic create, result polling, and shared delivery artifact

**Files:**
- Create: `apps/sales-bot/src/app-sales.ts`
- Modify: `apps/sales-bot/src/account-delivery.ts`
- Modify: `apps/sales-bot/src/app-api.ts`
- Create: `apps/sales-bot/test/app-sales.test.ts`
- Modify as needed: `apps/sales-bot/test/account-delivery.test.ts`

**Interfaces:**
- Produces: `previewSale(db: D1Database, actor: SalesActor, input: AppSaleInput, now: number): Promise<AppSalePreview>`.
- Produces: `createAppSale(env: Env, actor: SalesActor, input: AppSaleInput & { requestKey: string }, now: number): Promise<{ accountId: string; state: string }>` and delegates final authority to existing `createAccount`.
- Produces: `buildAccountDeliveryArtifact(env: Env, accountId: string, now: number): Promise<AccountDeliveryArtifact | null>` returning config/subscription text and metadata only when the account is truly ready.
- Keeps: `queueAccountDelivery(env, accountId, now)` using the same artifact builder, so bot and Mini App cannot disagree about the configuration.
- API routes: `POST /api/app/configs/preview`, `POST /api/app/configs/create`, `GET /api/app/configs/:id/result`.

- [ ] **Step 1: Write failing preview tests** for requested bytes/duration validation, eligible/disabled nodes, remaining slot calculation, before/after sellable bytes, and deterministic recommended-node selection (prefer healthy eligible node with the most sellable capacity, tie-break by display name/id).
- [ ] **Step 2: Write the stale-preview concurrency test**: preview succeeds; insert/activate another reservation; final create with the same requested quota must return the mapped `INSUFFICIENT_NODE_CAPACITY` or `NODE_SLOT_LIMIT` rather than oversell.
- [ ] **Step 3: Write idempotency tests** proving repeated `requestKey` returns the same account and does not consume capacity twice.
- [ ] **Step 4: Write result tests** for `preparing -> not ready`, active/deliverable -> returns the exact same config artifact used by bot delivery, and foreign seller account -> not found/forbidden without data leakage.
- [ ] **Step 5: Run** `pnpm --filter @madar/sales-bot exec vitest run test/app-sales.test.ts test/account-delivery.test.ts`; expect FAIL.
- [ ] **Step 6: Implement preview and API error mapping** (`SELLER_ACCOUNT_LIMIT` -> `SELLER_CONFIG_LIMIT`, `SELLER_ALLOCATION_FULL` -> `SELLER_VOLUME_LIMIT`, `NODE_ALLOCATION_FULL` -> `INSUFFICIENT_NODE_CAPACITY`, `NODE_FULL` -> `NODE_SLOT_LIMIT`) without changing `createAccount` atomic SQL semantics.
- [ ] **Step 7: Refactor delivery formatting into the shared artifact builder** and keep durable outbox insertion unchanged.
- [ ] **Step 8: Re-run focused tests**; expect PASS.
- [ ] **Step 9: Commit** with `git commit -m "feat: add Mini App sale and result API"`.

### Task 5: Add admin node/seller/report mutations behind shared domain functions

**Files:**
- Modify: `apps/sales-bot/src/app-api.ts`
- Reuse: `apps/sales-bot/src/node-settings.ts`
- Reuse: `apps/sales-bot/src/seller-accounting.ts`
- Reuse: `apps/sales-bot/src/resellers.ts`
- Create: `apps/sales-bot/test/app-admin-api.test.ts`

**Interfaces:**
- Admin node routes call `setNodeMaxAccounts` and `setNodeMaxAllocatedBytes`; `null` means unlimited bandwidth where already supported.
- Admin seller routes call `setReseller`, `setSellerLimits`, and `settleSeller`.
- Produces read endpoints for seller detail/current/all-time stats, node breakdown, settlement history, and reports required by the spec.

- [ ] **Step 1: Write failing authorization tests** showing an enabled seller receives 403/stable `ADMIN_REQUIRED` for every admin mutation and cannot infer whether a target node/seller exists.
- [ ] **Step 2: Write failing mutation tests** for node volume cap/unlimited, node account cap, seller enable/disable, seller config/volume limits, and settlement preserving active managed-account states.
- [ ] **Step 3: Write report/detail tests** for current-vs-all-time seller metrics and per-node breakdown.
- [ ] **Step 4: Run** `pnpm --filter @madar/sales-bot exec vitest run test/app-admin-api.test.ts`; expect FAIL.
- [ ] **Step 5: Implement routes by delegating to existing domain helpers**, adding a small shared helper only where legacy Telegram code still contains direct SQL that the Mini App also needs; do not create a second accounting implementation.
- [ ] **Step 6: Re-run focused tests**; expect PASS.
- [ ] **Step 7: Commit** with `git commit -m "feat: add Mini App admin controls"`.

### Task 6: Integrate VPS enrollment under the Mini App admin namespace

**Files:**
- Modify: `apps/sales-bot/src/app-api.ts`
- Reuse: `apps/sales-bot/src/enrollment.ts`
- Keep: `apps/sales-bot/src/admin-api.ts`
- Create: `apps/sales-bot/test/app-enrollment-api.test.ts`

**Interfaces:**
- Admin routes mirror existing enrollment primitives under `/api/app/admin/enrollment/session`, `/probe`, `/enroll`, and `/jobs/:id`.
- Existing `/api/admin/*` routes remain functional for `/enroll` fallback.

- [ ] **Step 1: Write failing tests** proving only admin can issue enrollment sessions, probe, submit enrollment, and read jobs; seller requests fail before any job/credential write.
- [ ] **Step 2: Add compatibility tests** proving the old `/api/admin/session|probe|enroll|jobs/*` contract still works unchanged.
- [ ] **Step 3: Run** `pnpm --filter @madar/sales-bot exec vitest run test/app-enrollment-api.test.ts test/enrollment.test.ts`; expect FAIL for new routes only.
- [ ] **Step 4: Implement thin app-namespace adapters** over `issueNonce`, `createProbe`, `createEnrollment`, and `enrollmentJobStatus`; preserve encrypted credential handling and existing validation codes.
- [ ] **Step 5: Re-run focused tests**; expect PASS.
- [ ] **Step 6: Commit** with `git commit -m "feat: integrate enrollment API into Mini App"`.

### Task 7: Build the visual shell, role dashboards, cards, navigation, and responsive states

**Files:**
- Modify: `apps/sales-bot/public/app.html`
- Modify: `apps/sales-bot/public/app.css`
- Modify: `apps/sales-bot/public/app.js`
- Create: `apps/sales-bot/test/app-browser.node.mjs`
- Modify: `apps/sales-bot/package.json`

**Interfaces:**
- Browser API helper sends `X-Telegram-Init-Data` on every request and maps stable backend error codes to Persian copy.
- Views: admin home/servers/sellers/configs/reports; seller home/configs/stats; common loading/empty/error/auth-expired states.

- [ ] **Step 1: Write browser-smoke assertions** that `/app` contains Telegram WebApp integration, RTL metadata, app shell anchors, and loads `/app.css` and `/app.js`; CSS must contain card/progress/status primitives and a mobile breakpoint.
- [ ] **Step 2: Add JS DOM tests** with stubbed API payloads asserting role-specific navigation, admin summary cards, seller summary cards, real width/ARIA values for progress bars, and amber/red state classes at warning/critical values.
- [ ] **Step 3: Run** `node --test apps/sales-bot/test/app-browser.node.mjs`; expect FAIL.
- [ ] **Step 4: Implement the dark Madar visual system** with RTL-first cards, safe-area padding, touch targets, bottom navigation, skeleton/loading/empty/error states, and LTR wrappers for technical strings.
- [ ] **Step 5: Implement data refresh** on first load, explicit refresh, post-mutation, and WebView foreground/visibility return where supported.
- [ ] **Step 6: Update the sales-bot `test` script** to include `test/app-browser.node.mjs` after Vitest.
- [ ] **Step 7: Re-run browser test and package test**; expect PASS.
- [ ] **Step 8: Commit** with `git commit -m "feat: build Mini App dashboard UI"`.

### Task 8: Build sale/test wizard, confirmation, async result, QR, copy/share, and durable recovery

**Files:**
- Modify: `apps/sales-bot/public/app.js`
- Modify: `apps/sales-bot/public/app.css`
- Modify: `apps/sales-bot/test/app-browser.node.mjs`
- Modify: `apps/sales-bot/package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `apps/sales-bot/src/app-sales.ts`

**Interfaces:**
- Wizard steps: label -> quota -> duration -> server -> confirmation -> result.
- Trial preset remains exactly 1 GB / 30 minutes.
- Add a small server-side QR utility dependency (`qrcode`, lockfile-pinned by pnpm) and return an SVG/data value from the safe result endpoint; never send config text to a third-party QR service.

- [ ] **Step 1: Extend browser tests** for wizard progression, custom values, trial preset, disabled insufficient-capacity node, `پیشنهادی` badge, before/after confirmation, stale-preview refresh, and double-submit prevention.
- [ ] **Step 2: Add async-result tests**: create returns `preparing`, UI polls the owned result endpoint, then renders active result; reopening with the stored account/request id must not issue a duplicate create.
- [ ] **Step 3: Add result-control tests** for QR presence, copy button, Web Share fallback, and a clear pending-delivery state while durable bot delivery is being queued/retried.
- [ ] **Step 4: Run focused browser/API tests**; expect FAIL.
- [ ] **Step 5: Add the QR dependency** with `pnpm --filter @madar/sales-bot add qrcode` and server-side SVG generation from the already-authorized result artifact.
- [ ] **Step 6: Implement wizard/result UI**; persist only non-secret recovery identifiers in session/local storage, never raw configuration as durable browser storage.
- [ ] **Step 7: Re-run focused tests**; expect PASS.
- [ ] **Step 8: Commit** with `git commit -m "feat: add Mini App sale wizard and result"`.

### Task 9: Build admin server, seller, report, and integrated enrollment pages

**Files:**
- Modify: `apps/sales-bot/public/app.js`
- Modify: `apps/sales-bot/public/app.css`
- Modify: `apps/sales-bot/test/app-browser.node.mjs`

**Interfaces:**
- Server page: cards -> detail -> cap changes/unlimited -> related configs -> add VPS wizard.
- Seller page: cards -> detail -> limits -> enable/disable -> settlement confirmation/history.
- Enrollment wizard: identity/caps -> target/SSH -> probe -> fingerprint -> credentials -> install progress -> result.

- [ ] **Step 1: Add browser tests** for server cards/details, admin-only technical fields, cap/unlimited confirmation dialogs, seller cards/current/all-time/history, settlement confirmation, and seller-limit controls.
- [ ] **Step 2: Add enrollment UI tests** for all seven wizard states, fingerprint confirmation gate, key/password mode switching, progress polling, ready result, and safe failure copy.
- [ ] **Step 3: Run** `node --test apps/sales-bot/test/app-browser.node.mjs`; expect FAIL.
- [ ] **Step 4: Implement admin pages** using only `/api/app/admin/*`; never call D1 or legacy callback routes from browser code.
- [ ] **Step 5: Integrate enrollment UI** while leaving `/enroll` untouched as fallback for this rollout.
- [ ] **Step 6: Re-run browser/API tests**; expect PASS.
- [ ] **Step 7: Commit** with `git commit -m "feat: add Mini App admin management pages"`.

### Task 10: Add the bot entry point, preserve fallback, and complete regression verification

**Files:**
- Modify: `apps/sales-bot/src/reseller-menus.ts`
- Modify as needed: `apps/sales-bot/src/reseller-menus-dashboard.ts`
- Modify: `apps/sales-bot/test/dashboard-design-regressions.test.ts`
- Modify: `apps/sales-bot/test/flows.test.ts`

**Interfaces:**
- Admin and enabled seller home replies expose one prominent `web_app` button labeled `باز کردن پنل مدار` pointing to `${PUBLIC_BASE_URL}/app`.
- Legacy inline-keyboard management actions remain available during initial rollout and are not deleted in this task.

- [ ] **Step 1: Write failing bot-menu tests** asserting both roles receive the `/app` Web App entry and ordinary users do not; existing fallback actions remain reachable.
- [ ] **Step 2: Run** `pnpm --filter @madar/sales-bot exec vitest run test/dashboard-design-regressions.test.ts test/flows.test.ts`; expect FAIL.
- [ ] **Step 3: Implement the entry button** without restoring the old standalone `/enroll` button as a top-level primary action; enrollment belongs inside Mini App server management.
- [ ] **Step 4: Run the full sales-bot suite**: `pnpm --filter @madar/sales-bot test`; expect all Vitest and browser-smoke tests PASS.
- [ ] **Step 5: Run repository verification**: `pnpm typecheck && pnpm test && pnpm build`; expect all workspaces PASS and Worker dry-run build succeeds.
- [ ] **Step 6: Inspect the branch diff against baseline** and verify no migration, node-agent, shared-443, quota-policy, or transport change slipped in without a task/spec requirement.
- [ ] **Step 7: Commit** with `git commit -m "feat: expose Madar Mini App from bot"`.

### Task 11: CI, review, and production rollout gate

**Files:**
- No product file required unless CI exposes a defect; fixes must return to the owning task's tests first.

**Interfaces:**
- Produces a single exact green commit SHA eligible for production rollout.

- [ ] **Step 1: Push the implementation branch and wait for the complete GitHub Actions run**; do not treat local-only success as release evidence.
- [ ] **Step 2: Review CI jobs/logs and fix any issue with a failing regression test before changing implementation.**
- [ ] **Step 3: Perform whole-branch review** focused on seller data leakage, auth failure behavior, stale preview atomicity, async result recovery, and visual acceptance hooks.
- [ ] **Step 4: Re-run verification on the final reviewed SHA** and record exact SHA + CI run id.
- [ ] **Step 5: Stop and request explicit production rollout approval.** Do not deploy merely because CI is green.
- [ ] **Step 6: After approval, deploy Worker additively with bindings/secrets preserved; do not remove legacy bot flow or `/enroll` in the same rollout.**
- [ ] **Step 7: Field acceptance on real Telegram mobile** in this order: admin dashboard read-only -> server cards/capacity -> seller dashboard -> controlled sale preview/create/result/durable bot delivery -> seller limits/settlement controlled checks -> integrated enrollment UI without unnecessary infrastructure mutation.
- [ ] **Step 8: Only after explicit visual/functional acceptance, make Mini App the primary management path; legacy cleanup is a later separately approved change.**
