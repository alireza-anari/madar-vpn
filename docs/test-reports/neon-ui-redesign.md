# Neon UI Redesign Verification Report

Date: 2026-10-12

Branch: `impl/neon-ui-redesign`

Runtime acceptance SHA: `a1703231f39a3f00750a6956863faad8afbde454`

Runtime acceptance CI: run `38250587863`, job `verify` — **success**.

## Scope

The Native/neon redesign preserves the existing backend and account contracts while replacing the user-facing presentation with the approved RTL mobile-first visual language. The verified surfaces include the application shell and bottom navigation, magic-link login, dashboard, VPN access/subscription workflow, premium catalog, profile/settings, missions, and shared state/presentation primitives.

Task 8 itself is narrowly scoped. Comparing Task 7 green SHA `af2e509c2db7dfa78dd2f0bca6f06284b086b27a` to runtime acceptance SHA `a1703231f39a3f00750a6956863faad8afbde454` shows changes only under `apps/web/**`: the premium catalog stylesheet/wiring and responsive/accessibility acceptance tests. No Phase 9 deployment or field-evidence artifact was modified by this Task 8 delta.

## Truthfulness constraints

The verified UI does not invent product capability that the current backend does not expose:

- Dashboard status is derived from real `AccountView` entitlement and node state; there is no browser-side fake connect/disconnect control, fake Mbps telemetry, or invented server location.
- VPN access issuance remains the real authenticated subscription URL workflow. The bearer URL is readonly and direction-isolated; QR is shown only when it can be encoded, otherwise an explicit fallback is shown.
- Premium plans, duration, prices, and currency come from the authenticated backend catalog. Purchase remains disabled until a real checkout action is wired; there is no frontend-authoritative price or fake checkout success.
- Mission rewards remain server-authoritative. Evidence/referral states do not claim advertising/referral reward readiness or browser-side settlement.
- Settings/profile displays real account email and entitlement state only. It does not invent join date, avatar upload, device inventory, language selection, or support workflow.

## Automated verification

The full repository workflow passed at runtime acceptance SHA `a1703231f39a3f00750a6956863faad8afbde454`:

- Secret/security scan: passed.
- PostgreSQL schema contract: passed.
- PostgreSQL backup/restore contract: passed.
- PostgreSQL restore smoke: 1 test passed.
- PostgreSQL integration suite: 12 files / 45 tests passed.
- JavaScript dependency audit (`pnpm audit --audit-level high`): no known vulnerabilities.
- Python dependency audit (`pip-audit`): no known vulnerabilities.
- Go race tests: all speed-enforcer packages passed.
- Go vet: passed.
- Go production build: passed.
- Web Vitest: 33 files / 78 tests passed.
- API Vitest: 44 files / 128 tests passed.
- TypeScript typecheck: web and API passed.
- Production build: web and API passed.
- Node-agent Python suite: 185 tests passed.

The production web build also completed successfully with the neon/responsive styles included in the output bundle.

## Responsive review

Acceptance is guarded in code and tests around the following viewport classes and failure modes:

- Narrow/mobile is the default layout. The shell is constrained to `max-width: 100%`, accidental horizontal overflow is clipped, and the five-item bottom navigation uses equal `minmax(0, 1fr)` columns.
- Device safe-area insets are reserved on top, bottom, left, and right so fixed/mobile chrome does not collide with notches or home indicators.
- At `44rem`, wider/tablet layouts expand selected cards and two-column surfaces without introducing a fixed viewport width.
- At `68rem`, admin three-column surfaces expand for desktop while remaining single-column on smaller screens.
- Premium cards are mobile-first, use `min-width: 0`, and wrap long plan/currency values with `overflow-wrap: anywhere`.
- Long account email, dashboard identity, VPN bearer URL, and other mixed-direction values are contained and direction-isolated instead of forcing horizontal overflow.
- Acceptance guards reject large fixed pixel widths that would exceed normal mobile viewports in the reviewed surface styles.

## Accessibility review

The acceptance suite verifies semantic and keyboard-facing behavior in addition to visual layout:

- Visible controls retain accessible names; existing Button/Card/PageHeader/StatusBadge contracts remain backward compatible.
- Account email and VPN subscription URL are explicitly isolated as LTR values inside the RTL application.
- The subscription field is readonly and explicitly labelled.
- Generated QR images have meaningful alt text; an explicit text fallback is rendered when the URL cannot be encoded into a QR image.
- Global `:focus-visible` styling retains the configured focus ring.
- Decorative motion respects `prefers-reduced-motion`, including the Madar logo and decorative orbit elements.
- Notification permission is still requested only after an explicit user action, and install/help remains usable when notifications are unavailable or denied.

## Verification limits

This verification used GitHub Actions, unit/integration tests, semantic DOM acceptance tests, CSS/static responsive guards, typechecking, production builds, and the existing Python/Go verification suites. It does **not** claim a manual screenshot-by-screenshot browser or physical-device visual inspection was performed in this execution environment.

The wider `impl/neon-ui-redesign` branch contains earlier project history beyond this UI task. Therefore this report makes the narrower, verified statement only: Task 8 changes from `af2e509c2db7dfa78dd2f0bca6f06284b086b27a` to `a1703231f39a3f00750a6956863faad8afbde454` are web-only and did not modify Phase 9 deployment/field-evidence artifacts.
