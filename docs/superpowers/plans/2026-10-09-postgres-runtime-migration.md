# Madar PostgreSQL Runtime Migration Plan

Date: 2026-10-09
Branch: `impl/phase-1`

## Why this plan exists

The approved Madar architecture defines PostgreSQL as the authoritative server-side database, and `packages/database/src/migrations/0001_core.sql` now defines that schema. However, the API runtime factories still instantiate D1-specific stores and expose a D1-shaped `DB` binding. That mismatch must be removed before production readiness.

This migration is not a cosmetic adapter rename. It must preserve the existing domain contracts, idempotency rules, atomic credit/payment mutations, one-time token semantics, node credential revocation, and audit behavior while changing the persistence/runtime boundary.

## Current Cloudflare runtime constraint

Use `node-postgres` (`pg`) through a Cloudflare Hyperdrive binding. Create a fresh `pg.Client` inside each Worker invocation; do not create a global Pool or global Client. Hyperdrive owns the origin connection pool and Worker-side client cleanup at invocation end.

No Hyperdrive ID or database credential is committed to source. Deployment configuration is environment-specific.

## Migration rules

- PostgreSQL is the only authoritative runtime database after the final switch.
- D1 adapters remain only until the equivalent PostgreSQL domain adapter is tested; they are removed after parity.
- Every domain moves RED → GREEN independently.
- Critical multi-write mutations use explicit PostgreSQL transactions on one client.
- External/idempotency keys remain enforced by database uniqueness, not process memory.
- Timestamps stay `timestamptz`; Tehran-day accounting remains an explicit domain value.
- Raw login/session/subscription/node secrets are never stored; only hashes are persisted.
- No test points at production. Integration tests use the disposable PostgreSQL 17 CI service.
- The Worker does not fall back silently to D1 when Hyperdrive is absent. Missing authoritative DB configuration is an honest unavailable state.

## Task P1 — PostgreSQL client/test foundation

### RED

Add a PostgreSQL-runtime test that requires:

- a typed query/transaction boundary;
- per-invocation connection creation from a connection string;
- transaction helper executes `BEGIN`, then callback queries, then `COMMIT`;
- callback failure causes `ROLLBACK` and rethrows;
- no global client/pool singleton.

### GREEN

Add `apps/api/src/postgres/client.ts` with a small `PgDatabase` abstraction over a connected `pg.Client` and a transaction helper. Add `@types/pg` if required by TypeScript. Add a separate Node/Vitest PostgreSQL integration config/script that can use `TEST_DATABASE_URL` in CI.

### Gate

- focused unit tests PASS;
- real PostgreSQL connection smoke test PASS against CI Postgres 17;
- existing Worker tests/typecheck/build/Python PASS.

## Task P2 — Authentication PostgreSQL store

### RED

Port D1 auth-store behavior tests to PostgreSQL and add real integration checks for:

- login token stored hash-only;
- atomic one-time consume (`used_at IS NULL AND expires_at > now`);
- replay returns null;
- canonical email lookup is case-insensitive through the PostgreSQL index/query;
- session token/CSRF hashes round-trip;
- suspension state round-trips.

### GREEN

Implement `PostgresAuthStore` against `users`, `login_tokens`, and `sessions`.

### Gate

Auth service tests + PostgreSQL auth integration + full CI PASS.

## Task P3 — Credit / entitlement PostgreSQL store

### RED

Create PostgreSQL integration tests for the existing credit-service contract, including:

- first verification grant exactly once;
- duplicate grant/event unique key applies zero twice;
- Tehran free-day projection/reset behavior;
- usage debit idempotency;
- Premium prevents free debit;
- Premium extension is idempotent;
- concurrent duplicate mutations cannot double-apply.

### GREEN

Implement `PostgresCreditStore` using explicit transactions and database uniqueness over `credit_ledger`, `memberships`, `usage_sessions`, and `premium_adjustments`.

### Gate

Credit domain + real PostgreSQL concurrency/idempotency integration + full CI PASS.

## Task P4 — Access and subscription PostgreSQL stores

### RED

Require PostgreSQL parity for:

- one access profile per user;
- one active client credential per user;
- one active subscription token per user;
- credential rotation revokes old row and advances policy revision atomically;
- subscription-token rotation invalidates old token immediately;
- eligible node/public-config/policy-ACK selection returns only safe public fields.

### GREEN

Implement PostgreSQL access and subscription-node stores.

### Gate

Access/subscription tests + real PostgreSQL integration + full CI PASS.

## Task P5 — Payments, missions, push, admin surfaces/audit

Move each store independently with focused RED/GREEN parity tests.

Required transactional invariants:

- manual/provider payment event settles one order once;
- mission approval/reward cannot reward twice;
- push subscription endpoint uniqueness is preserved;
- admin setting/resource writes persist correctly;
- audit entries remain append-only and contain no bearer secrets.

Do not combine all domains into one unreviewable commit; one store/domain per reviewable commit where practical.

## Task P6 — Node-control PostgreSQL store

### RED

Require real PostgreSQL parity for:

- one-time enrollment-token consume;
- hash-only node credential storage;
- explicit credential revocation on retirement;
- heartbeat/public config/capabilities persistence;
- policy revision + per-user ACK persistence;
- telemetry uniqueness `(node_id, window_id, sequence)`.

### GREEN

Implement `PostgresNodeControlStore` against the authoritative node tables.

### Gate

Node-control service/route tests + PostgreSQL integration + full CI PASS.

## Task P7 — Per-request Hyperdrive runtime assembly

### RED

Add runtime tests proving:

- production/default API path requires `HYPERDRIVE.connectionString` rather than D1 `DB`;
- a fresh PostgreSQL client is created/connected per request invocation;
- all default service factories receive stores backed by that request client;
- missing Hyperdrive produces an honest unavailable/error state and never silently falls back to D1;
- no client or pool is constructed in module/global scope.

### GREEN

Change Worker bindings/runtime assembly to Hyperdrive + `pg.Client`. Keep `createApiApp(...)` dependency injection for isolated unit tests, but construct production factories from the request-scoped PostgreSQL client.

Do not commit a real Hyperdrive ID or connection string. Document deployment provisioning separately.

### Gate

Runtime tests + Worker build + full CI PASS.

## Task P8 — Remove D1 runtime artifacts

Only after all PostgreSQL parity gates pass:

- remove D1 store imports from the default runtime;
- delete obsolete D1 adapter files/tests after equivalent PostgreSQL coverage exists;
- delete obsolete `apps/api/migrations/*` D1 schema files;
- remove the D1-shaped `DB` binding/type;
- verify repository search has no runtime D1 dependency except historical docs if explicitly retained for audit context.

## Task P9 — Final migration evidence

Create `docs/test-reports/postgres-runtime-migration.md` with:

- domain-by-domain PASS evidence;
- PostgreSQL integration CI run IDs;
- Hyperdrive runtime assembly evidence;
- explicit statement that no real production/Neon/Hyperdrive deployment is claimed unless credentials/configuration were actually available and tested.

Run the complete security scan, PostgreSQL schema/recovery tests, dependency audits, TS tests, typecheck, build, and Python tests. Do not mark this migration complete with any known D1 runtime path or red test.
