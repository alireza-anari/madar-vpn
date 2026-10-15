# Telegram Sales Bot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver an independent Persian Telegram VPN sales bot with manual payment approval and automatic Ubuntu node enrollment.

**Architecture:** A separate Worker owns Telegram, D1 state and node policies. An authenticated Python Runner installs a separate node Agent over SSH; both poll the public HTTPS control API without laptop bridges. The existing website and Madar runtime remain isolated.

**Tech Stack:** Existing Node >=22 / pnpm@12.9.1 workspace; TypeScript, Hono, Vitest with actual D1 integration via Cloudflare test runtime; Python 3.10+ / pytest for Runner and Agent. Select and pin a maintained SSH library and exact Xray artifact release after checking official documentation at implementation time.

**Spec:** `docs/superpowers/specs/2026-10-14-telegram-sales-bot-design.md` (approved 2026-10-14).

## Global Constraints

- Separate Worker `madar-sales-bot`, separate D1; no mutation of website runtime, bindings, database, retained VPS services or SSH/firewall settings.
- Ubuntu 22.04 / 24.04 LTS; AWS ubuntu key login and root key/password login; interactive sudo passwords stop installation.
- One 30-minute wall-clock trial per Telegram account, starting after valid node ACK; paid plans time-only, prices unset initially.
- Manual receipt approval; financial effects exactly once per order; no active-second billing, device lock or bank verification.
- Credential ciphertext expires after 15 minutes and is deleted on success/failure/expiry; no secrets in logs, argv, git or Telegram SSH messages.
- SSH host fingerprint approval for first trust; changed host keys stop execution; private/metadata/loopback targets rejected.
- No paid resources automatically created; Runner placement and real VPS access are deployment prerequisites.
- Token entry occurs only after code is ready. Mock tests do not constitute Telegram, SSH or VPN field acceptance.

## Review Focus

1. Duplicate concurrent approve callbacks must produce one extension (Task 2).
2. Telegram receipt from another customer's order must not change that order (Task 3).
3. Expired SSH ciphertext after a Runner crash must require new input rather than reconnect (Task 5).
4. Old ACK after renewal must not make new policy ready (Task 6).
5. An installed VPS with an unrelated service on the chosen port must stop without modifying it (Task 7).

## File Structure and Shared Contracts

Create `apps/sales-bot/` for Worker code, migrations and tests; `sales-runner/` for SSH executor; `sales-node/` for Agent; `docs/sales-bot/` for runbooks. Root changes limited to lockfile and a dedicated CI workflow. Do not edit existing application source or installer.

`apps/sales-bot/src/contracts.ts` defines:
- `Actor = { telegramId: string; role: 'admin' | 'customer' }`
- `Policy = { nodeId: string; revision: number; expiresAt: number; clients: { credentialId: string; uuid: string; validUntil: number }[] }`
- `InstallJob = { id: string; nodeId: string; targetIp: string; port: number; username: string; hostFingerprint: string; encryptedCredentials: string; credentialsExpireAt: number; leaseUntil: number; artifactVersion: string }`
- Public statuses never include `encryptedCredentials`, client UUIDs, token values or private keys. Policy and credential delivery require scoped authentication.
- All timestamps epoch seconds UTC; IDs strings; amounts integer smallest currency units with explicit currency.

## Task 1: Worker foundation, authenticated inbox and durable delivery

**Files:** Create `apps/sales-bot/{package.json,tsconfig.json,wrangler.jsonc,vitest.config.ts}`, `src/{contracts,index,auth,telegram,outbox}.ts`, `migrations/0001.sql`, `test/webhook.test.ts`.

**Interfaces:** `authenticateUpdate(request: Request, env: Env): Promise<TelegramUpdate | null>`; `resolveActor(telegramId: string, env: Env): Actor`; `recordUpdate(db: D1Database, update: TelegramUpdate): Promise<boolean>`; `deliverOutbox(env: Env, now: number): Promise<void>`. Env binds SALES_DB and server-configured admin IDs, bot and webhook secrets. No token required for tests.

