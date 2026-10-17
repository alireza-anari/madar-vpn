# Madar Telegram Mini App Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the production hardening pass for the Madar Telegram Mini App: Persian UI, Telegram seller identity, safe config lifecycle management, deterministic usage links, working QR/rich share, truthful server health reasons, and regression-safe rollout.

**Architecture:** Keep the existing Cloudflare Worker + D1 + Telegram WebApp architecture and extend it additively. Add small focused backend helpers for Telegram profiles and signed usage links, expose lifecycle/detail APIs through the existing app API, and update the current static Mini App client without replacing the quota/accounting model.

**Tech Stack:** TypeScript, Hono/Cloudflare Workers, D1 SQLite migrations, Vitest, Node test runner, Telegram WebApp, qrcode 1.5.4.

**Spec:** `docs/superpowers/specs/2026-10-17-miniapp-hardening-design.md`

## Global Constraints

- Preserve current quota/accounting, settlement, delivery, node enrollment and shared-443 semantics.
- All D1 changes are additive and backward-compatible with the currently deployed Worker.
- User-facing delete is revoke + archive; never physically delete managed-account history.
- Never fake node health by modifying D1 timestamps/state.
- Persist Telegram profile fields only from verified Telegram init data or trusted bot updates.
- Existing legacy `/usage/<token>` links remain valid.
- New lifecycle mutations require explicit UI confirmation and audit records.
- Critical UI assets/icons must not depend on external icon/font/CDN packages.
- Production is not accepted until tested from inside Telegram on a real mobile client.
- Final logo task requires the definitive repository-owned SVG/PNG asset; if it is not available, keep the fallback and stop final branding acceptance rather than inventing a brand asset.

## Review Focus

- Signed Telegram `user` data with missing/empty username: show bounded display name, then numeric ID only as final fallback.
- Archive a live account: revoke first, free live capacity, preserve historical sales/usage/audit, and hide from default lists.
- Usage v2 token tampering/expiry/revoked account: reject without exposing account existence beyond current status semantics.
- Telegram WebView without file sharing support: rich text share/copy must still include customer, quota, duration, server, usage URL and config URI.
- Stale heartbeat versus revision mismatch: health reason must report only evidence the backend actually knows and never invent a host/systemd/network cause.

---

### Task 1: Add backward-compatible profile and archive schema

**Files:**
- Create: `apps/sales-bot/migrations/0012-telegram-profiles.sql`
- Create: `apps/sales-bot/migrations/0013-managed-account-archive.sql`
- Create: `apps/sales-bot/test/miniapp-hardening-migrations.test.ts`

**Interfaces:**
- Consumes: existing `resellers.telegram_id` and `managed_accounts.id`.
- Produces: `telegram_profiles(telegram_id,username,first_name,last_name,updated_at)` and nullable `managed_accounts.archived_at`, `managed_accounts.archived_by`.

- [ ] **Step 1: Write the failing migration tests** asserting the two migrations apply over the current schema, profile rows can be upserted, archive columns default to `NULL`, and existing managed-account rows remain readable.
- [ ] **Step 2: Run `pnpm --filter @madar/sales-bot exec vitest run test/miniapp-hardening-migrations.test.ts`** and verify failure because the migrations do not exist.
- [ ] **Step 3: Add `0012-telegram-profiles.sql`** with a primary-keyed profile cache and bounded nullable text fields; do not alter `resellers` authorization semantics.
- [ ] **Step 4: Add `0013-managed-account-archive.sql`** with `archived_at INTEGER NULL` and `archived_by TEXT NULL` only.
- [ ] **Step 5: Re-run the migration test** and verify PASS.
- [ ] **Step 6: Commit** with `feat: add Mini App profile and archive schema`.

### Task 2: Preserve verified Telegram profile identity

