# Agent/Xray Fail-Closed Lifecycle Design

Date: 2026-10-10  
Status: **Approved; repository implementation complete; real-VPS Gate J rerun pending**  
Implementation branch: `impl/phase-1-native-lifecycle`  
Field blocker source: `docs/test-reports/phase-7-vps.md`

## Purpose

Close the Phase 7 startup fail-closed blocker reproduced on the real VPS.

Required invariant:

> If the Madar Node Agent is not alive and in control of the current Xray runtime, Xray must not continue serving managed VPN access.

The historical field pass proved that exiting the Agent after a failed `systemctl stop madar-xray.service` was insufficient: the already-running Xray process remained active and real external VLESS+REALITY traffic still passed. The repository design therefore moves authorization from a persisted config/application stop call to a bound service lifecycle plus an ephemeral per-Agent authorization marker.

## Scope

This design covers only:

- `madar-node-agent.service`;
- `madar-xray.service`;
- Agent/Xray startup, shutdown, restart, failure, and reboot behavior;
- persisted Xray config versus current runtime authorization;
- the ephemeral Agent-owned authorization marker.

It does not change Free active-second accounting, telemetry settlement, Premium entitlement charging, Premium single-active-client/device semantics, firewall/SSH policy, Xray release pin, or production Cloudflare/Hyperdrive deployment.

## Security invariants

1. Persisted `xray-config.json` is not authorization.
2. A new Agent activation starts without Xray authorization inherited from the previous activation.
3. Xray cannot normally start without both a live managed config and the current Agent authorization marker.
4. Agent stop/failure/restart must remove current authorization and pull Xray down.
5. Startup never trusts a `systemctl stop` return code as proof of inactivity.
6. If Xray inactivity cannot be proven, Agent startup refuses normal operation.
7. Candidate validation must complete before authorization is granted.
8. Failed start/restart/health verification revokes authorization and drives Xray inactive.
9. Stale/missing authorization means Xray down; a fresh explicit empty policy is allowed to run a validated zero-client Xray config.
10. No lifecycle error may echo command output, credential material, client UUIDs, REALITY private keys, bearer values, or raw managed config secrets.
11. No firewall or SSH modification is introduced.

Root-level hostile modification of systemd/unit files is outside this boundary.

## Selected architecture

### Agent-owned ephemeral runtime directory

`madar-node-agent.service` owns:

```text
/run/madar-node-agent/
```

with:

```text
RuntimeDirectory=madar-node-agent
RuntimeDirectoryMode=0700
RuntimeDirectoryPreserve=no
```

The current activation may create:

```text
/run/madar-node-agent/xray-authorized
```

The marker is fixed non-secret content, atomically created, mode `0600`, and is removed on fail-closed disable. Symlink/non-regular marker targets are rejected for authorization creation.

### Systemd lifetime binding

The Agent remains the lifecycle authority and has no `Wants=`/`Requires=` dependency on Xray.

`madar-xray.service` uses:

```text
BindsTo=madar-node-agent.service
After=madar-node-agent.service
ConditionPathExists=/etc/madar-node-agent/xray-config.json
ConditionPathExists=/run/madar-node-agent/xray-authorized
```

and pre-start checks both the live config and marker. The Xray unit has no independent `[Install]` target.

`PartOf=` is intentionally not used as the primary mechanism because Agent restart must not automatically re-authorize/restart Xray before fresh policy validation.

### Verified stop-and-recovery

The production lifecycle helper queries explicit systemd state with:

```text
systemctl show madar-xray.service --property=ActiveState --property=SubState --property=MainPID --no-pager
```

A safe closed state requires parseable `ActiveState=inactive` or `failed` **and** `MainPID=0`.

Active, activating, deactivating, reloading, nonzero PID, malformed/missing properties, or an unqueryable state are not accepted as proof of shutdown.

Startup/recovery sequence:

1. revoke any current marker;
2. request ordinary service stop;
3. independently verify systemd state;
4. if still active/unverifiable, use bounded control-group force-kill;
5. poll explicit state again;
6. continue only after inactive state is proven.

The force path is defense in depth. `BindsTo` is the independent lifecycle safety layer when the Agent itself dies/stops/fails.

## Xray authorization sequence

For a fresh valid policy:

1. render candidate config;
2. validate with pinned Xray `-test`;
3. atomically promote candidate to live config;
4. grant the current runtime marker;
5. request controlled authorized restart;
6. verify systemd reports Xray active;
7. validate the promoted live config again for health;
8. only then update in-memory managed-client state/readiness.

The marker must not exist before candidate validation/promotion.

Any failure after promotion causes best-effort marker revocation and runtime disable. Persisted config may remain on disk, but without the marker it is not authorization.

## Stale versus fresh empty policy

These cases are deliberately different:

- stale/missing/invalid authorization: clear in-memory clients, revoke marker, stop Xray;
- fresh explicit empty policy: validate/promote a zero-client config, grant marker, start Xray, verify health.

This permits controlled operational diagnosis with a current empty policy without treating persisted state as authorization.

## Startup, shutdown, restart, reboot

### Startup

Before runtime/outbox construction, Agent creates one lifecycle object and proves Xray inactive. Failure to prove inactivity returns a generic startup error and no normal runtime is built.

If runtime/outbox construction then fails, Agent performs best-effort lifecycle disable and exits with a generic non-secret error.

### Graceful/fatal Agent exit

Activity-sampler cleanup is attempted first, but sampler cleanup failure cannot skip Xray disable. Final cleanup always performs best-effort lifecycle disable. Systemd binding remains the independent guarantee.

### Agent restart/crash

The old Agent activation loses its runtime directory/marker. `BindsTo` pulls Xray down. The replacement Agent receives a fresh runtime directory and must re-establish fresh policy authorization before Xray can serve again.

### Reboot

`/run` authorization does not survive reboot. Persisted `xray-config.json` alone cannot authorize Xray. Agent must re-establish fresh authorization.

### Manual Xray start

With Agent inactive or marker absent, a normal `systemctl start madar-xray.service` must not produce a serving managed runtime because the marker condition/pre-start check is unsatisfied.

## Update behavior

Managed update stages Agent code plus both unit files before `daemon-reload`, then restarts only the Agent. It never independently enables/starts/restarts Xray. Restart of the Agent tears down the old authorization and requires the new activation to authorize Xray again.

## Automated acceptance

Repository tests cover:

- secure marker creation/revocation and symlink/non-regular rejection;
- explicit systemd state parsing and PID checks;
- stop-result versus actual-state matrix;
- bounded force-close and authorized restart behavior;
- candidate validation/promotion/authorization ordering;
- activation/health failure fail-closed cleanup;
- stale/no-policy hard disable versus fresh explicit empty policy;
- one shared lifecycle object in production wiring;
- Agent runtime-directory and Xray `BindsTo`/marker unit contract;
- startup build refusal when shutdown cannot be proven;
- build failure/fatal exit/graceful exit/sampler-cleanup paths;
- updater stages both units before reload and restarts Agent only;
- generic error paths do not expose fixture secret/client details.

Repository implementation code head before documentation reconciliation:

```text
1b7dee80fd068b76beaaf1ac27d9dbd0cd531c94
```

Full CI:

```text
38070242737 — SUCCESS
```

This is repository/CI evidence only.

## Real VPS Gate J acceptance

Phase 7 Gate J remains open until the exact implementation head is deployed to the disposable VPS and all mandatory checks pass:

1. reproduce the original controlled startup stop-command fault while Xray is serving;
2. Xray must become inactive and repeated external VLESS+REALITY probes must fail;
3. manual Xray start with Agent inactive/no marker must not serve;
4. Agent crash/kill while serving must pull Xray down;
5. Agent restart with control plane unavailable must not restore stale access;
6. restoring fresh valid policy may create a new marker and restore healthy access;
7. runtime/outbox initialization failure must leave marker absent and Xray down;
8. reboot must expose no stale access before fresh authorization;
9. marker must disappear across stop/restart/reboot and remain owner-only while present;
10. bounded logs and existing secret/outbox permissions must remain clean.

Only real field evidence can move Gate J to PASS.

## Release status

- Repository lifecycle remediation: implemented and CI-verified.
- Real VPS Gate J: **NOT YET RERUN**.
- Phase 7: **INCOMPLETE**.
- Phase 8: unstarted.
- Premium single-active-client/device enforcement: separate unresolved release gate.
- Production Ready: **not claimed**.
