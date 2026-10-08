# Madar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the clean-start Madar Persian RTL PWA, authoritative account/control plane, secure user subscription system, non-technical admin panel, node installer/agent, and real Xray/VLESS/REALITY integration, ending only after real v2rayNG/VPS/device E2E acceptance passes.

**Architecture:** React + TypeScript + Vite provides the PWA, served with Cloudflare Workers Static Assets. A Hono Cloudflare Worker owns authenticated APIs, authorization, subscriptions, provider callbacks, node control, and PostgreSQL-backed authoritative state. PostgreSQL is accessed through Cloudflare Hyperdrive using `pg`; the Python node agent runs beside pinned Xray-core on Ubuntu LTS and enforces server-issued policy. External providers and the VPN data plane stay independently testable and unavailable until genuinely configured and verified.

**Tech Stack:** pnpm workspace, React, TypeScript, Vite, Cloudflare Workers, Hono, Zod, PostgreSQL, `pg >= 8.16.3`, SQL migrations, Vitest, `@cloudflare/vitest-pool-workers`, React Testing Library, Playwright, Python 3, pytest, systemd, Xray-core, VLESS, REALITY.

**Spec:** `docs/superpowers/specs/2026-10-08-madar-clean-start-design.md`

## Global Constraints

- Clean start only: no code, database, repository history, credentials, secrets, installer assets, or architecture from Velo/WireGuard may be reused.
- Product language is Persian RTL; visual identity is very dark navy, light text, electric blue; mobile-first with complete desktop behavior.
- WireGuard is excluded. VPN target is Xray-core + VLESS + REALITY + per-user subscription URL + v2rayNG compatibility.
- First verified email grants exactly 1,800 free seconds once.
- Each valid server-verified rewarded-ad event grants exactly 900 free seconds once per provider event identity.
- Free credit expires at 00:00 Asia/Tehran; Premium does not reset and lasts through purchased expiration.
- Distinct simultaneous VPN sessions consume their actual combined observed usage; duplicate/replayed telemetry evidence never causes a second debit.
- Free speed cap is admin-configurable and initially 5 Mbps; Premium has no Madar-imposed application speed cap.
- Entitlement expiry, suspension, revocation, and credential rotation must be enforced on nodes, not only hidden in UI.
- REALITY private key and raw node credential remain only on the VPS.
- Subscription output must never expose email, internal user ID, admin secrets, node credentials, REALITY private key, or infrastructure secrets.
- Browser bundle, Git repository, logs, README/guides, and public installer must contain no secret.
- Sessions are secure HttpOnly cookies; sensitive mutations require CSRF/origin protection; admin authorization is independent of ordinary user identity.
- Missing email, ads, payment, push, or VPN integrations show unavailable/degraded states; no simulated production success.
- Node enrollment tokens are short-lived, one-time, hash-only; stale nodes fail closed and are excluded from subscription output.
- Service worker caches app-shell/static assets only; authenticated APIs, auth responses, subscription output, QR-bearing sensitive payloads, and secrets are not cached.
- Notification permission is requested only after explicit user action.
- A feature is not called operational until its real integration is verified; `Production Ready` is forbidden until Phase 10 acceptance passes.

## Review Focus

1. **Replay/concurrency accounting:** retries, duplicate provider callbacks, duplicate telemetry, concurrent transactions, and multiple active sessions must settle exactly according to source identity and actual observed usage.
2. **Tehran date boundary:** delayed reports from the previous Tehran day must never consume the new day's free balance; Premium must remain unchanged through midnight.
3. **Credential/node race conditions:** rotation must not publish a node before it has acknowledged the required credential policy; stale nodes must fail closed.
4. **Authorization/secrets:** anonymous users, ordinary users, forged CSRF/origin requests, and log/error paths must never expose or perform admin/subscription/node-secret operations.
5. **Honest readiness:** absent provider credentials, denied notification permission, unsupported install state, unhealthy nodes, and unavailable VPS integration must render as unavailable rather than success.

---

# Repository File Map

## Root

