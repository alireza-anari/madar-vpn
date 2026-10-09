# PostgreSQL Runtime Migration Evidence

Date: 2026-10-09

## Status

**PASS — PostgreSQL runtime migration is complete at the repository and CI acceptance level.**

This report does **not** claim that a live production deployment, a real Cloudflare Hyperdrive binding, or a real-VPS rollout has been exercised. Those remain deployment-environment acceptance gates. The evidence below proves the code path, schema, restore path, Worker assembly, persistence behavior, concurrency/idempotency invariants, security scans, dependency audits, tests, type checks, and builds in CI.

## Authoritative runtime and schema

- PostgreSQL is the authoritative application datastore.
- The authoritative schema is `packages/database/src/migrations/0001_core.sql`.
- The production Worker entrypoint is `apps/api/src/worker.ts`.
- Production runtime construction uses the Hyperdrive connection string and PostgreSQL stores.
- The router in `apps/api/src/index.ts` is dependency-injected and contains no D1 default runtime.
- Legacy D1 runtime adapters/tests and `apps/api/migrations/*.sql` were removed in commit `e3ca36d43736d982f8dafed376eb2e35f06e468a`.
- The repository-level Python hardening test rejects reintroduction of D1 runtime files, D1 imports, D1-shaped `DB` bindings, or legacy API migrations.

## Final acceptance run

GitHub Actions run `37898277872` on commit `c7ebf0f000defd50013bb65e70b2cf9c75400c01` completed successfully.

The run executed and passed:

| Gate | Result |
| --- | --- |
| Repository secret scan | PASS |
| PostgreSQL schema contract | PASS |
| PostgreSQL destructive backup/restore contract | PASS |
| Frozen `pnpm` install | PASS |
| Restored PostgreSQL HTTP Worker smoke | PASS |
| PostgreSQL driver + transaction rollback smoke | PASS |
| PostgreSQL integration suite | PASS — 9 files / 31 tests |
| `pnpm audit --audit-level high` | PASS |
| Python dependency audit | PASS |
| Full JavaScript/TypeScript test suite | PASS |
| TypeScript typecheck | PASS |
| Production build | PASS |
| Python test suite | PASS |

The CI workflow therefore contains the Phase 9 command chain plus the schema, restore, repository-secret, runtime-driver, and restored-HTTP smoke gates.

## Backup and restore acceptance

`tests/integration/postgres-backup-restore.sh` performs a real destructive restore exercise against the CI PostgreSQL 17 service:

1. Verifies deterministic witness data before backup.
2. Creates a custom-format `pg_dump` with PostgreSQL 17 tooling.
3. Verifies the backup file is non-empty and mode `0600`.
4. Drops and recreates the `public` schema so the restore cannot pass against untouched data.
5. Restores with `pg_restore --exit-on-error`.
6. Verifies restored user, credit-ledger, and app-settings witnesses.

After that restore, CI runs `test:postgres:restore-smoke`. The acceptance test verifies the restored witness row, creates a real persisted session, constructs the production PostgreSQL Worker runtime, supplies the restored database through the Hyperdrive-shaped binding, calls `/api/account`, and requires an authenticated HTTP `200` response for the restored user. The temporary smoke session is removed after the request.

CI then also executes `scripts/postgres-runtime-smoke.mjs`, which connects through the real `pg` driver, verifies `SELECT 1`, and proves transaction rollback semantics.

Operational backup/restore commands, safety notes, witness checks, and rollback guidance remain documented in `docs/runbooks/database-restore.md`.

## Acceptance matrix

