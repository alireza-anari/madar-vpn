# Phase 5 — Ads / Payments / Missions / Push verification

Date: 2026-10-08
Branch: `impl/phase-1`

## Status

- Task 18 — Provider verification contracts: **PASS** for the provider-neutral automated boundaries.
- Task 19 — Rewarded-ad settlement: **PASS** for verified, idempotent server-side settlement behavior.
- Task 20 — Plans/orders/manual and provider payment settlement: **PASS** for the implemented server-created order and settlement paths.
- Task 21 — Missions and rewards: **PASS** for evidence/review/referral verification and idempotent reward settlement.
- Task 22 — Web Push and PWA install/notification UX: **PASS** for the automated API, persistence, VAPID boundary, service-worker, and browser-gesture behavior.
- Real provider/device delivery: **INTEGRATION-UNVERIFIED**. No claim is made that a real rewarded-ad provider, payment provider, or Web Push device has completed an end-to-end transaction without the corresponding production credentials/device checks.
- Browser Push subscription mutation: **READ-ONLY BY DESIGN IN CURRENT BOOTSTRAP**. The current web bootstrap does not receive a safe session CSRF token handoff, so it does not request notification permission when it cannot securely persist the resulting Push subscription. The backend Push CRUD remains authenticated and CSRF-protected.

## Provider boundary evidence

Automated tests verify the provider-neutral rules used by Phase 5:

- an unconfigured provider remains unavailable instead of fabricating success;
- forged or unverifiable provider callbacks are rejected;
- provider parsing/verification does not directly grant ledger credit;
- repeated provider events are treated idempotently at the settlement boundary.

Provider-specific production success remains outside this automated gate until real credentials and callback/device evidence are supplied.

## Rewarded-ad evidence

The rewarded-ad settlement path is server-authoritative:

- a verified rewarded-ad event can settle the configured free-credit reward;
- replay of the same provider event does not grant the reward twice;
- a browser countdown or client-only endpoint cannot grant credit;
- verified evidence is bound to the intended user before settlement.

## Payment evidence

Payment tests cover the shared settlement rules:

- a browser return/navigation URL cannot settle an order;
- an administrator confirmation settles a pending order once;
- provider callback order/amount mismatch is rejected;
- replay of a provider callback does not extend Premium twice;
- a valid renewal extends from the later of the current Premium expiry or the settlement time.

The implementation stores server-created orders and routes both manual confirmation and verified provider callbacks through the same authoritative settlement behavior.

## Mission evidence

Mission tests cover:

- evidence submission starts in a pending state;
- approval grants the configured reward exactly once;
- rejection grants no reward;
- repeating an approval cannot grant a second reward;
- referral rewards require server-verified referral evidence/rules rather than a share click;
- approved mission rewards settle into the existing free-credit ledger with an idempotent mission submission key.

Mission definitions remain administered through the existing mission resource rather than a second source of truth.

## Push and PWA evidence

Automated Push/PWA coverage verifies:

- Push subscriptions are stored only for the authenticated user;
- mutation routes require the existing CSRF-protected authenticated session boundary;
- D1 subscription persistence upserts an endpoint while preserving ownership semantics;
- expired provider subscriptions are removed when the delivery boundary reports an expired endpoint;
- VAPID configuration is exposed through a provider boundary and does not report fabricated delivery when a real transport is absent;
- API, auth, and subscription-secret requests are excluded from service-worker runtime caching;
- the service worker handles `push` and `notificationclick`, displays a notification, and restricts navigation targets to safe same-origin relative paths;
- notification permission is requested only after an explicit user click;
- denied or unsupported notification capability leaves installation guidance and the rest of the app usable;
- when secure browser subscription persistence is not wired, the notification control is disabled and permission is not requested;
- Android `beforeinstallprompt` is captured and invoked only after a user click;
- iPhone Home Screen installation instructions remain available independently of notification support.

## Integration limitations

The following are intentionally not represented as proven production success:

- real Web Push delivery requires production VAPID credentials, a real delivery transport/provider path, and a supported device/browser;
- the current browser bootstrap has no safe CSRF-token handoff for Push subscription mutation, so UI subscription registration remains disabled rather than weakening the server mutation boundary;
- real rewarded-ad and payment provider behavior requires selected/configured provider credentials and live callback tests.

These limitations preserve the Phase 5 rule that unavailable integrations are explicit and no fake success state is shown.

## Verification gate

Latest full verification run before this report:

- Commit: `51e00c38b28d643796223162011059be171fe548`
- GitHub Actions run: `37775751150`
- `pnpm install --frozen-lockfile`: PASS
- `pnpm test`: PASS
- `pnpm typecheck`: PASS
- `pnpm build`: PASS
- `pnpm test:python`: PASS

A preceding full run on `f9fd738fa012b9575e0f1e981f5256989a729927` also passed after the service-worker Push/notification-click implementation.

## Gate interpretation

The automated Phase 5 security/replay gate is satisfied for the implemented provider-neutral settlement, mission reward, Push ownership/persistence, and PWA behavior. Actual third-party/provider/device checks remain explicitly pending where production credentials or devices are unavailable.

Phase 6 may proceed without treating those pending external integrations as already verified.
