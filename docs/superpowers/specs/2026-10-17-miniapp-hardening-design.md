# Madar Telegram Mini App — Production Hardening Design

Date: 2026-10-17
Status: awaiting user review
Target branch: `impl/telegram-miniapp-dashboard-20261017`
Baseline production commit: `813313ff0326fac7879e3430e1b2b46f9a0fdd3a`

## 1. Context

The Madar Telegram Mini App is already deployed to production and its primary admin/seller flows are working. Field acceptance exposed a final set of production defects and missing management capabilities. The goal of this hardening pass is to fix those issues without destabilizing the working quota/accounting model, the healthy second node, or the existing delivery/status flows.

Production evidence gathered before design approval shows that the first node (`Stockholm`) is not failing because of capacity or revision drift: it remains at `revision=2037` and `acked_revision=2037` with the expected `quota-v2,per-account-process,shared-443` capabilities, but its `last_seen` and quota reports stopped for hours while `AWS Stockholm 2` continues reporting normally. Therefore Node1 repair is treated as an operational agent/host regression investigation, not as a Mini App capacity calculation defect.

## 2. Goals

This pass must deliver all of the following:

1. Remove or Persian-localize user-facing English section/kicker labels.
2. Replace the placeholder `M` brand mark with a real logo slot and a safe fallback.
3. Replace ambiguous character/emoji icons with clear self-contained SVG icons.
4. Diagnose and repair the first node heartbeat/reporting outage without risking the healthy node.
5. Show seller Telegram identity as `@username` when available, otherwise Telegram display name, with numeric Telegram ID only as secondary metadata.
6. Add configuration management: detail view, revoke, and soft-delete/archive.
7. Show a useful server outage reason and last-seen information in server detail.
8. Make configuration delivery complete: config URI, QR, usage/subscription link, copy actions, and rich sharing.
9. Preserve all existing accounting, settlement, audit, quota and capacity semantics.
10. Finish with production rollout and Telegram field acceptance against all items above.

## 3. Non-goals

- No destructive physical deletion of configuration history.
- No rewrite of the quota protocol or node runtime architecture unless Node1 diagnosis proves an existing runtime defect requires a bounded fix.
- No redesign of settlement accounting.
- No migration away from the current Cloudflare Worker + D1 architecture.
- No dependency on external icon/font/CDN packages for critical UI assets.

## 4. Configuration lifecycle design

### 4.1 Revoke

The existing backend `revokeAccount` behavior remains the authoritative lifecycle action for terminating access. The Mini App will expose it through an authenticated API route.

Rules:

- Revoke immediately changes the managed account state to `revoked`.
- Pending outbox delivery for that account is killed.
- An audit event is written.
- The next quota policy excludes the account, causing its per-account process to stop on the node.
- Revoke must be idempotent from the UI perspective: an already terminal account is shown as terminal and cannot be revoked again.

### 4.2 Archive / soft delete

User-approved delete semantics are soft-delete/archive, never physical deletion.

Add nullable archive metadata to `managed_accounts`, preferably:

- `archived_at INTEGER NULL`
- `archived_by TEXT NULL`

Archive action requirements:

- If the account is live, archive first performs/ensures revoke semantics.
- Archive hides the account from the default config list.
- Historical sales, usage, settlement attribution, and audit rows remain intact.
- Archived rows continue to count only where existing historical accounting intentionally includes terminal history; they must not count as live capacity.
- A dedicated audit event records archive.
- API access to an archived account detail remains admin-authorized when explicitly addressed, so support/history is still inspectable.

The default `GET /api/app/configs` excludes archived rows. No restore/unarchive feature is included in this pass.

## 5. Seller Telegram identity

### 5.1 Problem

The current reseller model stores only `telegram_id`, and Mini App authentication currently discards Telegram profile fields after signature verification. This makes the UI fall back to numeric IDs.

### 5.2 Model

Persist a small Telegram profile cache for resellers. Recommended schema is a dedicated table to avoid coupling authorization with mutable profile data:

`telegram_profiles`

- `telegram_id TEXT PRIMARY KEY`
- `username TEXT NULL`
- `first_name TEXT NULL`
- `last_name TEXT NULL`
- `updated_at INTEGER NOT NULL`

Authentication parsing should return both the verified ID and bounded profile fields from the signed `user` object. On authenticated Mini App requests, upsert the caller profile. Existing bot flows that receive Telegram user objects may also upsert when convenient, but that is not required for the first release.

Seller admin queries left-join profile data and return:

- `sellerId`
- `username`
- `displayName`

Presentation priority:

1. `@username`
2. `first_name + last_name`
3. numeric Telegram ID

The Telegram ID remains visible as secondary/support metadata in seller detail.

Security constraints:

- Never trust unsigned query/body profile values.
- Only profile values extracted from verified Telegram init data or Telegram bot updates may be persisted.
- Bound all strings before storage/display.

