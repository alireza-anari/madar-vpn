# Madar Neon UI Redesign Design

**Status:** Proposed visual/product-surface redesign — approved in conversation, pending written-spec review
**Date:** 2026-10-12
**Repository:** `alireza-anari/madar-vpn`
**Branch:** `design/neon-ui-redesign`
**Base:** `a953d188a2bbd48444831bfc912df1c4478dfef3`

## 1. Purpose

Redesign the existing Madar user-facing PWA so it visually matches the approved four-screen mobile reference set: a dark navy Persian RTL interface with electric blue/violet/cyan neon accents, luminous rings, glassy cards, rounded geometry, strong mobile hierarchy, and a persistent bottom navigation.

This is a frontend presentation redesign, not a change to VPN semantics, accounting, node behavior, API contracts, database rules, Xray, telemetry, Speed Enforcer, or Phase 9 field-validation logic.

The redesign must preserve the product's existing honesty constraints: browser UI must never fabricate VPN connection state, node readiness, payment success, provider readiness, push delivery, or subscription availability.

## 2. Isolation and safety

The redesign work lives on `design/neon-ui-redesign`, created from commit `a953d188a2bbd48444831bfc912df1c4478dfef3`.

The active Phase 9 implementation/field-validation branch is not modified by this design/spec work. Merge back only after the UI branch is independently green and the Phase 9 owner chooses a safe integration point.

Allowed implementation scope:

- `apps/web/src/**`
- frontend-only test files under `apps/web/**`
- PWA presentation assets that do not change service-worker security boundaries
- frontend documentation/evidence

Out of scope unless separately approved:

- `apps/api/**`
- `packages/database/**`
- `packages/domain/**`
- `packages/contracts/**` wire-shape changes
- `node-agent/**`
- `speed-enforcer/**`
- Xray configuration or lifecycle
- telemetry/accounting semantics
- Node policy semantics
- payment/provider backend behavior

If the existing frontend cannot render a required state without an API-contract change, the UI must show the best honest representation possible and record the missing backend capability instead of silently changing the contract.

## 3. Visual source of truth

The four approved mobile reference screens define the visual direction:

1. Home/dashboard with luminous power/status ring, current location/status, active-subscription card, quick access actions, live throughput/location cards, and bottom navigation.
2. Email magic-link login with large Madar mark, cosmic/orb hero art, secure-login messaging, bordered email field, gradient CTA, guest/secondary action, and security note.
3. Profile/settings with account card, current-subscription card, settings rows, notification controls, support/privacy/language/device sections, logout treatment, and bottom navigation.
4. Subscription catalog with marketing hero card and stacked plan cards using blue/violet neon borders, highlighted recommended plan, and mobile purchase actions.

The redesign should match the visual language and hierarchy closely, but must adapt content to actual Madar capabilities and truthful backend state.

## 4. Design principles

### 4.1 Mobile first

Primary target width is modern mobile PWA portrait use. The layout must remain usable from narrow phones through large phones without horizontal overflow. Tablet/desktop expands spacing and grid structure rather than stretching one narrow column excessively.

### 4.2 Persian RTL first

All user-facing navigation, hierarchy, labels, cards, field alignment, and icon placement must be designed for RTL rather than mirrored as an afterthought. Latin fragments such as email, versions, URLs, and numeric values must remain readable with appropriate direction isolation.

### 4.3 Premium neon, not visual noise

Use glow selectively for:

- Madar ring/logo
- primary CTA
- selected navigation item
- subscription highlight
- important status/entitlement emphasis

Avoid glowing every container. Most cards should use low-contrast glass surfaces and fine blue borders so highlighted elements retain hierarchy.

### 4.4 Real states over decorative states

A beautiful unavailable/error state is preferred to a fabricated success state. Existing loading, unavailable, degraded, denied, pending, and error states remain first-class.

### 4.5 Motion is optional

Ambient ring/orb motion may be used only when subtle and non-essential. `prefers-reduced-motion` must disable or effectively eliminate it.

## 5. Color and material system

The existing dark theme evolves into a richer token system.

### Background layers

- deepest page background: near-black navy
- elevated shell/card surfaces: dark blue with controlled transparency
- inset surfaces: slightly lighter navy
- backdrop gradients: low-opacity cobalt/violet/cyan radial fields

### Accent family

- electric blue for primary structure and active controls
- violet/purple for premium emphasis and gradient transitions
- cyan for ring edge/highlight and secondary accent
- green only for true positive/active/healthy state
- amber/gold for subscription/crown emphasis where semantically appropriate
- red only for destructive/logout/error emphasis

### Surfaces

Cards use a combination of:

- semi-transparent dark fill
- 1px low-opacity blue border
- optional internal highlight gradient
- mild backdrop blur where supported
- restrained shadow

Glowing cards are reserved for selected/recommended/active items.

## 6. Brand mark

The Madar mark is a luminous circular/orbital ring paired with the Persian word `مدار`.

Implementation should prefer CSS/SVG/vector geometry over raster-only branding so it scales cleanly and supports reduced-motion/accessibility. The mark must have a static fallback and must not depend on heavy animation.

