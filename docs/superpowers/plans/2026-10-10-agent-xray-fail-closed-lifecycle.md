# Agent/Xray Fail-Closed Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the real Phase 7 Gate J blocker so managed Xray cannot remain serving when the Node Agent is failed, stopped, restarting, or unable to prove control of the current runtime.

**Architecture:** Bind the Xray systemd unit lifetime to the Agent, gate Xray start on an Agent-owned ephemeral authorization marker under `/run`, and add a small `SystemdXrayLifecycle` helper that revokes authorization before stop/kill operations and verifies actual unit inactivity rather than trusting a command exit code. The Xray adapter authorizes the runtime only after candidate validation and live-config promotion, then performs the controlled restart and health verification. Stale/no authorization stops the runtime; a fresh explicit empty policy may still intentionally authorize a zero-client Xray config.

**Tech Stack:** Python 3.12+, pytest, systemd unit files, Xray-core v26.3.27, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-10-agent-xray-fail-closed-lifecycle-design.md`

## Global Constraints

- Persisted `/etc/madar-node-agent/xray-config.json` is never authorization by itself.
- `madar-node-agent.service` remains the lifecycle authority and must not `Wants=`/`Requires=` Xray as a startup dependency.
- Agent runtime authorization is ephemeral per service activation and lives only under `/run/madar-node-agent`.
- `RuntimeDirectoryPreserve=no` is explicit so restart cannot inherit the previous activation's marker.
- Xray binds its lifetime to the Agent and cannot normally start without both the live config and current authorization marker.
- A nonzero `systemctl stop` is not proof that Xray is active; a zero exit code is not proof that it is inactive. State is verified independently.
- Any force-stop path is bounded and followed by state verification.
- No command stdout/stderr containing system details or secrets is copied into raised/logged lifecycle errors.
- Stale policy, missing fresh authorization, invalid policy, startup failure, runtime/outbox construction failure, or Agent shutdown must leave managed Xray down.
- A **fresh explicit empty policy** is different: it may validate/promote an empty client config, grant current runtime authorization, and run Xray with zero managed clients.
- Existing Free accounting, telemetry durability, Premium semantics, SSH/firewall policy, and Xray release pin must not change.
- Historical VPS evidence in `docs/test-reports/phase-7-vps.md` remains immutable history; repository automation cannot retroactively mark Gate J PASS.
- Phase 8 remains unstarted. Production Ready remains unclaimed.

## Review Focus

1. **Stop result vs real state:** both `stop failed + already inactive` and `stop succeeded + still active` must behave correctly.
2. **Restart-on-failure race:** authorization is revoked before force-kill, and the Xray unit condition prevents a killed process from re-establishing service without a fresh marker.
3. **Stale vs explicit empty policy:** stale/no authorization means runtime down; a current empty policy means an intentionally authorized zero-client runtime.
4. **Agent restart/crash:** old marker disappears between activations and `BindsTo` pulls Xray down before a replacement Agent may authorize it again.
5. **Update atomicity:** Agent and Xray unit files are staged together before `daemon-reload` and Agent restart so normal update never activates a mixed old/new unit pair.

---

## File Map

### systemd lifecycle contract
- Modify `node-agent/systemd/madar-node-agent.service`.
- Modify `node-agent/systemd/madar-xray.service`.
- Modify `node-agent/tests/test_reboot_runtime.py`.

### lifecycle primitive
- Create `node-agent/madar_agent/lifecycle.py`.
- Create `node-agent/tests/test_xray_lifecycle.py`.

### Agent runtime wiring
- Modify `node-agent/madar_agent/service.py`.
- Modify `node-agent/tests/test_service_runtime.py`.

### Xray authorization semantics
- Modify `node-agent/madar_agent/xray.py`.
- Modify `node-agent/tests/test_xray_adapter.py`.
- Modify `node-agent/tests/test_agent_core.py` only where stale/empty semantics need explicit regression coverage.

### installer/docs/evidence
- Modify `node-agent/tests/test_installer.py`.
- Modify `node-agent/madar_agent/installer.py` only if the existing stage-both-before-reload order does not satisfy the new regression tests.
- Modify `docs/runbooks/node-install.md` after repository behavior is green.
- Modify `docs/test-reports/phase-7-vps.md` only to append repository/CI remediation evidence before the field rerun; preserve the current Gate J failure section.
- Update the approved spec status after plan approval/execution starts.

---

## Task 1: Lock the systemd lifecycle contract

**Files:** modify `node-agent/tests/test_reboot_runtime.py`, `node-agent/systemd/madar-node-agent.service`, `node-agent/systemd/madar-xray.service`.

- [ ] **Step 1 — RED unit-contract tests:** assert Agent keeps only network startup dependencies; assert `RuntimeDirectory=madar-node-agent`, `RuntimeDirectoryMode=0700`, and `RuntimeDirectoryPreserve=no`; assert Agent contains no Xray `Wants=`/`Requires=` dependency. Assert Xray contains `BindsTo=madar-node-agent.service`, ordering after Agent, both config and `/run/madar-node-agent/xray-authorized` conditions, bounded stop cleanup (`TimeoutStopSec`), and no independent `[Install]` enable target.
- [ ] **Step 2 — Verify RED:** run `python3 -m pytest node-agent/tests/test_reboot_runtime.py -q`; expect failure against current units.
- [ ] **Step 3 — GREEN units:** add only the required lifecycle directives. Keep existing hardening and network ordering. Do not add `PartOf=` or a reverse Agent->Xray dependency.
- [ ] **Step 4 — Verify GREEN:** rerun focused test, then `python3 -m pytest node-agent/tests/test_reboot_runtime.py node-agent/tests/test_installer.py -q`.
- [ ] **Step 5 — Commit:** `fix: bind Xray lifecycle to node agent`.

Expected Xray unit intent:
- `BindsTo=madar-node-agent.service`
- `After=madar-node-agent.service network-online.target`
- config condition remains
- authorization-marker condition is added
- `Restart=on-failure` remains, but marker gating blocks unauthorized restart
- no independent boot enable section

---

## Task 2: Add a fail-closed systemd lifecycle primitive

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

The constructor takes the process runner, marker path (default `/run/madar-node-agent/xray-authorized`), and injected sleep/poll settings for deterministic tests.

- [ ] **Step 1 — RED marker tests:** parent runtime directory must already exist; marker creation is atomic, non-secret, mode `0600`, and symlink/non-regular marker paths are rejected. Revocation is idempotent.
- [ ] **Step 2 — RED state tests:** `systemctl is-active --quiet` return `0` = active and the known inactive code = inactive; unexpected/query-error status is treated as unverifiable and raises instead of being interpreted as safe.
- [ ] **Step 3 — RED stop matrix:** normal stop nonzero + verified inactive succeeds; normal stop zero + still active triggers force-kill; normal stop nonzero + active + force-kill then inactive succeeds; active/unverifiable after the bounded force path raises. Assert marker revocation happens before stop/kill.
- [ ] **Step 4 — RED authorized restart:** restart without marker is rejected; restart failure or post-restart inactive state revokes marker and drives `ensure_inactive()`; success requires marker + active state.
- [ ] **Step 5 — Verify RED:** `python3 -m pytest node-agent/tests/test_xray_lifecycle.py -q`.
- [ ] **Step 6 — GREEN implementation:** use `systemctl stop`, `systemctl is-active --quiet`, and a bounded `systemctl kill --kill-who=all --signal=SIGKILL madar-xray.service` recovery path. Use fixed, testable polling constants. Never embed command stdout/stderr in lifecycle exceptions.
- [ ] **Step 7 — Verify/commit:** focused suite green, then commit `fix: add fail-closed Xray lifecycle control`.

Implementation note: revoking the marker **before** kill is mandatory because Xray retains `Restart=on-failure`; an automatic restart attempt must encounter the missing marker.

---

## Task 3: Make Agent startup and shutdown use verified lifecycle state

**Files:** modify `node-agent/madar_agent/service.py`, `node-agent/tests/test_service_runtime.py`.

**Wiring:**
- add `build_xray_lifecycle()` returning the production `SystemdXrayLifecycle`;
- allow `build_agent_service(*, lifecycle=...)` so `main()` and the adapter share the same lifecycle object;
- wire adapter restart/active/authorization/disable callbacks from that object.

- [ ] **Step 1 — RED startup matrix:** replace the old “stop command failed => exit 4” assumption with: stop error + independently inactive => build may continue; stop success + still active => force path; cannot prove inactive => return 4 and do not build runtime/outbox.
- [ ] **Step 2 — RED build failure:** after verified startup closure, runtime/outbox construction failure leaves authorization absent, Xray inactive, returns the generic existing startup error, and leaks none of a fixture client/credential detail.
- [ ] **Step 3 — RED graceful/fatal shutdown:** normal SIGTERM path and fatal cycle exits attempt best-effort runtime disable after stopping the sampler. A cleanup exception must not echo secrets or convert systemd binding into the sole application flow; process still exits and systemd remains the independent guarantee.
- [ ] **Step 4 — Verify RED:** `python3 -m pytest node-agent/tests/test_service_runtime.py -q`.
- [ ] **Step 5 — GREEN service wiring:** remove raw stop/restart/is-active wrappers in favor of the lifecycle object where production Xray lifecycle decisions are made. Keep generic stderr messages and existing exit-code intent.
- [ ] **Step 6 — Verify/commit:** focused service + activity/outbox runtime tests green; commit `fix: verify Xray shutdown before agent startup`.

Do not start the activity sampler until startup closure and runtime construction have both succeeded.

---

## Task 4: Gate Xray authorization around validated config promotion

**Files:** modify `node-agent/madar_agent/xray.py`, `node-agent/tests/test_xray_adapter.py`, `node-agent/tests/test_agent_core.py`.

**Adapter callback additions:**
- `authorize_runtime: Callable[[], None]`
- `revoke_runtime_authorization: Callable[[], None]`
- `disable_runtime: Callable[[], None]`
- existing `reload` becomes the controlled authorized restart callback in production.

- [ ] **Step 1 — RED ordering test:** valid `apply_clients()` must execute in this order: render/write candidate -> pinned Xray validation -> atomic live promotion -> grant marker -> controlled restart -> health verification -> update in-memory managed-client set. Marker must not exist before validation/promotion.
- [ ] **Step 2 — RED failure matrix:** candidate validation failure creates no marker; grant/restart failure revokes marker and disables runtime; post-start health failure does the same; fixture REALITY private key and client UUID never appear in raised/logged error text.
- [ ] **Step 3 — RED stale semantics:** `disable_managed_access()` no longer calls `apply_clients([])`; it clears in-memory managed clients, revokes runtime authorization, and stops Xray through the lifecycle callback.
- [ ] **Step 4 — RED fresh-empty semantics:** a **fresh explicit empty policy** still calls normal `apply_clients([])`, validates/promotes the zero-client config, grants the current marker, and starts a healthy zero-client runtime. This regression must be distinct from stale/no-policy shutdown.
- [ ] **Step 5 — RED Agent policy tests:** stale policy, invalid policy, startup with no current authorization, and expiry during control-plane outage all use the hard runtime-disable path; fresh valid non-empty and empty policy remain normal applies.
- [ ] **Step 6 — Verify RED:** run `python3 -m pytest node-agent/tests/test_xray_adapter.py node-agent/tests/test_agent_core.py -q`.
- [ ] **Step 7 — GREEN adapter:** implement minimum callback/lifecycle changes. On any failure after live promotion, fail closed rather than leaving the previous authorized Xray runtime serving.
- [ ] **Step 8 — Verify/commit:** focused tests plus service runtime green; commit `fix: authorize Xray only from fresh policy`.

This task is the semantic boundary that prevents “empty config for stale state” from being mistaken for “freshly authorized empty policy.”

---

## Task 5: Lock update ordering, documentation, and repository acceptance

**Files:** modify `node-agent/tests/test_installer.py`; modify `node-agent/madar_agent/installer.py` only if required; modify `docs/runbooks/node-install.md`, `docs/test-reports/phase-7-vps.md`, and spec status.

- [ ] **Step 1 — RED installer regression:** prove `update()` stages both Agent and Xray unit files before `daemon_reload`, then restarts Agent only; it must never independently enable/start Xray. If current production code already satisfies the assertion, record that the test was added as a regression and make no unnecessary installer change.
- [ ] **Step 2 — Focused Python suite:** run all changed Node Agent tests, then `pnpm test:python`.
- [ ] **Step 3 — Full repository verification:** run/obtain full CI: security scan, PostgreSQL schema + backup/restore, runtime/integration tests, dependency audits, JS/TS tests, typecheck, build, Python tests.
- [ ] **Step 4 — Docs:** update runbook to describe `BindsTo`, ephemeral marker, verified startup closure, stale-vs-fresh-empty behavior, and safe unit-update ordering. Append repository/CI remediation evidence to the Phase 7 report **after** the historical Gate J failure; do not alter that historical field evidence and do not mark J/Phase 7 PASS.
- [ ] **Step 5 — Spec/plan status:** change spec from draft-review wording to approved/implementation status and record exact implementation head + CI in this plan after repository work is complete.
- [ ] **Step 6 — Commit:** `docs: record fail-closed lifecycle remediation status`.

Repository acceptance is not field acceptance. Gate J remains open until Task 6.

---

## Task 6: Rerun Gate J on the real VPS — Work only

**Execution environment:** existing disposable VPS through Work/SSH. Do not consume Work for Tasks 1-5.

Prerequisites:
- one exact implementation head from Tasks 1-5;
- full CI success on that head;
- existing Phase 7 environment cleaned/safe before deployment;
- deploy Agent code and both unit files together, `daemon-reload`, stop both services for transition, then start Agent only.

- [ ] Reproduce the original controlled startup stop-command failure while Xray is initially serving the disposable test credential. Agent may fail, but Xray must become inactive and repeated external VLESS+REALITY probes must fail.
- [ ] Attempt manual Xray start with Agent inactive/no marker; it must not become a serving runtime.
- [ ] Kill/crash Agent while authorized Xray is serving; `BindsTo` must pull Xray down and traffic must fail.
- [ ] Restart Agent with control plane unavailable; old marker must be gone and Xray must stay down.
- [ ] Restore fresh valid policy; Agent may create a new marker, start Xray, pass health/readiness, and external traffic may succeed again.
- [ ] Force runtime/outbox initialization failure; marker absent and Xray down.
- [ ] Reboot current units; persisted config alone must not expose stale access before fresh authorization.
- [ ] Confirm marker disappears on stop/restart/reboot and is owner-only while present.
- [ ] Recheck bounded logs/privacy and existing secret/outbox permissions; preserve historical journals.
- [ ] Update `docs/test-reports/phase-7-vps.md` with exact head, CI, fault-injection method, safe evidence, cleanup state. Only mark Gate J PASS if every mandatory real check passes.

If Gate J passes and no other single-node Phase 7 checklist item remains open, Phase 7 may be reconsidered for PASS. Phase 8 must still not begin without explicit user instruction. Premium single-active-client/device enforcement remains a separate unresolved release gate.

---

## Completion Evidence Required

Before claiming repository implementation complete:
- focused RED/GREEN evidence exists for every changed behavior;
- complete `pnpm test:python` passes;
- one fresh full GitHub Actions run passes on the exact head;
- diff review finds no unrelated refactor or secret-bearing output;
- Phase 7 report still says INCOMPLETE before Work field proof.

Before claiming Gate J fixed:
- Task 6 real VPS evidence must exist; CI alone is insufficient.
