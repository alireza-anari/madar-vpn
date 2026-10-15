# Reseller Bot and Shared Quotas Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Native execution by the current assistant preserves the user's previously selected method. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace retail bot flows with administrator/seller issuance of independent timed, volume-limited VLESS subscriptions and forwardable delivery with private live-usage links.

**Architecture:** Add an account model independent of Telegram user identities to existing D1. Assign each account to exactly one designated sales or trial node. The node persists cumulative usage and enforces limits locally; Worker stores monotonic reported totals and provides authorized bot and public capability-scoped status views. Keep current retail mode active until the compatible Agent has passed acceptance.

**Tech Stack:** Existing pinned TypeScript/Hono/D1/Vitest and Node browser tests, Python/sqlite3/pytest Agent and Runner, pinned Xray 26.3.27 and its loopback StatsService CLI. No OpenVPN, custom client, new paid service or simultaneous-device enforcement.

**Spec:** `docs/superpowers/specs/2026-10-15-reseller-quota-design.md` — user approved 2026-10-15.

## Global Constraints

- Preserve existing bot/Worker identity, secrets, website, historical financial data and existing VPS services.
- Roles: admin, seller, ordinary; seller owns accounts, not node administration. Admin numeric ID remains configured server-side.
- Each confirmed seller trial request creates one independent 1800-second trial; duplicate delivery of the same request creates no additional account.
- Sales and trial accounts use only their respective designated node. No cross-node quota spending or automatic reassignment.
- Byte quota is uplink plus downlink across all devices using that credential; 1 GB = 1,000,000,000 bytes.
- Expiry starts at valid ready ACK, never at failed provisioning; delivery requires the finalized expiry revision ACK.
- Local sample target 1 second; existing-stream cutoff target <=5 seconds after quota exhaustion is observed; healthy status update target <=15 seconds. These are acceptance gates, not claims from unit tests.
- Durable counters and pending reports survive restart; ambiguous quota state fails closed. No fabricated usage or guessed missing bytes.
- Forwarded Telegram messages are static; live values are in a private auto-refreshing HTTPS status page, with explicit last-report timestamp.
- No raw UUID, credentials, token, subscription link or SSH data in logs/evidence. Customer status has no management capability or identifying personal data.
- Personal needs read-only inventory before enrollment; do not bypass existing-service protection. Runner remains on Node1 unless a separate migration is authorized and verified.
- Native implementation; do not silently turn business goal of 10 sales into a hard-coded unchangeable issuance limit.

## Review Focus

1. Two seller confirmations/replayed inbox updates create one account and one durable delivery (Task 2).
2. A late quota report or old policy must not restore quota, shorten accounting history or re-enable revoked access (Tasks 1, 4, 5).
3. Xray byte counters must advance during an open long-running stream; delayed splice counters cannot satisfy the quota gate (Task 3).
4. Unclean process/Agent restart must not reset remaining volume or continue when continuity is ambiguous (Task 4).
5. Forwarded messages opened by a different Telegram user must retain status access without gaining seller/admin rights (Task 6).

## Files and Interfaces

- New Worker modules: `resellers.ts` (role membership), `accounts.ts` (creation/activation/revoke), `reseller-menus.ts` (conversations), `quota-reports.ts` (authenticated settlement), `account-delivery.ts` (VLESS/message/status capability), `status-routes.ts` (scoped GET), `public/status.html` (display).
- Add `migrations/0004-reseller-accounts.sql`; extend `contracts.ts` with `ManagedAccount`, `QuotaReport`, `QuotaClient` and versioned `QuotaPolicy`.
- New Agent modules: `stats.py`, `quota.py`, `quota_reports.py`; extend `agent.py`, `policy.py`, `xray.py`, `guard.py` and unit templates.
- Existing retail tests stay under default retail mode. New reseller-mode tests exercise removal of old mutation routes/callback effects.
- Exact input types: `AccountInput={kind:'sale'|'trial';label:string;quotaBytes:number|null;durationSeconds:number;requestKey:string}`; sale requires quota, trial duration is fixed at 1800 and has no hidden byte cap.
- Policy v2 client: `{accountId:string;uuid:string;quotaEpoch:number;quotaBytes:number|null;usedBytes:number;validUntil:number;generation:string}`. Report: `{accountId:string;quotaEpoch:number;sequence:number;totalBytes:number;observedAt:number;generation:string}`; numbers are nonnegative safe integers.

