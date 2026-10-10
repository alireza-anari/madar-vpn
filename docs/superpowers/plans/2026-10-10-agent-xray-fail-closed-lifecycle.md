# Agent/Xray Fail-Closed Lifecycle Implementation Plan

Date: 2026-10-10  
Status: **Tasks 1-4 repository implementation complete; Task 5 real-VPS Gate J pending**  
Implementation branch: `impl/phase-1-native-lifecycle`

**Goal:** close the real Phase 7 Gate J blocker so managed Xray cannot remain serving when the Node Agent is failed, stopped, restarting, or unable to prove control of the current runtime.

**Spec:** `docs/superpowers/specs/2026-10-10-agent-xray-fail-closed-lifecycle-design.md`

## Constraints

- Persisted Xray config is never authorization by itself.
- Agent owns the lifecycle; it does not auto-start Xray as a dependency.
- Authorization is per-Agent-activation and lives only under `/run/madar-node-agent`.
- Xray requires both current marker and live config.
- Stop/restart success is verified from explicit systemd state and `MainPID`, not command exit code alone.
- Stale/no authorization shuts Xray down.
- A fresh explicit empty policy may intentionally authorize a zero-client Xray runtime.
- Error paths remain non-secret.
- Free accounting, telemetry, Premium semantics, firewall/SSH behavior, and Xray pin are unchanged.
- Phase 7 remains incomplete until real field evidence exists.

## Task 1 — fail-closed lifecycle primitive

Files:

- `node-agent/madar_agent/lifecycle.py`
- `node-agent/tests/test_xray_lifecycle.py`

Status: **complete**.

- [x] RED: secure marker lifecycle, explicit state parsing, stop/force-stop matrix, authorized restart and generic errors.
- [x] GREEN: atomic `0600` marker, strict systemd property parsing, bounded kill/poll recovery, restart/disable behavior.
- [x] Full CI green.

Evidence:

- RED contract: `d6ce3ccb13d3ac478ab36725615a270be708632b`
- RED scaffold: `c8dd389af285a26dc2529fc088b1a35c32746a79`
- GREEN: `e3fa073e670626c050c2a53bac1865592427dd3d`
- CI: `38068600774` — SUCCESS

## Task 2 — authorize Xray only from fresh validated policy

Files:

- `node-agent/madar_agent/xray.py`
- `node-agent/madar_agent/service.py`
- Xray/Agent/runtime tests

Status: **complete**.

- [x] RED: candidate validation/promotion/marker/restart/health ordering.
- [x] RED: failure after promotion revokes authorization and disables runtime.
- [x] RED: stale/no authorization is hard disable; fresh explicit empty policy is a normal authorized apply.
- [x] RED: one supplied lifecycle instance owns all production callbacks.
- [x] GREEN implementation without fallback to legacy empty-config stale behavior.
- [x] Legacy test fixtures aligned with the new mandatory lifecycle contract after systematic debugging showed fixture drift, not a production defect.
- [x] Full CI green.

Evidence:

- RED: `cdd4769d6d5a1f35aa05735e9ee72dfb441eff1f`
- adapter implementation: `411dcd88dab06a61e1104d4d8625962735617d6e`
- service construction wiring: `00cd889ea31e5054c4afea84b4f57a1cca95791d`
- fixture alignment: `c951cbf3ff2bbdfba5ec09a14efa1b7fcf2850dd`
- CI: `38069469787` — SUCCESS

## Task 3 — atomically bind systemd and verified Agent startup/shutdown

Files:

- `node-agent/systemd/madar-node-agent.service`
- `node-agent/systemd/madar-xray.service`
- `node-agent/madar_agent/service.py`
- reboot/service/activity runtime tests

Status: **complete**.

