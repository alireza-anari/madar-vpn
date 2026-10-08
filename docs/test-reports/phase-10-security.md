# Phase 10 — Security and abuse hardening

## Status

**Implemented + Tested** for Task 31. This report does **not** declare Production Ready. Tasks 32–34 and the real external acceptance gates remain separate.

## Scope completed

### Abuse controls

Rate-limit coverage is present for:

- email login requests;
- subscription bearer fetches;
- rewarded-ad and payment provider callbacks;
- `/api/admin/*` requests;
- node enrollment.

Sensitive rate-limit inputs are hashed before they become limiter keys; raw subscription/enrollment credentials are not used as persisted keys.

### Secret scanning and log redaction

- Repository secret scanner runs before dependency installation in CI.
- Scanner findings report rule/path metadata without echoing matched secret values.
- Node Agent has shared operational log redaction tests for bearer credentials, subscription URLs, enrollment tokens, and named private-key values.
- Current repository scan is required to remain clean.

### Subscription bearer leakage review

The subscription URL is a bearer secret. The endpoint already returns `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex, nofollow, noarchive`, and `X-Content-Type-Options: nosniff`.

Cloudflare Worker automatic invocation logs were explicitly disabled while observability remains enabled, so request URLs containing `/s/<token>` are not intentionally persisted through invocation logging.

### Audit-log completeness

Sensitive admin outcomes now have explicit audit events without storing their secret/evidence input:

- `payment.manual.confirm` records order ID + applied outcome, not the confirmation credential;
- `mission.submission.review` records review/reward outcome, not user-submitted evidence;
- `node.enrollment-token.issue` records node ID + expiry, not the raw enrollment token.

Existing admin mutation auditing for settings, plans, missions, nodes, notification drafts, credit/premium adjustments, and user suspension remains covered by the corresponding surface/auth services.

### CSRF / origin / session review

Automated coverage confirms:

- magic-link tokens are hashed at rest, expire, are single-use, and reject replay;
- consuming a valid magic link creates fresh random session and CSRF values;
- session cookie uses the `__Host-` prefix with `Path=/`, `HttpOnly`, `Secure`, and `SameSite=Strict`, with no Domain attribute;
- browser mutations require CSRF and enforce same-origin policy;
- cross-origin mutation attempts are rejected even when session + CSRF values are present.

Automatic revocation of every previously issued session on each new login is not implemented and is not claimed here; the approved auth contract requires secure sessions and single-use login tokens, not that additional semantic.

### Dependency/security audit

CI now enforces both ecosystems:

- `pnpm audit --audit-level high`;
- `python3 -m pip_audit -r node-agent/requirements-dev.txt`.

The new gates found and blocked two real advisories during hardening:

1. transitive `sharp <0.35.5` — remediated with a workspace override to the patched line and regenerated lockfile;
2. `pytest 8.4.2` — remediated to `pytest 9.0.3`.

No advisory was silenced or ignored to make CI pass.

## Final verification evidence

Verified commit: `c9fab7d1bfc5f502f505ddb52d5756e75ff4c87e`

GitHub Actions run: `37842150727`

PASS gates:

- repository secret scan;
- frozen pnpm install + supply-chain lock verification;
- Node dependency audit: **No known vulnerabilities found** at configured high-severity gate;
- Python dependency audit: **No known vulnerabilities found** for the audited requirements;
- API: **99/99 tests**, 40 files;
- Web: **26/26 tests**, 9 files;
- TypeScript typecheck: PASS;
- production builds for web/API: PASS;
- Python/Node Agent: **36/36 tests** under Python 3.12 + pytest 9.0.3.

## Remaining production gates

Task 31 is complete, but these statements are deliberately **not** made:

- PostgreSQL backup/restore has not yet been proven for Task 32;
- node reinstall/update/remove recovery has not yet been proven on a disposable real VPS for Task 32;
- Android/iPhone PWA + real Web Push device acceptance is not yet complete;
- full final acceptance is not yet complete;
- Production Ready is not claimed.

Before Task 32 proceeds, the current persistence implementation must be reconciled with the approved architecture: the approved spec/plan names PostgreSQL/Neon + Hyperdrive as authoritative persistence, while the current runtime implementation contains D1 stores. Recovery evidence must test the authoritative architecture rather than silently treating D1 as PostgreSQL.