- Create: `package.json` — workspace scripts and toolchain.
- Create: `pnpm-workspace.yaml` — workspace boundaries.
- Create: `tsconfig.base.json` — shared strict TypeScript options.
- Create: `.gitignore`, `.editorconfig`, `.env.example` — safe local defaults with placeholders only.
- Modify: `README.md` — clean-start development instructions; no secrets or operational claims.
- Create: `.github/workflows/ci.yml` — lint/typecheck/unit/integration/build/Python tests.

## Web

- Create: `apps/web/package.json`, `apps/web/vite.config.ts`, `apps/web/tsconfig.json`.
- Create: `apps/web/index.html`, `apps/web/src/main.tsx`, `apps/web/src/app/App.tsx`.
- Create: `apps/web/src/styles/tokens.css`, `global.css` — RTL design system.
- Create: `apps/web/src/components/*` — shared UI.
- Create: `apps/web/src/features/auth/*`, `dashboard/*`, `access/*`, `admin/*`, `premium/*`, `missions/*`, `settings/*`.
- Create: `apps/web/public/manifest.webmanifest`, `apps/web/public/sw.js`, `apps/web/public/icons/*`.

## API Worker

- Create: `apps/api/package.json`, `apps/api/wrangler.jsonc`, `apps/api/vitest.config.ts`.
- Create: `apps/api/src/index.ts`, `env.ts`, `middleware/*`.
- Create: `apps/api/src/routes/auth.ts`, `account.ts`, `subscription.ts`, `admin.ts`, `providers.ts`, `nodes.ts`, `push.ts`.

## Shared packages

- Create: `packages/contracts/src/*` — Zod request/response/node/provider contracts.
- Create: `packages/domain/src/auth/*`, `account/*`, `access/*`, `nodes/*`, `providers/*` — pure domain rules.
- Create: `packages/database/src/client.ts`, `tx.ts`, `repositories/*`, `migrations/*.sql`.

## Node Agent

- Create: `node-agent/pyproject.toml`.
- Create: `node-agent/madar_agent/config.py`, `api.py`, `policy.py`, `telemetry.py`, `xray.py`, `speed.py`, `main.py`.
- Create: `node-agent/installer/install.sh`, `madar-node`, `systemd/madar-agent.service`.
- Create: `node-agent/tests/*`.

## Tests and evidence

- Create: `tests/integration/*.test.ts`.
- Create: `tests/e2e/*.spec.ts`.
- Create: `docs/test-reports/phase-*.md`.
- Create: `docs/runbooks/node-install.md`, `node-recovery.md`, `credential-rotation.md`.

---

# Phase 1 — PWA + Design System + Auth

## Task 1: Bootstrap workspace, Worker, web app, and CI

**Files:** root workspace files, `apps/web/*`, `apps/api/*`, `.github/workflows/ci.yml`.

**Interfaces:**
- Produces `pnpm test`, `pnpm typecheck`, `pnpm build`, `pnpm test:python`.
- Produces Worker entry `apps/api/src/index.ts` and React entry `apps/web/src/main.tsx`.

- [ ] **Step 1: Add bootstrap smoke tests**
  - `apps/api/src/index.test.ts`: `GET /api/health` returns `200` and `{status:'ok'}`.
  - `apps/web/src/app/App.test.tsx`: renders Persian product name `مدار` with `dir="rtl"`.
- [ ] **Step 2: Run tests before implementation**
  - Run: `pnpm test`
  - Expected: FAIL because workspace/apps do not yet exist.
- [ ] **Step 3: Scaffold the pnpm workspace and exact app boundaries**
  - Worker uses Hono + Cloudflare Vite plugin/static assets.
  - PostgreSQL dependency is `pg` with Hyperdrive-compatible version floor.
  - Strict TypeScript; no `any` in exported contracts.
- [ ] **Step 4: Add CI**
  - CI runs install with frozen lockfile, TS tests, typecheck, production build, Python tests when node-agent exists.
- [ ] **Step 5: Verify**
  - Run: `pnpm test && pnpm typecheck && pnpm build`
  - Expected: PASS.