### Task 1: Additive schema, roles, account model and mode gate

**Files:** new migration, `resellers.ts`, `accounts.ts`, contracts; tests `resellers.test.ts`, `accounts.test.ts`.
**Interfaces:** `resolveSalesActor(db,id,env):Promise<{telegramId,role}>`; `createAccount(db,actor,input,now):Promise<{id,state}>`; `revokeAccount(db,actor,id,now)`; `setNodePurpose(db,admin,nodeId,purpose)`.

- [ ] Write RED tests: ordinary user denied; seller cannot add seller/node or view another seller account; duplicate `(seller_id,request_key)` maps to one account; trial length exactly 1800; invalid/unsafe integers and sale without quota rejected; schema migration preserves existing ledger/orders; revoked seller cannot create new accounts.
- [ ] Run `pnpm --filter @madar/sales-bot test`; confirm expected new-test failures.
- [ ] Implement additive tables `resellers`, `managed_accounts`, `account_quota_reports` and `node_purposes`; account UUID is per account rather than per seller. Store pending duration before activation; states preparing/active/exhausted/expired/revoked/blocked. Node purpose selection is admin-only and unique per purpose.
- [ ] Store app mode in settings (`retail` default, `reseller` after rollout). Preserve old Actor/retail behavior outside the new mode and deny legacy retail mutation callbacks in reseller mode.
- [ ] Run tests/typecheck and commit `feat: add seller roles and independent quota accounts`.

### Task 2: Seller/admin menus and idempotent issuance

**Files:** `reseller-menus.ts`, existing `menus.ts`, `inbox.ts`, tests `reseller-flows.test.ts`.
**Interfaces:** `handleResellerUpdate(env,update,now):Promise<void>` uses Task 1 accounts and existing durable inbox/outbox; `queueAccountDelivery(env,accountId,now)` is defined by Task 6.

- [ ] RED tests: admin manages numeric seller IDs/node purposes; seller sees only issue/trial/own-account/status menus; confirmed sale snapshots label/quota/duration; two concurrent/replayed confirmations create one account; each distinct trial request creates a different account; seller cannot spoof owner; old receipt/approve callbacks have no financial effect in reseller mode.
- [ ] Implement small explicit conversation states and one-use confirmation request keys; validate label 1..80 chars, sale quota 1..1000 GB, duration 1..365 days. Display confirmation before any issue. Issuance is preparing until compatible ready ACK. Admin may revoke any account; seller may view only own accounts.
- [ ] Test inbox crash after creation and before reply: retry emits the same account/delivery without duplicate quota. Keep secret account material out of callback data.
- [ ] Run Worker suite/typecheck and commit `feat: add Persian reseller issuance flows`.

### Task 3: Prove continuous Xray quota counters before enabling quotas

**Files:** `sales-node/stats.py`, `xray.py`, `tests/test_stats.py`; `docs/sales-bot/quota-counter-probe.md`.
**Interfaces:** `read_counters(server,account_ids)->dict[str,int]`; `render_config(settings,clients,now)` maps managed account IDs to user email and local-only StatsService.

- [ ] RED tests: uplink+downlink count once per account; reject unknown counter names, nonintegers, negative/decreasing counters, missing required counters and oversized CLI output; command invocation uses argv list, no shell and never logs raw output.
- [ ] Implement loopback `127.0.0.1` stats listener and pinned Xray CLI query with bounded timeout/output. Keep existing public REALITY port separate from API port; validate loopback port availability in installer.
- [ ] Run a local real pinned-Xray transfer probe with continuous open traffic and record deltas before connection close. Verify Xray docs/source at the pinned release; do not assume Vision/splice counters are timely. If Vision delays counters, use the documented no-Vision VLESS/REALITY flow consistently on server/export and repeat real compatibility/throughput probe. No mode is enabled without a passing open-stream counter result.
- [ ] Prove local API is unreachable on public listen addresses; run Python suite and record masked probe results. Commit `feat: add verified live Xray account counters` only for the proven path; mark missing environment BLOCKED rather than passing.

