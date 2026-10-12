# Phase 10 Task 32 Installer Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the supported Madar node installer own the pinned Speed Enforcer release lifecycle end-to-end, then prove update, retirement, removal, clean re-enrollment, readiness, policy acknowledgement, and real VPN recovery on the retained disposable Node2.

**Architecture:** A dedicated GitHub release workflow publishes immutable static `linux/amd64` and `linux/arm64` Speed Enforcer assets from an exact repository SHA. Python installer code pins that release tag and repository-owned SHA-256 digests, verifies the complete HTTPS download before mutation, atomically installs the executable, and stages Agent/Xray/Speed units while leaving runtime authorization and subordinate service startup to the Agent. Repository/CI evidence is followed by a destructive-but-recoverable Node2 replacement acceptance sequence; Task 32 remains incomplete until the field sequence passes.

**Tech Stack:** Python 3.12, pytest, `urllib.request`, `hashlib`, POSIX atomic rename/fsync, systemd, GitHub Actions, GitHub CLI in Actions, Go 1.24.x static build helper, PostgreSQL 17 recovery tests, Xray-core 26.3.27.

**Spec:** `docs/superpowers/specs/2026-10-13-phase-10-speed-enforcer-installer-design.md`

## Global Constraints

- Speed Enforcer is installed from a published immutable release asset; it is never compiled on the VPS.
- The accepted release tag and SHA-256 digest for each supported architecture are pinned in repository code; the installer has no version/URL/checksum environment override.
- Supported lifecycle targets are Linux `amd64` and `arm64` only (`x86_64`/`amd64` → `amd64`; `aarch64`/`arm64` → `arm64`).
- The binary target remains `/opt/madar-speed-enforcer/madar-speed-enforcer`, matching the existing systemd unit.
- A remote fetch, redirect-policy, size, or digest failure must occur before runtime mutation and must leave an existing binary untouched.
- `install` and `update` stage all three units, but directly start/restart only `madar-node-agent.service`; Xray and Speed Enforcer return only through Agent authorization/policy application.
- `remove` explicitly stops/disables Agent, Xray, and Speed Enforcer and removes all three managed runtime roots/units/state.
- Enrollment tokens remain interactive-only; raw node credentials, REALITY private keys, sidecar credentials, client UUIDs, and subscription secrets must never be printed or committed.
- Server-side retirement precedes local `remove`; local file deletion alone is never treated as credential revocation.
- No SSH or firewall configuration is changed by the installer.
- PostgreSQL backup/restore acceptance must remain green.
- Repository tests alone cannot PASS Task 32; retained disposable Node2 field evidence is mandatory.
- Node1 remains available throughout Node2 recovery; do not retire/remove both nodes together.
- `Production Ready` remains forbidden until the remaining Phase 10 gates pass.

## Review Focus

1. **Release redirects and partial/oversized bodies:** a valid initial GitHub URL that redirects to an unapproved/non-HTTPS final origin, returns zero bytes, or exceeds the bound must be rejected before mutation. Task 2 owns these tests.
2. **Checksum mismatch or interrupted replacement:** a bad asset must never replace the installed executable; an atomic-write failure before rename must preserve the old binary and clean the temp file. Tasks 2–3 own these tests.
3. **Subordinate runtime start ordering:** `install`/`update` must never `enable --now` or directly restart Xray/Speed Enforcer; only Agent restarts and re-authorizes them. Task 4 owns these tests.
4. **Post-enrollment local failure:** if sidecar installation/unit staging fails after a credential is issued, the credential and incomplete sidecar state must be cleaned and no service may be left falsely ready. Task 4 owns this test.
5. **Release/source drift:** the released Speed Enforcer assets must come from the exact CI-green SHA selected for release, and later installer-only commits must not silently change `speed-enforcer/`; otherwise publish a new tag/digests. Release Gate A and Task 6 own this check.

---

## File Structure

Release packaging:

- Create: `.github/workflows/release-speed-enforcer.yml` — explicit immutable release publisher for two Linux architectures.
- Create: `node-agent/tests/test_phase10_speed_release_workflow.py` — static contract for tag safety, asset names, exact build helper, and release permissions.
- Reuse: `scripts/build-speed-enforcer.sh` — authoritative static builder; no duplicate build logic.