**Files:**
- Create: `apps/sales-bot/src/telegram-profiles.ts`
- Modify: `apps/sales-bot/src/miniapp-auth.ts`
- Modify: `apps/sales-bot/test/miniapp-app-auth.test.ts`
- Create: `apps/sales-bot/test/telegram-profiles.test.ts`

**Interfaces:**
- Produces: `VerifiedTelegramUser { telegramId: string; username: string | null; firstName: string | null; lastName: string | null }`.
- Produces: `upsertTelegramProfile(db, profile, now): Promise<void>` and `profileDisplayName(profile): string`.
- `authenticateMiniApp(initData, env, now)` continues returning a `SalesActor`, but upserts the verified caller profile before returning.

- [ ] **Step 1: Extend auth tests** for signed user JSON containing username/name, missing username, oversized/invalid profile strings, and signature failure.
- [ ] **Step 2: Add profile-store tests** for username priority, first+last fallback, numeric ID fallback, and idempotent upsert.
- [ ] **Step 3: Run the two focused test files** and verify the new assertions fail.
- [ ] **Step 4: Implement verified profile parsing** in `miniapp-auth.ts`; bound username/name lengths before persistence and never read profile values from request JSON/query parameters.
- [ ] **Step 5: Implement `telegram-profiles.ts`** with the exact interfaces above and D1 upsert.
- [ ] **Step 6: Re-run focused tests** and verify PASS.
- [ ] **Step 7: Commit** with `feat: persist verified Telegram seller profiles`.

### Task 3: Return seller display identity from admin APIs

**Files:**
- Modify: `apps/sales-bot/src/app-admin.ts`
- Modify: `apps/sales-bot/test/app-admin-api.test.ts`

**Interfaces:**
- `listAdminSellerCards` and `loadAdminSellerDetail` add `username: string | null`, `displayName: string`, while retaining `sellerId`.

- [ ] **Step 1: Add API tests** proving `@username` is primary, first/last name is fallback, and numeric ID remains present as secondary metadata.
- [ ] **Step 2: Run `pnpm --filter @madar/sales-bot exec vitest run test/app-admin-api.test.ts`** and verify failure.
- [ ] **Step 3: Join `telegram_profiles`** in seller list/detail queries and map identity through the helper from Task 2.
- [ ] **Step 4: Re-run the test** and verify PASS.
- [ ] **Step 5: Commit** with `feat: expose Telegram seller identity in admin API`.

### Task 4: Add stateless signed usage links v2

**Files:**
- Create: `apps/sales-bot/src/usage-links.ts`
- Modify: `apps/sales-bot/src/status-routes.ts`
- Modify: `apps/sales-bot/src/account-delivery.ts`
- Modify: `apps/sales-bot/src/app-api.ts`
- Modify: `apps/sales-bot/wrangler.jsonc`
- Create: `apps/sales-bot/test/usage-links.test.ts`
- Modify: `apps/sales-bot/test/app-sales.test.ts`

**Interfaces:**
- `createUsageToken(secret: string, accountId: string): string` returns a versioned URL-safe HMAC token.
- `verifyUsageToken(secret: string, token: string): string | null` returns the account ID only for a valid token.
- `usageUrl(env, accountId): string` builds `${PUBLIC_BASE_URL}/usage/v2/<token>`.
- `AccountDeliveryArtifact` adds `usageUrl: string`.
- `USAGE_LINK_SECRET` becomes a required Worker secret.

- [ ] **Step 1: Add failing token tests** for deterministic generation, tamper rejection, wrong-secret rejection, malformed input, and constant-time-safe validation behavior at the interface level.
- [ ] **Step 2: Add failing status-route tests** proving legacy hashed links still work and v2 links return the same limited status fields; revoked accounts do not resolve.
- [ ] **Step 3: Add failing app-result test** asserting `usageUrl` is present alongside config/QR.
- [ ] **Step 4: Run the focused tests** and verify failure.
- [ ] **Step 5: Implement `usage-links.ts`** using HMAC-SHA256 and base64url/version framing; do not store raw v2 tokens in D1.
- [ ] **Step 6: Extend status routing** to accept `/usage/v2/<token>` and `/api/usage/v2/<token>` while leaving existing `/usage/<legacy>` behavior unchanged.
- [ ] **Step 7: Add `usageUrl` to delivery/result artifacts** and use v2 links for new bot deliveries.
- [ ] **Step 8: Add `USAGE_LINK_SECRET` to required secrets** in `wrangler.jsonc`.
- [ ] **Step 9: Re-run focused tests** and verify PASS.
- [ ] **Step 10: Commit** with `feat: add signed regenerable usage links`.