## 6. Usage/status link v2

### 6.1 Problem

The current delivery flow generates a random raw usage token once, stores only its hash, and places the raw URL only in the queued Telegram message. The Mini App therefore cannot reconstruct the same URL later.

### 6.2 Design

Introduce a deterministic signed usage capability (`usage v2`) that can be regenerated by trusted backend code without storing a recoverable secret.

Recommended token payload:

- account ID
- purpose/version marker
- optional issuance/version field

Sign the payload with an HMAC secret already available as a Worker secret or a new dedicated `USAGE_LINK_SECRET`. Encode as URL-safe token and validate server-side using constant-time comparison.

Requirements:

- Existing legacy hashed status-token URLs continue to work.
- New Mini App result/detail APIs return `usageUrl` generated by the server.
- New bot deliveries may use v2 URLs after rollout.
- Revoked accounts return not-found/invalid status exactly as current status semantics require.
- The v2 route must not expose seller/admin data beyond the existing usage status fields.
- No long-lived raw bearer secret is stored in D1.

This design removes the need to persist or recover the old random token while preserving backwards compatibility.

## 7. Configuration result and sharing UX

### 7.1 Ready result

The ready screen must show:

- customer label
- quota
- duration
- server
- expiry where available
- rendered QR
- config URI
- usage/status link

Actions:

- Copy config
- Copy usage link
- Open usage/status
- Share
- Return to configs

### 7.2 QR rendering

The backend already returns QR SVG. The hardening pass must make rendering deterministic in Telegram WebView:

- Render the returned SVG directly.
- Add CSS for `#result-qr svg` with explicit width/height/max-width/display rules.
- Reject/ignore non-string QR payloads.
- Add browser tests that assert actual SVG markup is present, not merely the mount element.

### 7.3 Rich share

`shareResult()` must no longer share only the raw config URI.

Share text includes:

- Madar heading
- customer name
- quota
- duration
- server
- usage URL
- config URI

QR sharing strategy:

1. Preferred: convert the server-provided SVG to a PNG/File client-side and use `navigator.canShare({ files })` + `navigator.share({ files, text, title })` where supported.
2. Fallback: use text-only `navigator.share` with the complete formatted payload.
3. Final fallback: copy the complete formatted payload and show a clear toast.

A failure to share the QR file must never prevent sharing/copying the config and usage URL.

## 8. Config management UI/API

### 8.1 Config detail

Selecting a config opens a detail screen showing:

- label
- current effective state
- server name
- quota / used / remaining
- created time
- expiry
- seller identity for admin
- config + QR + usage link when a delivery artifact is available

### 8.2 Mutating actions

Add admin-only routes (exact naming may be adjusted during planning):

- `POST /api/app/configs/:id/revoke`
- `POST /api/app/configs/:id/archive`

Authorization:

- Admin may revoke/archive any visible account.
- Seller self-service revoke/delete is out of scope unless existing product requirements explicitly require it later.

UX:

- Both actions require confirmation.
- Archive confirmation explicitly says history/accounting remains preserved.
- After success, config list/dashboard/capacity are refreshed.
- Archived config disappears from the default list.

## 9. Server health diagnosis and outage reason

### 9.1 API presentation

Server detail should derive a stable `healthReason` and `lastSeenAge` from known backend state rather than inventing unsupported root causes.

Suggested reason precedence:

1. `STALE_HEARTBEAT` — `last_seen <= now - 90`
2. `REVISION_NOT_ACKED` — revision differs from acked revision
3. `MISSING_QUOTA_CAPABILITY` — no `quota-v2`
4. `AGENT_REPORTED_UNHEALTHY` — recent heartbeat but `healthy != 1`
5. `OK`

Expose human-friendly Persian copy in UI, for example:

- «ارتباط Agent قطع شده؛ آخرین گزارش … پیش»
- «نسخه جدید هنوز توسط سرور تأیید نشده است»
- «Agent این سرور از پروتکل سهمیه فعلی پشتیبانی نمی‌کند»

Do not claim host/network/systemd root cause unless the node itself reports such a diagnostic.

### 9.2 Node1 field repair

The current production evidence points to stale heartbeat/reporting. Field repair is therefore a separate acceptance subtask:

- inspect service status and journal on Node1
- inspect quota heartbeat file freshness
- verify Worker API reachability from Node1
- verify node token/config validity
- verify quota runtime and shared-443 frontend service state
- restart only after evidence identifies the failing layer
- verify fresh ACK, fresh quota report, healthy node, and real client traffic

No D1 manual mutation should be used to fake health.

## 10. UI localization, logo and icons

### 10.1 Localization

Remove user-facing English kickers such as:

