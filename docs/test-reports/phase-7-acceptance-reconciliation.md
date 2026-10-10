# Phase 7 Acceptance Reconciliation

Date: 2026-10-10  
Repository branch: `impl/phase-1-native-lifecycle`  
Documentation head before this reconciliation: `660cc63c16537fac625b44d5bd7bd825d5bebc52`  
Current deployed runtime head: `d4fe18b91a2da26488faedd96b4182190de31861`  
Current status: **Gate J PASS; Phase 7 PASS after the unchanged-runtime compact closure on 2026-10-11 (Asia/Tehran)**

## Purpose

This document reconciles the real Phase 7 evidence after the Gate J lifecycle remediation so the remaining VPS work is neither under-tested nor repeated unnecessarily.

The authoritative Phase 7 gate in `docs/superpowers/plans/2026-10-08-madar-implementation-plan.md` requires the current exact head to pass the real VPS active-second/debit/retry/idle/fail-closed checklist. The superseding accounting plan in `docs/superpowers/plans/2026-10-10-active-second-free-accounting.md` likewise leaves Task 8 Step 4 open until one current deployed head satisfies its field checklist.

This reconciliation does **not** weaken either gate. It identifies which evidence survives unchanged-source comparison and which checks must still be rerun on the final runtime head.

## Relevant field heads

### Accounting field head

The broad active-second field pass ran on:

```text
7848a28ac87ad24ac0cf6c2cbefb6c3e9af49f75
```

with full CI:

```text
38060721337 — SUCCESS
```

That pass produced real evidence for pinned Xray counters, sustained bitmap/debit settlement, idle no-debit, overlapping-connection de-duplication, reset/query-gap baseline recovery, exit-before-local-ACK retry identity, malformed acceptance retention, capability negotiation, permissions/privacy, no unmapped final reports, and real-control-plane PostgreSQL Premium/day semantics. It stopped when the original Gate J startup-stop fault left Xray serving.

### Lifecycle field head

Gate J remediation was deployed as:

```text
d4fe18b91a2da26488faedd96b4182190de31861
```

with full CI:

```text
38073194023 — SUCCESS
```

The subsequent real VPS A-L rerun closed Gate J. All eight direct external probes in closed states failed. The field evidence is recorded in `docs/test-reports/phase-7-vps.md` and `docs/test-reports/phase-7-vps-gate-j-remediation.md`.

## Code-change boundary between the two field heads

Git comparison from `7848a28...` to `d4fe18...` shows no control-plane, PostgreSQL settlement, activity algorithm, outbox implementation, telemetry API client, or accounting migration change.

The runtime changes are limited to the Node Agent lifecycle boundary:

- new `madar_agent/lifecycle.py`;
- `service.py` startup/shutdown and lifecycle construction;
- `xray.py` authorization/apply/disable/health behavior;
- the two systemd units;
- lifecycle-oriented tests and documentation.

Important source-level observations:

- `ActivitySamplerWorker` is unchanged.
- `AgentService.run_cycle()` telemetry capability/post/ACK flow is unchanged.
- `PinnedXrayAdapter.read_user_traffic_counters()` is unchanged.
- `activity.py`, `outbox.py`, the control-plane telemetry client, PostgreSQL usage settlement, Premium history, and Tehran-day accounting are unchanged.
- Xray authorization, apply/disable semantics, health handling, Agent startup/shutdown, and restart behavior did change.

Therefore old field evidence may be carried forward only where the exercised production path is source-identical and independent of the changed lifecycle boundary. Checks that cross startup/restart/Xray lifecycle or that the source-of-truth explicitly requires on one current exact head remain open.

## Phase 7 acceptance matrix