### Task 5: Add config detail, revoke and archive backend

**Files:**
- Modify: `apps/sales-bot/src/accounts.ts`
- Modify: `apps/sales-bot/src/app-dashboard.ts`
- Modify: `apps/sales-bot/src/app-api.ts`
- Modify: `apps/sales-bot/test/app-api.test.ts`
- Modify: `apps/sales-bot/test/app-dashboard.test.ts`
- Create: `apps/sales-bot/test/app-config-lifecycle.test.ts`

**Interfaces:**
- `archiveAccount(db, actor, id, now): Promise<void>` is admin-only, ensures revoke semantics for live accounts, sets archive metadata, and writes `archive_account` audit event.
- `loadAppConfigDetail(db, actor, id, now)` returns list fields plus server name, remaining bytes, seller identity (admin), archive metadata and effective state.
- `GET /api/app/configs/:id` returns detail.
- `POST /api/app/configs/:id/revoke` and `POST /api/app/configs/:id/archive` are admin-only.
- Default `GET /api/app/configs` excludes `archived_at IS NOT NULL`.

- [ ] **Step 1: Add lifecycle tests** for admin revoke, seller rejection, archive-live-account, archive-terminal-account, idempotent UI-safe terminal behavior, audit rows and capacity release.
- [ ] **Step 2: Add list/detail tests** proving archived configs disappear from the default list but explicit admin detail remains available and historical accounting values remain intact.
- [ ] **Step 3: Run the focused lifecycle/dashboard/API tests** and verify failure.
- [ ] **Step 4: Implement `archiveAccount`** by reusing the existing revoke authority rather than duplicating lifecycle rules; never delete the row.
- [ ] **Step 5: Implement `loadAppConfigDetail` and list filtering** without altering historical accounting queries.
- [ ] **Step 6: Add the three API routes** with existing Mini App authentication/error mapping conventions.
- [ ] **Step 7: Re-run focused tests** and verify PASS.
- [ ] **Step 8: Commit** with `feat: add config detail revoke and archive APIs`.

### Task 6: Derive truthful server health reason

**Files:**
- Modify: `apps/sales-bot/src/app-admin.ts`
- Modify: `apps/sales-bot/test/app-admin-api.test.ts`

**Interfaces:**
- Node detail adds `healthReason: "OK" | "STALE_HEARTBEAT" | "REVISION_NOT_ACKED" | "MISSING_QUOTA_CAPABILITY" | "AGENT_REPORTED_UNHEALTHY"` and `lastSeenAgeSeconds: number`.

- [ ] **Step 1: Add tests** for all five reason states and precedence: stale heartbeat first, then revision mismatch, missing quota capability, recent unhealthy, OK.
- [ ] **Step 2: Run the admin API test** and verify failure.
- [ ] **Step 3: Implement the derivation** from current `last_seen`, `revision`, `acked_revision`, `healthy`, and capabilities only.
- [ ] **Step 4: Re-run the test** and verify PASS.
- [ ] **Step 5: Commit** with `feat: expose evidence-based node health reasons`.

### Task 7: Fix result QR, usage actions and rich sharing

**Files:**
- Modify: `apps/sales-bot/public/app.js`
- Modify: `apps/sales-bot/public/app.css`
- Modify: `apps/sales-bot/test/app-browser.node.mjs`
- Modify: `apps/sales-bot/test/app-recovery-browser.node.mjs`