- [ ] Write tests asserting missing/wrong webhook secret returns 401; duplicate update_id produces one inbox row; admin ID checks use exact numeric strings; database failure returns non-2xx; outbound transient error remains retryable.
- [ ] Run `pnpm --filter @madar/sales-bot test -- test/webhook.test.ts`; confirm intended failure before implementation.
- [ ] Implement inbox/outbox schema, webhook and scheduled retry, bounded retries and dead-letter status. Reuse current dependency versions only after verifying current official APIs. Respond 200 only after durable persistence; scheduled processor drains inbox and outbox without reliance on floating promises.
- [ ] Run the same tests with real test D1 and typecheck; expect PASS.
- [ ] Commit `feat: add sales bot durable webhook foundation`.

## Task 2: Plans, orders and entitlement ledger

**Files:** Create `src/{orders,entitlements,plans}.ts`, `test/orders.test.ts`; extend migration before first deployment or add numbered migration after deployment.

**Interfaces:** `createOrder(db, actor: Actor, planId: string, now: number): Promise<Order>`; `approveOrder(db, actor: Actor, orderId: string, now: number): Promise<ApprovalResult>`; `reserveTrial(db, actor: Actor): Promise<TrialResult>`; `startTrialAfterAck(db, userId: string, revision: number, now: number): Promise<void>`. Approved expiry is max(now, previousExpiry) + snapshot duration.

- [ ] Write tests: two concurrent approvals yield one ledger entry; changed plan price does not alter an existing order; replay approval adds zero seconds; customer approval denied; trial starts with expiry now+1800 only after ACK and cannot be reserved twice; prices unset disable ordering.
- [ ] Run `pnpm --filter @madar/sales-bot test -- test/orders.test.ts`; expect intended FAIL.
- [ ] Implement transaction-safe conditional statements and unique constraints with D1 batch semantics; preserve audit and order snapshots; reject stale/invalid state transitions.
- [ ] Run tests against real test D1 and typecheck; expect PASS.
- [ ] Commit `feat: add transactional sales orders and timed entitlements`.

## Task 3: Persian customer/admin bot flows

**Files:** Create `src/{menus,callbacks,receipts,admin}.ts`, `test/flows.test.ts`; connect `src/index.ts` inbox dispatch.

**Interfaces:** `handleUpdate(env: Env, update: TelegramUpdate, now: number): Promise<void>` uses Task 1 Actor and Task 2 orders; `recordReceipt(db, actor: Actor, orderId: string, fileId: string): Promise<void>`. Telegram file IDs are opaque; no arbitrary receipt URL fetch.

- [ ] Write tests: /start exposes customer menus; only admin sees privileged actions; forged admin callback denied; another customer's receipt cannot modify order; approval shows preparing while no ready node exists; callbacks replay without repeated financial effect; plan and payment details edited by admin persist; rejection reason sent to owner only.
- [ ] Run `pnpm --filter @madar/sales-bot test -- test/flows.test.ts`; expect intended FAIL.
- [ ] Implement concise Persian menus, private-chat receipt intake, server-owned conversation state and audited admin actions. Support plan duration/price/payment destination, user revoke and node status; use callback IDs rather than embedding secrets.
- [ ] Run flows and order tests; expect PASS.
- [ ] Commit `feat: add Persian sales and administration conversations`.

## Task 4: Secure VPS Mini App and enrollment jobs

**Files:** Create `src/{miniapp-auth,enrollment,targets}.ts`, `public/enroll.html`, `test/enrollment.test.ts`.

**Interfaces:** `verifyMiniApp(initData: string, botToken: string, now: number): Promise<Actor>` validates official HMAC and configured admin allowlist; `createEnrollment(env, actor: Actor, input: EnrollmentInput, now: number): Promise<{jobId:string}>`. Inputs include numeric public IP, port 1..65535, username, ciphertext and pinned fingerprint; credentials encrypt in browser with pinned Runner public key via a reviewed public-key envelope implementation. Server stores 900-second credential expiry and hashes one-use enrollment secrets.

