# Phase 10 Task 32 — Speed Enforcer installer lifecycle design

Date: 2026-10-13
Target branch: `impl/phase-1-native-lifecycle`
Working branch: `phase10-task32-installer-final`
Status: DESIGN APPROVED IN CHAT; awaiting written-spec review before implementation planning

## Context

Phase 9 proved the `madar-speed-enforcer` runtime on real VPS traffic, including fail-closed Free TCP/UDP behavior and Premium bypass. Phase 9 deliberately did not claim installer packaging for the sidecar; that responsibility was deferred to Phase 10 Task 32.

The current installer lifecycle manages the Node Agent and Xray unit/runtime, but it does not install, update, or remove the Speed Enforcer binary/unit as a first-class lifecycle asset. That leaves a real recovery gap: a clean replacement VPS cannot be expected to reproduce the Phase 9 runtime from the supported installer alone.

Task 32 therefore needs to complete the node lifecycle contract so a supported clean host can install all required runtime assets, update them deterministically, remove them cleanly, and then pass real replacement/re-enrollment acceptance.

## Goals

1. Install the Speed Enforcer from a published, immutable release asset rather than compiling Go on the VPS.
2. Pin the exact release version and SHA-256 digest in repository code so a modified or replaced remote asset is rejected.
3. Support both `linux/amd64` and `linux/arm64`, matching the existing reproducible build helper.
4. Make `install`, `update`, and `remove` own the Agent, Xray unit/runtime, and Speed Enforcer unit/runtime coherently.
5. Preserve the existing fail-closed runtime model: the installer stages the sidecar, while the Agent remains the authority that creates runtime authorization markers and starts the sidecar only when policy requires capped clients.
6. Keep lifecycle operations secret-safe: no enrollment token, node credential, REALITY private key, sidecar local credential, or raw client UUID may be printed.
7. After implementation, prove the lifecycle on the retained disposable Node2 with real control-plane retirement, credential rejection, update, remove, fresh re-enrollment, readiness/policy ACK, and real VPN traffic.

## Non-goals

- No automatic “latest release” discovery.
- No in-place remote updater for Xray.
- No Go toolchain installation on the VPS.
- No modification of SSH or firewall rules.
- No reuse of an old node credential or REALITY private key during replacement recovery.
- No Production Ready claim from repository tests alone.

## Supply-chain trust model

The installer must not trust a checksum downloaded from the same release location as the binary. Instead, repository code contains a small immutable manifest describing the accepted Speed Enforcer release for each supported architecture.

Example logical manifest:

```text
release tag: speed-enforcer-v0.1.0
linux/amd64:
  asset: madar-speed-enforcer-linux-amd64
  sha256: <repo-pinned digest>
linux/arm64:
  asset: madar-speed-enforcer-linux-arm64
  sha256: <repo-pinned digest>
```

The exact digest values are produced from CI-built release assets and committed before the installer can accept that release. The production installer has no environment-variable override for version, asset URL, or checksum. Test code may inject a downloader or fixture, but normal lifecycle commands use only the pinned manifest.

A transport compromise or replaced GitHub asset therefore causes a checksum mismatch and aborts before the installed binary is replaced.

## Release artifact contract

The existing `scripts/build-speed-enforcer.sh` remains the authoritative static build path. Release preparation builds:

- `madar-speed-enforcer-linux-amd64`
- `madar-speed-enforcer-linux-arm64`

using `CGO_ENABLED=0`, `-trimpath`, and the exact repository source revision intended for the release.

A release is immutable from the installer’s point of view. Updating the sidecar requires a repository change that pins a new tag and new digest(s), followed by normal review and CI. `install.sh update` installs the version pinned by the checked-out installer source; it never follows a moving `latest` alias.

## Installer architecture

### New release-asset abstraction

Add a small Python module under `node-agent/madar_agent/` that owns:

- supported platform/architecture mapping;
- release tag and asset-name selection;
- expected SHA-256 values;
- HTTPS-only download;
- size bound;
- digest verification;
- a verified binary payload/result type.

The module must reject:

- unsupported operating systems;
- unsupported architectures;
- redirects or final URLs that violate the approved HTTPS/GitHub release origin contract;
- empty or implausibly large assets;
- SHA-256 mismatch.

Error messages must identify only the class of failure, never secret values.

### Installer system primitive

Extend the installer system boundary with an explicit atomic binary-install operation rather than treating the sidecar as a source-tree file.

