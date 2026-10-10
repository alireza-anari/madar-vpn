# Agent/Xray Fail-Closed Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the real Phase 7 Gate J blocker so managed Xray cannot remain serving when the Node Agent is failed, stopped, restarting, or unable to prove control of the current runtime.

**Architecture:** Add a focused `SystemdXrayLifecycle` primitive that owns an ephemeral authorization marker under `/run`, revokes that marker before stop/kill operations, and verifies Xray state from explicit systemd properties rather than trusting command exit codes. The Xray adapter grants runtime authorization only after candidate validation and live-config promotion. Production wiring then atomically adds Agent/Xray systemd lifetime binding plus verified startup/shutdown handling. Stale/no authorization stops Xray; a fresh explicit empty policy may still intentionally authorize a zero-client Xray runtime.

**Tech Stack:** Python 3.12+, pytest, systemd unit files, Xray-core v26.3.27, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-10-agent-xray-fail-closed-lifecycle-design.md`

## Global Constraints

- Persisted `/etc/madar-node-agent/xray-config.json` is never authorization by itself.
- `madar-node-agent.service` remains the lifecycle authority and must not `Wants=`/`Requires=` Xray as a startup dependency.
- Agent runtime authorization is ephemeral per service activation and lives only under `/run/madar-node-agent`.
- `RuntimeDirectoryPreserve=no` is explicit so restart cannot inherit the previous activation's marker.
- Xray binds its lifetime to the Agent and cannot normally start without both the live config and current authorization marker.
- Start gating uses both a systemd condition and an `ExecStartPre` marker check so automatic/manual starts cannot serve without the current marker.
- A nonzero stop command is not proof of failure and a zero stop command is not proof of inactivity. Actual unit state is independently verified.
- “Inactive” is accepted only from parseable systemd state showing `ActiveState` is `inactive` or `failed` **and** `MainPID=0`; activating/deactivating/reloading/active, nonzero MainPID, missing fields, or an unqueryable state are not treated as safe.
- Any force-stop path is bounded and followed by the same state verification.
- No command stdout/stderr containing system details or secrets is copied into raised/logged lifecycle errors.
- Stale policy, missing fresh authorization, invalid policy, startup failure, runtime/outbox construction failure, or Agent shutdown must leave managed Xray down.
- A **fresh explicit empty policy** is different: it may validate/promote an empty client config, grant current runtime authorization, and run Xray with zero managed clients.
- Existing Free accounting, telemetry durability, Premium semantics, SSH/firewall policy, and Xray release pin must not change.
- Historical VPS evidence in `docs/test-reports/phase-7-vps.md` remains immutable history; repository automation cannot retroactively mark Gate J PASS.
- Phase 8 remains unstarted. Production Ready remains unclaimed.

## Review Focus

1. **Stop result vs real state:** `stop failed + verified inactive` may continue; `stop succeeded + process/state still active` must force-close.
2. **Restart-on-failure race:** marker is revoked before force-kill; Xray has both marker condition and pre-start check, so a restart attempt cannot serve without fresh authorization.
3. **Stale vs explicit empty policy:** stale/no authorization means runtime down; a current empty policy means an intentionally authorized zero-client runtime.
4. **Agent restart/crash:** old marker disappears between activations and `BindsTo` pulls Xray down before a replacement Agent may authorize it again.
5. **Cleanup ordering:** sampler-stop failure must not skip runtime disable; shutdown uses nested `finally`/best-effort cleanup while systemd binding remains the independent guarantee.
6. **Update atomicity:** both unit files are staged before `daemon-reload` and Agent restart so normal update never activates a mixed old/new pair.

---

## File Map

### lifecycle primitive
- Create `node-agent/madar_agent/lifecycle.py`.
- Create `node-agent/tests/test_xray_lifecycle.py`.

### Xray authorization + service construction
- Modify `node-agent/madar_agent/xray.py`.
- Modify `node-agent/madar_agent/service.py` for construction/wiring only in Task 2.
- Modify `node-agent/tests/test_xray_adapter.py`.
- Modify `node-agent/tests/test_agent_core.py`.
- Modify `node-agent/tests/test_service_runtime.py`.

### systemd + process lifecycle
- Modify `node-agent/systemd/madar-node-agent.service`.
- Modify `node-agent/systemd/madar-xray.service`.
- Modify `node-agent/madar_agent/service.py` startup/shutdown in Task 3.
- Modify `node-agent/tests/test_reboot_runtime.py` and `test_service_runtime.py`.

### installer/docs/evidence
- Modify `node-agent/tests/test_installer.py`.
- Modify `node-agent/madar_agent/installer.py` only if the existing stage-both-before-reload order fails the new regression test.
- Modify `docs/runbooks/node-install.md` after repository behavior is green.
- Modify `docs/test-reports/phase-7-vps.md` only to append repository/CI remediation evidence before the field rerun; preserve the current Gate J failure section.
- Update the approved spec status after plan execution starts.

---

## Task 1: Add the fail-closed systemd lifecycle primitive

**Files:** create `node-agent/madar_agent/lifecycle.py`, `node-agent/tests/test_xray_lifecycle.py`.

**Interface:**

```python
class XrayLifecycleError(RuntimeError): ...