Release verification:

- Create: `node-agent/madar_agent/speed_release.py` — platform mapping, pinned manifest, HTTPS/final-origin/size/SHA verification.
- Create: `node-agent/tests/test_speed_release.py` — release selection and download-verification tests.

Installer lifecycle:

- Modify: `node-agent/madar_agent/installer.py` — atomic executable install primitive and three-runtime lifecycle orchestration.
- Modify: `node-agent/installer_cli.py` — fetch/verify sidecar before lifecycle mutation for `install`/`update` only.
- Modify: `node-agent/tests/test_installer.py` — install/remove/failure cleanup and atomic-file behavior.
- Modify: `node-agent/tests/test_installer_update_order.py` — update ordering and Agent-only restart.
- Modify: `node-agent/tests/test_installer_cli.py` — prefetch/fail-before-mutation and command-specific download behavior.
- Create: `node-agent/tests/test_phase10_installer_assets.py` — production manifest/unit/path/secret-safe packaging contract.

Documentation/evidence:

- Modify: `docs/runbooks/node-recovery.md` — three-runtime update/remove/replacement procedure and release verification.
- Modify after field acceptance: `docs/test-reports/phase-10-recovery.md` — exact CI/release/Node2 evidence.
- Modify after PASS: `docs/superpowers/plans/2026-10-08-madar-implementation-plan.md` — reconcile Task 32 status only after all acceptance items pass.

---

### Task 1: Add an immutable Speed Enforcer release workflow

**Files:**
- Create: `.github/workflows/release-speed-enforcer.yml`
- Create: `node-agent/tests/test_phase10_speed_release_workflow.py`
- Reuse: `scripts/build-speed-enforcer.sh`

**Interfaces:**
- Consumes: `scripts/build-speed-enforcer.sh OUTPUT linux {amd64|arm64}`.
- Produces release assets named exactly `madar-speed-enforcer-linux-amd64`, `madar-speed-enforcer-linux-arm64`, plus `SHA256SUMS`.
- Produces release tag format `speed-enforcer-vMAJOR.MINOR.PATCH` from either `workflow_dispatch` or a pushed `release/speed-enforcer-vMAJOR.MINOR.PATCH` branch.

- [ ] **Step 1: Write the failing workflow contract test**

Add tests named `test_release_workflow_builds_both_static_assets_from_exact_sha` and `test_release_workflow_refuses_moving_or_reused_release_tags`. Assert the workflow file exists; has `contents: write` only for the release workflow; builds both architectures by calling the existing helper; uses exact asset names above; creates `SHA256SUMS`; validates `^speed-enforcer-v[0-9]+\.[0-9]+\.[0-9]+$`; targets `GITHUB_SHA`; contains no `latest`; and refuses an already-existing tag/release.

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `cd node-agent && pytest -q tests/test_phase10_speed_release_workflow.py`

Expected: FAIL because `.github/workflows/release-speed-enforcer.yml` does not exist.

- [ ] **Step 3: Implement `.github/workflows/release-speed-enforcer.yml`**

Use only official checkout/setup-go/upload-artifact/download-artifact actions plus the preinstalled `gh` CLI. Build a matrix for `amd64` and `arm64` from the exact triggering `GITHUB_SHA`; aggregate both binaries in one release job; derive the tag from the dispatch input or strip `release/` from `GITHUB_REF_NAME`; reject malformed/existing tags before `gh release create`; create `SHA256SUMS`; publish all three files with `--target "$GITHUB_SHA"`. Never build from or resolve a moving branch after checkout.

- [ ] **Step 4: Run the focused test and existing build-asset tests**

Run: `cd node-agent && pytest -q tests/test_phase10_speed_release_workflow.py tests/test_phase9_build_assets.py`

Expected: PASS.

- [ ] **Step 5: Run the exact static builder for both supported architectures**

Run from repository root:

```bash
scripts/build-speed-enforcer.sh /tmp/madar-speed-enforcer-linux-amd64 linux amd64
scripts/build-speed-enforcer.sh /tmp/madar-speed-enforcer-linux-arm64 linux arm64
file /tmp/madar-speed-enforcer-linux-amd64 /tmp/madar-speed-enforcer-linux-arm64
```

