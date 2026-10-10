# Agent/Xray Fail-Closed Lifecycle Design

Date: 2026-10-10  
Status: **Draft for written-spec review**  
Branch: `impl/phase-1`  
Field blocker source: `docs/test-reports/phase-7-vps.md`

## 1. Purpose

Close the Phase 7 startup fail-closed blocker reproduced on the real VPS.

The required invariant is simple:

> If the Madar Node Agent is not alive and in control of the current Xray runtime, Xray must not be able to continue serving managed VPN access.

The current implementation tries to stop Xray before Agent runtime construction. The real field pass proved that this ordering is insufficient: when the startup `systemctl stop madar-xray.service` operation was forced to fail, the Agent exited with status 4 but the already-running Xray process remained alive and real external VLESS+REALITY traffic still passed.

This design changes the lifecycle boundary so fail-closed safety does not depend on one application-level `systemctl stop` call succeeding.

## 2. Scope

This design covers only the lifecycle relationship between:

- `madar-node-agent.service`;
- `madar-xray.service`;
- the persisted managed Xray config;
- a per-Agent-process runtime authorization marker;
- Agent startup/shutdown/restart/failure behavior.

It does not change:

- active-second Free accounting;
- telemetry settlement;
- Xray/VLESS/REALITY protocol configuration except lifecycle gating;
- Premium single-active-client/device enforcement;
- firewall/SSH configuration;
- production Cloudflare/Hyperdrive deployment.

Phase 7 remains incomplete until this exact lifecycle design is implemented and rerun on the real VPS.

## 3. Current failure

Current startup logic performs:

1. `systemctl stop madar-xray.service`;
2. if the command fails, Agent exits;
3. otherwise Agent builds runtime/outbox and begins normal control-plane processing.

The current Xray systemd unit has an independent lifecycle. A persisted `xray-config.json` is sufficient for the Xray unit's existing file condition, and Agent termination does not currently force Xray down.

The field test therefore demonstrated this unsafe state:

- Agent: failed/exited;
- Xray: still active;
- stale managed config: still serving traffic;
- fresh Agent authorization: absent.

That state violates Madar's fail-closed requirement.

## 4. Security invariant

The system MUST satisfy all of the following:

1. Persisted Xray configuration is not authorization.
2. Agent process death, failure, stop, or restart must remove the current runtime authorization and cause Xray to stop.
3. Xray must not start solely because a persisted config file exists.
4. A new Agent process must establish its own fresh runtime authorization before Xray can start.
5. Application-level stop failure must not leave an independently serving Xray process.
6. If the system cannot prove Xray is inactive during startup recovery, Agent must not proceed to normal operation.
7. A failed Xray start/restart must not leave a reusable runtime authorization marker behind.
8. The solution must not require Madar to modify host SSH or firewall rules.

Root-level compromise of the VPS is outside this boundary; a root administrator can always alter systemd units/files. The purpose here is deterministic fail-closed behavior under Agent/Xray/process/systemd failures within the managed installation.

## 5. Selected architecture

The selected design uses three independent layers.

### 5.1 Systemd lifecycle binding

`madar-xray.service` becomes lifecycle-bound to `madar-node-agent.service` using systemd dependency semantics equivalent to:

- `BindsTo=madar-node-agent.service`;
- ordering after the Agent unit where needed for runtime authorization availability.

Required behavior:

- when Agent becomes inactive/failed/stopped, systemd stops Xray;
- an Agent restart must not automatically re-authorize/start Xray using persisted state;
- Xray is started only through the Agent-controlled validated-policy path.

`PartOf=` is not the selected primary mechanism because restart propagation can cause an Xray restart during Agent restart before fresh authorization has been re-established.

### 5.2 Ephemeral per-Agent runtime authorization

The Agent systemd unit owns a private runtime directory under `/run`, for example:

`/run/madar-node-agent/`

using systemd `RuntimeDirectory` with restrictive permissions.

The Agent creates a runtime authorization marker, for example:

`/run/madar-node-agent/xray-authorized`

only after the current Agent process has:

1. obtained/validated the managed policy state required for the intended Xray config;
2. rendered and validated the candidate Xray config;
3. promoted the validated config to the live managed config.

The Xray unit adds a start condition requiring that runtime marker in addition to the live config file.

Properties:

- `/run` state is ephemeral across reboot;
- `RuntimeDirectory` is associated with the Agent service lifecycle;
- a new Agent process starts without authorization inherited from the previous process;
- a stale on-disk `xray-config.json` cannot by itself authorize Xray start;
- when Agent stops/fails, the runtime directory/marker is removed as part of service lifecycle cleanup.

The marker is an ownership/authorization-of-this-runtime marker, not a substitute for user entitlement. User access remains controlled by the currently promoted Xray config and policy revision.

### 5.3 Stop-and-verify defense in depth