class SystemdXrayLifecycle:
    def grant_authorization(self) -> None: ...
    def revoke_authorization(self) -> None: ...
    def authorization_granted(self) -> bool: ...
    def is_active(self) -> bool: ...
    def ensure_inactive(self) -> None: ...
    def restart_authorized(self) -> None: ...
    def disable(self) -> None: ...
```

Constructor dependencies: process runner, marker path (default `/run/madar-node-agent/xray-authorized`), injected sleep, and fixed poll attempts/interval for deterministic tests.

- [ ] **Step 1 — RED marker tests:** runtime parent must already exist; marker creation is atomic, contains no secret, mode `0600`, rejects symlink/non-regular marker targets, and revocation is idempotent.
- [ ] **Step 2 — RED state parser:** production query uses `systemctl show madar-xray.service --property=ActiveState --property=SubState --property=MainPID --no-pager`. Exact `inactive|failed` plus `MainPID=0` is safe; active/activating/deactivating/reloading, nonzero PID, malformed/missing fields, or query failure is active/unverifiable and cannot be accepted as closed.
- [ ] **Step 3 — RED stop matrix:** marker is revoked first; normal stop nonzero + verified inactive succeeds; normal stop zero + still active triggers force-kill; stop nonzero + active + force-kill then inactive succeeds; state still active/unverifiable after bounded polling raises.
- [ ] **Step 4 — RED authorized restart:** restart without marker is rejected; restart command failure or post-restart state not active revokes marker and drives best-effort `ensure_inactive()`; success requires marker and verified active state.
- [ ] **Step 5 — Verify RED:** `python3 -m pytest node-agent/tests/test_xray_lifecycle.py -q`.
- [ ] **Step 6 — GREEN helper:** force recovery uses `systemctl kill --kill-who=all --signal=SIGKILL madar-xray.service`, then bounded state polling. Never include raw command output in `XrayLifecycleError`.
- [ ] **Step 7 — Verify/commit:** focused suite green; commit `fix: add fail-closed Xray lifecycle control`.

The marker is revoked **before** kill because Xray keeps `Restart=on-failure`; no automatic restart may inherit authorization.

---

## Task 2: Gate Xray around validated policy and wire lifecycle into service construction

**Files:** modify `node-agent/madar_agent/xray.py`, `node-agent/madar_agent/service.py`, `node-agent/tests/test_xray_adapter.py`, `node-agent/tests/test_agent_core.py`, `node-agent/tests/test_service_runtime.py`.

**Adapter callbacks:**
- `authorize_runtime: Callable[[], None]`
- `revoke_runtime_authorization: Callable[[], None]`
- `disable_runtime: Callable[[], None]`
- existing `reload` becomes the controlled `lifecycle.restart_authorized` callback in production;
- existing `is_active` becomes `lifecycle.is_active`.

**Service construction:** add `build_xray_lifecycle()` and allow `build_agent_service(*, lifecycle=None)`; production/focused tests must prove the same lifecycle instance supplies authorize/revoke/restart/disable/active callbacks.

- [ ] **Step 1 — RED apply ordering:** valid `apply_clients()` order is candidate write -> pinned Xray `-test` -> atomic live promotion -> marker grant -> controlled restart -> live health verification -> in-memory client-set update. Marker cannot be granted before validation/promotion.
- [ ] **Step 2 — RED failure matrix:** any candidate/apply failure closes access. Candidate validation, marker grant, restart, or post-start health failure must revoke authorization and best-effort disable runtime. Fixture REALITY private key/client UUID must not enter raised/logged error text.
- [ ] **Step 3 — RED stale semantics:** `disable_managed_access()` no longer implements stale state by `apply_clients([])`; it clears in-memory clients, revokes authorization, and disables the runtime.
- [ ] **Step 4 — RED fresh-empty semantics:** a fresh explicit empty policy still uses normal `apply_clients([])`, validates/promotes a zero-client config, grants the marker, starts Xray, verifies health, and remains a valid applied policy.
- [ ] **Step 5 — RED Agent policy cases:** stale policy, invalid policy, startup with no current authorization, and expiry during control-plane outage call the hard disable path; fresh non-empty and empty policy use normal apply.
- [ ] **Step 6 — RED construction wiring:** `build_agent_service(lifecycle=fake)` passes the lifecycle callbacks into `PinnedXrayAdapter`; no second lifecycle instance is created when one is supplied.
- [ ] **Step 7 — Verify RED:** `python3 -m pytest node-agent/tests/test_xray_adapter.py node-agent/tests/test_agent_core.py node-agent/tests/test_service_runtime.py -q`.
- [ ] **Step 8 — GREEN implementation:** keep lifecycle callbacks mandatory for managed production behavior; test-only adapters that never manage clients may omit them only where existing isolated tests require it. Fail closed rather than silently falling back to legacy empty-config behavior.
- [ ] **Step 9 — Verify/commit:** focused suites green; commit `fix: authorize Xray only from fresh policy`.

At the end of Task 2, application-level Xray management understands authorization markers, but the systemd binding/marker start gate is not yet considered complete until Task 3.

---

## Task 3: Atomically add systemd binding and verified Agent startup/shutdown

**Files:** modify `node-agent/tests/test_reboot_runtime.py`, `node-agent/tests/test_service_runtime.py`, `node-agent/systemd/madar-node-agent.service`, `node-agent/systemd/madar-xray.service`, `node-agent/madar_agent/service.py`.

- [ ] **Step 1 — RED unit contract:** Agent has `RuntimeDirectory=madar-node-agent`, `RuntimeDirectoryMode=0700`, `RuntimeDirectoryPreserve=no`, and no Xray startup dependency. Xray has `BindsTo=madar-node-agent.service`, `After=madar-node-agent.service network-online.target`, both config and marker `ConditionPathExists`, `ExecStartPre` checks for both config and marker, bounded stop cleanup (`TimeoutStopSec`, explicit control-group kill semantics), and no independent `[Install]` target.
- [ ] **Step 2 — RED startup matrix:** `main()` creates one lifecycle, calls `ensure_inactive()` before runtime/outbox build, allows a failed stop command only when final state is verified inactive, invokes force-close when needed, and returns 4 without build when inactivity cannot be proved.
- [ ] **Step 3 — RED build failure:** after verified startup closure, runtime/outbox construction failure calls best-effort lifecycle disable, returns the generic startup error, and leaks no fixture identifier/detail.
- [ ] **Step 4 — RED shutdown matrix:** normal stop, fatal permanent API exit, and sampler-stop exception all reach best-effort lifecycle disable. Use nested cleanup so sampler failure cannot skip Xray authorization revocation/stop. Cleanup errors must not echo secrets or override the intended process exit contract.
- [ ] **Step 5 — Verify RED:** `python3 -m pytest node-agent/tests/test_reboot_runtime.py node-agent/tests/test_service_runtime.py -q`.
- [ ] **Step 6 — GREEN units/service:** implement the exact contract without `PartOf=` and without Agent `Wants=`/`Requires=` Xray. Remove raw `_stop_xray/_restart_xray/_xray_is_active` production lifecycle decisions in favor of the shared lifecycle object.
- [ ] **Step 7 — Cross-regression:** run `python3 -m pytest node-agent/tests/test_reboot_runtime.py node-agent/tests/test_service_runtime.py node-agent/tests/test_xray_lifecycle.py node-agent/tests/test_xray_adapter.py node-agent/tests/test_agent_core.py -q`.
- [ ] **Step 8 — Commit:** `fix: bind Xray runtime to agent authorization`.

Task 3 is the first commit that claims the complete repository-level Gate J remediation design; do not deploy an earlier intermediate commit to the VPS.

---

## Task 4: Lock updater behavior, documentation, and repository acceptance

**Files:** modify `node-agent/tests/test_installer.py`; modify `node-agent/madar_agent/installer.py` only if needed; modify `docs/runbooks/node-install.md`, `docs/test-reports/phase-7-vps.md`, and spec/plan status.

- [ ] **Step 1 — Installer characterization/regression:** assert `update()` stages the Agent unit and Xray unit before `daemon_reload`, then restarts Agent only, and never independently enables/starts Xray. The current implementation appears to already have this order; if the new regression passes immediately, make no production installer change and record it as preserved behavior rather than fabricating a RED failure.
- [ ] **Step 2 — Full Python verification:** run focused changed tests, then `pnpm test:python`.
- [ ] **Step 3 — Full repository verification:** obtain a fresh exact-head CI covering secret scan, PostgreSQL schema/backup-restore/runtime tests, dependency audits, JS/TS tests, typecheck, build, and Python tests.
- [ ] **Step 4 — Diff/security review:** review the implementation range for unrelated refactors, command-output leaks, marker/config permission regressions, or any path that can start Xray without fresh authorization.
- [ ] **Step 5 — Docs:** update runbook with `BindsTo`, ephemeral marker, exact state verification, stale-vs-fresh-empty behavior, and updater ordering. Append repository/CI remediation evidence after the historical Gate J failure in `phase-7-vps.md`; preserve the failure evidence and keep Phase 7 INCOMPLETE.
- [ ] **Step 6 — Status:** update the approved spec from draft-review wording to approved/implemented-at-repository-level wording and record exact implementation head + CI in this plan.
- [ ] **Step 7 — Commit/docs CI:** commit `docs: record fail-closed lifecycle remediation status`, then require the final documentation head CI to succeed too.

Repository acceptance is not field acceptance. Gate J remains open until Task 5.

---

## Task 5: Rerun Gate J on the real VPS — Work only

**Execution environment:** existing disposable VPS through Work/SSH. Do not consume Work for Tasks 1-4.

**Prerequisites:** one exact Tasks 1-4 head with full CI success; deploy Agent code and both unit files together; `daemon-reload`; explicitly stop both services for the maintenance transition; start Agent only.

- [ ] Reproduce the original controlled startup stop-command failure while Xray initially serves the disposable credential. Agent may fail, but Xray must become inactive and repeated external VLESS+REALITY probes must fail.
- [ ] Attempt manual Xray start with Agent inactive/no marker; it must not become a serving runtime.
- [ ] Kill/crash Agent while authorized Xray is serving; `BindsTo` must pull Xray down and traffic must fail.
- [ ] Restart Agent with control plane unavailable; the old marker must be gone and Xray must stay down.
- [ ] Restore fresh valid policy; Agent may create a new marker, start Xray, pass health/readiness, and external traffic may succeed again.
- [ ] Force runtime/outbox initialization failure; marker absent and Xray down.
- [ ] Reboot current units; persisted config alone must not expose stale access before fresh authorization.
- [ ] Confirm marker disappears on stop/restart/reboot and is owner-only while present.
- [ ] Recheck bounded logs/privacy and existing secret/outbox permissions; preserve historical journals.
- [ ] Update `docs/test-reports/phase-7-vps.md` with exact head, CI, fault-injection method, safe evidence, and cleanup state. Only mark Gate J PASS if every mandatory real check passes.

If Gate J passes and no other single-node Phase 7 item remains open, Phase 7 may be reconsidered for PASS. Phase 8 still requires explicit user instruction. Premium single-active-client/device enforcement remains a separate unresolved release gate.

---

## Completion Evidence Required

Before claiming repository implementation complete:
- focused RED/GREEN evidence exists for every behavior that actually required a change;
- characterization tests may legitimately start GREEN only for already-correct behavior such as current updater ordering;
- complete `pnpm test:python` passes;
- one fresh full GitHub Actions run passes on the exact implementation head and again on the final docs head if different;
- implementation-range review finds no unrelated refactor or secret-bearing output;
- Phase 7 report still says INCOMPLETE before Work field proof.

Before claiming Gate J fixed:
- Task 5 real VPS evidence must exist; CI alone is insufficient.