Expected: both outputs exist and are Linux executables for their requested architectures; no committed binary is created.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/release-speed-enforcer.yml node-agent/tests/test_phase10_speed_release_workflow.py
git commit -m "ci: add immutable speed enforcer releases"
```

#### Release Gate A — publish the first immutable asset set

This is an operational gate, not a substitute for repository tests.

- [ ] Wait for the normal CI run on the exact Task 1 commit to complete successfully.
- [ ] Create branch `release/speed-enforcer-v0.1.0` from that exact green commit; do not add commits to the release branch.
- [ ] Verify the release workflow triggered from that branch and completed successfully.
- [ ] Verify GitHub release `speed-enforcer-v0.1.0` targets the exact Task 1 commit and exposes exactly the two architecture binaries plus `SHA256SUMS`.
- [ ] Read `SHA256SUMS` from the release without downloading/executing an unverified binary, and record the two lowercase 64-hex digests for Task 2.
- [ ] If the workflow/tag/release already exists unexpectedly or the target SHA differs, stop; do not overwrite the release. Choose a new version only after diagnosing why.

---

### Task 2: Add pinned release selection and download verification

**Files:**
- Create: `node-agent/madar_agent/speed_release.py`
- Create: `node-agent/tests/test_speed_release.py`

**Interfaces:**
- Produces `SpeedEnforcerReleaseAsset(tag: str, asset_name: str, sha256: str, url: str)`.
- Produces `canonical_speed_arch(system: str, machine: str) -> str`.
- Produces `pinned_speed_enforcer_asset(system: str | None = None, machine: str | None = None) -> SpeedEnforcerReleaseAsset`.
- Produces `download_verified_speed_enforcer(asset: SpeedEnforcerReleaseAsset, *, opener=urllib.request.urlopen, max_bytes: int = 67108864) -> bytes`.
- Pins tag `speed-enforcer-v0.1.0` and the exact two digests from Release Gate A; there is no environment override.

- [ ] **Step 1: Write failing platform/manifest tests**

Add tests asserting Linux aliases map exactly as specified; non-Linux and unsupported architectures raise a secret-safe `SpeedReleaseError`; the selected URL is exactly under `https://github.com/alireza-anari/madar-vpn/releases/download/speed-enforcer-v0.1.0/`; both production digests match `^[0-9a-f]{64}$`; and neither digest is all zeros or a placeholder.

- [ ] **Step 2: Write failing transport/integrity tests**

Use an in-memory fake response exposing `read()` and `geturl()`. Assert: correct payload/hash passes; hash mismatch fails; empty body fails; body larger than `max_bytes` fails by reading at most `max_bytes + 1`; `http://` final URL fails; a final host outside `github.com` or `release-assets.githubusercontent.com` fails; allowed GitHub release redirect host passes. Assert exception text does not contain the payload sentinel.

- [ ] **Step 3: Run the focused tests and confirm RED**

Run: `cd node-agent && pytest -q tests/test_speed_release.py`

Expected: FAIL because `madar_agent.speed_release` does not exist.

- [ ] **Step 4: Implement the minimal verifier**

Use `platform.system()` / `platform.machine()` only as defaults; permit explicit values for deterministic tests. Stream at most `max_bytes + 1` bytes, reject zero/oversize before hashing success, verify the post-redirect URL with `urllib.parse.urlparse`, calculate SHA-256 with `hashlib.sha256`, compare with `hmac.compare_digest`, and return bytes only after every check passes. Error messages identify only failure class (`unsupported platform`, `release origin rejected`, `release size invalid`, `release digest mismatch`, `release download failed`).

- [ ] **Step 5: Run focused tests**