Agent startup retains an explicit attempt to shut down any pre-existing Xray runtime, but it no longer trusts the command exit code as proof.

Startup behavior:

1. runtime authorization marker is absent;
2. request normal `systemctl stop madar-xray.service`;
3. independently query whether Xray is actually inactive;
4. if still active, invoke a bounded systemd-managed force-stop/kill path;
5. query again;
6. continue only when Xray inactivity is proven;
7. if inactivity cannot be proven, Agent exits fail-closed without constructing/using a new runtime authorization.

A nonzero ordinary stop command is not by itself fatal if independent state verification proves Xray is already inactive. Conversely, a zero stop exit code is not considered sufficient if Xray is still active.

Systemd lifecycle binding is the authoritative second safety layer: if Agent exits or fails, Xray must be stopped by the unit relationship even when the Agent's own command path failed.

## 6. Xray authorization/start sequence

For a valid fresh policy, the intended sequence is:

1. Agent is alive; runtime directory exists; authorization marker is absent.
2. Agent obtains fresh policy/control-plane authorization.
3. Agent renders candidate Xray config.
4. Candidate config passes pinned Xray validation.
5. Candidate atomically replaces the live managed config.
6. Agent atomically creates the runtime authorization marker with restrictive permissions.
7. Agent requests Xray start/restart.
8. Agent verifies Xray is active and healthy under the newly promoted config.
9. Only then may readiness/heartbeat advertise managed access as ready.

If steps 6-8 fail:

- remove the runtime authorization marker;
- force Xray toward inactive state;
- do not report readiness;
- propagate the failure so normal access is not advertised.

The authorization marker must never be created before candidate validation/promotion.

## 7. Empty/fail-closed policy behavior

An empty managed policy remains a valid way for the Agent to run Xray with zero managed clients when operational diagnosis requires the runtime to be up.

This is distinct from stale authorization:

- fresh, explicit empty policy: Agent may deliberately authorize a zero-client Xray config;
- no fresh authorization / startup failure / runtime-construction failure: Xray remains unauthorized and must be down.

This distinction preserves existing operational behavior without treating persisted empty/non-empty config as authorization.

## 8. Shutdown and restart behavior

### Graceful Agent stop

On SIGTERM/service stop:

- Agent should proactively revoke/remove the runtime authorization marker and request Xray stop where practical;
- regardless of application cleanup success, systemd lifecycle binding must stop Xray when Agent becomes inactive.

### Agent crash/failure

If Agent exits unexpectedly, is killed, or enters failed state:

- Xray must be stopped by the lifecycle binding;
- runtime authorization must disappear with Agent runtime-directory cleanup;
- automatic Agent restart starts from no runtime authorization;
- Xray must remain down until the new Agent process obtains/validates fresh state.

### Agent restart

Restart must behave as stop + fresh start, not as continuation of the previous authorization.

There must be no automatic Xray restart caused merely by the Agent service restarting.

### Reboot

After reboot:

- no old runtime authorization marker exists;
- persisted `xray-config.json` alone cannot start Xray;
- Agent must re-establish fresh authorization/policy before Xray can start.

## 9. Manual Xray start

When Agent is inactive or has not established the runtime marker, a normal `systemctl start madar-xray.service` must not produce a serving managed Xray runtime.

The expected systemd start condition fails because the per-Agent runtime authorization marker is absent.

If Agent is alive and has created the marker for the current validated runtime, systemd start/restart remains possible because that runtime is already authorized by the Agent lifecycle.

This design does not claim to defend against a hostile root administrator modifying unit files or bypassing Madar controls.

## 10. Failure handling

### Startup ordinary stop command fails

- verify actual Xray state;
- if inactive, proceed;
- if active, attempt bounded force-stop;
- if still active/unverifiable, Agent exits;
- lifecycle binding must independently pull Xray down when Agent fails.

### Runtime/outbox construction fails

- authorization marker remains absent;
- Xray remains/stays inactive;
- Agent exits with generic non-secret error.

### Candidate validation fails

- live config is not replaced by invalid candidate;
- authorization marker is not created;
- current access must not be newly authorized from the failed candidate.

### Xray restart/start fails

- remove authorization marker;
- force Xray inactive;
- readiness false;
- do not retain a marker that could authorize a later independent start.

### Agent shutdown cleanup fails

Application cleanup failure must not be the sole barrier. Systemd binding and runtime-directory cleanup provide independent enforcement.

## 11. Systemd design constraints

The implementation must preserve the following intent:

### Agent unit

- remains the lifecycle authority;
- owns `/run/madar-node-agent` through `RuntimeDirectory`;
- does not require/start Xray as a startup dependency;
- keeps its existing restrictive service sandbox unless a narrowly necessary change is reviewed.

### Xray unit