- [ ] **Step 6: Commit**
  - `git commit -m "chore: bootstrap Madar workspace"`

## Task 2: Implement RTL design system and PWA shell

**Files:** `apps/web/src/styles/*`, `components/*`, `public/manifest.webmanifest`, `public/sw.js`.

**Interfaces:**
- Produces `AppShell`, `PageHeader`, `Card`, `Button`, `StatusBadge`, `TimeRing`.
- Produces PWA manifest with Persian name, standalone display, theme/background metadata.

- [ ] **Step 1: Write UI tests**
  - mobile shell has no horizontal overflow fixture;
  - `TimeRing` exposes an accessible label;
  - reduced-motion preference disables non-essential ring animation;
  - app shell remains usable when API state is unavailable.
- [ ] **Step 2: Run focused tests and confirm failure**
- [ ] **Step 3: Implement tokens/components and responsive navigation**
  - No provider/VPN success indicators are hard-coded.
- [ ] **Step 4: Implement manifest/service worker shell caching**
  - Explicitly bypass `/api/`, `/s/`, auth, and sensitive request paths.
- [ ] **Step 5: Verify**
  - `pnpm --filter @madar/web test`
  - `pnpm --filter @madar/web build`
  - Expected: PASS.
- [ ] **Step 6: Commit**
  - `git commit -m "feat: add Madar RTL PWA shell"`

## Task 3: Create identity/session database schema

**Files:** `packages/database/src/migrations/0001_identity.sql`, repositories; `packages/domain/src/auth/*`.

**Interfaces:**
- `canonicalizeEmail(email: string): string`
- `createLoginChallenge(email: string, now: Date): Promise<{rawToken:string; expiresAt:Date}>`
- `consumeLoginChallenge(rawToken: string, now: Date): Promise<{userId:string; firstVerification:boolean}>`
- `createSession(userId: string, now: Date): Promise<{rawSession:string; expiresAt:Date}>`
- `resolveSession(rawSession: string, now: Date): Promise<UserSession|null>`

- [ ] **Step 1: Write failing DB/domain tests**
  - canonical email uniqueness;
  - login token stored hash-only;
  - expired token rejected;
  - replay rejected;
  - first verification returns true once only;
  - session lookup rejects revoked/expired token.
- [ ] **Step 2: Run focused tests; expect failure**
- [ ] **Step 3: Implement SQL constraints and transactional repositories**
- [ ] **Step 4: Verify tests against isolated PostgreSQL test database**
- [ ] **Step 5: Commit**
  - `git commit -m "feat: add secure identity persistence"`

## Task 4: Implement magic-link auth API and provider boundary

**Files:** `apps/api/src/routes/auth.ts`, `packages/contracts/src/auth.ts`, `packages/domain/src/providers/email.ts`.

**Interfaces:**
- `POST /api/auth/request-link`
- `POST /api/auth/consume-link`
- `POST /api/auth/logout`
- `EmailProvider.sendMagicLink(input): Promise<'sent'|'unavailable'>`

- [ ] **Step 1: Write failing Worker tests**
  - invalid email -> 400;
  - unconfigured provider -> honest `unavailable` response and no fake delivery;
  - valid consume -> secure HttpOnly session cookie;
  - replay/expired token -> 401/invalid;
  - cookie value not present in response JSON/log fixture.
- [ ] **Step 2: Verify failure**
- [ ] **Step 3: Implement provider-neutral email boundary and routes**
- [ ] **Step 4: Verify Worker tests**
  - Run with `@cloudflare/vitest-pool-workers`.
- [ ] **Step 5: Commit**
  - `git commit -m "feat: add email magic-link authentication"`

## Task 5: Implement user/admin authorization and CSRF/origin protection

**Files:** `apps/api/src/middleware/session.ts`, `admin.ts`, `csrf.ts`; DB admin repository.

**Interfaces:**
- `requireUser(c): Promise<AuthUser>`
- `requireAdmin(c): Promise<AdminUser>`
- `verifyMutationOrigin(request, expectedOrigins): boolean`
- `verifyCsrf(session, token): boolean`