Run: `cd node-agent && pytest -q tests/test_speed_release.py`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add node-agent/madar_agent/speed_release.py node-agent/tests/test_speed_release.py
git commit -m "feat: verify pinned speed enforcer releases"
```

---

### Task 3: Add atomic executable installation to the installer system boundary

**Files:**
- Modify: `node-agent/madar_agent/installer.py`
- Modify: `node-agent/tests/test_installer.py`

**Interfaces:**
- Extends `InstallerSystem` with `install_executable(payload: bytes, destination: Path) -> None`.
- Implements `LocalSystem.install_executable(payload: bytes, destination: Path) -> None` using a same-directory temporary file, `0755`, file fsync, `os.replace`, and parent-directory fsync where supported.
- Later Task 4 consumes this primitive for `/opt/madar-speed-enforcer/madar-speed-enforcer`.

- [ ] **Step 1: Write the failing atomic-install tests**

Add `test_local_system_installs_verified_executable_atomically` and `test_atomic_executable_failure_preserves_old_binary_and_removes_temp`. The first asserts exact bytes and mode `0755`. The second starts with an old binary, injects/monkeypatches a failure immediately before `os.replace`, and asserts old bytes remain and no temporary file remains.

- [ ] **Step 2: Run the focused tests and confirm RED**

Run: `cd node-agent && pytest -q tests/test_installer.py -k 'executable or atomic'`

Expected: FAIL because `install_executable` does not exist.

- [ ] **Step 3: Implement the system primitive**

Create the destination parent with mode `0755`, use `tempfile.mkstemp(dir=destination.parent, prefix='.madar-speed-enforcer.')`, write/flush/fsync, `fchmod(0755)`, close, `os.replace`, then fsync an opened parent directory when the platform supports it. In `finally`, unlink a still-existing temporary path. Do not shell out and do not place payload bytes in argv/environment.

- [ ] **Step 4: Run installer tests**

Run: `cd node-agent && pytest -q tests/test_installer.py`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add node-agent/madar_agent/installer.py node-agent/tests/test_installer.py
git commit -m "feat: install node executables atomically"
```

---

### Task 4: Make NodeInstaller own all three runtime lifecycles

**Files:**
- Modify: `node-agent/madar_agent/installer.py`
- Modify: `node-agent/tests/test_installer.py`
- Modify: `node-agent/tests/test_installer_update_order.py`

**Interfaces:**
- Adds `SPEED_SERVICE_NAME = "madar-speed-enforcer.service"`.
- Extends `NodeInstaller.__init__(..., speed_enforcer_binary: bytes | None = None)`; `install()` and `update()` require verified bytes, while `status()` and `remove()` do not.
- Adds internal paths derived from existing `InstallPaths`: speed unit source/path, `/opt/madar-speed-enforcer`, and `/opt/madar-speed-enforcer/madar-speed-enforcer`.
- `install()` stages Agent/Xray/Speed and starts only Agent.
- `update()` refreshes Agent files → speed binary → three units → daemon reload → Agent restart only.
- `remove()` stops/disables all three services and removes all three unit/runtime roots plus state.

- [ ] **Step 1: Extend the FakeSystem and write failing install assertions**

Teach test `FakeSystem` to record `install_executable`. Add/extend a test asserting install places the supplied bytes at the speed binary path, stages `madar-speed-enforcer.service`, and contains no `enable_and_start` action for Xray or Speed Enforcer. Assert Agent remains the only `enable_and_start` action.

- [ ] **Step 2: Write the failing post-enrollment cleanup test**

Make `install_executable` raise after the fake enrollment returned a credential. Assert all managed services receive stop/disable, the credential path and speed install root are removed, Agent is not left active, and no credential/token sentinel appears in output.

- [ ] **Step 3: Write the failing update-order test**

In `test_installer_update_order.py`, assert the ordered actions are: Agent source refresh; atomic speed binary install; stage Agent/Xray/Speed units; daemon reload; restart Agent. Assert no `restart` or `enable_and_start` for Xray/Speed.

- [ ] **Step 4: Write the failing remove test**

Assert remove stops/disables Agent, Xray, and Speed; removes `/opt/madar-node-agent`, `/opt/madar-xray`, `/opt/madar-speed-enforcer`, all three unit paths, credential/state; and performs daemon reload even when managed files are already absent.

- [ ] **Step 5: Run the focused tests and confirm RED**

Run: `cd node-agent && pytest -q tests/test_installer.py tests/test_installer_update_order.py`

Expected: FAIL on missing Speed lifecycle actions.

- [ ] **Step 6: Implement the lifecycle changes**