- [ ] Write tests: forged initData and auth_date over five minutes rejected; nonce replay rejected; non-admin denied; IPv4/IPv6 private, loopback, link-local, mapped-private and metadata addresses rejected; public IP preserved exactly; validation/log output contains no secret; missing fingerprint confirmation creates no runnable job.
- [ ] Run `pnpm --filter @madar/sales-bot test -- test/enrollment.test.ts`; expect intended FAIL.
- [ ] Implement authenticated short session/CSRF nonce, form encryption and lifecycle cleanup; authenticate Runner APIs with scoped service secret and never expose ciphertext to generic admin status endpoints. SSH credential acquisition and initial fingerprint probe remain distinct: probe uses no login secret, returned fingerprint requires admin approval before install.
- [ ] Run enrollment tests and manually inspect form on mobile; expect PASS and usable error copy.
- [ ] Commit `feat: add secure admin node enrollment form`.

## Task 5: Runner lease protocol and SSH execution boundary

**Files:** Create `sales-runner/{pyproject.toml,runner.py,ssh_transport.py,credential_envelope.py}`, `sales-runner/tests/{test_runner.py,test_transport.py}`, `src/runner-api.ts`, `test/runner-api.test.ts`.

**Interfaces:** Worker `leaseJob(env, runnerId: string, now: number): Promise<InstallJob|null>`, `reportJob(env, jobId: string, leaseId: string, state: string, safeCode: string): Promise<void>`; Python `run_job(job: dict, transport: SshTransport, clock) -> JobResult`. Lease 120 seconds, renew every 30 seconds; one target lock. Runner decrypts using private key held locally outside repo.

- [ ] Write tests: two runners cannot lease one target; expired lease cannot report success; restart reconciles stage before continuing; expired 900-second ciphertext is deleted and requires reentry; changed fingerprint blocks authentication; key/password login uses library API without shell argv; failure cleans temporary credentials; logs omit injected secret canaries.
- [ ] Run `python3 -m pytest sales-runner/tests` and Worker runner-api tests; expect intended FAIL.
- [ ] Implement authenticated polling, signed job envelope verification, pinned-host SSH, bounded timeouts and checkpoint reporting; no arbitrary command endpoint. Select/pin maintained SSH dependency from official primary docs. Expose fingerprint probe separately without requesting or using credentials.
- [ ] Run the same tests; expect PASS.
- [ ] Commit `feat: add leased SSH provisioning runner`.

## Task 6: Node policies, ACK and customer config delivery

**Files:** Create `src/{policies,node-api,subscriptions}.ts`, `test/policies.test.ts`, `sales-node/{agent.py,policy.py,xray.py}`, `sales-node/tests/test_policy.py`.

**Interfaces:** `buildPolicy(db, nodeId: string, now: number): Promise<Policy>`; `ackPolicy(db, nodeId: string, revision: number, health: HealthReport): Promise<void>`; `getSubscription(db, userId: string, now: number): Promise<SubscriptionResult>`. Python `apply_policy(policy: dict, now: int) -> ApplyResult`; per-node credentials and HMAC policy signatures. Policy lifetime 300 seconds, poll every 30 seconds; watchdog revokes after expiry even during API outage. Trial reservation ACK enables issuance, then entitlement start yields finalized policy revision and required ACK before delivery.

- [ ] Write tests: old ACK cannot ready renewal; unhealthy node omitted; cross-user subscription access denied; expired/revoked credential removed; node replayed/stale policy rejected; trial timing starts after ACK and finalized entitlement is acknowledged; no policy after TTL can leave Xray authorized.
- [ ] Run Worker policy tests and `python3 -m pytest sales-node/tests`; expect intended FAIL.
- [ ] Implement signed scoped polling and atomic Xray configuration update/reload, explicit readiness by revision, hashed customer subscription tokens and private config messaging. Use separate units/paths under madar-sales naming; no changes to existing Agent.
- [ ] Run tests including simulated control-plane outage; expect PASS with fail-closed result.
- [ ] Commit `feat: add independent sales node policy and subscription service`.

## Task 7: Idempotent Ubuntu installer and recovery