- [ ] **Step 1: Write failing security tests**
  - anonymous user API denied;
  - ordinary user admin API denied;
  - forged Origin denied;
  - missing/incorrect CSRF denied;
  - no public endpoint can assign admin membership.
- [ ] **Step 2: Verify failure**
- [ ] **Step 3: Implement middleware and server-controlled admin membership**
- [ ] **Step 4: Verify security suite and full Phase 1 suite**
- [ ] **Step 5: Build/typecheck**
- [ ] **Step 6: Commit**
  - `git commit -m "feat: enforce user and admin authorization"`

## Task 6: Implement Login and honest authenticated dashboard shell

**Files:** `apps/web/src/features/auth/*`, `dashboard/*`, API account placeholder route.

**Interfaces:**
- `GET /api/account` returns real auth status plus explicit integration/readiness fields; fields not implemented yet are unavailable, never successful.

- [ ] **Step 1: Write UI/Playwright tests** for login states, expired link state, unavailable email state, authenticated shell, mobile/desktop keyboard navigation.
- [ ] **Step 2: Verify failure**
- [ ] **Step 3: Implement Login/Dashboard surfaces using design system**
- [ ] **Step 4: Run UI tests, Playwright smoke test, typecheck/build**
- [ ] **Step 5: Write `docs/test-reports/phase-1.md`** with automated evidence and explicitly unverified real-email/device items.
- [ ] **Step 6: Commit**
  - `git commit -m "feat: complete phase 1 auth experience"`

**Phase 1 Gate:** all auth/security/PWA-shell tests pass; build passes; email remains unavailable until a real provider is configured. Do not proceed on red tests.

---

# Phase 2 — Account Ledger + Free/Premium Rules

## Task 7: Add immutable credit ledger and one-time verification grant

**Files:** `0002_accounting.sql`, `packages/domain/src/account/ledger.ts`, repositories/tests.

**Interfaces:**
- `grantInitialCredit(userId, verificationId, now): Promise<boolean>`
- `getEntitlement(userId, now): Promise<Entitlement>`

- [ ] Tests: first verification grants 1800; second call/source replay grants zero; concurrent attempts still produce one ledger event; ledger rows immutable.
- [ ] Run failing tests.
- [ ] Implement transaction + uniqueness constraint.
- [ ] Run tests; commit `feat: add atomic initial credit ledger`.

## Task 8: Implement Premium settlement and generic idempotent credit operations

**Interfaces:**
- `applyFreeCredit(input:{userId,seconds,sourceType,sourceId,occurredAt}): Promise<boolean>`
- `extendPremium(input:{userId,durationDays,sourceType,sourceId,now}): Promise<boolean>`

- [ ] Tests: +900 valid source; duplicate source zero; Premium extension uses later of now/current expiration; Premium not reset at Tehran midnight; active Premium prevents free debit.
- [ ] Implement generic settlement transactions.
- [ ] Verify/commit `feat: add premium and idempotent credit settlement`.

## Task 9: Implement Tehran-day semantics

**Files:** `packages/domain/src/account/tehran-day.ts`, tests.

**Interfaces:**
- `toTehranDay(instant: Date): string`
- `effectiveFreeSeconds(account, now): number`

- [ ] Tests immediately before/after Tehran midnight, DST-independent timezone library behavior, absent user, previous-day grant/read.
- [ ] Implement with IANA `Asia/Tehran`; never client timezone.
- [ ] Verify/commit `feat: enforce Tehran free-credit day boundary`.

## Task 10: Implement telemetry settlement model

**Files:** `0003_usage.sql`, `packages/domain/src/account/usage.ts`, `tests/integration/usage-settlement.test.ts`.

**Interfaces:**
- `recordUsage(report:{nodeId,clientId,windowId,sequence,seconds,timestamp,observedFrom?,observedTo?}): Promise<'accepted'|'duplicate'|'stale-day'>`

