# Madar Neon UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign Madar's existing user-facing PWA to closely match the approved dark-neon mobile references while preserving all current backend contracts, truthful readiness behavior, PWA security boundaries, and Phase 9 isolation.

**Architecture:** Keep the existing React/TypeScript route and data-fetching architecture. Build a richer presentation-only design system inside `apps/web`, then migrate Login, authenticated shell, Dashboard/Access, Premium, Profile/Settings, and secondary user surfaces onto those primitives without changing API wire shapes or backend business rules. The work remains isolated on `design/neon-ui-redesign` until its own tests/build are green and a later merge point is explicitly chosen.

**Tech Stack:** React, TypeScript, Vite, CSS custom properties/gradients/SVG, React Testing Library, Vitest, existing Playwright/PWA tooling.

**Spec:** `docs/superpowers/specs/2026-10-12-neon-ui-redesign-design.md`

## Global Constraints

- Visual source of truth is the four approved mobile reference screens supplied on 2026-10-12.
- Implementation scope is frontend-only: `apps/web/src/**`, frontend tests, and frontend/PWA presentation assets that do not weaken cache/security boundaries.
- Do not change `apps/api/**`, database/domain/contracts wire shapes, `node-agent/**`, `speed-enforcer/**`, Xray, telemetry/accounting, or node-policy semantics.
- Do not modify the active Phase 9 field-validation branch while implementing this plan.
- User-facing product language remains Persian RTL and mobile-first, with complete desktop behavior.
- Browser UI must not fabricate VPN tunnel state, node readiness, provider readiness, payment success, throughput, server location, subscription availability, or other production success.
- The dashboard status hero may visually resemble a power/status ring but must not become a fake VPN connect/disconnect control.
- Plan prices come from backend catalog data; `349,000` تومان is not a frontend constant.
- Login continues to use the existing magic-link request/consume behavior and states.
- Premium purchase remains disabled/unavailable until the existing real checkout path exists; visual redesign must not imply successful purchasing.
- Subscription URL and QR behavior must preserve current bearer-secret handling and PWA no-cache rules.
- Use CSS/SVG/pseudo-elements for orbital/neon visuals; do not add heavy animation/UI frameworks, autoplay video, or large raster backgrounds.
- `prefers-reduced-motion` must suppress non-essential visual motion.
- No horizontal overflow at supported phone widths; touch targets, focus visibility, semantic controls, and accessible labels remain mandatory.
- Admin functionality is not redesigned in this plan except for shared primitive changes that must remain backward-compatible.

## Review Focus

1. **Unavailable/backend-error states under the new visuals:** loading/error/unavailable screens must remain explicit and must never render sample success data; Task 7 owns regression tests.
2. **Route-specific bottom navigation:** active state must track the real current path, while `/login`, `/admin`, and unsupported paths must not show misleading user-nav selection; Task 2 owns tests.
3. **RTL mixed-direction content:** emails, URLs, prices, versions, and numeric values must remain readable without breaking Persian layout; Tasks 3–6 own targeted assertions.
4. **Narrow phones and safe areas:** fixed bottom navigation and decorative orbs must not cause horizontal overflow or cover content/home indicators; Tasks 2 and 8 own layout tests.
5. **Reduced motion and accessibility:** orbital/ring decoration must be ignorable by assistive tech and static under reduced-motion preference; Tasks 1 and 8 own tests.

---

## File Structure

### Shared visual system

- Modify: `apps/web/src/styles/tokens.css` — neon palette, surface/glow/radius/safe-area/typography tokens.
- Modify: `apps/web/src/styles/global.css` — document shell, reusable neon primitives, focus/reduced-motion behavior.
- Modify: `apps/web/src/styles/surfaces.css` — route composition for Login, Dashboard, Access, Premium, Missions, Settings/Profile.
- Create: `apps/web/src/components/MadarLogo.tsx` — accessible/static brand lockup and decorative ring mark.
- Create: `apps/web/src/components/StatusOrb.tsx` — presentation-only labeled status hero; no connection mutation behavior.
- Create: `apps/web/src/components/BottomNav.tsx` — path-aware authenticated navigation.
- Create: `apps/web/src/components/QuickAction.tsx` — link/button visual primitive for dashboard/access actions.
- Create: `apps/web/src/components/SettingsRow.tsx` — semantic settings/profile row primitive.
- Modify: existing `Card`, `Button`, `PageHeader`, `StatusBadge`, `TimeRing` only as needed to remain compatible with existing/admin call sites.