The brand lockup appears prominently on Login and compactly in authenticated top bars.

## 7. Typography

Use a Persian-capable system/web-safe stack already permitted by the project, without adding a new font dependency unless separately reviewed.

Hierarchy:

- prominent, bold Persian page titles
- medium-weight card titles
- clear numeric/entitlement values
- muted explanatory/support copy
- compact metadata and status labels

Line height must remain generous enough for Persian readability. Visual polish must not reduce accessible contrast.

## 8. App shell and navigation

### 8.1 Authenticated shell

Mobile authenticated pages use:

- safe-area-aware top padding
- compact brand/top action row
- central content column
- fixed/floating bottom navigation with glass background
- safe-area-aware bottom padding so content is never obscured by nav/home indicator

### 8.2 Bottom navigation

User navigation follows the visual reference while mapping only to real product surfaces.

Target items are derived from existing app routes/features, with labels such as:

- خانه
- دسترسی/سرورها where appropriate to current routing
- اشتراک‌ها
- اعتبار/ماموریت‌ها where currently supported
- پروفایل/تنظیمات

Exact item count may vary by authenticated route architecture, but the shell must not expose dead/fake destinations merely to match the screenshot.

The active item gets violet/blue emphasis and a short luminous indicator.

### 8.3 Desktop

Desktop may use a wider centered shell, optional side/upper navigation adaptation, and multi-column cards. It must retain the same visual language rather than becoming a separate design system.

## 9. Login surface

The login page is redesigned to match the second reference.

Structure:

1. Back/secondary navigation only where route semantics require it.
2. Large centered Madar brand.
3. Short Persian brand promise.
4. Decorative orbital/cosmic hero constructed with lightweight CSS/SVG.
5. Heading: secure/simple entry messaging.
6. Existing magic-link email input.
7. Primary gradient `ارسال لینک ورود` action.
8. Optional secondary/guest action only if the existing product actually supports it; otherwise omit it.
9. Security note explaining the one-time, short-lived login link.
10. Honest states for provider unavailable, request pending, sent, invalid, expired, replayed, and error.

The redesign does not change magic-link API behavior.

## 10. Dashboard/home surface

The dashboard should feel closest to the first reference while respecting web/PWA limitations.

### 10.1 Hero status ring

A large luminous circular hero visual represents account/access status, not a fake browser-controlled VPN tunnel.

It may display states such as:

- access available
- access unavailable
- subscription/credit state
- node/subscription readiness where real data exists

It must not claim `متصل` solely because the web page is open. If no authoritative connected-state signal exists, copy must describe access/readiness rather than active tunnel connection.

The visual may resemble a power button, but it must not masquerade as a functional VPN connect/disconnect control unless a real supported action exists.

### 10.2 Entitlement card

Show the real entitlement:

- Premium: expiry/remaining duration and unlimited-traffic product copy if that is the active commercial offering
- Free: actual remaining free credit and applicable speed policy
- unavailable: explicit unavailable/degraded treatment

### 10.3 Quick actions

Use the existing access functionality for actions such as:

- دریافت کانفیگ / subscription URL
- کپی لینک
- QR

Actions must preserve bearer-secret handling rules and existing API boundaries.

### 10.4 Throughput and location

Only show upload/download throughput when trustworthy real telemetry exists for the account/client surface. Do not invent live numbers for visual parity.

Node/location may show current eligible/selected location only when actual backend data supports it. Otherwise use a truthful availability/status card.

## 11. Subscription/Premium catalog

The catalog follows the fourth reference while using real plan data from the backend.

### Hero

Explain the commercial promise in concise Persian copy: high-speed, stable, secure access, with time-based plans and no user-facing volume meter for the intended Premium product.

### Plan cards

Each backend plan renders as a visual card with:

- duration/title
- backend price/currency
- availability/enabled state
- purchase action only when the current payment path supports it
- optional UI-only merchandising badge (`پیشنهادی`, `به‌صرفه`) derived deterministically from plan position/value, not from fake discount data

Do not hard-code screenshot prices as authoritative product data.

The monthly price discussed for product strategy (`349,000` تومان) is not a frontend constant; if adopted, it belongs in real plan configuration/admin data.

## 12. Profile and settings

The profile/settings surface follows the third reference.

Sections map to real capabilities only:

- account identity/email
- account status
- current subscription/entitlement
- notifications/push settings
- service-status notifications where supported
- device/account-security area only when real management behavior exists
- language/time-zone preferences only if implemented
- privacy information
- support/contact path
- PWA/install/push settings
- logout

Rows that are not implemented must not appear as interactive dead ends. Where useful, a disabled/unavailable row may appear only if explicitly labeled unavailable and product value justifies exposing it.

## 13. Shared component redesign

Existing primitives are retained conceptually but restyled/extended:

- `AppShell`
- `Card`
- `Button`
- `PageHeader`
- `StatusBadge`
- `TimeRing`

Likely new frontend-only primitives:

- `MadarLogo`
- `GlowRing` / `StatusOrb`
- `BottomNav`
- `GlassCard`
- `MetricCard`
- `QuickAction`
- `PlanCard`
- `SettingsRow`
- `NeonIconBadge`