### Task 4: Persistent local quota engine and existing-stream cutoff

**Files:** `quota.py`, `quota_reports.py`, `agent.py`, `xray.py`, `guard.py`, unit templates; tests `test_quota.py`, `test_quota_restart.py`.
**Interfaces:** `QuotaStore(path)` with `observe(account,generation,counter,now)`, `remaining(account_id)`, `pending_reports()`, `ack_report(account_id,sequence)`, `reconcile_policy(policy,now)`; persisted SQLite under `/var/lib/madar-sales-node`, mode 0600.

- [ ] RED tests: two-device traffic shares one remaining balance; repeated sample doesn't add twice; sample and outbox commit atomically; restart preserves pending sequence and used total; quota epoch/revision rollback denied; unexpected reset/missing generation blocks the affected account; no policy refresh replenishes used volume; expired/revoked/exhausted clients removed.
- [ ] Implement persistent cumulative totals plus counter baseline/generation, signed remaining quota bounds and report outbox. Sample locally at 1 second independent of 30-second policy fetch; send batches at <=10 seconds under healthy network with bounded retry/backoff. The network path must not block local expiry/quota checks.
- [ ] Drain/freeze accounting before controlled Xray restart. Existing connections for exhausted/expired users must terminate; a validated config plus controlled process restart is permitted for the small initial deployment. Account for any interruption to other users. Ambiguous unclean reset closes access instead of granting a fresh quota.
- [ ] Extend watchdog to verify fresh local authorization AND quota-engine liveness. A hung/dead meter must not leave Xray transferring indefinitely. Test stalled API, hung CLI, disk write failure and meter death.
- [ ] Run all sales-node tests and local real-Xray open-download cutoff probe; commit `feat: enforce durable shared quotas on sales nodes`.

### Task 5: Authenticated quota reports, versioned policies and activation

**Files:** Worker `quota-reports.ts`, `node-api.ts`, `policies.ts`, `accounts.ts`; tests `quota-reports.test.ts`, `quota-policies.test.ts`; Agent policy validation.
**Interfaces:** `acceptQuotaReports(db,nodeId,reports,now):Promise<{accepted:number;duplicates:number}>`; `buildQuotaPolicy(db,nodeId,now):Promise<QuotaPolicy>`; `ackQuotaPolicy(db,nodeId,revision,health,now)`.

- [ ] RED tests: foreign node/account reports denied; duplicate/out-of-order reports never double debit or lower totals; conflicting sequence rejected; safe integers/body/batch size enforced; old epoch/policy ACK cannot reactivate exhausted/revoked account; no quota issue to legacy Agent.
- [ ] Implement transactionally monotonic server totals scoped to the assigned node and epoch, report idempotency constraints and revocation propagation. Never sum repeated cumulative totals. Limit a batch to 100 reports and body to 64 KiB.
- [ ] Use policy version 2 and Agent capability/readiness acknowledgement. Trial and sale activation set expiry exactly once from duration at first valid ready ACK; require the finalized-expiry policy ACK before sending the config. Each account only appears on its designated node. Incompatible Agents cannot be marked quota-ready.
- [ ] Run tests including network-loss then full duplicate batch retry; commit `feat: settle quota reports and activate reseller policies`.

### Task 6: Forwardable delivery and private refreshing usage page

**Files:** `account-delivery.ts`, `status-routes.ts`, `public/status.html`, `index.ts`; tests `account-delivery.test.ts`, `status.test.ts`, browser test; add browser test command to package script.
**Interfaces:** `queueAccountDelivery(env,accountId,now)`; `accountStatus(db,token,now):Promise<PublicStatus|null>`; GET `/usage/{token}` and GET `/api/usage/{token}`. PublicStatus only contains label, total/used/remaining bytes, expiry, state and lastReportAt.