Keep existing `InstallPaths` stable and derive sibling Speed paths inside `NodeInstaller`. Add a small `_require_speed_enforcer_binary() -> bytes` guard used only by `install`/`update`. Extend operator-facing descriptions to mention Speed Enforcer without any secret value. Preserve existing Xray staging semantics.

- [ ] **Step 7: Run the focused tests**

Run: `cd node-agent && pytest -q tests/test_installer.py tests/test_installer_update_order.py`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add node-agent/madar_agent/installer.py node-agent/tests/test_installer.py node-agent/tests/test_installer_update_order.py
git commit -m "feat: manage speed enforcer installer lifecycle"
```

---

### Task 5: Fetch and verify the sidecar before CLI lifecycle mutation

**Files:**
- Modify: `node-agent/installer_cli.py`
- Modify: `node-agent/tests/test_installer_cli.py`
- Create: `node-agent/tests/test_phase10_installer_assets.py`

**Interfaces:**
- Consumes Task 2 `pinned_speed_enforcer_asset()` and `download_verified_speed_enforcer()`.
- Produces `load_speed_enforcer_binary() -> bytes` in `installer_cli.py`.
- Changes `build_install_installer(speed_enforcer_binary: bytes) -> NodeInstaller`.
- Changes `build_lifecycle_installer(*, speed_enforcer_binary: bytes | None = None) -> NodeInstaller`.
- `install` and `update` call `load_speed_enforcer_binary()` before builder/files/environment mutation; `status`, `observe`, and `remove` never download a release asset.

- [ ] **Step 1: Write failing CLI prefetch tests**

Add tests that monkeypatch `load_speed_enforcer_binary` to fail and assert install/update never reach `build_install_installer`, `write_agent_environment`, `NodeInstaller.install`, or `NodeInstaller.update`. Add tests asserting `status`, `observe`, and `remove` do not call the loader.

- [ ] **Step 2: Write the production packaging contract test**

In `test_phase10_installer_assets.py`, assert the Speed service source exists; its `ExecStart` remains `/opt/madar-speed-enforcer/madar-speed-enforcer --config /etc/madar-node-agent/speed-enforcer.json`; it retains both authorization `ConditionPathExists` guards; production release tag/digests are non-placeholder; `install.sh` still reads enrollment token silently and contains no release checksum/URL override flag; installer output/test fixtures do not include private-key or credential sentinel values.

- [ ] **Step 3: Run the focused tests and confirm RED**

Run: `cd node-agent && pytest -q tests/test_installer_cli.py tests/test_phase10_installer_assets.py`

Expected: FAIL because CLI does not fetch verified Speed assets or pass them into installers.

- [ ] **Step 4: Implement CLI wiring**

`load_speed_enforcer_binary()` resolves the pinned asset then verifies/downloads it. For `install`, call it before `build_install_installer(...)`; for `update`, call it before `build_lifecycle_installer(...)`. Convert `SpeedReleaseError` to a concise non-secret `SystemExit` without exposing response bodies. Do not add release-related environment variables or command-line options.

- [ ] **Step 5: Run all node-agent tests**

Run: `cd node-agent && pytest -q`

Expected: PASS.

- [ ] **Step 6: Run repository secret scan**

Run from repository root: `python3 scripts/security_scan.py .`

Expected: PASS with no committed secret finding.

- [ ] **Step 7: Commit**

```bash
git add node-agent/installer_cli.py node-agent/tests/test_installer_cli.py node-agent/tests/test_phase10_installer_assets.py
git commit -m "feat: wire verified speed release into installer"
```

---

### Task 6: Update the recovery runbook and pass full repository/CI regression

**Files:**
- Modify: `docs/runbooks/node-recovery.md`
- Verify: `.github/workflows/ci.yml`
- Verify: `tests/integration/postgres-backup-restore.sh`

**Interfaces:**
- Documents exact lifecycle contract that Task 7 will execute on Node2.
- Produces an exact CI-green SHA for field deployment.

- [ ] **Step 1: Update the runbook before field execution**

Replace the old “Speed real lifecycle blocked” wording with the implemented contract: pinned release tag/digest, three-service update/remove ownership, server-side retirement first, fresh one-time token, no old credential/REALITY-key reuse, and required post-update/post-reinstall heartbeat/readiness/policy/traffic checks. Keep Task 32 itself marked unverified until field acceptance.

- [ ] **Step 2: Run the complete local-equivalent verification set**

Run:

```bash
python3 scripts/security_scan.py .
bash tests/integration/postgres-schema.sh
bash tests/integration/postgres-backup-restore.sh
cd speed-enforcer && go test -race ./... && go vet ./... && cd ..
cd node-agent && pytest -q && cd ..
pnpm test
pnpm typecheck
pnpm build
```

Expected: every command PASS. If a local PostgreSQL/tool prerequisite is unavailable, do not substitute a claim; rely only on the subsequent GitHub Actions job for that gate.

- [ ] **Step 3: Verify release/source drift before field deployment**

Compare the Release Gate A target commit to current HEAD. There must be no changes under `speed-enforcer/` or `scripts/build-speed-enforcer.sh` after the release commit. If either changed, stop, publish `speed-enforcer-v0.1.1` from a fresh green SHA, update the pinned tag/digests, and rerun Tasks 2–6 verification.

- [ ] **Step 4: Commit the runbook**

```bash
git add docs/runbooks/node-recovery.md
git commit -m "docs: define complete node recovery lifecycle"
```

- [ ] **Step 5: Verify GitHub Actions on the exact resulting HEAD**

Wait for the CI run associated with exact HEAD. Inspect job steps and require success for security scan, PostgreSQL schema, PostgreSQL backup/restore, API PostgreSQL/restore smoke, dependency audits, Go race/vet/static build, all TS tests/typecheck/build, and full Python tests.

Expected: workflow conclusion `success`. Record exact HEAD and run ID for the recovery report.

---

### Task 7: Execute real Node2 update, retirement, remove, and clean replacement

**Files:**
- No repository code changes during the field sequence.
- Later evidence target: `docs/test-reports/phase-10-recovery.md`.

**Interfaces:**
- Consumes exact CI-green SHA from Task 6 and pinned release from Tasks 1–2.
- Uses retained Node2 only as the disposable recovery target; Node1 remains running.
- Produces safe field evidence with booleans/counts/status codes only, never raw secrets/UUIDs.

- [ ] **Step 1: Record a safe Node2 baseline**

Capture OS/architecture, boot ID, Agent/Xray/Speed service active state, installed unit presence, current pinned sidecar binary SHA match as a boolean, and fresh control-plane heartbeat/readiness. Store a one-way hash of the current Node2 REALITY private key in a root-only temporary file solely for post-replacement inequality comparison; never print the hash or key.

- [ ] **Step 2: Deploy the exact Task 6 source and run real `install.sh update`**

Use a trusted source checkout/copy pinned to the exact green SHA. Run the installer update from that source. Do not expose `agent.env`, node credential, REALITY private key, or sidecar config.

- [ ] **Step 3: Verify post-update runtime and control-plane recovery**

Require: Agent active; expected three units installed; sidecar binary owner/mode correct and SHA equals repository-pinned digest; fresh heartbeat/readiness timestamp later than the update start; current policy applied/ACKed; Xray/Speed subordinate state consistent with current policy; bounded update journal scan has zero known-secret matches.

- [ ] **Step 4: Destructive field gate — obtain explicit operator confirmation immediately before retirement**

Before the next step, confirm Node1 is still healthy/eligible and the operator still approves retiring/removing Node2. Do not infer this confirmation from earlier design approval if runtime conditions changed.

- [ ] **Step 5: Retire Node2 server-side through the real control-plane/admin path**

Use the real admin Servers retirement/delete flow so `NodeControlService.retireNode` revokes credentials before the surface record disappears. Do not emulate success by deleting local files or directly editing only the UI/surface record.

- [ ] **Step 6: Prove the previous Node2 credential is rejected**

Before local removal, run a small root-only Python probe on Node2 that reads the credential file internally, reads only the API base URL from managed config, calls a node-authenticated endpoint, and prints only the HTTP status/classification. Expected: `401` / node credential invalid. Never put the credential in shell argv or output.

- [ ] **Step 7: Run real `install.sh remove` and verify complete cleanup**

Require all three services inactive/absent as applicable; all three unit files absent; `/opt/madar-node-agent`, `/opt/madar-xray`, `/opt/madar-speed-enforcer`, `/etc/madar-node-agent` and node credential absent; daemon reload completed; SSH remains available and firewall unchanged.

- [ ] **Step 8: Reinstall/re-enroll Node2 with a fresh one-time token**

Use the same exact green installer source from outside the removed install root. Create a new node enrollment in the real admin flow and enter the fresh token only at the silent interactive prompt. Do not paste the token into chat, command arguments, environment variables, files, or shell history. Reuse only public node parameters as appropriate; let the installer generate new node-local REALITY key material.

- [ ] **Step 9: Prove old secret material was not reused**

Compare the new REALITY private-key hash internally against the root-only pre-removal hash and print only `REALITY_KEY_ROTATED=true`; delete the temporary old hash immediately. Confirm the replacement has a new authenticated node identity and that the retired credential remains unauthorized; do not print either credential.

- [ ] **Step 10: Obtain fresh heartbeat/readiness and policy ACK**

Wait for a new control-plane heartbeat after enrollment; publish/obtain the required current policy for the replacement; require a real acknowledgement for that replacement node before treating it as eligible. Enrollment alone is not Ready.

- [ ] **Step 11: Re-run real Xray/VLESS/REALITY traffic through replacement Node2**

Use a disposable/reusable non-secret test account/credential under the established Phase 7/8 field method. Prove a real VLESS+REALITY client flow exits through Node2 and that subscription eligibility includes the recovered node only after readiness/policy gates. If using a phone/v2rayNG step, record only safe counts/result, never subscription URL or client UUID.

- [ ] **Step 12: Restore safe idle field state and run privacy scans**

Return temporary test policy to empty/expected state, remove temporary client/origin/listener harnesses, require telemetry outbox drain, zero unmapped telemetry, no test listeners, and bounded Node1/Node2 journal scans with zero known-secret/raw-UUID matches. Retain safe JSONL/report evidence only.

Expected: every Node2 lifecycle/recovery item PASS. Any credential-auth success after retirement, old REALITY-key reuse, missing cleanup, missing ACK, or failed real traffic keeps Task 32 incomplete.

---

### Task 8: Record Task 32 acceptance and run final documentation CI

**Files:**
- Modify: `docs/test-reports/phase-10-recovery.md`
- Modify: `docs/superpowers/plans/2026-10-08-madar-implementation-plan.md`

**Interfaces:**
- Consumes Task 1 release run, Task 6 exact green CI, and Task 7 safe field evidence.
- Produces final Task 32 status only; it does not upgrade unrelated Phase 10 gates.

- [ ] **Step 1: Rewrite the recovery report from PARTIALLY VERIFIED to factual field status**

Record: exact repository SHA(s), CI run IDs/conclusions, release tag and target SHA, architecture asset verification, update result, retirement/old-credential rejection, remove cleanup, fresh enrollment, REALITY-key rotation boolean, fresh heartbeat/readiness/policy ACK, real traffic, privacy scans, database backup/restore CI, and any caveats. Do not include IP-sensitive secrets, raw node/client identifiers, credentials, private keys, tokens, subscription URLs, or database URLs.

- [ ] **Step 2: Reconcile the parent implementation plan**

Mark only the Task 32 checklist items actually proved by repository + field evidence. Do not alter Task 31/33 or Production Ready claims unless their own evidence independently supports it.

- [ ] **Step 3: Run repository security scan on the documentation changes**

Run: `python3 scripts/security_scan.py .`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add docs/test-reports/phase-10-recovery.md docs/superpowers/plans/2026-10-08-madar-implementation-plan.md
git commit -m "docs: record Phase 10 recovery acceptance"
```

- [ ] **Step 5: Verify final GitHub Actions on exact documentation HEAD**

Wait for CI associated with exact HEAD and require conclusion `success`; inspect that PostgreSQL backup/restore and all normal security/build/test gates still ran.

- [ ] **Step 6: Completion boundary**

Only if Tasks 1–8 and both CI checkpoints are green: declare **Task 32: PASS**. Do not declare **Phase 10 PASS** or **Production Ready** until every remaining Phase 10 acceptance gate, including unresolved Premium client-instance enforcement if still outstanding, is separately complete.
