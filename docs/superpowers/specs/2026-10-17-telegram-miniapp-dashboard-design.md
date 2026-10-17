# Madar Telegram Mini App dashboard design

Date: 2026-10-17
Branch: `work/telegram-miniapp-dashboard-20261017`
Baseline: `6cdb8b841bffe1e8470ee2a2e3d3ef9e2c41d1dd`

## 1. Goal

Replace the text-heavy Telegram bot management experience with a real Telegram Mini App dashboard for Madar while preserving the already field-tested backend behavior for node capacity, seller limits, settlement, account lifecycle, quota enforcement, shared-443 transport, and automated VPS enrollment.

The approved visual direction is the previously reviewed dark Madar mockup: real cards, progress bars, clear status colors, mobile-first RTL spacing, role-specific navigation, and multi-step flows instead of long Telegram messages and stacked inline keyboards.

This work is successful only if the production Mini App both works correctly and visibly resembles that approved design language. Functional equivalence without the intended visual hierarchy is not sufficient.

## 2. Users and scope

The Mini App has exactly two user roles:

- **Admin**: full operational, accounting, seller, server, enrollment, reporting, and configuration access.
- **Seller**: limited sales dashboard, own statistics, own configs, sale/test creation, and only the server information needed to make a sale.

End customers are **not users of the bot or Mini App**. They receive a VPN configuration from the seller and use it directly.

There is no customer dashboard in this phase.

## 3. Architecture decision

Use a single Telegram Mini App hosted by the existing `madar-sales-bot` Cloudflare Worker.

Do not introduce a separate hosting stack or frontend service in this phase. The existing Worker already bundles HTML assets, owns the D1 database, receives Telegram updates, serves the current enrollment Mini App, and implements the production sales logic.

The new structure is:

```text
Telegram bot
  -> "باز کردن پنل مدار" Web App button
  -> /app
      -> Telegram initData
      -> /api/app/*
          -> auth + role resolution
          -> existing capacity/accounting/lifecycle modules
          -> D1
```

The bot remains responsible for:

- entry into the Mini App,
- operational notifications,
- capacity alerts,
- durable config delivery to the seller,
- fallback management during rollout.

The Mini App becomes the primary management UI after field acceptance.

## 4. Reuse versus rewrite

This phase must reuse the current production backend wherever possible.

Reuse:

- node-capacity calculations,
- seller-accounting calculations,
- seller limits,
- settlement semantics,
- atomic node/seller sale guard,
- account creation lifecycle,
- quota enforcement,
- outbox delivery,
- enrollment probe/install workflow,
- node health and revision reporting,
- capacity alerts.

Do not duplicate those rules in browser JavaScript.

The Mini App is primarily a new presentation and API surface around proven backend capabilities.

## 5. Authentication and authorization

Every Mini App API request sends Telegram `initData` through a request header.

A shared Mini App authentication layer must:

1. verify the Telegram signature,
2. enforce the accepted authentication age,
3. resolve the Telegram user to a Madar actor,
4. resolve the actor role as `admin` or `seller`,
5. reject disabled sellers from privileged/sales actions.

The current admin-only Mini App verifier must be generalized rather than copied into parallel inconsistent implementations.

Authorization is enforced in the Worker, not merely hidden in the UI.

Seller API responses must not include admin-only fields such as:

- public/private infrastructure IP details beyond what is explicitly safe for sales,
- SSH port or credentials,
- node fingerprints,
- installer details,
- internal revision/debug values,
- admin capacity controls,
- other sellers' statistics.

Admin routes must explicitly assert the admin role server-side.

## 6. API shape

The API should use a dedicated `/api/app` namespace.

Recommended endpoint families:

```text
GET  /api/app/me
GET  /api/app/dashboard
GET  /api/app/nodes
GET  /api/app/configs
POST /api/app/configs/preview
POST /api/app/configs/create
POST /api/app/configs/test
GET  /api/app/seller/stats

GET/POST /api/app/admin/nodes/...
GET/POST /api/app/admin/sellers/...
GET      /api/app/admin/reports/...
GET/POST /api/app/admin/enrollment/...
```

Exact endpoint granularity may change during implementation, but these boundaries are required:

- shared actor/session endpoints,
- seller-safe read/write endpoints,
- admin-only endpoints,
- no direct D1 access from the browser.

Responses use stable machine-readable error codes. Examples:

- `AUTH_EXPIRED`
- `SELLER_DISABLED`
- `SELLER_CONFIG_LIMIT`
- `SELLER_VOLUME_LIMIT`
- `INSUFFICIENT_NODE_CAPACITY`
- `NODE_SLOT_LIMIT`
- `STALE_PREVIEW`
- `NODE_UNAVAILABLE`

The frontend maps these codes to concise Persian messages.

## 7. Sale flow and atomicity

The seller or admin sale flow is a Mini App wizard:

1. customer label,
2. quota,
3. duration,
4. server selection,
5. final confirmation,
6. result.

Server selection shows:

- display name,
- current sellable capacity,
- remaining account slots,
- availability state,
- a `پیشنهادی` badge for the recommended eligible server.