The local implementation must:

1. create `/opt/madar-speed-enforcer` root-owned;
2. write the verified bytes to a temporary file in that directory;
3. set executable permissions (`0755`);
4. flush/fsync the file;
5. atomically replace `/opt/madar-speed-enforcer/madar-speed-enforcer`;
6. fsync the parent directory where supported;
7. remove any temporary file on failure.

The target path is intentionally the stable path already used by `madar-speed-enforcer.service`, so the existing unit contract remains unchanged.

Replacing the binary while an old process is running is safe because the old process retains its open inode. The subsequent Agent restart owns the runtime transition; the installer must not directly start the sidecar.

## Lifecycle behavior

### `install`

Before mutating installed runtime state, the installer resolves the current host architecture and downloads/verifies the pinned Speed Enforcer asset.

Then installation proceeds with the existing enrollment safety rules:

1. stage/copy Node Agent files;
2. prepare Xray runtime/public configuration through the existing pinned Xray path;
3. enroll using the one-time token;
4. write the returned node credential with mode `0600`;
5. atomically install the verified Speed Enforcer binary;
6. stage all three systemd units:
   - `madar-node-agent.service`
   - `madar-xray.service`
   - `madar-speed-enforcer.service`
7. `systemctl daemon-reload`;
8. enable/start only `madar-node-agent.service`.

Xray and Speed Enforcer remain subordinate managed runtimes. They are not enabled or started directly by the installer before the Agent has validated policy/configuration and created ephemeral authorization markers.

If any post-enrollment local installation step fails, the installer must fail closed: stop managed services, remove the newly written node credential and incomplete sidecar install, and never report a ready installation.

### `update`

`update` is deterministic and non-discovering:

1. resolve host architecture;
2. download and verify the pinned sidecar asset completely before replacing the currently installed sidecar;
3. refresh Agent source files;
4. atomically replace the Speed Enforcer binary;
5. refresh Agent, Xray, and Speed Enforcer systemd units;
6. `daemon-reload`;
7. restart only `madar-node-agent.service`.

The Agent restart is the single orchestration boundary. Because Xray and Speed Enforcer are bound to the Agent, they must return only through normal validated Agent policy application. `update` must not call `restart` or `enable --now` on Xray or Speed Enforcer directly.

A download/checksum failure occurs before any sidecar replacement and leaves the previous runtime intact. A later local staging failure must surface as a failed update; it must not print secrets or silently claim success.

### `remove`

`remove` is local cleanup only; server-side retirement remains a mandatory prerequisite in the recovery runbook.

The local removal path must explicitly stop/disable all three managed services, including Speed Enforcer, then remove:

- node credential and managed state under `/etc/madar-node-agent`;
- `/opt/madar-node-agent`;
- `/opt/madar-xray`;
- `/opt/madar-speed-enforcer`;
- the three systemd unit files;
- runtime authorization markers/directories owned by the managed state path where applicable.

Finally it runs `daemon-reload`.

Local remove does not revoke a credential at the control plane. The accepted recovery order remains: retire server-side first, verify the old credential is rejected, then remove the local installation.

## Architecture and platform handling

Supported lifecycle hosts remain Linux only. Architecture mapping is explicit:

- `x86_64` / `amd64` → `amd64`
- `aarch64` / `arm64` → `arm64`

Any other host fails before download or runtime mutation. The installer must not guess compatible binaries.

## Failure and rollback boundaries

The design intentionally avoids a complex multi-version rollback manager.

- Remote fetch or checksum failure: no mutation.
- Atomic sidecar write failure before rename: old sidecar remains intact.
- Unit staging or Agent restart failure during `update`: command fails loudly; existing secret material stays protected; runtime readiness must be re-established by the Agent before the node is considered Ready.
- `install` failure after enrollment: remove local credential and incomplete managed assets; do not leave a falsely-ready service.
- `remove` is best-effort for already-absent files but must still execute service stop/disable and `daemon-reload`.

The control plane remains the authority for whether a node is eligible. A local command returning zero is not sufficient evidence for readiness.

## Security requirements

- Enrollment token remains interactive-only and is never persisted.
- Download URLs and checksums contain no secrets and may be logged only at a coarse release/version level if needed.
- Node credential remains `0600` and is never copied into command arguments.
- REALITY private key remains node-local and must not be emitted during lifecycle operations.
- Speed Enforcer configuration remains generated by the Agent under the existing secret-safe Phase 9 contract.
- Sidecar binary is root-owned executable code, not writable by the service process.
- No lifecycle command changes SSH or firewall settings.
- No “force” option may bypass checksum verification.

