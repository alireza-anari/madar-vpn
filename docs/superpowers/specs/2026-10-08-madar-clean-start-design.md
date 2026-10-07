# Madar Clean Start Design

**Status:** Approved architecture baseline
**Date:** 2026-10-08
**Repository:** `alireza-anari/madar-vpn`

## 1. Purpose

Build **Madar**, a Persian RTL, mobile-first installable PWA for selling and providing VPN access. The project is a strict clean start: no code, architecture, database, repository history, credentials, or implementation decisions from the previous Velo/WireGuard project may be reused.

The product must never claim an integration or VPN path is operational until that path has been verified end-to-end with the real external dependency involved.

## 2. Source-of-truth order

For product behavior, `vpn-app-design-v2.md` is authoritative. For execution details, `vpn-app-implementation-plan-v2.md` is authoritative. `madar-start-guide-v2.md` is supporting context only where it does not conflict with the first two documents or the current project brief.

The current project brief overrides historical delivery/status claims in the start guide because this repository starts from zero.

Any administrator key or secret found in prior documentation is considered compromised/historical and must not be reused.

## 3. Product identity and UX

- Product name: **مدار**.
- Persian RTL throughout.
- Very dark navy background, light text, electric-blue accent.
- Minimal, modern and distinctive visual language.
- Mobile-first, with complete desktop behavior.
- Dashboard centers on a credit/time ring.
- Free accounts show remaining free time.
- Premium accounts show expiration date.
- VPN/node status must come from real telemetry/readiness. No fake browser-side Connect control is allowed.

Primary user surfaces:

- Login
- Dashboard
- VPN Access
- Subscription / QR / Copy
- Free credit
- Rewarded ads
- Premium
- Missions
- Purchase history
- Settings
- Install PWA / Notifications

## 4. Identity and authorization

### User authentication

Users sign in with email and a single-use magic link.

Magic-link requirements:

- high-entropy token;
- hash-only persistence;
- explicit expiry;
- single consumption;
- replay rejection;
- server-side verification.

Session cookies must be `HttpOnly`, `Secure`, and use an appropriate `SameSite` policy. Sensitive mutations require CSRF protection and origin validation.

### Administration

Admin authorization is independent of ordinary user identity. There is no public role switch and no administrator secret entered into the browser UI. Administrator membership is server-controlled and auditable.

## 5. Account and entitlement rules

### Initial free credit

After the first successful email verification, a user receives exactly **1,800 seconds** of free credit once. Re-login, new sessions, devices, or subsequent magic links must never repeat the grant.

### Rewarded ads

A server-verified valid rewarded-ad callback grants exactly **900 seconds** of free credit.

The reward must be idempotent by provider event identity. A duplicate `eventId` grants nothing.

Client-side countdowns or redirects never prove ad completion.

### Free-credit reset

Only free credit expires at **00:00 Asia/Tehran**. Premium remains unchanged.

Free credit is modeled against the Tehran calendar day rather than relying on a global midnight mass-update job. Previous-day usage can never debit the new day's free balance.

### Premium

Premium lasts until its purchased expiration and does not reset at midnight.

When extending Premium, the new expiration is calculated from the later of `now` or the current premium expiration.

While Premium is active, free credit is not consumed.

### Concurrent usage accounting

Distinct simultaneous VPN sessions consume their **actual combined observed usage**, as required by the execution plan. For example, two independent active sessions lasting 60 seconds each may consume 120 seconds of free credit.

What must never be charged twice is the same telemetry evidence: retries, duplicate reports, replayed event identities, or repeated processing of the same session/window sequence are idempotent and add no second debit.

### Speed policy

Free accounts have an administrator-configurable speed cap, initially **5 Mbps**. Premium has no Madar-imposed application speed cap.

Speed enforcement is not considered complete until measured on a real VPS with real traffic.

### Enforcement

Entitlement expiry, suspension, credential rotation, or revocation must be enforced on VPN nodes. Hiding access in the UI is insufficient.

## 6. VPN architecture

WireGuard is explicitly excluded.

The target VPN architecture is:

- Xray-core
- VLESS
- REALITY
- one dedicated subscription URL per user
- v2rayNG compatibility

Each user receives:

- a dedicated client UUID/credential;
- an unguessable subscription token;
- independent rotation of client credential and subscription URL.