New primitives should remain presentation-focused and receive data/state via props. They must not own backend business rules.

## 14. CSS architecture

The token layer expands first, followed by shell/primitives, then page-specific surfaces.

Target organization may remain:

- `styles/tokens.css` — color, spacing, radii, glow, typography, z-index, safe-area tokens
- `styles/global.css` — reset, document/app shell, shared primitive styles
- `styles/surfaces.css` — page/surface composition

If page complexity makes `surfaces.css` unwieldy, split into frontend-only page CSS modules/files without changing runtime architecture.

No utility-CSS framework or new styling runtime is required for this redesign.

## 15. Accessibility

Required:

- WCAG-conscious text/background contrast despite neon effects
- keyboard-visible focus states
- semantic buttons/links/forms
- accessible labels for icon-only controls
- no status conveyed by color alone
- screen-reader text for decorative/functional distinction
- touch targets suitable for mobile
- no horizontal overflow at supported phone widths
- reduced motion support
- logical heading order
- form errors associated with fields

Decorative orbit/ring elements are `aria-hidden` unless they communicate a real labeled state.

## 16. Performance

The visual target must not require large video backgrounds or heavy animation libraries.

Prefer:

- CSS gradients
- SVG
- pseudo-elements
- small optimized static assets only when necessary

Avoid:

- autoplay video
- canvas-heavy ambient effects
- large raster phone mockups inside the production UI
- unnecessary third-party visual dependencies

The PWA must remain responsive on mid-range mobile devices.

## 17. PWA/security invariants

The redesign must preserve existing PWA/security rules:

- no authenticated API caching
- no auth response caching
- no subscription/bearer-secret caching
- no QR-bearing sensitive response caching
- no secrets in frontend bundle
- push permission only after explicit user action
- offline shell must not fabricate current account/VPN state

## 18. State model and honesty rules

Every redesigned surface must retain explicit UI states for:

- loading
- ready
- unavailable
- degraded where currently modeled
- error
- empty
- permission denied where applicable

Real server data remains authoritative.

Specific prohibitions:

- no fake connected timer
- no fake live Mbps values
- no fake node country/location
- no fake active Premium state
- no fake successful payment
- no fake push enabled state
- no fake QR/subscription URL

## 19. Testing strategy

### Existing behavior regression

All current frontend tests must continue to pass unless a test is intentionally updated for presentational markup while preserving behavior.

### New visual-structure tests

Add focused tests for:

- Madar brand rendered on core surfaces
- mobile bottom navigation and active-state semantics
- dashboard does not claim connected when only access/readiness data exists
- no fake throughput values in unavailable state
- plan cards use backend plan values
- login preserves magic-link request states
- settings/push controls retain explicit-action behavior
- RTL and direction isolation
- reduced-motion behavior
- narrow viewport has no horizontal overflow

### Verification commands

At minimum before merge:

```bash
pnpm --filter @madar/web test
pnpm --filter @madar/web build
pnpm typecheck
```

Full repository CI should be run at the final integration point.

## 20. Implementation sequencing

Recommended order after this written spec and implementation plan are approved:

1. Expand design tokens and introduce reusable brand/neon primitives.
2. Redesign `AppShell` and bottom navigation.
3. Redesign Login and auth states.
4. Redesign Dashboard/access presentation while preserving honest status semantics.
5. Redesign Premium/plan catalog using real backend data.
6. Redesign Profile/Settings/PWA-push settings.
7. Apply shared visual language to remaining user surfaces (missions, free credit, access states).
8. Responsive/desktop pass.
9. Accessibility/reduced-motion/performance pass.
10. Run frontend suite/build/typecheck and then full CI before proposing merge.

Admin UI is intentionally not part of the first visual-parity pass. It may receive token-level consistency automatically, but a full admin redesign should be a separate follow-up unless implementation proves it can be safely included without scope expansion.

## 21. Acceptance criteria

The redesign is acceptable when:

- on mobile, the product is immediately recognizable as the approved dark-neon Madar design rather than the current minimal dark UI;
- Login, Dashboard, Subscription, and Profile/Settings closely follow the hierarchy and visual language of the four approved references;
- Persian RTL behavior is native and polished;
- no backend/API/data-plane behavior changes are required for the visual redesign;
- no fake VPN connection/speed/location/payment/provider state is introduced;
- all existing supported real actions still work;
- unavailable/error/loading states are visually complete;
- reduced motion and accessibility remain supported;
- mobile overflow and fixed-navigation overlap are prevented;
- frontend tests, build, and typecheck pass on the redesign branch;
- merging the UI branch can be scheduled independently of Phase 9 field validation.

## 22. Non-goals

This redesign does not:

- implement an in-browser VPN tunnel;
- turn the hero ring into a fake Connect button;
- change Free/Premium accounting;
- change Premium concurrency enforcement;
- change Node capacity policy;
- change Xray/VLESS/REALITY behavior;
- change Speed Enforcer behavior;
- add real throughput telemetry if backend support is absent;
- change payment/provider integration readiness;
- declare the product Production Ready.