## Repository test strategy

Implementation follows TDD.

### RED tests first

Add/extend tests proving:

1. installer currently lacks Speed Enforcer lifecycle ownership;
2. `install` stages the Speed unit and verified binary but starts only the Agent;
3. `update` verifies the complete asset before mutation, atomically replaces the binary, stages all three units, reloads systemd, and restarts only the Agent;
4. checksum mismatch leaves the old binary untouched;
5. unsupported architecture fails before mutation;
6. `remove` stops/disables Speed Enforcer and removes its unit/runtime root;
7. lifecycle output contains no supplied token/credential/private-key sentinel values;
8. failure after enrollment removes the newly persisted credential and incomplete sidecar state;
9. the production release manifest has non-placeholder lowercase SHA-256 digests for every supported asset;
10. the service unit still points to `/opt/madar-speed-enforcer/madar-speed-enforcer` and retains its Phase 9 fail-closed authorization conditions.

### Full regression

After focused tests pass, run the complete Python node-agent suite, Go race/vet/build gates, TypeScript tests/typecheck/build, security scan, PostgreSQL schema tests, and backup/restore acceptance through the existing CI workflow.

No repository-only result is sufficient to PASS Task 32.

## Real Node2 acceptance sequence

The retained Node2 is the disposable field target. Node1 remains available as the surviving control/traffic node.

The field sequence must preserve recoverability and avoid deleting both nodes at once.

1. Record Node2 baseline readiness, current boot/service status, and fresh control-plane heartbeat without printing credentials.
2. Deploy the exact CI-green Task 32 installer source to Node2 through the approved field path.
3. Run real `install.sh update`.
4. Verify:
   - Agent active;
   - required units/files/binary exist;
   - pinned binary SHA-256 matches the repository manifest;
   - fresh control-plane heartbeat/readiness occurs after update;
   - policy apply/ACK remains current;
   - no secret appears in bounded lifecycle logs.
5. Retire Node2 server-side through the real control-plane path.
6. Prove the previous Node2 credential can no longer authenticate to a node API without printing the credential.
7. Run real `install.sh remove` on Node2.
8. Verify all three services/units, credential/state, Agent root, Xray root, and Speed Enforcer root are removed as specified.
9. Reinstall/re-enroll Node2 with a fresh one-time enrollment token. Never reuse the retired credential or old token.
10. Verify a newly generated node-local REALITY private key is not exposed to the control plane or logs.
11. Obtain fresh heartbeat/readiness and a fresh policy acknowledgement from the replacement node.
12. Re-run the required real Xray/VLESS/REALITY traffic gate through Node2 and confirm subscription eligibility behavior.
13. Run bounded privacy scans and confirm no raw credential/private key/client UUID leakage.
14. Record evidence in `docs/test-reports/phase-10-recovery.md`.

Task 32 can PASS only after all repository/CI gates and this real disposable-VPS lifecycle sequence succeed.

## Database recovery relationship

The PostgreSQL logical backup/restore contract already exists and remains part of Task 32 evidence. This change does not redesign database recovery. The new implementation must keep the existing backup/restore CI acceptance green.

Provider-managed PITR, production retention, and production cutover remain environment-specific and are not newly claimed by this installer work.

## Expected file changes

Likely implementation scope:

- Modify `node-agent/madar_agent/installer.py`
- Modify `node-agent/installer_cli.py`
- Modify `node-agent/tests/test_installer.py`
- Modify `node-agent/tests/test_installer_update_order.py`
- Add focused release-asset tests/module under `node-agent/madar_agent/` and `node-agent/tests/`
- Modify `node-agent/tests/test_phase9_build_assets.py` or add a Phase 10 packaging contract test
- Potentially add a release-build/publish helper or workflow if no existing immutable release path is sufficient
- Update `docs/runbooks/node-recovery.md`
- Update `docs/test-reports/phase-10-recovery.md` after real acceptance

The implementation plan must refine these paths after a fresh code review; this spec does not require unnecessary new abstractions if the existing installer boundaries can satisfy the same contracts more simply.

## Acceptance boundary

This work closes only the Task 32 node lifecycle/recovery gap. It must not claim overall Production Ready unless the remaining Phase 10 acceptance work also passes.