- [ ] RED tests: config is unique per account and withheld until final ACK; delivery outbox stable across replay; customer message excludes seller Telegram ID/admin controls; status capability grants access only to its account, no mutation; guessed/rotated/revoked tokens rejected; valid copied/forwarded URL works without Telegram identity.
- [ ] Generate a 32-byte random status capability, hash for lookup; raw token is only in the private durable delivery payload and customer's link. No secret-bearing URLs in logs. Keep the QR/connection content private and avoid third-party QR services.
- [ ] Render ready-to-forward Persian message with public account label, volume/duration, expiry, copyable VLESS configuration, URL button and fallback status URL in text. Readiness is tied to Task 5 policy version.
- [ ] Implement no-store/no-referrer status HTML with refresh every 5 seconds while visible; show last report time and stale indication after 15 seconds rather than fabricated live values. Page never exposes UUID, node credentials, seller/customer identity or management actions. URL token should not enter analytics or external resources.
- [ ] Run Worker/browser suite and verify two distinct account links cannot read each other's data. Commit `feat: deliver forwardable configs with private live usage pages`.

### Task 7: Safe upgrade, CI and genuine device acceptance

**Files:** `sales-runner/installer.py`, artifacts/source manifest, tests `test_installer.py`; `.github/workflows/sales-bot.yml`; docs `reseller-rollout.md`, `reseller-acceptance.md`.
**Interfaces:** existing safe installer plus explicit owned sales-node update path; no arbitrary Runner command API and no persisted SSH credential reuse.

- [ ] RED tests: update requires matching managed-node ownership; private config and key identity survive update; unrelated Madar/Xray installation and occupied ports still stop preflight. Persisted quota directory is never removed during update/recovery. New installer includes all quota modules and loopback API configuration.
- [ ] Package/install only compatible namespaced Agent changes with verified immutable source/Xray artifacts. If retained SSH credentials are unavailable, prepare a checksum-pinned one-time update command for the owner; never bypass SSH authentication or existing-service guards.
- [ ] Keep retail active while migrating D1 and upgrading Madar_st1. Read-only inventory of Personal determines whether safe enrollment is possible. A conflict is BLOCKED and requires an explicit migration design, never overwrite-by-default. Register seller through admin flow when their numeric Telegram ID is supplied.
- [ ] Run complete Worker/node/Runner suites, typecheck/build and existing workspace regression checks affected by shared files, security scan and diff checks; verify exact-head remote CI. Perform a final focused review of quota/reset/auth/report/link boundaries and fix findings.
- [ ] Field acceptance with owner: real import/internet traffic on phone/laptop, combined usage on both devices, tiny test quota exhaustion while stream remains open, 1800-second trial expiry, restart/API outage/retry and revoke; status page on forwarded message from another Telegram account; Hamrah Aval/Irancell/ADSL results recorded at actual availability. Measure target sampling/cutoff/freshness under 10-user synthetic load.
- [ ] Switch reseller mode only after quota-capable ready nodes and automated gates pass; no sales-ready claim before required real acceptance. Keep missing Personal/network/device proofs BLOCKED. Do not stop retained VPSs or migrate Runner implicitly. Record deployed immutable version and secret-free results.

## Plan Self-review

Spec sections map to Tasks 1/2 (roles and independent accounts), 3/4/5 (real byte metering and local fail-closed enforcement), 6 (forwarded delivery/status), 7 (Personal onboarding, safe upgrade and field acceptance). All five review-focus failures have explicit owning tests. No unrequested concurrency/OpenVPN/payment subsystem is included. Remaining source-access and physical-network dependencies are acceptance prerequisites, not assumed successes.

## Execution handoff

Native execution in this session is the preserved method. This plan is ready for user review; implementation begins after plan review under the writing-plans workflow. The spec is already approved and must not be requested again.