The subscription system must support multiple nodes in the future and must never expose:

- email;
- internal user ID;
- administrator secrets;
- node credentials;
- REALITY private key;
- infrastructure secrets.

## 7. Credential rotation semantics

### Rotate Client Credential

- create a new client UUID;
- revoke the previous UUID;
- propagate a new policy revision to every eligible node;
- ensure old UUID access is actually removed;
- keep the subscription URL stable unless separately rotated;
- after refresh, v2rayNG receives the new config.

A node must not be advertised for the new credential until it has acknowledged the required policy revision.

### Rotate Subscription URL

- create a new high-entropy subscription token;
- revoke the previous token atomically;
- old URL becomes invalid immediately at the API;
- client UUID does not need to change.

Subscription endpoints use `Cache-Control: no-store` and are treated as bearer-secret surfaces.

## 8. Control-plane architecture

### Frontend

- React
- TypeScript
- Vite
- custom RTL design system
- PWA manifest/service worker

### API

- Cloudflare Workers
- Hono for routing/middleware
- Zod for boundary validation
- versioned REST contracts

### Static hosting

Use Cloudflare Workers Static Assets, not the deprecated Workers Sites architecture.

### Database

Use PostgreSQL as the server-side source of truth, initially targeted at Neon behind Cloudflare Hyperdrive.

The choice is driven by clear multi-table transactional semantics, constraints, and auditable idempotency for ledger, payments, rewards, and telemetry settlement.

### Async work

Queues may be used for non-authoritative asynchronous work such as push delivery. Accounting correctness must never depend on exactly-once queue delivery; consumers remain idempotent.

## 9. Repository layout

Target monorepo structure:

```text
madar-vpn/
├─ apps/
│  ├─ web/
│  └─ api/
├─ packages/
│  ├─ contracts/
│  ├─ domain/
│  └─ database/
├─ node-agent/
│  ├─ madar_agent/
│  ├─ installer/
│  ├─ systemd/
│  └─ tests/
├─ tests/
│  ├─ integration/
│  ├─ e2e/
│  └─ fixtures/
├─ docs/
│  ├─ architecture/
│  ├─ runbooks/
│  ├─ security/
│  └─ test-reports/
└─ .github/workflows/
```

No previous project source tree or history is imported.

## 10. Database domains

### Identity

`users`, `login_tokens`, `sessions`, `admin_members`.

Important invariants:

- canonical email unique;
- magic-link token hash unique and single-use;
- initial grant recorded once;
- admin membership server-authoritative.

### Accounting

`account_state`, `credit_ledger`, `premium_events`.

`credit_ledger` is immutable. Current account state is a transactional projection. Every external or administrative credit mutation carries a unique source identity for idempotency.

### Access

`access_profiles`, `client_credentials`, `subscription_tokens`.

Only one active client credential and one active subscription token version exist per user at a time.

### Ads

`ad_events` with a uniqueness constraint equivalent to `(provider, event_id)`.

### Payments

`plans`, `orders`, `payment_events`.

Manual administrator confirmation and future provider callbacks converge on the same server-side settlement function. A browser redirect is never proof of payment.

### Missions

`missions`, `mission_submissions`, `mission_rewards`.

Evidence may be pending/approved/rejected. A reward can be settled only once for an eligible submission.

### Nodes

`nodes`, `node_enrollment_tokens`, `node_credentials`, `node_public_config`, `node_policy_revisions`, `node_policy_acks`, `node_health_samples`.

Node credentials are hash-only in the control plane. REALITY private keys never leave the VPS.

### Usage

`telemetry_reports`, `usage_session_buckets`, `usage_debit_events`.

Raw telemetry has an idempotency identity equivalent to `(node_id, window_id, sequence)`. Settlement preserves distinct simultaneous sessions while rejecting repeated processing of the same telemetry identity.

### Push

`push_subscriptions`, `notification_jobs`, `notification_deliveries`.

### Audit

`audit_log` records sensitive administrative and lifecycle changes without logging bearer secrets.

## 11. Node architecture

Each VPS contains:

- pinned Xray-core;
- Madar Node Agent written in Python;
- systemd services;
- local configuration;
- local node credential;
- local REALITY private key.

The Node Agent is responsible for:

- enrollment;
- heartbeat;
- health/readiness;
- policy retrieval;
- client activation/deactivation;
- revocation;
- usage telemetry;
- free-account speed-policy enforcement;
- Agent/Xray version reporting;
- capacity and error reporting.

### Enrollment

Admin flow:

`Servers → Add Node → name/country/tier → one-time enrollment token → installer → environment checks → install → enroll → health/readiness → Ready`

Enrollment tokens are short-lived, one-time, random, and stored hash-only. The returned node credential is saved only on the VPS with restrictive file permissions.

### Installer safety

Before sensitive changes, the installer explains what it will do. It does not blindly modify SSH or firewall configuration, does not print secrets, and does not embed private keys or permanent credentials.

It provides `status`, `update`, and `remove` operations.

### Fail closed

Policies are revisioned and time-limited. If a node cannot refresh authorization before policy validity expires, managed VPN access is disabled. Stale or unhealthy nodes are removed from subscription output.

## 12. REALITY key handling

The REALITY private key is generated and retained only on the VPS. The control plane receives only the public parameters required to create client-facing VLESS/REALITY entries.

## 13. Telemetry and free-credit debit

Minimum telemetry payload:

- `nodeId`
- `clientId`
- `windowId`
- `sequence`
- `seconds`
- `timestamp`

The implementation may additionally send `observedFrom`, `observedTo`, and a stable server-observed session identity when the selected Xray telemetry mechanism can provide one reliably.

Backend requirements:

- duplicate report: no second debit;
- out-of-order report: accepted/reconciled correctly;
- previous Tehran-day report: cannot debit today's free balance;
- distinct simultaneous sessions: their actual observed usage is summed;
- retry/replay of the same session/window sequence: no duplicate debit.

If Xray does not provide sufficiently accurate connection timing, actual server-observed activity on a real VPS is measured and documented. No invented connection-state signal is allowed.

## 14. Multi-node subscriptions

A node may appear in a user's subscription only when it is:

- enabled;
- recently heartbeating;
- healthy/readiness-approved;
- carrying valid public REALITY configuration;
- acknowledged at the necessary policy revision;
- within the active capacity policy.

Multiple eligible nodes may be rendered into the same user subscription using the same active user client credential.

Subscription formatting is not frozen until real v2rayNG E2E testing passes.

## 15. Speed enforcement boundary

The product requirement for a real per-user free speed cap is fixed; the exact enforcement mechanism is deliberately deferred until it is verified against pinned Xray/VLESS/REALITY on a real VPS.

A `SpeedEnforcer` boundary will isolate the mechanism. A node-wide aggregate cap is not accepted as a substitute for per-free-user enforcement.

Phase 9 cannot pass unless real throughput testing proves the configured Free cap and proves no Madar application cap is imposed on Premium.

## 16. PWA and Web Push

PWA requirements:

- Android installability;
- iPhone Add to Home Screen flow;
- manifest;
- service worker;
- icons;
- appropriate offline app shell;
- no API/secret caching;
- Web Push;
- notification permission requested only after explicit user action.

Service-worker caching excludes authenticated API responses, subscription responses, secrets, QR-bearing sensitive payloads, and auth responses.

Offline mode may render the shell but must show account/network data as unavailable rather than fabricate state.

## 17. External integrations

Email, ads, payments, and push are adapter boundaries.

Missing provider configuration is represented as unavailable. Preview/sample states are labelled. No fake payment, ad reward, email delivery, push delivery, or VPN success may be shown.

Rewarded ads grant credit only from a valid server-side provider callback.

Payments settle only against server-created orders after a valid manual or provider-side confirmation.

## 18. Admin panel

The admin UI is designed for a non-programmer and includes:

- Overview
- Users
- Suspend/activate
- Free credit
- Premium
- Plans
- Payments
- Ads
- Missions
- Rewards
- Push notifications
- Nodes
- Health
- Capacity
- Speed limit
- Subscription status
- Rotate subscription
- Rotate credential
- Audit log
- Integration readiness

Every integration exposes honest readiness states such as unconfigured, configured, verification pending, verified, or degraded/error.

## 19. Security invariants

