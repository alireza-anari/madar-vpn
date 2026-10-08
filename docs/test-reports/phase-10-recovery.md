# Phase 10 Recovery / Task 32 Report

Date: 2026-10-09
Branch: `impl/phase-1`

## Overall status

**Task 32: PARTIALLY VERIFIED / BLOCKED on real disposable-VPS lifecycle acceptance.**

The PostgreSQL recovery contract and the control-plane node-retirement safety path are implemented and CI-verified. Real VPS reinstall/re-enroll, installer `update`, and installer `remove` cannot be marked PASS because this execution environment has no disposable supported Ubuntu VPS access.

This report is evidence only. It does not upgrade the project to Production Ready.

## PostgreSQL backup / restore — PASS

Implemented automated recovery contract:

- `tests/integration/postgres-backup-restore.sh`
- `docs/runbooks/database-restore.md`

The CI contract:

1. starts disposable PostgreSQL 17;
2. applies the authoritative core schema and deterministic witness data;
3. creates a custom-format logical backup with restrictive local permissions;
4. destroys the disposable `public` schema;
5. restores the backup using PostgreSQL 17 tooling;
6. verifies the witness user, its 1,800-second credit-ledger total, and the 5,000 kbps application speed setting.

An initial RED run correctly exposed a PostgreSQL client/server version mismatch (`pg_dump` 16 against server 17). The fix uses pinned PostgreSQL 17 backup/restore tooling rather than weakening the test.

Evidence:

- RED CI run `37844075946` — backup step failed on the expected tool-version incompatibility.
- GREEN commit `961094971feec368636807bff271c15b925f183c` — matching PostgreSQL 17 backup tooling.
- GREEN CI run `37844414391` — full pipeline PASS.
- Later full regression run `37846235396` — schema, backup/restore, dependency audits, tests, typecheck, build, and Python suite all PASS.

Verified scope is a disposable logical backup/restore contract. Provider-managed PITR, production retention policy, live Neon recovery, and production cutover remain environment-specific operations and are not claimed by this evidence.

## Node retirement safety — PASS (automated/control-plane scope)

A recovery review found that the admin delete path previously removed only the admin surface record and could leave the node credential authorized at the service boundary. Depending on D1 cascade behavior was not accepted as a storage-independent security invariant.

TDD evidence:

- RED service test commit `c9f527e0e1632c556c411366f57e82cc3857ad34` defined explicit secure node retirement.
- RED CI run `37844864521` failed only because `retireNode` did not exist; prior recovery/security gates remained green.
- GREEN introduced a `NodeControlStore.revokeNodeCredentials(...)` primitive, memory/D1 implementations, and `retireNode(...)` that revokes active credentials and marks the node offline.
- Full GREEN CI run `37845546373` passed all gates.

A second route-level RED proved the admin DELETE route still did not call retirement:

- RED commit `1275e5b4fddb35062ff120a645f1d31923d9e42f`.
- RED CI run `37845787718`: 100 API tests passed and exactly one failed because the old node credential still authenticated after DELETE.
- GREEN commit `3b8522c016d7c20117c8764794d47ba4801309c3` changed the route to retire the node before deleting the admin surface record.
- GREEN CI run `37846235396`: all gates PASS.

The resulting safety invariant is fail-closed: if control-plane retirement cannot be performed, the admin route does not silently delete only the surface record.

## Recovery documentation — PASS

Runbooks now exist for both sides of Task 32:

- `docs/runbooks/database-restore.md`
- `docs/runbooks/node-recovery.md`

The node recovery runbook requires server-side retirement before local removal, a fresh one-time enrollment token for replacement, no reuse of old node credentials, and no copying of a REALITY private key when compromise is suspected.

## Real node reinstall / re-enroll / recovery — BLOCKED / NOT RUN

Still requires a disposable supported Ubuntu VPS and real control-plane deployment. Required evidence includes:

- retire a real enrolled node and prove its previous node credential is rejected;
- clean reinstall/re-enroll with a fresh one-time token;
- prove no old credential/private key is reused or exposed;
- obtain fresh heartbeat/readiness/policy acknowledgement from the replacement;
- continue through real Xray/VLESS/REALITY validation before claiming usable VPN recovery.

No such real-VPS evidence exists in this environment, so this item remains BLOCKED.

## Installer `update` / `remove` on disposable VPS — BLOCKED / NOT RUN

Automated installer tests cover lifecycle semantics and secret-file cleanup, but the Task 32 requirement specifically calls for disposable-VPS execution.

Required real evidence still includes:

- run `install.sh update` on a disposable enrolled node and verify service restart plus fresh control-plane heartbeat/readiness;
- run `install.sh remove` after server-side retirement and verify service/unit/managed credential cleanup on the real host;
- verify no secret values are printed during either lifecycle operation.

No disposable VPS is available in this environment, so this item remains BLOCKED.

## Release gate

Task 32 is not fully complete while the real-VPS lifecycle items are BLOCKED. The project must not claim Production Ready on the basis of PostgreSQL CI recovery and automated node-control tests alone.