### Route/surface composition

- Modify: `apps/web/src/components/AppShell.tsx` — new header/brand/nav shell and safe-area behavior.
- Modify: `apps/web/src/app/App.tsx` — pass current path to shell; provide authenticated account data to settings/profile without changing API calls.
- Modify: `apps/web/src/app/auth-surface.tsx` — neon login and magic-link states.
- Modify: `apps/web/src/app/surfaces.tsx` — dashboard presentation and shared authenticated user surfaces only; admin exports/behavior remain functionally unchanged.
- Modify: `apps/web/src/app/access-surface.tsx` — real issue/copy/QR flow in reference-style cards.
- Modify: `apps/web/src/app/account-catalog-surface.tsx` — premium/missions visual redesign using real catalog values.
- Modify: `apps/web/src/pwa/PwaSettingsPage.tsx` — profile/account summary plus real install/push controls.

### Tests

- Create: `apps/web/src/components/neon-primitives.test.tsx`.
- Modify: `apps/web/src/components/AppShell.test.tsx`.
- Create or extend focused tests beside `auth-surface`, `access-surface`, `account-catalog-surface`, `PwaSettingsPage`, and Dashboard behavior.
- Modify: `apps/web/src/styles/layout.test.ts`.
- Modify existing app wiring tests only when necessary to pin unchanged API/readiness behavior.

---

### Task 1: Establish neon tokens, logo, and status primitives

**Files:**
- Modify: `apps/web/src/styles/tokens.css`
- Modify: `apps/web/src/styles/global.css`
- Create: `apps/web/src/components/MadarLogo.tsx`
- Create: `apps/web/src/components/StatusOrb.tsx`
- Create: `apps/web/src/components/neon-primitives.test.tsx`

**Interfaces:**
- Produces: `MadarLogo({ compact?: boolean }: { compact?: boolean }): JSX.Element`.
- Produces: `StatusOrb({ label, value, tone, supportingText }: { label:string; value:string; tone:'positive'|'neutral'|'warning'|'unavailable'; supportingText?:string }): JSX.Element`.
- Both are presentation-only; neither performs fetches or mutations.

- [ ] **Step 1: Write failing primitive accessibility tests**

Assert `MadarLogo` exposes `مدار` as readable brand text, its decorative ring is `aria-hidden`, `StatusOrb` exposes its supplied label/value as text, and no primitive renders a `button` unless explicitly passed an action (which these interfaces do not support).

- [ ] **Step 2: Run the focused tests and confirm RED**

Run: `pnpm --filter @madar/web test -- neon-primitives.test.tsx`

Expected: FAIL because the new primitives do not exist.

- [ ] **Step 3: Expand exact visual tokens in `tokens.css`**

Add named tokens for near-black navy background layers, cobalt/electric-blue, violet, cyan, positive green, amber/gold, destructive red, glass fills/borders, glow strengths, safe-area offsets, and compact/large radii. Keep existing token names as compatibility aliases where current components/admin styles consume them.

- [ ] **Step 4: Implement `MadarLogo` and `StatusOrb`**

Use semantic text plus CSS/SVG geometry; all purely decorative geometry is hidden from assistive technology. No runtime animation library or backend logic.

- [ ] **Step 5: Add reduced-motion/static styling**

Any ring breathing/orbit effect must be non-essential and disabled by the existing `prefers-reduced-motion` rule.

- [ ] **Step 6: Verify primitives and existing component tests**