- [ ] Tests: duplicate `(node,window,sequence)` no second debit; out-of-order sequence accepted once; negative/invalid seconds rejected; prior Tehran-day report cannot debit new-day credit; two distinct 60-second simultaneous sessions may debit 120 seconds; replay of either session adds zero.
- [ ] Implement raw telemetry idempotency plus session-scoped settlement.
- [ ] Verify under concurrent transactions.
- [ ] Commit `feat: add idempotent real-usage settlement`.

## Task 11: Expose authoritative account API and TimeRing states

- [ ] Tests: Free shows remaining seconds; Premium shows expiry; suspended/unavailable states are explicit; no browser mutation can grant credit.
- [ ] Implement `GET /api/account` and dashboard binding.
- [ ] Full Phase 2 tests/typecheck/build.
- [ ] Write `docs/test-reports/phase-2.md`.
- [ ] Commit `feat: complete account entitlement phase`.

**Phase 2 Gate:** all grants/debits/premium/reset behavior proven with DB integration tests and concurrency cases.

---

# Phase 3 — Access Profile + Subscription System

## Task 12: Add access profile, client credential, and subscription token persistence

**Interfaces:**
- `ensureAccessProfile(userId): Promise<AccessProfile>`
- `getActiveClientCredential(userId): Promise<ClientCredential>`
- `issueSubscriptionToken(userId): Promise<{rawToken:string;version:number}>`

- [ ] Tests: one active credential/token version; UUID uniqueness; token hash-only; no raw bearer value returned by read repository.
- [ ] Implement SQL/repositories; verify/commit.

## Task 13: Implement eligible-node abstraction and subscription renderer

**Interfaces:**
- `listEligibleNodes(userId, now): Promise<NodePublicConfig[]>`
- `renderSubscription(profile,nodes): string`
- `GET /s/:token`

- [ ] Tests: invalid/revoked token 404/unauthorized without information leak; `Cache-Control: no-store`; unhealthy/stale/unacked node excluded; no forbidden internal fields; multiple eligible nodes produce multiple entries.
- [ ] Implement renderer as VLESS share-link output boundary, not yet declared v2rayNG E2E verified.
- [ ] Commit.

## Task 14: Implement credential and subscription rotation state machines

**Interfaces:**
- `rotateClientCredential(adminOrUserContext,userId): Promise<Rotation>`
- `rotateSubscriptionToken(userId): Promise<{rawToken:string}>`

- [ ] Tests: old subscription URL invalid immediately after token rotation; client UUID unchanged on URL rotation; credential rotation creates new UUID, revokes old, increments policy revision; node not advertised for new UUID until required revision ACK.
- [ ] Implement transactional rotations/audit.
- [ ] Commit.

## Task 15: Build VPN Access UI with QR/Copy and honest readiness

- [ ] Tests: Copy/QR expose only subscription URL/client-safe output; stale/no-node state displays unavailable; no fake Connect button.
- [ ] Implement UI; full phase tests/build.
- [ ] Write `phase-3.md`; commit.

**Phase 3 Gate:** lifecycle/rotation/security tests pass; no claim that generated subscription has connected to v2rayNG yet.

---

# Phase 4 — Admin

## Task 16: Implement audited admin APIs

**Files:** `0005_admin.sql`, admin routes/repositories/contracts.

**Interfaces:** protected CRUD for users, suspension, manual free-credit adjustment, premium adjustment, plans, node metadata, integration-readiness; all sensitive mutations append audit events.

- [ ] Tests: non-admin denial; audit row for every sensitive mutation; duplicate source on manual settlement rejected; secret fields never returned.
- [ ] Implement and verify/commit.

## Task 17: Implement non-technical Admin UI

- [ ] Build Overview, Users, Free Credit, Premium, Plans, Payments, Ads, Missions, Rewards, Push, Nodes, Health, Capacity, Speed limit, Subscription status, rotation actions, Audit, Integration readiness.
- [ ] Tests for empty/loading/error/unavailable states and mobile/desktop accessibility.
- [ ] No fake sample-success action.
- [ ] Full phase tests/build; `phase-4.md`; commit.

**Phase 4 Gate:** all admin mutations server-authorized/audited; unavailable integrations clearly disabled.

---

# Phase 5 — Ads / Payments / Missions / Push Adapters

