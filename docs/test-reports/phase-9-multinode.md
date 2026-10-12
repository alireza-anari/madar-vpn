# Phase 9 — multi-node field acceptance

Date: 2026-10-12  
Status: **FIELD PASS — Task 29 real two-node acceptance complete; final documentation CI for this evidence commit is pending.**

## Scope

Task 29 proves that one Madar account can receive multiple eligible VLESS+REALITY nodes, that each Node is advertised only while independently fresh/healthy/capacity-eligible and ACKed for the user's current policy revision, and that Free active seconds remain account-global when overlapping seconds are observed by more than one Node.

Task 29 is separate from the per-user speed acceptance in `phase-9-speed.md`, but both real gates were executed in the same bounded field session.

## Exact field runtime

The real field session used the exact CI-green runtime below:

- deployed repository SHA: `07179e48f0447782745673bb17e1f1fb4867aa13`;
- GitHub Actions CI run: `38166200895` — success;
- Xray: `26.3.27`;
- both Nodes used independently installed Agent/Xray/runtime files checked against the exact field source artifacts.

The working branch later advanced with unrelated staging/email/security-test work. Field conclusions remain tied to the exact deployed SHA above rather than silently moving with the branch.

## Second real Node enrollment

A second Ubuntu 24.04 amd64 AWS VPS was enrolled through the real one-time enrollment path. Its Node credential and REALITY private material were generated independently rather than cloned from Node1. Reuse of the consumed enrollment token returned `401`, proving the one-time boundary.

Both Nodes subsequently operated with independent heartbeat/readiness state and independently ACKed policy revisions.

## Real subscription and device evidence

Three actual test accounts were used during the combined field session: two Free and one Premium. A common policy was published to both Nodes and independently ACKed.

The real subscription returned both eligible Nodes. The same subscription was refreshed in real v2rayNG 2.2.6 on Android and displayed two Madar configs. Ordinary public traffic was then connected through each config independently and the observed public exit changed to the selected Node, proving data-plane traffic through both real VPSs rather than merely subscription rendering.

## Independent health/readiness filtering

### Controlled unhealthy Node

With capped Free traffic available, the Speed Enforcer on Node1 was stopped deliberately. The Node transitioned out of eligible readiness while the Agent/Xray process state remained observable, the real subscription retained only Node2, and the real phone refresh likewise left only the healthy Node usable. After the sidecar recovered and readiness became fresh again, Node1 returned.

This also served the Task 30 fail-closed acceptance and did not rely on a synthetic subscription fixture.

### Controlled capacity exclusion

Node2 was temporarily configured with `MADAR_NODE_MAX_CLIENTS=3` while reporting three active Clients. Its health remained otherwise valid, but `activeClients == maxClients` made capacity non-accepting and the control plane excluded the Node from subscription output. Removing the temporary capacity override and restarting the Agent restored fresh `ready` state and the Node returned.

Thus health and capacity eligibility were exercised independently on real Nodes.

## Client credential rotation / per-Node ACK withholding

All three field Client credentials were rotated through the real access service. Immediately after rotation, both Nodes were withheld server-side because neither had ACKed the new user policy revision.

The observed progression was:

```text
server-side eligible Nodes: 0 -> 1 -> 2
real v2rayNG refresh:        1 -> 2
```

Node1 was republished/ACKed first, at which point only Node1 was eligible. Node2 remained withheld until its independent new revision ACK. After Node2 ACKed, both Nodes were eligible and the real v2rayNG subscription refresh again contained two configs.

The phone client retained old local entries when a refresh returned zero new configs, so the authoritative zero-node stage is recorded from the server-side eligibility query. The real device evidence is therefore intentionally worded as server-side `0 -> 1 -> 2` and phone-side `1 -> 2`, without overstating a phone UI zero-state that v2rayNG did not display.

## Account-global cross-node active-second de-duplication

The same current Free account generated deliberately overlapping real traffic through both Nodes in one UTC accounting interval. Both Nodes reported activity, but settlement debited only the union of active seconds.

Safe accounting evidence:

```text
2026-10-12 18:22 | node_count=2 | raw_seconds=60 | union_seconds=37 | debited_seconds=37 | overlap_seconds=23 | GLOBAL_DEDUPE_PASS
2026-10-12 18:23 | node_count=1 | raw_seconds=5  | union_seconds=5  | debited_seconds=5  | overlap_seconds=0  | CHECK
```

This proves the overlapping 23 seconds observed by two Nodes were not charged twice. The production accounting rule remained account-global while speed enforcement remained per Client per Node.

## Privacy and telemetry closure

The field session ended with no pending telemetry and no unexplained activity:

- Node1 pending telemetry outbox reports: `0`;
- Node2 pending telemetry outbox reports: `0`;
- unexplained `unmapped` reports: `0`;
- unexplained `unmapped` seconds: `0`.

The control-plane audit found no Node credential or REALITY private-key leak. A bounded full-session Node1 journal scan checked 14 known secret/Client values with zero matches. Node2's bounded scan found zero exact local-secret matches, zero raw UUID-shaped values, and zero secret-field/value matches. Historical journals were retained.

No enrollment token, Node credential, raw Client UUID, subscription bearer, REALITY private key, session/CSRF value, plaintext SOCKS credential, or raw traffic payload is recorded in this report.

## Cleanup and retained state

Field cleanup preserved unrelated state and both VPSs:

- the three Phase 9 field Client credentials were revoked;
- the three Phase 9 field subscription tokens were revoked;
- one unrelated pre-existing active credential remained untouched;
- temporary overlap/UDP/throughput/Premium test harnesses and listeners were removed;
- Node1 final empty policy revision `31` was ACKed with `clients=0`;
- Node2 final empty policy revision `5` was ACKed with `clients=0`;
- both Nodes finished `ready` with fresh heartbeats;
- Agent and Xray remained active on both Nodes;
- Speed Enforcer remained inactive, which is expected with zero capped Clients;
- sanitized field evidence and historical journals were retained;
- both VPSs were retained as requested.

## Task 29 acceptance checklist

- [x] Second supported Ubuntu VPS enrolled through a fresh one-time token; no credential/private-key cloning.
- [x] Approved Xray version and exact Agent/runtime artifacts verified on both Nodes.
- [x] Fresh user policy independently ACKed by both Nodes.
- [x] Real subscription contained both eligible Nodes.
- [x] Real v2rayNG refresh displayed both Madar Nodes.
- [x] Ordinary public traffic proved a real exit through Node1.
- [x] Ordinary public traffic proved a real exit through Node2.
- [x] Controlled unhealthy Node disappeared while the healthy Node remained, then recovered only after fresh readiness.
- [x] Controlled capacity-excluded Node disappeared and returned after capacity recovery.
- [x] Client-ID rotation withheld Nodes independently until each new revision ACK; observed server sequence `0 -> 1 -> 2` and phone sequence `1 -> 2`.
- [x] Overlapping real active seconds from both Nodes settled with account-global de-duplication.
- [x] Both telemetry outboxes ended at zero and unexplained unmapped activity ended at zero.
- [x] Bounded privacy scans passed and historical journals were preserved.
- [x] Test credentials/policies/harnesses were cleaned up without deleting retained VPSs.

## Gate state

- Task 29 field acceptance: **PASS**.
- Task 30 field acceptance: see `phase-9-speed.md` — **PASS**.
- Phase 9 field requirements: **PASS**.
- Final Phase 9 repository completion claim: **pending the full CI run triggered by the documentation evidence commit containing this report**.
- Production Ready: **not claimed**; Phase 10 remains a separate gate.