- `ADMIN CONTROL`
- `ADMIN · SERVERS`
- `ADMIN · SELLERS`
- `SERVER DETAIL`
- `SELLER DETAIL`
- `CONFIGS`
- `REPORTS`
- `READY`
- `CONFIG PREPARING`
- `SELLER STATS`

Replace with concise Persian labels or remove redundant kickers entirely.

Technical values such as IP, SNI, protocol capability names and config URIs remain LTR/technical as appropriate.

### 10.2 Logo

Replace the hard-coded `M` mark with an image slot in the header.

- Use a repository-owned local asset only.
- Provide CSS fallback to the existing styled `M` when the image fails or is absent.
- The final brand asset may be added after the user provides the definitive SVG/PNG; the structure must support it without further layout work.

### 10.3 Icons

Replace ambiguous glyphs (`◈`, `◫`, `◎`, `◇`, `♙`, `▤`, `⌁`, etc.) with inline/local SVG symbols for:

- home
- servers
- sellers
- configs
- reports/statistics
- volume/storage
- usage/activity
- active users/configs
- refresh
- copy/share/link/archive/revoke

Icons must have accessible labels through surrounding button text/ARIA and must not depend on platform emoji rendering.

## 11. Dashboard consistency

The field review originally suspected the Home `configsInService` value was missing, but code and later visual inspection show that the value is present and sourced consistently from backend summary. No independent fix is required unless a regression test reproduces a real rendering failure.

Add/retain regression coverage asserting:

- admin dashboard renders nonzero `configsInService`
- reports and dashboard derive compatible live-account counts
- archive/revoke immediately remove live reservations from capacity calculations according to existing predicates

## 12. Migrations

Expected D1 migrations:

1. Telegram profile cache table.
2. Managed account archive columns.

Usage v2 should avoid a migration if it can be implemented entirely as signed stateless tokens.

All migrations must be additive and backward-compatible with the currently deployed Worker during rollout sequencing.

## 13. Testing strategy

### 13.1 Unit/API tests

Add tests for:

- verified Telegram profile extraction and profile upsert
- seller list/detail display identity priority
- revoke API authorization + state/audit effects
- archive API authorization + revoke-before-archive behavior
- default config list excludes archive
- historical accounting remains intact after archive
- signed usage URL generation and validation
- old legacy usage URL still works
- healthReason derivation

### 13.2 Browser tests

Add tests for:

- no forbidden English UI kickers
- SVG navigation/metric icons render
- logo element + fallback exists
- QR SVG is actually mounted in ready result
- usage link buttons are present
- rich share payload contains customer/quota/duration/server/usage URL/config
- file-share path when supported and safe fallback when unsupported
- config detail, revoke confirmation, archive confirmation and post-action refresh
- seller username/display name instead of numeric-only primary identity

### 13.3 Regression tests

Run the full existing sales-bot/node suite to protect:

- quota policy lifecycle
- capacity limits
- settlement accounting
- node enrollment
- Telegram auth
- delivery outbox
- shared-443 runtime

## 14. Rollout plan constraints

Implementation planning must preserve this rollout order:

1. Add backward-compatible schema migrations.
2. Deploy Worker code that can read old + new data.
3. Run smoke/API/browser tests.
4. Verify Mini App production behavior without touching Node1 health state manually.
5. Perform evidence-based Node1 field repair separately.
6. Verify Node1 heartbeat + quota reports + real traffic.
7. Complete Telegram field acceptance for UI, seller identity, config management, QR/share/usage and server health reason.

No rollout is considered complete until production is tested from inside Telegram.

## 15. Acceptance criteria

The pass is accepted only when all are true:

- No unintended English section headings remain in the user-facing Mini App.
- Real logo asset slot works and fallback is safe.
- Navigation and metric/action icons are semantically clear SVGs.
- Seller primary identity is `@username` or Telegram display name; numeric ID is secondary.
- Config detail is usable.
- Revoke works end-to-end and frees live node/seller capacity as expected.
- Archive performs soft delete, preserves history/audit/accounting, and hides the item from default lists.
- Server detail shows a truthful diagnostic reason and last-seen information.
- Node1 produces fresh heartbeat/ACK/quota reports again after evidence-based repair.
- Ready config screen visibly renders QR.
- Ready/detail screens expose a working usage link.
- Share sends a rich payload and includes QR as a file where WebView/platform support allows; otherwise a complete safe fallback is used.
- Existing legacy usage links remain valid.
- CI/test suite is green.
- Production rollout succeeds.
- Final field acceptance inside Telegram passes on a real mobile client.

## 16. Safety and data integrity principles

- Never physically delete managed-account history for the user-facing delete action.
- Never fake node health by editing D1 health timestamps/state.
- Never expose a reusable admin/seller credential in a usage URL.
- Never trust unsigned Telegram identity fields.
- Keep all destructive UI actions behind explicit confirmation.
- Prefer additive schema/API changes so rollback remains possible during rollout.