| Acceptance item | Current disposition | Reason |
| --- | --- | --- |
| Real installer / supported Ubuntu / enrollment / basic node operation | **PASS — historical field evidence retained** | Already exercised on the same disposable VPS; Gate J rerun also byte-matched deployed Agent files/units and ran the current Python suite. This is not the remaining exact-head accounting gate. |
| Credential policy apply/revoke and direct VLESS+REALITY transport | **PASS — historical/current evidence retained** | Historical live revoke/replacement passed; Gate J current head repeatedly proved direct serving after fresh policy and denial after safe empty-policy cleanup. |
| Gate J boot/startup/crash/reboot fail-closed lifecycle | **PASS on current head** | Current `d4fe18...` A-L field rerun passed, including original stop fault, manual start without marker, SIGKILL, API-unavailable restart, init failure, reboot and marker lifecycle. |
| Stale/no-fresh-policy fail-closed | **PASS on current head** | Gate J current-head API-unavailable restart/reboot windows denied direct traffic until fresh authorization. |
| Outbox/state/secret permissions and bounded lifecycle log privacy | **PASS on current head** | Gate J K rechecked `0700`/`0600` state and bounded sensitive-pattern absence while preserving historical journals. |
| Delayed Premium-period and Tehran-day settlement semantics | **PASS by unchanged-source carry-forward** | Previously exercised against the real disposable control-plane/PostgreSQL integration. No `apps/api`, PostgreSQL settlement, Premium-history or Tehran-day source changed between accounting field head and current runtime head. |
| Capability authenticated true / old-server 404 safety | **Not a remaining Phase 7 blocker** | Real evidence exists on the accounting head and automated coverage remains green. The authoritative Phase 7 gate does not require re-running every capability-unavailability variant on the final lifecycle head. |
| Real populated v1 SQLite migration | **Not a Phase 7 field blocker** | The approved requirement is safe migration semantics; deterministic v1->v2 fixtures cover it. The Phase 7 real checklist does not require manufacturing a populated historical v1 node state. |
| Excessive-skew-specific field injection | **Not a separate Phase 7 blocker** | The field gate requires ambiguous reset/restart/gap/missed-boundary behavior. `>0.75s` skew remains automated coverage/operational validation detail, not a distinct release item in the authoritative Phase 7 gate. |
| Cross-node active-second de-duplication | **Deferred to Phase 9 real multi-node gate** | Explicitly non-blocking when a second real node is not part of this Phase 7 rerun. |
| Premium single-active-client/device enforcement | **Separate unresolved release gate** | Explicitly outside Free accounting Phase 7. |
| Real v2rayNG end-to-end | **Phase 8** | Must not be pulled into Phase 7. |

## Exact current-head checklist — completed by the compact closure below

The strict exact-head requirement means the accounting evidence from `7848a28...` cannot by itself close Phase 7 after lifecycle code changed. However a full re-run of all historical setup is unnecessary.

One compact field session on the already-deployed `d4fe18...` head must still prove these production paths:

1. **Sustained activity / settlement smoke** — real direct VLESS+REALITY traffic increases managed Xray counters, creates current UTC `activeSecondsHex`, reaches PostgreSQL settlement, and debits exactly the newly billable seconds.
2. **Idle** — keep a valid connection open without payload for a bounded interval; unchanged counters create no new bits and no new debit.
3. **Overlap** — two simultaneous connections using the same managed credential/account during overlapping UTC seconds do not multiply Free debit.
4. **Ambiguous gap/reset** — create one controlled Xray/query/restart or missed-boundary gap under the new lifecycle; no ambiguous seconds are inferred and the first recovered observation is baseline-only.
5. **Restart-before-local-ACK retry** — settle one masked batch server-side, terminate/restart Agent before local ACK, then prove exact `(windowId, sequence, seconds, activeSecondsHex)` survives and the retry is duplicate/zero additional debit. This must be rerun because Agent restart/shutdown semantics changed.
6. **Malformed/incomplete acceptance retention** — for one current-head pending masked report, a controlled malformed/partial acceptance must leave the exact pending report intact; a later genuine complete acceptance may clear it. Although `run_cycle()` is source-identical, this remains in the explicit one-current-head field checklist and is cheap to re-prove in the same session.
7. **Final accounting hygiene** — every masked report created in this compact rerun must finish `settled`, with no unexplained `unmapped`; pending/activity must return to the expected clean state; outbox/state permissions and bounded log privacy are rechecked once at the end.