## Task 18: Define provider verification contracts

**Interfaces:**
- `EmailProvider`
- `RewardedAdProvider.verifyCallback(request): Promise<VerifiedAdEvent>`
- `PaymentProvider.verifyCallback(request): Promise<VerifiedPaymentEvent>`
- `PushProvider.send(subscription,payload): Promise<DeliveryResult>`

- [ ] Tests: unconfigured adapter unavailable; forged callback rejected; provider parser cannot directly mutate ledger.
- [ ] Implement adapters with no provider-specific success until selected/configured.
- [ ] Commit.

## Task 19: Implement rewarded-ad settlement

- [ ] Tests: verified callback +900; duplicate provider event +0; client countdown/endpoint cannot grant; wrong user binding rejected.
- [ ] Implement callback → verify → transactional settlement.
- [ ] Commit.

## Task 20: Implement plans/orders/manual and provider payment settlement

- [ ] Tests: browser return URL does not settle; admin confirmation settles once; verified callback amount/order mismatch rejected; duplicate callback no extension; valid renewal extends later-of date.
- [ ] Implement server-created order workflow and shared settlement function.
- [ ] Commit.

## Task 21: Implement missions and rewards

- [ ] Tests: evidence submission pending; approve once; reject no reward; duplicate approval no second reward; referral requires verified evidence/rules, not share click.
- [ ] Implement admin mission definition/review + user status.
- [ ] Commit.

## Task 22: Implement Web Push and PWA install/notification UX

- [ ] Tests: subscription stored only for authenticated user; permission requested only from user gesture; denied/unsupported leaves app usable; expired subscriptions removed; API payloads not service-worker cached.
- [ ] Implement VAPID boundary and push subscription CRUD; actual delivery remains integration-unverified until credentials/device supplied.
- [ ] Android install prompt + iPhone Home Screen instructions.
- [ ] Full phase suite/build; `phase-5.md`; commit.

**Phase 5 Gate:** provider replay/security tests pass; real-provider/device checks are explicitly pending where credentials/devices are absent.

---

# Phase 6 — Node Enrollment + Agent

## Task 23: Implement node enrollment/control-plane APIs

**Interfaces:**
- `createEnrollmentToken(adminId,nodeDraft,now)`
- `enrollNode(rawToken,capabilities,publicConfig)`
- `authenticateNode(rawCredential)`
- `heartbeatNode(nodeId,health,versions,capacity)`
- `getNodePolicy(nodeId,knownRevision)`
- `ackNodePolicy(nodeId,revision)`
- `postTelemetry(nodeId,reports)`

- [ ] Tests: one-time/expired token; hash-only node credential; unauthorized heartbeat denied; stale readiness; policy ACK; duplicate telemetry; secret redaction.
- [ ] Implement/verify/commit.

## Task 24: Implement Python Agent core with fail-closed policy

**Interfaces:**
- `validate_environment() -> EnvironmentReport`
- `fetch_policy() -> Policy`
- `apply_policy(policy) -> ApplyResult`
- `collect_usage() -> list[UsageReport]`
- `is_authorization_fresh(now) -> bool`

- [ ] pytest cases: invalid Ubuntu/environment; credential permission check; monotonic window sequence; stale policy disables managed access; free/premium policy distinction; bounded retry/backoff.
- [ ] Implement API/config/policy/telemetry layers with Xray adapter initially test-double backed.
- [ ] Verify/commit.

## Task 25: Implement safe installer and lifecycle commands

- [ ] Shell/Python tests: explains changes before sensitive action; never echoes token; does not alter SSH/firewall by default; install uses restrictive credential permissions; `status`, `update`, `remove` exist; failed enrollment leaves no falsely-ready service.
- [ ] Implement systemd unit and installer.
- [ ] Produce `docs/runbooks/node-install.md`.
- [ ] Full phase tests; `phase-6.md`; commit.

**Phase 6 Gate:** enrollment/agent/installer automated tests pass. Still no claim of real Xray operation until Phase 7.

---

# Phase 7 — Xray / VLESS / REALITY Integration