- binds its lifetime to Agent lifetime;
- requires the ephemeral authorization marker to start;
- keeps the persisted config existence check;
- is not enabled as an independent boot service;
- retains service-level process cleanup strong enough that normal stop can escalate to SIGKILL after a bounded timeout if needed.

No firewall/SSH modification is added.

## 12. Files expected to change during implementation

Exact paths may be refined by the implementation plan, but expected scope is limited to:

- `node-agent/systemd/madar-node-agent.service`;
- `node-agent/systemd/madar-xray.service`;
- `node-agent/madar_agent/service.py`;
- `node-agent/madar_agent/xray.py` or a small lifecycle helper if clearer;
- existing Node Agent/systemd tests;
- `docs/runbooks/node-install.md`;
- `docs/test-reports/phase-7-vps.md` after real rerun.

The implementation should avoid unrelated refactoring.

## 13. Automated acceptance tests

Repository tests must cover at least:

1. Agent unit owns restrictive `RuntimeDirectory`.
2. Xray unit has lifecycle binding to Agent and requires the runtime authorization marker.
3. Xray is not an independent boot-enabled managed service.
4. startup stop returns failure + Xray already inactive -> safe startup may continue;
5. startup stop returns success + Xray still active -> do not trust exit code; force-stop path runs;
6. ordinary stop failure + Xray active + successful force-stop -> startup may continue only after verified inactive;
7. stop/force-stop cannot prove inactive -> Agent exits fail-closed and no runtime marker exists;
8. runtime/outbox build failure -> marker absent and Xray inactive;
9. valid candidate -> marker created only after validation/promotion and before controlled Xray start;
10. candidate validation failure -> no marker;
11. Xray start/restart failure -> marker removed and access forced down;
12. graceful Agent shutdown revokes authorization;
13. tests assert error paths do not print credentials, UUIDs, REALITY private key, raw config secrets, or bearer material.

## 14. Real VPS acceptance

After repository/CI success, Work/VPS execution must rerun Gate J against the exact implementation head.

Mandatory real checks:

1. Reproduce the original controlled startup stop-command failure while Xray is initially serving a valid test credential.
2. Agent must fail/exit as designed.
3. Xray must become inactive despite the injected Agent stop-command failure.
4. Repeated direct external VLESS+REALITY probes must fail while Agent is failed/not freshly authorized.
5. Start Xray manually while Agent is inactive/no marker: it must not become a serving runtime.
6. Kill/crash Agent while Xray is serving: Xray must be stopped by lifecycle binding and external traffic must fail.
7. Restart Agent with control plane unavailable: Xray must remain down.
8. Restore control plane/fresh valid policy: Agent may authorize/start Xray and external traffic must succeed again.
9. Force runtime/outbox initialization failure: Xray must remain down.
10. Reboot with current units: no stale managed access before fresh authorization.
11. Confirm the runtime marker is ephemeral and not present after Agent stop/reboot.
12. Confirm secret/log privacy and existing state-file permissions remain intact.

Phase 7 may only move past Gate J after these real checks pass on one exact code head with full CI success.

## 15. Rollout

Because systemd behavior changes, rollout order on the existing disposable VPS is:

1. publish repository implementation and obtain full green CI;
2. deploy updated Agent/Xray unit files and Agent code together;
3. `systemctl daemon-reload`;
4. explicitly stop both services during the maintenance transition;
5. start Agent only;
6. verify no Xray start is possible before fresh authorization;
7. execute the Gate J acceptance matrix;
8. restore an empty policy at test end unless continuing immediately into an approved next field step.

The installer/update path must stage both unit files consistently so an old Agent unit is not paired with a new Xray unit or vice versa during normal managed update.

## 16. Alternatives rejected

### Only add another `systemctl stop`

Rejected. Repeating the same application-level mechanism does not remove the independent-lifecycle failure mode.

### Only force-kill Xray from Python

Rejected as the sole solution. It improves startup recovery but still leaves Agent crash/failure lifecycle uncoupled from Xray.

### `PartOf=madar-node-agent.service` as the primary binding

Rejected because restart propagation can restart Xray during an Agent restart before fresh authorization is re-established.

### Firewall kill switch

Rejected for this change. Madar's installer deliberately avoids modifying host firewall state, and this lifecycle failure can be solved at the service/runtime boundary.

### Merge Agent and Xray into one process/service

Rejected as unnecessarily invasive for this blocker. Systemd lifecycle binding plus ephemeral authorization provides the required boundary without replacing the established adapter/service architecture.

## 17. Status and next step

This document specifies the approved conceptual direction but remains **Draft for written-spec review** until the user reviews this committed artifact.

No production implementation is authorized by the existence of this draft alone.

After written-spec approval, create a dedicated TDD implementation plan. Repository/CI work can be executed in the normal chat/GitHub workflow; Work/VPS should be reserved for the final real Gate J field rerun.