**Interfaces:**
- Ready-result state consumes `qrSvg` and `usageUrl` from `/api/app/configs/:id/result`.
- `buildShareText(result): string` formats the complete Persian payload.
- `shareResult()` attempts QR file share only when `navigator.canShare({ files })` succeeds; otherwise shares rich text; final fallback copies rich text.

- [ ] **Step 1: Update browser fixtures** so ready results include a real minimal SVG and a v2 usage URL.
- [ ] **Step 2: Add failing assertions** that actual `<svg` markup is mounted, usage/open/copy controls exist, and share text contains label/quota/duration/server/usage URL/config.
- [ ] **Step 3: Add file-share/fallback tests** for supported `navigator.canShare`, unsupported file sharing, `AbortError`, and missing clipboard/share APIs.
- [ ] **Step 4: Run `node --test apps/sales-bot/test/app-browser.node.mjs apps/sales-bot/test/app-recovery-browser.node.mjs`** and verify failure.
- [ ] **Step 5: Add explicit `#result-qr svg` sizing/display CSS** and keep server-provided SVG as the only QR source.
- [ ] **Step 6: Implement usage buttons and `buildShareText`**; do not let QR conversion failure block text share/copy.
- [ ] **Step 7: Implement SVG-to-PNG/File conversion only inside the preferred share path** with a bounded filename and no persistence.
- [ ] **Step 8: Re-run browser tests** and verify PASS.
- [ ] **Step 9: Commit** with `fix: complete Mini App QR usage and sharing`.

### Task 8: Add config detail and lifecycle controls to the Mini App

**Files:**
- Modify: `apps/sales-bot/public/app.js`
- Modify: `apps/sales-bot/public/app-admin.js`
- Modify: `apps/sales-bot/public/app-admin.css`
- Modify: `apps/sales-bot/test/app-browser.node.mjs`
- Modify: `apps/sales-bot/test/app-admin-browser.node.mjs`

**Interfaces:**
- Config list `مشاهده` opens `GET /api/app/configs/:id`.
- Admin detail exposes `لغو سرویس` and `حذف از فهرست` with explicit confirmation; seller detail is read-only unless later requirements change.

- [ ] **Step 1: Add browser tests** for config detail values, admin-only lifecycle actions, cancel/confirm paths, archive explanatory copy, and refresh after success.
- [ ] **Step 2: Run the browser tests** and verify failure.
- [ ] **Step 3: Implement config detail rendering** including state, server, quota/used/remaining, created/expiry, seller identity for admin, QR/config/usage when available.
- [ ] **Step 4: Implement confirmation UI** using Telegram WebApp confirmation where available and a safe in-app fallback.
- [ ] **Step 5: Wire revoke/archive routes** and refresh dashboard/list/capacity after successful mutations.
- [ ] **Step 6: Re-run browser tests** and verify PASS.
- [ ] **Step 7: Commit** with `feat: manage configs from Mini App`.

### Task 9: Persian localization, seller identity UI and semantic SVG icons

**Files:**
- Modify: `apps/sales-bot/public/app.html`
- Modify: `apps/sales-bot/public/app.js`
- Modify: `apps/sales-bot/public/app-admin.js`
- Modify: `apps/sales-bot/public/app.css`
- Modify: `apps/sales-bot/public/app-admin.css`
- Modify: `apps/sales-bot/test/app-browser.node.mjs`
- Modify: `apps/sales-bot/test/app-admin-browser.node.mjs`

**Interfaces:**
- `icon(name): string` returns only allow-listed self-contained SVG markup for home, servers, sellers, configs, reports, volume, usage, active, refresh, copy, share, link, archive and revoke.