Run: `pnpm --filter @madar/web test -- neon-primitives.test.tsx TimeRing.test.tsx`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/styles apps/web/src/components/MadarLogo.tsx apps/web/src/components/StatusOrb.tsx apps/web/src/components/neon-primitives.test.tsx
git commit -m "feat: add Madar neon visual primitives"
```

---

### Task 2: Rebuild the authenticated shell and path-aware bottom navigation

**Files:**
- Create: `apps/web/src/components/BottomNav.tsx`
- Modify: `apps/web/src/components/AppShell.tsx`
- Modify: `apps/web/src/components/AppShell.test.tsx`
- Modify: `apps/web/src/app/App.tsx`
- Modify: `apps/web/src/styles/global.css`
- Modify: `apps/web/src/styles/layout.test.ts`

**Interfaces:**
- Produces: `BottomNav({ currentPath }: { currentPath:string }): JSX.Element` with real destinations `/`, `/access`, `/premium`, `/missions`, `/settings` chosen from the current product routes.
- Changes: `AppShellProps` gains `currentPath: string`; existing `serviceStatus` semantics remain unchanged.
- `App` passes its already-derived `window.location.pathname` to `AppShell`; no new router dependency is introduced.

- [ ] **Step 1: Write failing navigation tests**

Assert the shell remains `dir="rtl"`/`lang="fa"`; brand links to `/`; each real user route is reachable; exactly the current route receives the active state/current-page semantics; `/admin` and `/login` do not falsely mark a user nav item current; service unavailable notice remains explicit.

- [ ] **Step 2: Run tests and confirm RED**

Run: `pnpm --filter @madar/web test -- AppShell.test.tsx`

Expected: FAIL because `BottomNav`/`currentPath` behavior does not exist.

- [ ] **Step 3: Implement `BottomNav` and shell composition**

Use lightweight inline SVG/icon geometry or text-safe icon marks already within the repo; no icon package dependency. Active item receives blue/violet emphasis plus luminous underline; inactive items remain readable.

- [ ] **Step 4: Wire `currentPath` from `App`**

Do not change route resolution, API fetches, or admin route behavior.

- [ ] **Step 5: Pin safe-area and narrow-width layout**

Update layout test assertions so the shell/nav use logical insets and `env(safe-area-inset-bottom)` without introducing fixed widths wider than the viewport.

- [ ] **Step 6: Verify shell/layout tests**

Run: `pnpm --filter @madar/web test -- AppShell.test.tsx layout.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/BottomNav.tsx apps/web/src/components/AppShell.tsx apps/web/src/components/AppShell.test.tsx apps/web/src/app/App.tsx apps/web/src/styles
git commit -m "feat: redesign Madar app shell navigation"
```

---

### Task 3: Redesign Login and magic-link result states

**Files:**
- Modify: `apps/web/src/app/auth-surface.tsx`
- Test: existing auth/app tests plus a focused auth-surface test file if no direct one exists
- Modify: `apps/web/src/styles/surfaces.css`

**Interfaces:**
- Keeps: `InteractiveLoginPage({ emailAvailable, requestLogin })` and `MagicLinkPage({ token, consume })` signatures unchanged.
- Consumes: Task 1 `MadarLogo`.
- No guest-login behavior is added because no current backend capability exists.

- [ ] **Step 1: Write failing visual/semantic login tests**

Assert: brand text `مدار`; heading/copy communicates secure/simple magic-link entry; email input remains `type=email` and `autocomplete=email`; submit state still disables correctly; unavailable/sent/error notices remain `role=status` where appropriate; no guest action appears; mixed-direction email placeholder/input remains LTR-safe.

- [ ] **Step 2: Run focused auth tests and confirm RED on the new structure/copy**

Run: `pnpm --filter @madar/web test -- auth`

Expected: new visual-structure assertions FAIL while existing auth behavior remains green or unchanged.

- [ ] **Step 3: Implement the reference-style login composition**

Use large centered `MadarLogo`, CSS/SVG orbital hero, Persian headline, bordered email field, blue-violet gradient primary CTA, and a security note card. Preserve request/consume state machine exactly.

- [ ] **Step 4: Restyle all magic-link result states with the same visual language**

Checking/success/invalid/error remain separate, honest states; token removal from URL history remains unchanged.

- [ ] **Step 5: Verify auth tests**

Run: `pnpm --filter @madar/web test -- auth App.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/app/auth-surface.tsx apps/web/src/app/*auth*.test.tsx apps/web/src/styles/surfaces.css
git commit -m "feat: redesign Madar magic-link login"
```

---

### Task 4: Redesign Dashboard and real VPN Access flow

**Files:**
- Create: `apps/web/src/components/QuickAction.tsx`
- Modify: `apps/web/src/app/surfaces.tsx` (`DashboardPage` user-facing section only)
- Modify: `apps/web/src/app/access-surface.tsx`
- Modify: existing dashboard/access tests
- Modify: `apps/web/src/styles/surfaces.css`

**Interfaces:**
- Produces: `QuickAction({ href?, label, description?, disabled?, onClick?, icon }: ...)` as a semantic link/button depending on supplied action.
- Consumes: Task 1 `StatusOrb`/`MadarLogo` presentation primitives.
- Keeps: `DashboardPage({ account }: { account: AccountView })` and `AccessPage({ readiness, issue })` data contracts unchanged.

- [ ] **Step 1: Write failing Dashboard truthfulness tests**

Assert: premium/free entitlement derives only from `account.entitlement`; connected/disconnected copy derives only from existing `account.node.connectionStatus`; no fake live Mbps values render; unavailable/not-ready node state is visible; the hero/status visual is not a connect/disconnect button.

- [ ] **Step 2: Write failing Access behavior tests**

Pin existing behavior: issue disabled while not ready; successful issue reveals QR when encodable and readonly LTR subscription URL; copy action uses `navigator.clipboard`; issue/copy failures remain explicit; raw subscription URL is not inserted into unrelated decorative elements.

- [ ] **Step 3: Run focused tests and confirm RED on redesigned structure**

Run: `pnpm --filter @madar/web test -- access-flow Dashboard`

Expected: new structure assertions FAIL.

- [ ] **Step 4: Implement reference-style Dashboard**

Compose status orb, entitlement card, real service/node readiness, and quick actions. Dashboard quick actions navigate to `/access` for actual issue/copy/QR operations rather than presenting nonfunctional copy/QR controls. Do not invent server location or throughput if `AccountView` does not provide them.

- [ ] **Step 5: Redesign `AccessPage` around the real issue/copy/QR workflow**

Use glass/neon cards, clear bearer-secret treatment, accessible QR alt text, and LTR isolation for the URL/version values.

- [ ] **Step 6: Verify dashboard/access regression tests**

Run: `pnpm --filter @madar/web test -- access-flow App.test.tsx`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/QuickAction.tsx apps/web/src/app/surfaces.tsx apps/web/src/app/access-surface.tsx apps/web/src/app/*access*.test.tsx apps/web/src/styles/surfaces.css
git commit -m "feat: redesign dashboard and VPN access"
```

---

### Task 5: Redesign Premium catalog using real backend plans

**Files:**
- Modify: `apps/web/src/app/account-catalog-surface.tsx`
- Create or modify: focused catalog tests
- Modify: `apps/web/src/styles/surfaces.css`

**Interfaces:**
- Keeps: `PremiumCatalogPage({ paymentAvailable, plans })` and `AccountCatalogView['plans']` unchanged.
- Price formatter continues to derive amount/currency from `priceMinor` and `currency`; no frontend business price constant is introduced.

- [ ] **Step 1: Write failing catalog truthfulness tests**

Assert every rendered plan uses supplied title/duration/price/currency; zero plans shows the real empty state; payment unavailable keeps purchase disabled and explicit; payment available still does not claim checkout works because the current component has no real checkout action; no `349000`, `199000`, `499000`, or screenshot price is hard-coded as authority.

- [ ] **Step 2: Run focused catalog tests and confirm RED on visual structure**

Run: `pnpm --filter @madar/web test -- account-catalog`

Expected: new composition assertions FAIL.

- [ ] **Step 3: Implement subscription hero and plan-card composition**

Match the reference hierarchy: premium hero/benefits, stacked mobile plan cards, neon selected/recommended visual only when it can be derived without fake discount claims. If no honest recommendation rule is available, omit the badge.

- [ ] **Step 4: Preserve disabled purchase semantics**

Do not introduce a click handler, redirect, toast, or fake success until a real checkout interface exists.

- [ ] **Step 5: Verify catalog tests**

Run: `pnpm --filter @madar/web test -- account-catalog`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/app/account-catalog-surface.tsx apps/web/src/app/*catalog*.test.tsx apps/web/src/styles/surfaces.css
git commit -m "feat: redesign premium subscription catalog"
```

---

### Task 6: Build the Profile/Settings surface around real account, install, and push state

**Files:**
- Create: `apps/web/src/components/SettingsRow.tsx`
- Modify: `apps/web/src/pwa/PwaSettingsPage.tsx`
- Modify: `apps/web/src/pwa/PwaSettingsPage.test.tsx` or existing equivalent
- Modify: `apps/web/src/app/App.tsx`
- Modify: `apps/web/src/styles/surfaces.css`

**Interfaces:**
- Changes frontend-only `PwaSettingsPage` props to additionally accept `account: AccountView` or a presentation-safe subset `{ identity, entitlement }`; no API wire type changes.
- Keeps push/install action interfaces and permission timing unchanged.
- `AccountRoute(mode='settings')` must resolve account loading/error/unavailable honestly before rendering settings and then pass real account data.

- [ ] **Step 1: Write failing profile/account tests**

Assert the page displays supplied email with direction isolation, tier/entitlement status from supplied account, and never invents join date, avatar upload, device list, language picker, or support workflow not backed by current capability.

- [ ] **Step 2: Extend existing PWA tests before implementation**

Pin: notification permission is requested only after explicit button action; denied permission leaves page usable; unsupported notifications remain honest; install prompt behavior remains unchanged; push unavailable cannot appear enabled.

- [ ] **Step 3: Run focused settings tests and confirm RED for new account props/composition**

Run: `pnpm --filter @madar/web test -- PwaSettingsPage`

Expected: new profile assertions FAIL.

- [ ] **Step 4: Implement `SettingsRow` and reference-style profile cards**

Render account summary, current entitlement, real PWA install controls, real notification controls, and static explanatory privacy/security/support information only where noninteractive. Omit dead interactive rows.

- [ ] **Step 5: Fix `AccountRoute` settings-state ordering**

Require real account `ready` state before profile rendering; preserve existing loading/error/unavailable components and do not make a new API request.

- [ ] **Step 6: Verify settings/push/app wiring tests**

Run: `pnpm --filter @madar/web test -- PwaSettingsPage App-push-wiring.test.tsx App.test.tsx`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/SettingsRow.tsx apps/web/src/pwa apps/web/src/app/App.tsx apps/web/src/styles/surfaces.css
git commit -m "feat: redesign Madar profile settings"
```

---

### Task 7: Harmonize Missions, loading/error/unavailable, and shared cards without breaking Admin

**Files:**
- Modify: `apps/web/src/app/account-catalog-surface.tsx` (missions section)
- Modify: `apps/web/src/app/App.tsx` (presentation panels only if needed)
- Modify: `apps/web/src/components/Card.tsx`
- Modify: `apps/web/src/components/Button.tsx`
- Modify: `apps/web/src/components/PageHeader.tsx`
- Modify: `apps/web/src/components/StatusBadge.tsx`
- Modify: `apps/web/src/styles/global.css`
- Modify: `apps/web/src/styles/surfaces.css`
- Test: existing missions/admin/component tests

**Interfaces:**
- Shared component public props remain backward-compatible so Admin surfaces continue to compile and behave without redesign-specific data dependencies.
- Missions submission state machine and status types remain unchanged.

- [ ] **Step 1: Add shared-primitive compatibility tests**

Assert current `Button` variants, `Card` children, `PageHeader` labels, and `StatusBadge` tones still render semantically after visual changes.

- [ ] **Step 2: Add unavailable/error regression assertions**

For account/catalog failure/unavailable fixtures, assert no sample plan/node/mission or positive-ready copy appears and the explicit error/unavailable copy remains visible.

- [ ] **Step 3: Run focused regression tests**

Run: `pnpm --filter @madar/web test -- missions admin App.test.tsx`

Expected: existing tests PASS before behavior changes; new visual assertions may be RED.

- [ ] **Step 4: Restyle Missions and state panels with the neon system**

Preserve evidence submission, latest status, reward minutes, and disabled unsupported ad/referral behaviors exactly.

- [ ] **Step 5: Apply backward-compatible shared primitive styling**

Do not force user-surface layout assumptions into Admin; shared components may gain classes/visual variants but not required user-only props.

- [ ] **Step 6: Verify full frontend unit suite**

Run: `pnpm --filter @madar/web test`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/app apps/web/src/components apps/web/src/styles
git commit -m "feat: harmonize Madar neon user surfaces"
```

---

### Task 8: Responsive/accessibility verification and branch acceptance

**Files:**
- Modify: `apps/web/src/styles/layout.test.ts`
- Modify/Create: focused accessibility/responsive tests under `apps/web/src/**`
- Modify/Create: `docs/test-reports/neon-ui-redesign.md`

**Interfaces:**
- No new runtime interface.
- Produces final branch evidence only; does not merge to the Phase 9 branch.

- [ ] **Step 1: Add narrow/mobile layout assertions**

Pin no component relies on fixed viewport-exceeding widths; app shell content reserves bottom-nav/safe-area space; long email/URL/plan values can wrap or isolate without horizontal overflow.

- [ ] **Step 2: Add reduced-motion and keyboard/focus assertions**

Verify motion styles are suppressed under `prefers-reduced-motion`, icon-only controls have accessible names, and focus-visible styling remains present.

- [ ] **Step 3: Run frontend unit tests**

Run: `pnpm --filter @madar/web test`

Expected: PASS.

- [ ] **Step 4: Run typecheck and production build**

Run:

```bash
pnpm typecheck
pnpm build
```

Expected: PASS.

- [ ] **Step 5: Run the repository-wide non-field regression suite that is safe for this branch**

Run the existing CI-equivalent commands required by the repository, without claiming or rerunning Phase 9 field evidence from this UI branch.

Expected: all automated checks green; no field-validation claim is changed.

- [ ] **Step 6: Record UI acceptance evidence**

Create `docs/test-reports/neon-ui-redesign.md` with exact branch SHA, commands/results, tested viewport classes, reduced-motion/accessibility coverage, and explicit statement that Phase 9 VPN field evidence is unchanged and not superseded.

- [ ] **Step 7: Self-review diff scope**

Confirm changed runtime files are confined to `apps/web/**`; documentation changes are only the redesign spec/plan/report; no backend/node/speed-enforcer contract file changed.

- [ ] **Step 8: Commit final evidence**

```bash
git add apps/web docs/test-reports/neon-ui-redesign.md
git commit -m "test: verify neon UI redesign"
```

- [ ] **Step 9: Observe CI for the exact UI branch head**

Expected: complete automated CI green. Do not merge automatically and do not change any `Production Ready` or Phase 9 PASS status from this UI work.

---

## Completion Contract

The redesign implementation is complete only when:

1. Login, Dashboard/Access, Premium, Profile/Settings, Missions, and authenticated navigation share the approved neon visual language.
2. The user-facing layouts remain mobile-first RTL and responsive without horizontal overflow.
3. Real backend values/states remain the sole source of production status, entitlement, plans, readiness, and subscription output.
4. No fake browser VPN control, throughput, location, payment success, provider success, or server success has been introduced.
5. PWA install/push security and permission behavior remains unchanged.
6. Existing Admin behavior still compiles/tests despite shared visual primitive updates.
7. Frontend tests, repository typecheck/build, and applicable automated CI are green on one exact UI branch SHA.
8. The Phase 9 branch and its field-evidence SHA/status have not been modified by this redesign branch.

## Self-Review Result

- **Spec coverage:** all spec sections map to Tasks 1–8; unsupported reference-screen features are explicitly omitted rather than faked.
- **Type consistency:** existing `AccountView`, `AccountCatalogView`, `AccessReadiness`, `IssuedAccess`, magic-link result types, and PWA action interfaces stay authoritative; only frontend component props are added where needed.
- **Review Focus coverage:** unavailable/error states (Task 7), nav routing (Task 2), mixed direction (Tasks 3–6), safe areas/narrow widths (Tasks 2/8), and reduced motion/accessibility (Tasks 1/8) all have explicit tests.
- **Scope:** no implementation task requires backend, database, node, Xray, telemetry, or Speed Enforcer changes.
- **Proportion:** tasks are split at independently reviewable visual/behavior boundaries and each has its own RED→GREEN verification/commit cycle.