Gate J does **not** need another full A-L rerun unless this compact session changes runtime code or exposes a lifecycle regression. A quick closed-state sanity check after any Agent restart used by item 5 is sufficient to ensure the already-passed lifecycle behavior was not disturbed by test instrumentation.

## Minimal Work session design

The seven items above can be combined into one short VPS session rather than separate field campaigns:

- restore one fresh managed test credential/policy;
- run a bounded sustained transfer and capture only safe bucket/count/debit evidence;
- transition directly into a bounded idle interval;
- run a bounded overlapping two-connection interval;
- induce one controlled observation/restart gap;
- create one pending masked report and exercise exit-before-ACK duplicate recovery;
- reuse a pending report or create one final small report for malformed-acceptance retention;
- verify zero `unmapped`, expected debit totals, permissions/privacy;
- return VPS to fresh empty policy, zero managed clients and no usable old field credential.

No new architecture, migration, provider work, Phase 8 work, second node, Premium device identity work, or broad installer re-test is required for this compact closure attempt.

## PASS rule after the compact rerun

Phase 7 may be changed to **PASS** only if all seven current-head checks above pass on the same exact runtime head and no new Phase 7 blocker appears.

If the compact session changes production runtime code, the affected checks must be repeated on the new final CI-green deployed SHA. Documentation-only evidence commits do not require rerunning the VPN data path.

If all seven pass without runtime code change, the canonical `docs/test-reports/phase-7-vps.md`, the active-second implementation plan Task 8 Step 4, and the Phase 7 status in the main implementation plan should be reconciled to PASS. Phase 8 must still wait for explicit user instruction.

Historical pre-closure checkpoint:

**Gate J: PASS. Phase 7: INCOMPLETE. Phase 8: unstarted. Production Ready: not claimed.**

## Compact closure result — 2026-10-11 (Asia/Tehran)

The same existing VPS completed all seven checks on unchanged exact runtime `d4fe18b91a2da26488faedd96b4182190de31861`, full CI `38073194023` SUCCESS, reverified. Reference reconciliation commit `0f8cd0a8ba33e97073183218e46ab9f05598094a` passed CI `38083723606`. No migration or production runtime code changed; Agent files and both units byte-matched before/after. The canonical report's compact closure contains actual method, limits and cleanup.

| Current-head check | Result | Evidence |
| --- | --- | --- |
| Sustained / settlement | **PASS** | Independent counter-derived bits, durable buckets and PG masks agreed on 69 seconds; ten reports settled; seconds=popcount and Free debit=69 new billable bits |
| Idle | **PASS** | Same connection, 20 fixed-counter samples, zero new bits/debit, online presence 1 |
| Overlap | **PASS** | Two actual connections; 18 interior shared seconds debited 18 times total; no duplicate billed bit |
| Gap/reset | **PASS** | Seven-second stop/restart, two query failures, zero ambiguous buckets/debit, first recovery baseline only |
| Restart before ACK | **PASS** | Two-report/nine-second settled batch survived exit 77 identically; restart closed-state probe denied; duplicate retry/complete ACK, no repeated debit, pending 0 |
| Malformed acceptance | **PASS** | Exact pending retained after controlled missing-duplicates 2xx; genuine complete response ACKed it |
| Final hygiene | **PASS** | All ten reports settled, unmapped/pending/activity 0, schema2 `0600`/state `0700`, bounded privacy scan clean after final probe |

Fault/drop-in removed, temporary origin stopped, fresh empty revision 16 ACKed, managed clients 0, session credential denied, client export removed; VPS/history retained. One positive probe timeout before recovery-runner completion was retained, not counted as verified recovery; subsequent confirmed genuine recovery succeeded. No new Phase 7 blocker remains.

**Current decision: Phase 7 PASS; Gate J PASS; Phase 8 unstarted; Production Ready not claimed.** Deferred/non-blocking boundaries above remain unchanged, including Premium device locking, v2rayNG and multi-node work.