## Task 26: Implement pinned Xray adapter and REALITY key handling

**Interfaces:**
- `XrayAdapter.ensure_runtime(config)`
- `XrayAdapter.apply_clients(clients)`
- `XrayAdapter.revoke_client(uuid)`
- `XrayAdapter.collect_observed_activity()`
- `XrayAdapter.health()`

- [ ] Contract tests against fixture/process test double first.
- [ ] Implement pin/checksum verification for downloaded Xray release.
- [ ] Generate REALITY private key on VPS only; send only public client-safe parameters to control plane.
- [ ] Ensure logs/tests never print private key/node credential.
- [ ] Commit automated portion.

## Task 27: Run disposable real-VPS integration test

**Evidence file:** `docs/test-reports/phase-7-vps.md`.

- [ ] Install on supported Ubuntu LTS using real installer.
- [ ] Verify Xray/Agent systemd health.
- [ ] Enroll node through one-time token.
- [ ] Add user policy and verify Xray accepts credential.
- [ ] Revoke credential and verify access removal.
- [ ] Observe real traffic/activity source and document exact semantics; if exact connection duration is unavailable, document the server-observed activity algorithm rather than inventing connection state.
- [ ] Verify stale-policy fail-closed behavior.
- [ ] Record commands/results without secrets.
- [ ] Commit evidence/config changes only after real test passes.

**Phase 7 Gate:** real VPS integration and revoke/fail-closed behavior verified. If VPS access is unavailable, phase remains incomplete.

---

# Phase 8 — v2rayNG E2E

## Task 28: Freeze subscription compatibility through real v2rayNG test

**Evidence:** `tests/e2e/v2rayng-acceptance.md`, `docs/test-reports/phase-8.md`.

- [ ] Create brand-new user and verify email.
- [ ] Confirm exactly 1800 initial seconds once.
- [ ] Fetch real subscription URL.
- [ ] Import subscription in current real v2rayNG.
- [ ] Connect to real VPS and prove public traffic traverses VPS.
- [ ] Confirm usage telemetry appears and free balance decreases only during observed active usage.
- [ ] Disconnect and prove debit stops under documented observation window semantics.
- [ ] Rotate Client ID: old config fails after revocation, Refresh obtains working new config.
- [ ] Rotate Subscription URL: old URL fails immediately; new URL refresh works.
- [ ] Freeze renderer/parser fixtures only after this test.
- [ ] Commit evidence and compatibility fixtures.

**Phase 8 Gate:** real v2rayNG/VPS connection and lifecycle tests pass. Otherwise subscription remains integration-unverified.

---

# Phase 9 — Multi-node + Speed Enforcement

## Task 29: Add second real node and multi-node readiness/capacity behavior

- [ ] Enroll a second VPS node.
- [ ] Tests: two healthy ACKed nodes appear; stale/unhealthy node disappears; capacity-excluded node disappears; rotations propagate before advertisement.
- [ ] Verify real subscription refresh displays both nodes in v2rayNG.
- [ ] Verify traffic can pass through each node.
- [ ] Record `phase-9-multinode.md`; commit.

## Task 30: Implement and prove per-free-user SpeedEnforcer

**Interfaces:**
- Python `SpeedEnforcer.apply(client_id, speed_mbps: float|null) -> None`
- `null` means no Madar-imposed cap for Premium.

- [ ] Write adapter tests before implementation.
- [ ] Implement only a mechanism that actually enforces per-client Free speed under Xray/VLESS/REALITY; do not substitute a node-wide cap.
- [ ] Real throughput test Free near configured cap.
- [ ] Real throughput test Premium with no Madar software cap.
- [ ] If no reliable mechanism is proven, mark Phase 9 failed/incomplete and do not fake readiness.
- [ ] Commit only verified mechanism/evidence.

**Phase 9 Gate:** real two-node subscription + unhealthy filtering + per-user Free speed cap + uncapped Premium behavior verified.

---

# Phase 10 — Production Readiness

## Task 31: Security and abuse hardening

