# Madar Final Acceptance Matrix

**Date:** 2026-10-09  
**Branch:** `impl/phase-1`  
**Status:** **BLOCKED — not Production Ready**

This document is the Task 34 release-gate matrix. It distinguishes deterministic repository/CI evidence from external acceptance that requires real providers, VPS hosts, VPN clients, or physical devices. Automated success is never used as a substitute for a required real integration check.

## Status definitions

- **PASS** — the exact acceptance item has current evidence sufficient for the scope required by the implementation plan.
- **BLOCKED** — prerequisite external infrastructure, provider credentials, VPS/client environment, or physical device evidence is unavailable; no failure of the implemented automated boundary is implied.
- **FAIL** — the required acceptance was run and failed.

No item below is marked PASS solely because source code exists.

## Task 34 acceptance matrix

| # | Acceptance item | Status | Evidence / rationale |
| --- | --- | --- | --- |
| 1 | Run all TS/Python automated suites, typecheck and production build | **PASS** | Final repository CI run `37907030529` on commit `ef6f0a48db8eaf7e34fce00c756077ddd75ec9aa` passed secret scan, PostgreSQL schema, destructive backup/restore, restored-DB Worker HTTP smoke, PostgreSQL runtime smoke, PostgreSQL integration tests, npm/pip audits, full JS/TS tests, TypeScript typecheck, production build, and Python tests. |
| 2 | Re-run account creation and prove the one-time 30-minute grant | **BLOCKED** | PostgreSQL integration proves the **1,800-second grant invariant exactly once**, and auth/session persistence is CI-verified. However the final acceptance item asks for the real account-creation flow; no configured real email delivery/provider acceptance has been run in this environment. Automated invariant: PASS. Real email/account creation path: NOT RUN. |
| 3 | Re-run v2rayNG import, real connection and VPS traffic | **BLOCKED** | `docs/test-reports/phase-7-vps.md` records that no disposable real VPS was available and no real Xray/VLESS/REALITY traffic traversal was run. Without that prerequisite, current real v2rayNG import/traffic cannot be accepted. |
| 4 | Re-run debit-start / debit-stop behavior | **BLOCKED** | Automated accounting covers telemetry identity dedupe, concurrent usage summation, Premium zero-debit behavior, and prior-day isolation. The plan requires the final debit start/stop re-run against real observed VPN activity; no real VPS traffic/activity source has been exercised. |
| 5 | Verify a valid rewarded-ad callback grants +15 minutes only with a real configured provider | **BLOCKED** | Provider-neutral verification and PostgreSQL settlement/idempotency are automated and PASS, including exactly one 900-second reward per verified event. No real rewarded-ad provider credentials/callback acceptance exists, so the release item remains blocked exactly as required by Task 34. |
| 6 | Verify Tehran midnight reset and Premium survival with controlled clock/integration evidence | **PASS** | `apps/api/integration/credits.postgres.test.ts` runs against PostgreSQL with instants immediately before/after Tehran midnight and proves free credit projects to the new Tehran day while Premium expiry remains unchanged. The current final CI run includes and passes this PostgreSQL integration suite. |
| 7 | Verify entitlement expiry → real revoke; recharge → real re-enable | **BLOCKED** | Control-plane policy/revocation primitives and fail-closed behavior have automated coverage, but real Xray/VLESS/REALITY enforcement has not been exercised on a VPS. The required live revoke/re-enable proof is NOT RUN. |
| 8 | Re-run Client ID rotation and Subscription URL rotation | **BLOCKED** | PostgreSQL/API tests prove credential/token rotation state, old bearer invalidation, and renderer behavior. The Task 34 re-run requires the real lifecycle against v2rayNG/VPS: old client credential must fail after revocation, refresh must obtain working new config, old subscription URL must fail, and the new URL must refresh successfully. That real path is NOT RUN. |
| 9 | Re-run second node, unhealthy removal, Free speed cap and Premium no-app-cap | **BLOCKED** | No second real VPS acceptance exists. Per-client Free speed enforcement is intentionally not represented as ready: the approved design requires a real per-client mechanism and measured throughput; a node-wide or fabricated cap is forbidden. Admin readiness reports speed enforcement as unavailable until real proof exists. |
| 10 | Re-run Android/iPhone PWA install and real Web Push | **BLOCKED** | `docs/test-reports/phase-10-device-readiness.md` proves the automated prerequisites: explicit permission gesture, denied/unsupported usability, authenticated CSRF bootstrap/rotation, public-only VAPID bootstrap, browser subscription persistence/rollback, and App wiring. Real Android install, iPhone Add to Home Screen, and real Push delivery on target devices are NOT RUN. |
| 11 | Create this final acceptance report with PASS/FAIL/BLOCKED and evidence references | **PASS** | This file records every Task 34 item without upgrading blocked external gates to PASS. |
| 12 | Use `Production Ready` only when every required item is PASS | **PASS as a release-control rule; release remains BLOCKED** | This report explicitly does **not** label Madar Production Ready. Multiple mandatory items remain BLOCKED. The plan's final `chore: record production acceptance` commit is intentionally not used yet. |

