# Phase 7 Gate J lifecycle remediation — repository appendix

Date: 2026-10-10  
Status: **repository remediation implemented and CI-verified; real-VPS Gate J rerun pending**  
Canonical historical field report: `docs/test-reports/phase-7-vps.md`

## Why this appendix exists

The canonical Phase 7 report preserves the actual current-head field failure in which a controlled startup stop-command failure caused the Node Agent to exit while the already-running Xray process remained active and direct external VLESS+REALITY traffic still succeeded.

That failure is historical field evidence and must not be rewritten as a PASS by repository automation.

This appendix records the subsequent approved lifecycle remediation and repository/CI evidence. It does **not** replace the historical report and does not close Gate J.

## Approved remediation

The repository now uses three independent layers:

1. **systemd lifetime binding** — Xray uses `BindsTo=madar-node-agent.service` and has no independent install target;
2. **ephemeral per-Agent authorization** — each Agent activation owns `/run/madar-node-agent`, with a current `xray-authorized` marker required to start Xray;
3. **verified stop/recovery** — Agent startup revokes authorization, requests stop, then verifies explicit systemd `ActiveState`/`MainPID`; bounded force-kill recovery runs only when shutdown is not yet proven.

Persisted `xray-config.json` is no longer sufficient authorization.

## Runtime authorization ordering

A valid fresh policy can authorize Xray only after:

1. candidate config is rendered;
2. pinned Xray validates the candidate;
3. candidate is atomically promoted to live config;
4. current Agent marker is created;
5. controlled authorized restart succeeds;
6. Xray active state and live-config health are verified.

A failure after promotion revokes authorization and drives Xray inactive.

Stale/missing/invalid authorization uses hard runtime disable. A fresh explicit empty policy remains a distinct valid case and may intentionally run a zero-client Xray runtime.

## Systemd repository contract

Agent unit now owns:

```text
RuntimeDirectory=madar-node-agent
RuntimeDirectoryMode=0700
RuntimeDirectoryPreserve=no
```

Xray unit now requires:

```text
BindsTo=madar-node-agent.service
After=madar-node-agent.service
ConditionPathExists=/etc/madar-node-agent/xray-config.json
ConditionPathExists=/run/madar-node-agent/xray-authorized
```

Both config and marker also have pre-start file checks. Xray has bounded stop cleanup/control-group semantics and no independent `[Install]` target.

The Agent unit still does not `Wants=`/`Requires=` Xray as a startup dependency.

## TDD / implementation evidence

### Lifecycle primitive

- RED contract: `d6ce3ccb13d3ac478ab36725615a270be708632b`
- RED scaffold: `c8dd389af285a26dc2529fc088b1a35c32746a79`
- GREEN implementation: `e3fa073e670626c050c2a53bac1865592427dd3d`
- full CI: `38068600774` — SUCCESS

### Xray authorization boundary

- RED: `cdd4769d6d5a1f35aa05735e9ee72dfb441eff1f`
- adapter implementation: `411dcd88dab06a61e1104d4d8625962735617d6e`
- service lifecycle wiring: `00cd889ea31e5054c4afea84b4f57a1cca95791d`
- legacy fixture alignment after systematic debugging: `c951cbf3ff2bbdfba5ec09a14efa1b7fcf2850dd`
- full CI: `38069469787` — SUCCESS

### Systemd + Agent startup/shutdown

- RED: `dfcdcab7713bb8a88627e5cea0ad162b91b3e5b4`
- GREEN systemd/runtime: `417fb6f6651b72153075593ef460c09c8c012333`
- stale activity test fixture alignment: `9a936590c8d4dd79280f78e652d6c68a96c7057c`
- full CI: `38070109137` — SUCCESS

### Updater regression / repository code head

The existing updater already staged both unit files before `daemon_reload` and restarted the Agent only. A dedicated regression was added without unnecessary installer production changes.

Repository code head before documentation reconciliation:

```text
1b7dee80fd068b76beaaf1ac27d9dbd0cd531c94
```

Full CI:

```text
38070242737 — SUCCESS
```

That exact workflow passed secret scan, PostgreSQL schema/backup-restore/runtime integration gates, JavaScript and Python dependency audits, full tests, typecheck, build, and the Python suite.

## Diff/security review

Implementation range reviewed:

```text
dd453018ac9202225b634edb57fb985aaeb38f2d..1b7dee80fd068b76beaaf1ac27d9dbd0cd531c94
```

The range is limited to:

- Node Agent lifecycle helper;
- Xray lifecycle/authorization wiring;
- Agent service startup/shutdown;
- two systemd units;
- lifecycle/runtime/updater tests.

No Free accounting, control-plane API, PostgreSQL settlement, Premium behavior, Xray version pin, firewall, or SSH behavior was changed by this remediation.

The exact code-head CI secret scan and dependency audits passed. Lifecycle errors intentionally do not surface raw command output or callback exception details.

## What this evidence proves

At repository/CI level, tests now prove:

- a fresh Agent activation has no inherited authorization marker;
- a persisted Xray config alone cannot satisfy the managed Xray start contract;
- startup must prove Xray inactive before runtime/outbox construction;
- a failed stop exit code may continue only when explicit systemd state proves inactivity;
- a successful stop exit code is insufficient when Xray state/PID remains active;
- bounded force-close is followed by state verification;
- valid config is promoted before marker grant;
- start/restart/health failure revokes authorization and disables runtime;
- Agent normal/fatal/cleanup exit paths reach runtime disable;
- systemd unit relationships encode the Agent/Xray lifetime boundary;
- updater stages both units before reload and does not independently start Xray.

## What this evidence does not prove

Repository automation cannot prove:

- the original real fault-injection scenario is fixed on the VPS;
- real external traffic fails after Agent failure with the new units;
- `BindsTo` behaves as required under the actual VPS systemd/runtime environment;
- manual Xray start is denied on the VPS when the marker is absent;
- Agent crash, control-plane outage restart, initialization failure, or reboot produce no stale access on the VPS;
- marker lifecycle and permissions under the actual deployed `/run` environment;
- real log/privacy behavior for this new lifecycle.

## Required Gate J rerun

Before Gate J can become PASS, deploy one exact final documentation/code head with full CI and prove on the existing disposable VPS:

1. reproduce the original controlled startup stop-command fault while Xray initially serves;
2. Agent may fail, but Xray becomes inactive and repeated direct external probes fail;
3. manual Xray start with Agent inactive/no marker cannot serve;
4. Agent kill/crash pulls Xray down through lifetime binding;
5. Agent restart with control plane unavailable leaves Xray down and old marker absent;
6. restoring fresh policy may create a new marker and restore healthy access;
7. runtime/outbox construction failure leaves Xray down;
8. reboot exposes no persisted stale access before fresh authorization;
9. marker is owner-only while present and absent after stop/restart/reboot;
10. bounded logs/privacy and existing secret/outbox permissions remain intact.

The canonical `phase-7-vps.md` should receive the actual field result after this rerun.

## Release decision

**Gate J remains OPEN. Phase 7 remains INCOMPLETE. Phase 8 remains unstarted. Production Ready is not claimed.**

Premium single-active-client/device enforcement remains a separate unresolved release gate and is not addressed by this lifecycle remediation.