**Files:** Create `sales-runner/{installer.py,artifacts.py}`, `sales-runner/templates/{madar-sales-node.service,madar-sales-watchdog.service}`, `sales-runner/tests/test_installer.py`, `docs/sales-bot/installer.md`.

**Interfaces:** `preflight(transport: SshTransport, target: Target) -> PreflightResult`; `install(transport: SshTransport, job: dict) -> InstallResult`; `reconcile(transport: SshTransport, job: dict) -> InstallResult`. Names `/opt/madar-sales-node`, `/etc/madar-sales-node`; artifact manifest pins exact Xray version and SHA256 per supported architecture.

- [ ] Write tests: unsupported Ubuntu stops; root/ubuntu noninteractive sudo supported; interactive sudo rejected; existing Madar/Xray or port conflict stops without file/firewall/SSH mutation; checksum mismatch stops; second run preserves completed install identity; partial failure rollback removes only owned files; reboot without valid policy remains closed.
- [ ] Run `python3 -m pytest sales-runner/tests/test_installer.py`; expect intended FAIL.
- [ ] Implement preflight, pinned fetch and atomic install, ownership manifest and bounded rollback. Verify artifact source/license and official Xray configuration syntax before pinning release; do not reuse legacy installer on retained nodes.
- [ ] Run suite and Ubuntu 22.04/24.04 disposable integration fixtures with both key/password transports where available; mark unavailable environments BLOCKED rather than PASS.
- [ ] Commit `feat: add safe idempotent Ubuntu node installation`.

## Task 8: CI, deployable Worker and secure activation runbook

**Files:** Create `.github/workflows/sales-bot.yml`, `docs/sales-bot/{activation,acceptance,operations}.md`; update sales Worker config only.

**Interfaces:** Runbook names bindings SALES_DB, BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, ADMIN_TELEGRAM_IDS, RUNNER_SERVICE_SECRET and policy-signing secret. Private Runner key remains on Runner; public encryption key is configured in form. Activation command validates bot identity before setting webhook and preserves secrets without printing them.

- [ ] Write deployment/config tests asserting separate Worker/D1, no default admin, no guessed prices, no secret defaults and bot-disabled health response without token.
- [ ] Run tests; expect intended FAIL.
- [ ] Implement config and CI for TypeScript/D1 and Python; document secret entry, webhook setup, Runner install, enrollment, rotation, backup/restore and incident revocation. Load Cloudflare/wrangler skills and official docs before deployment. Create only explicitly authorized independent Worker and free-eligible storage; stop at any paid resource requirement.
- [ ] Run all new suites, typecheck and appropriate existing workspace regression checks; obtain independent final branch review and resolve actionable findings.
- [ ] Commit/push branch, verify CI at exact HEAD, deploy tokenless Worker and verify health. Record immutable deployment version and bindings without secret values.
- [ ] Provide user secure token/admin setup instructions. Do not declare live bot or automatic provisioning complete before real acceptance below.

## Field Acceptance and Deployment Dependencies

- [ ] Confirm an approved Runner host and disposable Ubuntu target; do not change retained Madar instances by inference.
- [ ] After user enters token securely, verify real webhook and admin/customer separation.
- [ ] Enroll target via Mini App fingerprint confirmation and encrypted SSH data; verify install, ACK and readiness without laptop relay.
- [ ] Test customer trial, receipt, duplicate approval, paid subscription, actual v2rayNG internet egress, renewal, timed expiry and revocation; record outcomes without token/config secrets.
- [ ] Verify shutdown/API outage fail-closed, recovery and removal of transient credentials.
- [ ] Publish acceptance with explicit PASS/FAIL/BLOCKED and cleanup checks. No sales-ready claim with blocked gates.

## Self-review

Spec coverage maps bot/security to Tasks 1–4, execution security to Task 5, policy/readiness to Task 6, Ubuntu provisioning to Task 7, and operational handoff to Task 8. All five review-focus failures have owning tests. Runner placement, token entry and genuine field targets remain explicit deployment dependencies; no new authorization for existing server mutations is inferred. Execution method is selected by the user after reviewing this plan.
