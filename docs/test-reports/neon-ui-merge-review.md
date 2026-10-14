# Neon UI integration review

Date: 2026-10-14. Target: `impl/phase-10-task33-pwa-push`.

## Exact inputs and authorization

- Target source: `bb42d68e4f2046b2b2f6d40b5ed297ca7d93e939`, full CI `38558208621` success.
- UI source: `f8ae6ae9ad71682ddc3a115e0639245ce0401760`, full CI `38251006670` success, independently queried.
- Merge base: `a953d188a2bbd48444831bfc912df1c4478dfef3`.
- Operator requested review of the separately developed appearance branch and merge if sound on 2026-10-14.

The prepared merge has no conflicts. Effective changes are restricted to `apps/web/src/**` and UI design/verification documents. API, shared packages, PostgreSQL migrations, node agent, speed enforcer, service worker and public PWA assets are unchanged. Current Task 33 encrypted Push transport and own-account diagnostic backend routes remain intact; approved Premium release-scope amendment is retained.

## Review and verification

An independent read-only reviewer found no Critical/Important issue. The relocated `surfaces-legacy.tsx` is byte-identical to the old module, preserving administrative forms/actions. Auth, CSRF, secure subscription issuance, QR fallback and copy behavior are retained. Settings uses actual authenticated account state and only reports enabled after subscription persistence; permission remains explicit-button-only. Dashboard/catalog state comes from the server and purchase does not claim a successful checkout.

Local prepared-merge checks:

- Frozen dependency installation completed; local fallback pnpm is 11.25.0. The project pins 12.9.1, which the normal CI installs and validates.
- `pnpm test`: Web 33 files / 78 tests and API 48 files / 155 tests PASS.
- `pnpm build`: both Web and API PASS.
- `python3 scripts/security_scan.py .`: PASS.
- `git diff --cached --check`: PASS.
- Local `pnpm typecheck`: environment-blocked, TypeScript native executable cannot resolve `/proc/self/exe`. Both packages failed before typechecking. Full typecheck/PostgreSQL/Python/Go/audits must pass in normal candidate CI; this local result is not PASS.
- Browser layout inspection could not run: Playwright is installed but its Chromium executable is absent. No actual viewport/contrast or screenshot comparison is claimed. Existing DOM/CSS guards are not physical-device acceptance.

## Minor findings retained for follow-up

1. Login/result/dashboard lack a page-level h1 after shell brand heading removal; improve document heading hierarchy.
2. Denied/failed notification notices lack live-region semantics; inherited behavior, not introduced by this merge.
3. Settings shows Premium expiry as the server timestamp, whereas dashboard formats it.

These findings do not change authentication, authorization, billing or transport behavior and do not block this integration. No unsolicited product behavior changes or unrelated runtime repairs were added.

## Integration and release boundary

Publish the exact prepared merge candidate on a separate `impl/**` verification branch, run the whole normal CI, and advance the target only after success and a matching expected target head. Preserve both parents in the merge commit and all historical field evidence. Match local and remote trees before synchronizing.

This integration does not deploy staging. Because frontend/settings changed, previous Android/iPhone device observations remain historical; relevant final-candidate device acceptance must be repeated after a separately authorized deploy. No new device PASS is inferred. Phase 10 remains incomplete. Current release blockers and required final field checks in `final-acceptance.md` remain authoritative.
