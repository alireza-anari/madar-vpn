# Phase 10 Recovery / Task 32 Report

Date: 2026-10-14
Branch: `impl/phase-10-task32-installer`

## Overall status

**Task 32: PASS within the disposable amd64 recovery field scope below. Phase 10 and Production Ready are not PASS.**

The historical operator handoff proves the real installer update, retirement, remove and fresh replacement sequence. This continuation completed the previously missing application publication, replacement ACK/eligibility, public VLESS+REALITY Internet traffic, independent one-time enrollment replay witness and final safe cleanup. Historical SQL-seeded revision 1/2 observations are diagnostic only and are excluded from acceptance.

The operator subsequently authorized the runtime publication change and its TDD implementation. Acceptance combines the exact installer source and the separately tested/deployed API source below; it does not claim all results occurred on the old installer commit alone.

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

## Exact deployed source and release

- Historical installer source: `7834fe6c000411e61d22208df4d50f1184a80a2e`; exact successful CI `38341099149`, job `115112030331`, independently queried in this continuation.
- Fresh application source deployed on Node1: `2dfd0e3c81dba85430024a9e7e17b2970a439576`; full CI [38450115960](https://github.com/alireza-anari/madar-vpn/actions/runs/38450115960) succeeded on that exact SHA.
- No Agent, installer or Speed Enforcer runtime source change was introduced by the application publication work. The replacement's 16 installed Agent modules and three units matched the exact green Git blobs: 19 matches, zero mismatches, freshly checked at final cleanup.
- Speed release: `speed-enforcer-v0.1.0`; target `52d93efc0ae59d38e7ac3311e31b8f98c5ad73e5`.
- Linux amd64 digest: `25e2c0aad88013abf1e600791dc6c6b45d3eb30f962137cc8596aca69d4a74a3`; freshly verified on Node2, root-owned/executable, no group/world write.
- Linux arm64 digest: `a61b4b47946968cb2b3a4ee3d3817b0c76c93554ea4a40147cff08ea27367a32`; pinned release metadata only, no arm64 VPS field claim.

GitHub release metadata reports `immutable=false`. Version/tag refusal and repository-owned digest pinning are the verified contract, not absolute platform immutability. Node1's pre-existing binary was retained; this report does not claim Node1 was updated to Node2's release digest.

## Historical lifecycle evidence — operator handoff

These actions were completed before this continuation and were deliberately not repeated:

| Check | Recorded real result |
| --- | --- |
| Node2 installer update | Three units, core source, binary pin/permissions and bounded update privacy passed |
| Old authenticated policy transport | HTTP 200 |
| Operator-approved admin retirement | DELETE 204; old record absent, active credentials zero; Node1 remained healthy |
| Retired node credential | HTTP 401 |
| Installer remove | Managed runtime/state paths absent; three units not-found; SSH/firewall preserved |
| Same retained VPS reinstall | Fresh silent one-time enrollment, fresh authenticated identity, REALITY key inequality; old key witness removed |
| Replacement identity | One replacement record and one active credential |

Revision 1 empty and revision 2 Free policies were inserted directly into PostgreSQL before this continuation. Their ACKs do not count as application-path acceptance. No SQL policy, session or account mutation was used for the fresh acceptance below.

## Application publication — TDD, review, CI and deployment

The authenticated administrator route `POST /api/admin/nodes/:id/policy` accepts strict `current` or `empty` mode and bounded TTL (60–7200 seconds). Existing session, CSRF, Origin and rate-limit protections apply. It compiles authoritative active credentials, account verification/suspension, available Free credit, application Free speed and Premium entitlement; expiry is clamped to the entitlement/Tehran Free-day boundary. Publication, monotonic revision and audit are atomic. Responses contain only revision, expiry and client count with no-store.

The PostgreSQL publisher serializes publication/ACK at the node lock and clears obsolete per-user ACK eligibility. The reviewed fixes additionally reject expired subscription ACK eligibility, recheck the clock after a blocked ACK obtains its lock, and re-read settled credit after candidate-account locks.

- Initial pure compiler/HTTP tests were observed failing before implementation, then passed.
- RED CI `38447731672` exposed the missing PostgreSQL publisher; RED `38448444512` exposed obsolete user ACK retention.
- GREEN `38448794422` passed the first implementation.
- Independent code review found three expiry/concurrency issues. Regression commit `26dcb38db63ce4c4a3e262ca0141b22c87690cf4` produced RED CI `38449538584` with all three expected failures.
- Fix commit `2dfd0e3c81dba85430024a9e7e17b2970a439576` produced full GREEN `38450115960`; local typecheck and 135 API tests across 46 files passed.
- The real Node1 API assembly was rebuilt from that exact source against the real PostgreSQL database; HTTPS health returned 200. Agent installation and pinned sidecar release were unchanged.

This is a temporary Node22/PostgreSQL control plane with private-CA HTTPS, not production Cloudflare/Hyperdrive deployment. Node2 reaches it through the retained private SSH forwarding bridge on the Work computer. The API/admin/node surfaces were not exposed publicly. That operational bridge remains required for live Node2 heartbeats; it is distinct from the removed client test listener.

## Fresh replacement field acceptance

| UTC evidence | Check | Result |
| --- | --- | --- |
| 2026-10-13 18:09 | Bounded inbound probe | TCP 443 SYN reached Node2, but expired policy left no listener; raw capture discarded |
| 2026-10-13 18:58:39 | Actual admin current publication | HTTP 201/no-store, revision 3, one Free client, valid until 20:30 UTC; no SQL write |
| After revision 3 | Runtime and actual subscription service | Fresh policy ACK, healthy/ready/accepting, one active client; replacement eligible through production service |
| 2026-10-13 19:02:27 | Public VLESS+REALITY | Official Windows Xray 26.3.27 connected directly to Node2; ipify exit matched Node2; 1,048,576 Internet payload bytes received; both curl exits zero |
| 2026-10-13 19:06:27 | Independent disposable enrollment witness | Actual issue 201, consume 201, replay 401; actual admin retirement 204; witness record absent and active credentials zero |
| 2026-10-13 19:08:57 | Actual admin safe-idle publication | Empty revision 4, HTTP 201, ACK, clients zero, subscription service no longer eligible |
| 2026-10-13 19:16:30 | Credit/session cleanup | Audited removal of 593 unused seconds, restoring zero baseline; logout 204 and old session rejected 401 |

Windows client configuration remained only in the private orchestration pipe/process memory. The remote temporary config was removed and the local TCP 19090 test listener was absent after traffic. No profile, client ID, subscription URL or raw per-client observation is retained in the evidence.

The replacement installation token had already been discarded. Its specific replay was **not proved** and it was not recovered. The operator-authorized independent fresh witness proves real one-time replay rejection, not the identity of that earlier token. The disposable witness created no VPS and was retired afterward.

## Final safe state and cleanup — 2026-10-14

Overnight, the bounded empty policies expired and the disconnected bridge caused stale state. The Agents correctly stopped Xray fail-closed. The existing private bridge was restored and empty policies were republished through actual authentication and the admin endpoint, not database insertion.

Authentication used the existing verified administrator and the real request/consume API with a temporary root-only Unix mail channel (mode 600, nonce in memory). It created no public mail endpoint. The session was logged out (204), subsequent identity access returned 401, and the private session file/mail channel were removed. The original default API assembly on exact `2dfd0e3` was restored, HTTPS health 200.

At `2026-10-14T05:07:35.310Z`:

- Node1 empty revision 34 and Node2 empty revision 5 were fresh and ACKed; both status ready, health healthy/ready, capacity accepting with zero clients. Heartbeat ages were 4 and 16 seconds respectively.
- Policy expiry is bounded: Node1 `2026-10-14T07:05:01.829Z`; Node2 `2026-10-14T07:05:01.863Z`. This snapshot is not a claim of indefinite readiness: expiry or loss of the retained bridge causes fail-closed behavior.
- Active administrator sessions zero; active unused enrollment tokens zero; replacement records one; field-window unmapped telemetry zero.
- The original field day's credit total (Tehran day derived from the October 13 start, not the next day's reset) was zero, equal to its pre-test baseline.
- Both pending telemetry outboxes and activity-window tables were zero. State directories were mode 700 and agent environment files root-owned mode 600.
- Bounded journals from `2026-10-13T18:09:00Z` through final scan yielded zero known-secret, raw UUID and secret-field matches on both nodes. Raw journals were read/discarded in RAM; historical journals were preserved. Bounded old REALITY witness-file counts were zero.