The seller chooses the server. The system recommends one but does not silently force automatic placement.

Nodes that cannot satisfy the requested quota or slot requirement are visible as disabled or omitted from selectable choices with a clear reason.

`preview` is informational. Final creation must re-run the authoritative node and seller checks in the same atomic creation path already used for oversell protection.

If capacity changes after preview, creation fails safely and the UI returns the user to a refreshed confirmation state.

The final confirmation screen shows at least:

- customer,
- quota,
- duration,
- selected server,
- sellable capacity before sale,
- projected sellable capacity after sale.

## 8. Result and delivery

After successful creation, the Mini App displays a dedicated result screen containing:

- customer label,
- quota,
- expiry/duration,
- server display name,
- configuration string or subscription value as appropriate,
- QR code,
- `کپی کانفیگ`,
- system share action when supported,
- close/back action.

The same configuration must also be delivered through the existing durable bot/outbox path to the seller so closing the WebView does not lose the sale result.

A browser-only success state is not considered sufficient delivery.

## 9. Admin dashboard

The admin home follows the approved dark-card design.

Top summary cards show at least:

- configs currently in service,
- active reserved volume,
- finalized/actual consumed volume,
- active sellers.

Below the summary, node cards show:

- node display name,
- health state,
- total configured capacity or unlimited mode,
- active reserved bytes,
- finalized used bytes,
- sellable bytes,
- occupied/max account slots,
- utilization percent,
- visual progress bar,
- 80/90/95 warning state when applicable.

Status colors:

- teal/green: normal,
- yellow/amber: warning,
- red: critical/unavailable.

Primary admin navigation:

- خانه
- سرورها
- فروشندگان
- کانفیگ‌ها
- گزارش‌ها

Primary create action remains prominent.

## 10. Admin server management

The server list uses full cards rather than Telegram message summaries.

Server detail may include admin-only fields such as:

- IP/address,
- health,
- revision/ACK status,
- finite/unlimited bandwidth mode,
- total bandwidth budget,
- committed bytes,
- finalized usage,
- sellable capacity,
- finite/unlimited account-count mode,
- occupied/max slots,
- alert level,
- related configs.

Admin actions include:

- change volume cap,
- set bandwidth unlimited,
- change config-count cap,
- set config count unlimited,
- inspect configs,
- open enrollment/add VPS flow.

Destructive or high-impact changes require a confirmation dialog before submission, but backend authorization remains authoritative.

## 11. VPS enrollment integration

The current standalone `/enroll` experience is integrated into the Mini App under server management.

The user flow becomes a multi-step wizard:

1. server identity/name and capacity settings,
2. target IP and SSH port,
3. connectivity probe,
4. host fingerprint confirmation,
5. login method and encrypted credentials,
6. install/progress state,
7. final ready/failed result.

Existing secure credential encryption, probe, enrollment, and installer-job behavior should be reused.

During rollout, `/enroll` remains available as a compatibility/fallback route. After the integrated Mini App flow passes field acceptance, it may redirect to the new server enrollment route.

## 12. Sellers dashboard

The seller dashboard is intentionally simpler than the admin dashboard.

It shows only seller-relevant data, including:

- configs currently in service,
- sold quota in current settlement window,
- sold quota all-time,
- actual customer usage where useful,
- own configured seller limits and remaining allowance,
- sellable node capacity needed to choose a server.

Primary actions:

- ساخت کانفیگ
- ساخت تست
- کانفیگ‌های من
- آمار من

The seller sees server display names and sale-relevant remaining capacity but no infrastructure administration details.

## 13. Seller management for admin

Admin seller list uses one card per seller showing:

- enabled/disabled state,
- configs created/currently in service,
- current settlement sold volume,
- current settlement actual traffic,
- all-time totals.

Seller detail shows:

- current settlement metrics,
- all-time metrics,
- state counts,
- per-node breakdown,
- max config limit,
- max volume limit,
- seller enable/disable control,
- configs belonging to the seller,
- settlement history.

The action `ثبت تسویه و شروع حساب جدید` advances the seller settlement window only. It must never revoke, reset, stop, or modify existing customer service.

## 14. Visual system

The approved reference is a dark operational dashboard, not a generic Telegram form.

Required visual characteristics:

- RTL-first mobile layout,
- dark Madar background independent of Telegram theme changes,
- rounded elevated cards,
- strong card hierarchy,
- compact numeric summaries,
- real horizontal progress bars,
- consistent teal/blue healthy accents,
- amber warning state,
- red critical/error state,
- large touch targets,
- fixed/clear navigation behavior,
- technical values such as IPs and configuration strings rendered LTR,
- Persian labels and Persian-localized human-readable numbers.

Telegram theme data may be used for safe-area/integration behavior but must not destroy the approved Madar brand appearance.

No narrow desktop-style data grids are used for primary mobile flows. Lists and breakdowns use cards or expandable sections.

## 15. Frontend structure

Keep the frontend lightweight and colocated with the existing Worker.

Recommended structure:

```text
apps/sales-bot/public/app.html
apps/sales-bot/public/app.css
apps/sales-bot/public/app.js
```

Backend responsibilities should be separated from rendering through focused modules, for example:

```text
src/app-auth.ts
src/app-api.ts
src/app-dashboard.ts
src/app-presenters.ts
```

Names may change, but large mixed files containing auth, SQL, rendering, and action mutation in one unit should be avoided.

Do not add a large frontend framework unless implementation proves plain HTML/CSS/JS inadequate. The default design is framework-free to minimize bundle size, dependency surface, and production rollout risk.

## 16. Data freshness

Dashboard and capacity responses should be `no-store` or otherwise treated as fresh operational data.

The Mini App refreshes important values:

- on initial load,
- on manual refresh,
- when Telegram brings the WebView back to foreground where practical,
- before final sale confirmation,
- after mutations.

A displayed preview is never an authorization token for capacity. Final backend checks always win.

## 17. Error and offline behavior

The Mini App must have explicit states for:

- loading,
- empty data,
- expired Telegram session,
- unauthorized role,
- disabled seller,
- offline/network failure,
- backend validation failure,
- stale capacity preview,
- enrollment failure,
- creation success with bot delivery pending/retrying if relevant.

No raw SQL, stack trace, secret, or internal exception is rendered to the seller.

Retry actions must be safe and respect existing idempotency/durable creation behavior.

## 18. Testing strategy

Implementation follows TDD.

### Backend tests

Add deterministic tests for:

- valid admin Mini App authentication,
- valid seller Mini App authentication,
- disabled seller rejection,
- seller denied from every admin mutation endpoint,
- seller response redaction of admin-only fields,
- dashboard aggregates matching accounting modules,
- node eligibility and recommendation,
- preview before/after capacity,
- final create rejecting stale/oversold preview,
- seller config and byte limits,
- settlement preserving active service,
- enrollment admin-only access.

### Browser/UI tests

Add browser-level tests covering at least:

- `/app` loads Telegram WebApp integration,
- admin dashboard render,
- seller dashboard render,
- role-specific navigation,
- progress bar values,
- warning/critical visual states,
- disabled insufficient-capacity server,
- sale wizard progression,
- final confirmation values,
- result QR/copy controls,
- auth-expired screen,
- integrated enrollment wizard state transitions.

### Regression

All existing tests remain green, including:

- shared-443 lifecycle,
- quota cutoff,
- revoke,
- expiry,
- account delivery,
- node health,
- seller accounting,
- capacity alerts,
- existing enrollment and status browser tests.

## 19. Rollout strategy

Rollout is additive and reversible.

Phase sequence:

1. implement Mini App auth/API/frontend behind new `/app` routes,
2. keep existing bot management menus working,
3. deploy production Worker only after complete CI passes,
4. add `باز کردن پنل مدار` Web App entry button,
5. field-test admin account on Telegram mobile,
6. field-test a controlled seller account,
7. field-test sale preview/create/result and durable bot delivery,
8. field-test server management and integrated VPS enrollment without unnecessarily mutating production infrastructure,
9. only after explicit acceptance make the Mini App the primary UI,
10. retain old bot flow temporarily as fallback before any later cleanup.

No production mutation is performed solely for visual testing when the same behavior can be validated read-only or with a controlled test entity.

## 20. Field acceptance criteria

The Mini App phase is accepted only when all of the following are true on real Telegram mobile:

- admin can open the Mini App from the bot,
- seller can open the same Mini App and receives the seller role UI,
- seller cannot retrieve or mutate admin-only data even with crafted API requests,
- admin dashboard visually resembles the approved dark-card mockup,
- server cards show correct production capacity values and real progress bars,
- 80/90/95 states render correctly,
- seller sees only own statistics and safe node sales metadata,
- sale wizard works end-to-end,
- recommended server is identified,
- insufficient servers cannot be selected,
- confirmation shows correct before/after capacity,
- final atomic guard still prevents overselling,
- result screen provides QR and copy/share controls,
- successful config is also delivered durably in the seller bot chat,
- seller limits are enforced,
- settlement does not interrupt active configs,
- admin can manage server capacity settings,
- VPS enrollment is accessible from inside the dashboard,
- reopening the Mini App does not cause loss of durable sale results,
- existing production lifecycle behavior remains green.

Visual acceptance is explicit: if the result falls back to mostly text blocks and stacked Telegram-like buttons rather than cards, progress indicators, hierarchy, and mobile dashboard interaction, the UI phase is not complete.

## 21. Compatibility and non-goals

This phase does not:

- add a customer-facing app,
- change the VLESS/shared-443 node transport,
- change quota semantics,
- change seller settlement semantics,
- create a separate billing system,
- add payment processing,
- require a new database solely for the Mini App,
- require a separate frontend hosting service,
- remove the legacy bot UI before field acceptance.

The prior capacity/accounting design remains authoritative for accounting semantics. This design supersedes only its earlier decision to keep ordinary sales management message-and-inline-keyboard based; production field review showed that approach could not meet the approved visual goal.