## Phase 10 recovery prerequisite outside the Task 34 row list

Task 32 is also required before the overall Phase 10 release gate can close:

| Recovery item | Status | Evidence |
| --- | --- | --- |
| PostgreSQL disposable backup/restore and restored Worker serving | **PASS** | `docs/test-reports/postgres-runtime-migration.md`, `docs/test-reports/phase-10-recovery.md`, and current CI restore/HTTP-smoke gates. |
| Database and node recovery runbooks | **PASS** | `docs/runbooks/database-restore.md` and `docs/runbooks/node-recovery.md`. |
| Real node reinstall/re-enroll/recovery without secret reuse/exposure | **BLOCKED** | `docs/test-reports/phase-10-recovery.md` records disposable-VPS execution as NOT RUN. |
| Installer `update` and `remove` on a disposable real VPS | **BLOCKED** | Automated lifecycle tests exist, but the plan explicitly requires disposable-VPS evidence; none exists in this environment. |

## Supporting automated evidence that does not replace blocked real gates

- **PostgreSQL runtime:** `docs/test-reports/postgres-runtime-migration.md` records PostgreSQL as the authoritative runtime, D1 retirement, destructive restore, restored Worker HTTP serving, integration/concurrency/idempotency coverage, audits, tests, typecheck, and build.
- **Security/abuse:** `docs/test-reports/phase-10-security.md` records Task 31 hardening.
- **Recovery:** `docs/test-reports/phase-10-recovery.md` records database recovery PASS and real disposable-VPS lifecycle BLOCKED.
- **Real VPS:** `docs/test-reports/phase-7-vps.md` records Task 27 as BLOCKED and forbids claims of real VPN integration from automated adapter tests alone.
- **Provider-neutral adapters:** `docs/test-reports/phase-5.md` records automated rewarded-ad/payment/mission/Push boundaries as verified while real provider/device integrations remain unverified. Its historical note that browser Push persistence was not wired is superseded for that narrow prerequisite by `docs/test-reports/phase-10-device-readiness.md`; real-device Push remains BLOCKED.
- **PWA/Push readiness:** `docs/test-reports/phase-10-device-readiness.md` records the current secure browser subscription prerequisite path as automated-PASS / real-device-NOT-RUN.

## Blocking set before Production Ready

The minimum unresolved external acceptance set currently includes:

1. disposable real Ubuntu VPS install/enrollment/Xray/Agent health, real traffic, revoke, and stale-policy fail-closed;
2. current real v2rayNG import/connection/traffic and credential/subscription rotation lifecycle;
3. real server-observed debit start/stop behavior;
4. a second real node, unhealthy/capacity filtering, and cross-node rotation/traffic;
5. a proven **per-client** Free speed mechanism with measured Free throughput near the configured cap and Premium with no Madar-imposed application cap;
6. real rewarded-ad provider callback acceptance for the +900-second grant;
7. real email delivery/account-creation acceptance;
8. real entitlement expiry/revoke and recharge/re-enable on Xray;
9. real node recovery plus installer `update` / `remove` on a disposable VPS;
10. Android PWA install/relaunch and iPhone Add to Home Screen/standalone acceptance;
11. real Web Push subscription, delivery, display, and denied-permission behavior on the supported target devices;
12. target-environment deployment acceptance such as real Cloudflare/Hyperdrive/provider secret configuration and live smoke/monitoring, where applicable to the release environment.

## Release decision

**BLOCKED.** The repository/CI implementation has strong automated coverage and the current full gate is green, but mandatory external acceptance remains outstanding. Madar must not be described as `Production Ready`, VPN E2E verified, v2rayNG verified, speed-cap verified, real-provider verified, or real-device Push verified until the corresponding blocking items above have current real evidence and every mandatory Task 34 row is PASS.