At `05:08:28Z`/`05:08:30Z`, final cleanup confirmed Agent active, Xray active and Speed Enforcer inactive on both nodes. Twenty-six temporary field/helper/reference/rollback files were removed from Node1; targeted remaining count was zero on both nodes. The managed runtime, real API/certificates/database, operational SSH bridge, both VPSs and historical journals were preserved. No firewall or SSH rule was changed and no new paid resource was created.

Safe aggregate evidence is stored in `docs/test-reports/evidence/phase-10-task32-field.json`. It contains result metadata only; it is not a raw log or secret backup.

## Completion boundary

Task 32 combines the historical exact-green installer lifecycle with fresh exact-green application publication and affected field reruns. Database recovery CI, pinned replacement installation, retirement/re-enrollment, real replacement traffic, independent replay witness and bounded final cleanup are complete. The specific discarded installation-token replay, arm64 field execution and production hosted-control-plane recovery are not claimed.

Evidence commit `12bdb829c7ae85a1a43cfb1cd2b227b013880d02` passed the complete [CI 38515338135](https://github.com/alireza-anari/madar-vpn/actions/runs/38515338135), including PostgreSQL schema/backup/restore/runtime/integration, security/dependency audits, Go, all TS/Python tests, typecheck and build. This closure update must also pass its own exact-head CI before handoff. Unrelated Task 31/33/34 acceptance, Phase 10 and Production Ready remain unpromoted. No next phase is started.