- no secrets in browser bundle;
- no secrets in Git;
- no secrets in logs;
- no admin key in README/guides;
- no private key in public installer;
- secure HttpOnly sessions;
- CSRF/origin protection for sensitive mutations;
- independent admin authorization;
- subscription URL treated as a bearer secret;
- rotatable user/node credentials;
- stale nodes fail closed;
- audit sensitive actions;
- redact bearer values from observability.

Provider secrets entered through Admin are encrypted before persistence with a master key supplied only through server secret storage; cleartext values are never returned by read APIs.

## 20. Implementation phases and gates

### Phase 1 — PWA + Design System + Auth

Repository/bootstrap, CI, PWA shell, RTL design system, email magic-link model, session security, admin authorization, CSRF, tests, build/typecheck.

Gate: server-authoritative auth behavior is tested; missing email provider is honestly unavailable.

### Phase 2 — Account Ledger + Free/Premium rules

TDD for one-time 1,800-second grant, 900-second ad grant, replay prevention, Tehran reset boundary, Premium survival/extension, concurrent mutation, prior-day telemetry, distinct concurrent-session settlement, and duplicate-report replay prevention.

Gate: all credit mutations are transactional and idempotent.

### Phase 3 — Access Profile + Subscription

Client credential lifecycle, subscription token lifecycle, no-store endpoint, QR/copy, rotations, multi-node abstraction.

Gate: no VPN-working claim yet.

### Phase 4 — Admin

Non-technical admin surfaces and protected CRUD/audit.

### Phase 5 — Ads / Payments / Missions / Push adapters

Provider-neutral boundaries, verified callbacks, manual payment settlement, mission review/reward, VAPID push.

### Phase 6 — Node enrollment + Agent

Enrollment, heartbeat, policy, stale behavior, telemetry sequencing, installer safety and Python tests.

### Phase 7 — Xray/VLESS/REALITY integration

Disposable real VPS, pinned Xray, REALITY setup, real add/remove/revoke, actual traffic, activity telemetry investigation.

### Phase 8 — v2rayNG E2E

Create account → verify email → get free credit → obtain subscription → import into real v2rayNG → connect → pass real traffic through VPS → observe/debit usage.

### Phase 9 — Multi-node + speed enforcement

Second real node, multi-node subscription, unhealthy filtering, cross-node rotation, concurrent telemetry, real Free/Premium throughput tests.

### Phase 10 — Production readiness

Security review, failure-mode review, backup/restore, recovery, installer update/remove, logging/redaction, abuse controls, real Android/iPhone PWA checks and real Web Push.

## 21. Development workflow

Every implementation task follows:

1. write failing test;
2. verify failure;
3. implement minimum behavior;
4. run focused tests;
5. run relevant suite;
6. typecheck/build;
7. review security/behavior;
8. update docs/test evidence;
9. commit;
10. advance only after the task gate passes.

Implementation, Tested, Integration Verified, and E2E Verified are distinct statuses. `Production Ready` is forbidden until Phase 10 and the real acceptance matrix pass.

## 22. Final real acceptance matrix

The project is not production-ready until all of the following have passed with real dependencies where applicable:

- create a new account;
- initial free credit granted once only;
- import subscription in real v2rayNG;
- establish a real VPN connection;
- pass traffic through the VPS;
- decrement free time only during observed activity;
- stop decrementing after disconnect/inactivity;
- verify distinct simultaneous sessions consume their real combined usage without duplicate replay debit;
- add exactly 15 minutes after a valid rewarded-ad callback;
- reset Free at Tehran midnight;
- keep Premium across midnight;
- expire entitlement and revoke real node access;
- recharge and restore access;
- rotate Client ID and make old config fail;
- refresh and make new config work;
- rotate Subscription URL and invalidate the old URL immediately;
- add a second node;
- return multiple nodes in the subscription;
- exclude unhealthy nodes;
- enforce and measure the Free speed cap;
- verify no Madar application speed cap for Premium;
- install PWA on Android;
- add PWA to iPhone Home Screen;
- deliver real Web Push.

## 23. Explicit non-goals for early phases

- no WireGuard;
- no fake browser-side VPN connection;
- no fabricated provider success;
- no claim of production readiness before real VPS/v2rayNG/device tests;
- no reuse of prior-project secrets, code, schema, or infrastructure decisions;
- no premature commitment to an unverified Xray speed-enforcement mechanism.