| Product behavior | Evidence | Status |
| --- | --- | --- |
| Signup/login/session persistence | PostgreSQL auth integration covers canonical user lookup, token consume, persisted session hashes, and suspended-session invalidation; full route suite remains green | PASS in CI |
| Guest initial credit | PostgreSQL credit integration proves initial grant is applied exactly once | PASS in CI |
| Premium grant | PostgreSQL credit integration proves premium adjustment persistence and audit behavior | PASS in CI |
| Payment idempotency | PostgreSQL payment integration proves plan snapshots, idempotent settlement, `max(now,currentPremiumUntil)` extension, and concurrent settlement serialization | PASS in CI |
| Mission reward idempotency | PostgreSQL mission integration proves approval reward once and concurrent duplicate-approval serialization | PASS in CI |
| Subscription rotation | PostgreSQL access integration proves old bearer revocation and new token rendering | PASS in CI |
| Node enrollment | PostgreSQL node-control integration proves concurrent one-time enrollment-token consume and credential authentication/revocation | PASS in CI |
| Node retirement | API route suite proves retirement/revocation orchestration before published-node deletion; PostgreSQL node-control integration separately proves credential revocation primitives | PASS in CI, but not a live production end-to-end retirement exercise |
| Push subscription cleanup | PostgreSQL push integration proves endpoint upsert uniqueness, concurrent save behavior, owner-only delete, and exact-row cleanup | PASS in CI |

The migration plan called for manual verification of these product flows. In this repository acceptance, the checklist is covered by deterministic CI/integration tests rather than a live production manual session. A deployed-environment manual pass is still required before claiming production rollout acceptance.

## Concurrency and idempotency evidence

Focused successful migration runs include:

- Payments: run `37890039091` — commit `d0953b58cb4e4cb4a6122fd1c30c909db41b9323`.
- Missions: run `37890381736` — PostgreSQL mission persistence and reward idempotency.
- Push: run `37890648104` — PostgreSQL push uniqueness and cleanup.
- Node control: run `37891394407` — enrollment-token concurrency, credential revocation, heartbeat/config/capabilities, policy ACK, telemetry dedupe.
- D1 removal regression: run `37897261565` — all gates green on the branch with legacy D1 runtime/deployment artifacts removed.
- Restored-DB HTTP acceptance: run `37898277872` — all gates green including the new post-restore Worker request.

## D1 cutover evidence

The final runtime path has no D1 fallback:

- `wrangler.jsonc` points `main` to `src/worker.ts`.
- No D1 database binding is configured in the Worker config.
- The production Worker creates PostgreSQL runtime dependencies from the Hyperdrive-shaped connection binding.
- The API router defaults to unavailable/null dependencies rather than constructing a legacy database adapter.
- Seventeen D1 source/test artifacts and twelve legacy `apps/api/migrations/*.sql` files were deleted.
- The hardening suite fails if those D1 artifacts, imports, or bindings are reintroduced.

Historical documents that describe an earlier D1-backed state are retained as historical evidence; they are not current runtime configuration. This report supersedes those historical observations only for the PostgreSQL migration status.

## Security and dependency evidence

The final acceptance run passed:

- repository secret scanning;
- `pnpm audit --audit-level high`;
- `pip-audit` for the node-agent development requirements;
- full security-hardening Python tests.

No production database connection string, Hyperdrive identifier, or application secret is committed as part of this migration evidence.

## Rollback and operations

`docs/runbooks/database-restore.md` remains the operational restore/rollback reference. It identifies PostgreSQL as authoritative, uses the repository schema as the restore contract, documents backup and restore commands, requires smoke validation after restore, and explicitly excludes D1 as a recovery path.

## Deployment-only validation still required

The following items are outside repository/CI acceptance and must be completed in the target environment before declaring the live rollout production-ready:

- provision/configure the actual Cloudflare Hyperdrive binding for the production PostgreSQL instance;
- configure production secrets and provider credentials through the deployment secret mechanism;
- deploy the Worker and run live HTTP smoke checks against the production/staging database path;
- execute the real-VPS/node rollout and operational acceptance checklist;
- observe production monitoring/alerts during cutover and exercise the documented rollback decision path if required.

## Conclusion

The repository migration from the legacy D1 runtime to PostgreSQL is complete and regression-protected. PostgreSQL schema, persistence adapters, concurrency-sensitive flows, backup/restore, restored-database HTTP serving, security scans, audits, tests, typecheck, and build are all verified by CI. Live infrastructure rollout remains a separate deployment gate and is intentionally not represented here as completed.