- [ ] **Step 1: Add failing tests** forbidding user-facing `ADMIN CONTROL`, `ADMIN · SERVERS`, `ADMIN · SELLERS`, `SERVER DETAIL`, `SELLER DETAIL`, `CONFIGS`, `REPORTS`, `READY`, `CONFIG PREPARING`, and `SELLER STATS`.
- [ ] **Step 2: Add failing tests** asserting nav/metric/action icons contain SVG markup rather than the current glyph set and seller cards use `displayName` as primary text with ID secondary.
- [ ] **Step 3: Run browser tests** and verify failure.
- [ ] **Step 4: Replace English kickers** with concise Persian labels or remove redundant ones; preserve technical LTR values such as IP/SNI/capability names.
- [ ] **Step 5: Implement allow-listed inline SVG icons** and replace ambiguous glyphs/emoji in navigation, metrics and lifecycle actions.
- [ ] **Step 6: Update seller list/detail rendering** to primary `@username`/display name and secondary numeric ID.
- [ ] **Step 7: Re-run browser tests** and verify PASS.
- [ ] **Step 8: Commit** with `fix: localize Mini App and clarify icons`.

### Task 10: Wire the real Madar logo with safe fallback

**Files:**
- Create from user-provided brand asset: `apps/sales-bot/public/madar-logo.svg` or `apps/sales-bot/public/madar-logo.png`
- Modify: `apps/sales-bot/public/app.html`
- Modify: `apps/sales-bot/public/app.css`
- Modify: `apps/sales-bot/test/app-browser.node.mjs`

**Interfaces:**
- Header renders a local `<img class="brand-logo">`; failure/absence reveals the existing styled `M` fallback without layout shift.

- [ ] **Step 1: Confirm the definitive user-provided logo asset is available**; if not, pause only this task and do not invent one.
- [ ] **Step 2: Add failing shell test** asserting the local logo path plus fallback element and accessible brand label.
- [ ] **Step 3: Add the repository-owned asset and fallback markup/CSS** with fixed dimensions and `onerror`/CSS fallback behavior that does not execute remote code.
- [ ] **Step 4: Re-run browser test** and verify PASS.
- [ ] **Step 5: Commit** with `fix: restore Madar logo in Mini App`.

### Task 11: Full verification, migration rollout and production acceptance

**Files:**
- Modify only if verification exposes a regression; no speculative edits.

**Interfaces:**
- Produces a verified commit SHA, applied D1 migrations, configured `USAGE_LINK_SECRET`, green CI, production Worker deployment and field-acceptance checklist.

- [ ] **Step 1: Run full sales-bot tests:** `pnpm --filter @madar/sales-bot test`; expected all PASS.
- [ ] **Step 2: Run typecheck:** `pnpm --filter @madar/sales-bot typecheck`; expected exit 0.
- [ ] **Step 3: Run dry build:** `pnpm --filter @madar/sales-bot build`; expected Wrangler dry-run succeeds.
- [ ] **Step 4: Review `git diff` against the approved spec** and verify no physical-delete path, no external icon CDN, and no legacy usage regression.
- [ ] **Step 5: Apply D1 migrations 0012 and 0013 to production** before deploying code; verify table/column existence with read-only queries.
- [ ] **Step 6: Configure a strong production `USAGE_LINK_SECRET`** through the existing secret-management path; never commit its value.
- [ ] **Step 7: Deploy the exact verified commit** and confirm 100% Worker traffic only after smoke checks pass.
- [ ] **Step 8: Run production smoke checks** for `/app`, admin dashboard, seller list identity, config detail, v2 usage status, and a non-destructive QR/result recovery path.
- [ ] **Step 9: Perform real Telegram field acceptance**: Persian headings, logo, semantic icons, seller name, QR visible, usage link works, rich share fallback works, revoke works, archive hides item while history remains, server health reason renders.
- [ ] **Step 10: Record final commit/deployment IDs and any remaining Node1-only operational issue**; Node1 repair follows the separate plan.
- [ ] **Step 11: Commit any acceptance-only documentation** with `docs: record Mini App hardening acceptance` if the repo already keeps rollout records; otherwise do not add unnecessary documentation.
