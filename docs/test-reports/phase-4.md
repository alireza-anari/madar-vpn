# Phase 4 — Admin verification

Date: 2026-10-08
Branch: `impl/phase-1`

## Status

- Task 16 — Audited admin APIs: **PASS** for the implemented D1/Worker control plane.
- Task 17 — Non-technical Admin UI: **PASS** for operating-map coverage, honest unavailable states, loading/error/empty handling, and responsive/accessibility guards.
- Privileged browser submission: **READ-ONLY BY DESIGN IN CURRENT BOOTSTRAP**. `/admin` does not currently receive the session CSRF token, so mutation controls remain disabled instead of pretending success. Server mutation endpoints themselves are protected and tested.
- Phase 3 dependency: **NOT IMPLEMENTED YET**. Access profile, subscription rendering, and credential/subscription rotation are shown as unavailable; this report does not claim those capabilities work.

## Server-side admin evidence

Automated tests cover:

- administrator-only authorization for privileged mutations;
- CSRF enforcement for protected mutations;
- real resource listing without returning fabricated secrets;
- plan create/update/delete with audit events;
- mission editing without granting browser-controlled credit;
- node enrollment records that remain `enrolled` and do not fabricate readiness or client credentials;
- notification drafts that do not claim delivery when Push is unavailable;
- manual free-credit adjustment with a dedicated `manual` ledger kind, idempotency, and one audit event only when settlement is applied;
- absolute Premium adjustment with idempotent settlement and one audit event only when applied;
- user suspension enforced at the authentication boundary, including an already-issued session, with duplicate state changes not producing duplicate audit events;
- non-admin denial across privileged admin routes.

## Admin UI evidence

The admin surface includes explicit sections for:

- Overview and integration readiness;
- Users;
- Free Credit;
- Premium;
- Plans;
- Payments;
- Ads;
- Missions;
- Rewards;
- Push;
- Nodes;
- Health;
- Capacity;
- Free speed limit;
- Subscription status;
- access rotation;
- Audit history.

Provider- or control-plane-dependent modules that are not implemented are rendered as unavailable and do not expose fake success actions. No node credential or ready configuration is fabricated in the UI.

State tests cover loading, HTTP error, intentionally unavailable (`503`), and empty resource collections. Layout guards verify the admin grids are single-column on mobile and expand only at the defined desktop breakpoints. Form controls use associated labels and privileged actions remain disabled without the current session CSRF token.

## Verification gate

Latest full verification run before this report:

- Commit: `d0826ce4775a327612eafe2b982e067133367387`
- GitHub Actions run: `37744868871`
- `pnpm install --frozen-lockfile`: PASS
- `pnpm test`: PASS
- `pnpm typecheck`: PASS
- `pnpm build`: PASS
- `pnpm test:python`: PASS

A preceding full run on `8fffb44ede2f025aa3d85aac586f17655ca8172c` also passed after the loading/error/unavailable/empty-state implementation.

## Gate interpretation

The Phase 4 security gate is satisfied for implemented admin mutations: authorization and audit behavior are server-side, and unavailable integrations are visibly disabled rather than simulated.

This does **not** mean every Admin UI form is currently executable from the browser. Until the authenticated web bootstrap has a safe CSRF handoff, the current `/admin` route intentionally renders privileged controls read-only. That limitation must not be described as an operational admin mutation workflow.

The next implementation work should return to the missing Phase 3 Task 12 access-profile persistence instead of proceeding to Phase 5 provider adapters.
