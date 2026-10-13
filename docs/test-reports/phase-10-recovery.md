# Phase 10 Recovery / Task 32 Report

Date: 2026-10-13
Branch: `impl/phase-10-task32-installer`

## Overall status

**Task 32: PARTIALLY VERIFIED / BLOCKED on application policy publication and completion of replacement-node field acceptance.**

The PostgreSQL recovery contract and control-plane retirement path are CI-verified. The operator handoff records real Node2 update, retirement, credential rejection, removal and fresh reinstall on the exact installer source below. Those historical field results were not repeated in this continuation. The complete recovery acceptance remains blocked: existing policy/ACK diagnostics were seeded with direct SQL, and this source has no operational application policy-publication path. The operator explicitly chose to document this blocker without changing runtime code.

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

## Real node lifecycle — historical execution; complete acceptance blocked

The operator handoff records real update, retirement, old-credential rejection, remove and fresh reinstall/re-enrollment. The detailed continuation below distinguishes those historical results from fresh checks and lists the missing publication/traffic/cleanup acceptance. Lack of VPS access is no longer the blocker.

## Release gate

Task 32 is not fully complete while the real-VPS lifecycle items are BLOCKED. The project must not claim Production Ready on the basis of PostgreSQL CI recovery and automated node-control tests alone.

## Task 32 field continuation — 2026-10-13

### Exact source and release

- Installer source: `7834fe6c000411e61d22208df4d50f1184a80a2e`.
- Deployment CI: `38341099149`, job `115112030331`. This continuation independently queried the run and verified completed/success on that exact source SHA.
- Release: `speed-enforcer-v0.1.0`; target `52d93efc0ae59d38e7ac3311e31b8f98c5ad73e5`.
- Linux amd64 digest: `25e2c0aad88013abf1e600791dc6c6b45d3eb30f962137cc8596aca69d4a74a3`.
- Linux arm64 digest: `a61b4b47946968cb2b3a4ee3d3817b0c76c93554ea4a40147cff08ea27367a32`.

Release metadata/digests are carried from the operator handoff, not newly re-downloaded asset evidence. The release contract is version/tag refusal and digest pinning; GitHub reports `immutable=false`, so absolute platform immutability is not claimed.

### Historical real field evidence supplied by the operator

The continuation brief records these results on retained Node2. They are historical field evidence, not newly executed checks in this continuation:

- Real installer update: all three units present, installed core source/units match, pinned binary owner/mode/digest correct, bounded update privacy scan passed.
- Previous node authenticated policy transport returned HTTP 200.
- Actual administrator DELETE returned HTTP 204; retired node absent and active credential rows zero; Node1 remained healthy.
- Old node credential subsequently returned HTTP 401.
- Real remove left managed paths absent and all three unit load states `not-found`; firewall unchanged and SSH remained available.
- Fresh in-place reinstall/re-enroll on the same retained VPS used exact installer source; fresh REALITY material differed from the old witness, which was removed. Secret-file/state permissions and pinned binary verification passed.
- Replacement control-plane record count and active credential count were each one.
- Replacement revision 1 empty-policy and revision 2 one-Free-client diagnostics reached actual ACK and fresh healthy/ready heartbeats; runtime subordinate states matched those policies.

**The revision 1/2 policies were created by direct PostgreSQL inserts.** Their runtime results are diagnostic only and do not prove policy publication through the real application/control-plane path. No Premium traffic acceptance is claimed from this inventory.

### Fresh investigation in this continuation

- SSH to the replacement remained available.
- At `2026-10-13T18:09:09Z`, Agent was active, Xray and Speed Enforcer were inactive, and no TCP 443 listener was present.
- The historical checkout at `/home/ubuntu/madar-vpn` was still an older SHA. It was not treated as the authoritative installed installer source, and no fresh installed-source match is claimed from it.
- A simultaneous Windows TCP probe and bounded Node2 tcpdump observed an inbound TCP 443 packet reaching the OS, while the TCP connection failed. Raw packet output was discarded in memory; only booleans were emitted.

The earlier handoff's `INBOUND_443_PACKET_SEEN=false` is historical. The new capture proves packet arrival for this attempt; it does not prove Security Group attachment, NACL configuration, or successful VLESS traffic. No AWS rule was changed in this continuation, and no broad SSH/443 rule was introduced.

### Application policy-publication blocker

Inspection of the exact source found:

- `NodeControlStore` exposes `getPolicy` and `acknowledgePolicy`, but no publication primitive.
- The production PostgreSQL adapter reads `node_policy_revisions` and updates acknowledgement fields; it has no policy creation/compiler operation.
- The node HTTP routes retrieve and acknowledge policies. Repository policy-insert searches locate integration fixtures, not an operational application publication path.

Therefore the required acceptance-valid publication, fresh replacement ACK, real replacement traffic and final empty-policy recovery cannot be completed on this source without implementing an operational path. No direct SQL policy write was performed in this continuation. The operator selected **retain the blocker; do not change runtime**.

### Remaining acceptance and cleanup limitations

- Acceptance-valid policy publication and resulting fresh ACK: **BLOCKED**.
- Real replacement-node VLESS+REALITY Internet traffic: **NOT PROVEN in this continuation**.
- Replacement-install-token-specific replay: **NOT PROVEN**; the token was discarded after install and must not be recovered. Historical old-credential HTTP 401 is a different check.
- A separate disposable token issue/consume/replay/retire test: **NOT RUN in this continuation**; it would not retroactively prove replay of the replacement install token.
- Final empty policy with Agent/Xray active, Speed inactive, fresh ready heartbeat, ACK and zero clients: **NOT PROVEN through the application path**.
- Final bounded secret scan, drained outbox, zero unmapped telemetry and complete historical harness/admin-session cleanup: **NOT VERIFIED in this continuation**.

This continuation created no VPS, changed no runtime, repeated no retirement/remove/reinstall, regenerated no REALITY material, and created no temporary client credential/config/listener. Both VPSs and historical journals were preserved. Repository documentation/security checks are separate from missing runtime cleanup evidence.

Task 32 remains **BLOCKED / INCOMPLETE**. No Phase 10 PASS or Production Ready claim follows from this report. A final documentation CI result, once available, verifies only the documentation head and normal repository gates; it cannot substitute for the missing field acceptance.