- [ ] Add API rate limits/abuse controls for login, subscription fetch, callbacks, admin, and node enrollment.
- [ ] Secret scanning and log-redaction tests.
- [ ] Dependency/security audit.
- [ ] CSRF/origin/session rotation review.
- [ ] Subscription bearer leakage review for logs/analytics/referrers.
- [ ] Audit-log completeness review.
- [ ] Commit hardening.

## Task 32: Backup, restore, recovery, and installer lifecycle

- [ ] Test PostgreSQL backup/restore on disposable database.
- [ ] Test node reinstall/re-enroll/recovery without exposing secrets.
- [ ] Test installer `update` and `remove` on disposable VPS.
- [ ] Write `docs/runbooks/node-recovery.md` and DB restore runbook.
- [ ] Commit evidence.

## Task 33: Real PWA and Web Push device acceptance

- [ ] Android: install PWA, relaunch standalone, verify core shell/account states.
- [ ] iPhone: Add to Home Screen and verify standalone behavior.
- [ ] Request notifications only after explicit button action.
- [ ] Send and receive real Web Push on supported Android/iPhone target devices.
- [ ] Verify denied notification state leaves app usable.
- [ ] Record device/browser/OS versions and results.

## Task 34: Full final acceptance and release gate

- [ ] Run all TS/Python automated suites, typecheck and production build.
- [ ] Re-run account creation/one-time 30m grant.
- [ ] Re-run v2rayNG import, real connection and VPS traffic.
- [ ] Re-run debit-start/debit-stop behavior.
- [ ] Verify valid rewarded ad +15m only when a real configured provider callback exists; otherwise Production Ready remains blocked on that acceptance item.
- [ ] Verify Tehran midnight reset and Premium survival with controlled clock/integration evidence.
- [ ] Verify entitlement expire → real revoke; recharge → real re-enable.
- [ ] Re-run Client ID rotation and Subscription URL rotation.
- [ ] Re-run second node, unhealthy removal, Free speed cap and Premium no-app-cap.
- [ ] Re-run Android/iPhone PWA install and real Web Push.
- [ ] Create `docs/test-reports/final-acceptance.md` with each item PASS/FAIL/BLOCKED and evidence reference.
- [ ] Only when every required item is PASS may release notes use `Production Ready`.
- [ ] Final commit: `chore: record production acceptance`.

---

# Cross-Phase Verification Commands

Use these commands after each relevant task and always at the end of a phase:

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm build
python3 -m pytest node-agent/tests
```

Database integration tests run against an isolated PostgreSQL database and must not point at production. Cloudflare Worker tests use the Worker-compatible Vitest pool. Browser E2E uses Playwright. Real-VPS/device acceptance is recorded separately from automated tests.

# Commit and Status Rules

- One reviewable task per commit whenever practical.
- Never mark a task complete based only on code presence; its specified test/build gate must pass.
- A phase cannot close with known red tests.
- External-integration tasks may be `BLOCKED` when credentials/VPS/device/provider access is genuinely absent; they may not be called PASS.
- Do not store provider credentials, node credentials, enrollment tokens, subscription tokens, session secrets, VAPID private keys, or REALITY private keys in GitHub source, Actions logs, test evidence, screenshots, or docs.

# Self-Review Mapping

- Product/PWA/Auth: Tasks 1–6.
- Atomic/idempotent Free/Premium accounting and Tehran reset: Tasks 7–11.
- Access profile, subscription, credential/token rotation: Tasks 12–15.
- Admin/audit: Tasks 16–17.
- Ads/payments/missions/push: Tasks 18–22.
- Node enrollment/agent/installer: Tasks 23–25.
- Xray/VLESS/REALITY and real VPS validation: Tasks 26–27.
- Real v2rayNG E2E: Task 28.
- Multi-node and speed enforcement: Tasks 29–30.
- Production security, recovery, real-device push/install, full acceptance: Tasks 31–34.

All mandatory requirements from the approved design are assigned to at least one task. The five Review Focus risks are exercised by explicit tests in Tasks 3–5, 7–10, 12–14, 18–25, and 31–34. No external provider or VPN behavior is treated as operational before its real integration gate passes.