- [x] RED unit contract for `RuntimeDirectory`, non-preservation, `BindsTo`, marker/config start gate, bounded stop cleanup, no independent Xray install target.
- [x] RED startup matrix proving runtime build is forbidden until Xray inactivity is verified.
- [x] RED build-failure/fatal-exit/graceful-exit/sampler-cleanup paths.
- [x] GREEN systemd/service implementation in one deployment-safe commit.
- [x] One legacy activity-runtime fixture updated after CI showed it still monkeypatched the removed raw stop helper; production code was not weakened.
- [x] Full CI green.

Evidence:

- RED: `dfcdcab7713bb8a88627e5cea0ad162b91b3e5b4`
- GREEN systemd/runtime: `417fb6f6651b72153075593ef460c09c8c012333`
- fixture alignment: `9a936590c8d4dd79280f78e652d6c68a96c7057c`
- CI: `38070109137` — SUCCESS

## Task 4 — updater regression, review, docs and repository acceptance

Status: **complete at repository/CI level**.

- [x] Updater regression proves both unit files are staged before `daemon_reload`, then only Agent is restarted; Xray is never independently enabled/started/restarted.
- [x] No production installer change was necessary because existing ordering already satisfied the approved design.
- [x] Exact-head full CI passed after updater regression.
- [x] Implementation diff reviewed against base `dd453018ac9202225b634edb57fb985aaeb38f2d`: lifecycle/runtime/systemd/tests only; no Free accounting, API, Premium, or unrelated refactor changes.
- [x] Secret scan and dependency audits passed in the exact-head CI.
- [x] Spec/runbook/status evidence reconciled without marking field acceptance PASS.
- [x] Documentation reconciliation head also passed the complete CI.

Repository code head before docs:

```text
1b7dee80fd068b76beaaf1ac27d9dbd0cd531c94
```

Exact code-head CI:

```text
38070242737 — SUCCESS
```

Updater regression commit:

```text
1b7dee80fd068b76beaaf1ac27d9dbd0cd531c94
```

Documentation reconciliation head:

```text
02f6eb3469dda21d688f2c16109271a9a8d06da6
```

Documentation reconciliation CI:

```text
38070647195 — SUCCESS
```

The current status-only commit changes no runtime or test behavior; it only records the already-successful documentation CI witness above. A fresh CI for this status-only head is still required before reporting Tasks 1-4 as finalized in this execution session.

## Task 5 — real-VPS Gate J rerun

Status: **open**.

Prerequisites:

- deploy one exact final repository head with full CI success;
- stage Agent code and both units together;
- `daemon-reload`;
- explicitly stop both services for the maintenance transition;
- start Agent only.

Mandatory real checks:

- [ ] Reproduce the original controlled startup stop-command fault while Xray initially serves the disposable credential. Xray must become inactive and repeated direct VLESS+REALITY probes must fail.
- [ ] Manual Xray start with Agent inactive/no marker must not serve.
- [ ] Kill/crash Agent while authorized Xray is serving; `BindsTo` must pull Xray down and traffic must fail.
- [ ] Restart Agent with control plane unavailable; old marker must be gone and Xray must remain down.
- [ ] Restore fresh valid policy; Agent may create a new marker, start Xray, become healthy/ready, and traffic may succeed again.
- [ ] Force runtime/outbox initialization failure; marker absent and Xray down.
- [ ] Reboot current units; persisted config alone must not expose stale access before fresh authorization.
- [ ] Marker disappears across stop/restart/reboot and remains owner-only while present.
- [ ] Recheck bounded logs/privacy and existing secret/outbox permissions; preserve historical journals.
- [ ] Update the canonical Phase 7 field report with exact deployed head, CI, fault-injection evidence and cleanup state.

## Acceptance boundary

Repository/CI acceptance does **not** close Gate J. Only Task 5 can establish real fail-closed behavior on the disposable VPS.

Current release status:

- lifecycle code: implemented;
- Tasks 1-4 repository evidence: complete;
- code-head CI: SUCCESS;
- documentation reconciliation CI: SUCCESS;
- Gate J: open;
- Phase 7: **INCOMPLETE**;
- Phase 8: unstarted;
- Premium single-active-client/device enforcement: separate unresolved release gate;
- Production Ready: not claimed.