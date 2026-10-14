# Task 34 private-field handoff — 2026-10-14

Source: `836382e823d21e05b43b4eaf3382ca43c2ba97c9`, branch `impl/phase-10-task33-pwa-push`. Full CI `38591095766`, job `115945880564`: success, independently verified by this cloud continuation. Phase 10 incomplete.

## Evidence provenance

Private VPS/Windows/phone observations below were supplied by the operator's desktop execution handoff at 21:14 Asia/Tehran (17:44Z). They were not independently repeated from this cloud workspace. Tests used real application APIs and real PostgreSQL on the private Node1 control plane. A temporary private authentication/email-delivery assembly was present; no real SMTP or complete staging-database acceptance is inferred.

Cloudflare API independently confirms staging source tag `836382e...`, existing 13 bindings, invocation logging disabled and version `27e69b72-4c0c-45b9-9769-100776ff022f` at 100%, created `2026-10-14T15:48:18.111755Z`.

## Diagnosis and fix

Initial Node2 policies expired and its private control-plane connection was disconnected. Xray stopping and absence of its runtime authorization marker were correct fail-closed behavior. No marker was manually created; SSH/firewall unchanged; Task 32 not repeated.

Before correction, a fresh account received 1800 seconds but initial credential creation deadlocked readiness and first rotation returned 500. User-authorized bootstrap/first rotation correction retains readiness/ACK gates. RED source `10e6d515167042c4676e20aa510d25256c2ece60`; handoff reports expected related CI failures. Fixed source passed 12 focused and 158 API tests, independent review, and full CI. Agent, installer and Speed Enforcer code unchanged.

## Scoped results

| Subcheck | Status | Operator evidence / limit |
| --- | --- | --- |
| Fresh account / one-time grant / replay | PASS | 1800 seconds across three reads and login again; replay link 401. Private delivery transport only, not real SMTP. |
| First credential rotation | PASS | Actual route returned 201; old/new credential enforcement and old URL invalidation still need separate evidence. |
| Joint node authorization/readiness snapshot | PASS | Node1 revision 36 and Node2 revision 7, ACK/ready/healthy together at `2026-10-14T16:05Z`. Historical bounded snapshot only. |
| Two-node phone import and connections | PASS | Operator observed two configs, each connected with expected egress. Current v2rayNG version not recorded. |
| Independent Windows internet traffic | PASS | Node2 expected egress and 1,048,576 transferred internet bytes. |
| Combined active-traffic debit | PASS | Account decreased 1800→1762 after combined traffic. 38 seconds cannot be attributed solely to Windows test. |
| Real telemetry duplicate/replay | PASS | Two responses 200, accepted=0/duplicates=1; unchanged ledger and report count. No second debit. |
| Idle sixty-second zero-debit | BLOCKED | Operator response missing. Do not infer from previous idle tests. |
| Current throughput baseline / Free cap | BLOCKED | Not executed in this continuation. |
| Current v2rayNG version | BLOCKED | Historical 2.2.6 not a current reading. |
| Final current node state / cleanup | BLOCKED | Bounded policies expire at `2026-10-14T17:45Z`. Recheck current state; do not infer ongoing health. |

All remaining final-candidate revoke/re-enable, rotation enforcement, unhealthy-node exclusion, cross-node overlap-dedupe, Premium no-app-cap and privacy checks are governed by the final matrix. Historical evidence is preserved; only missing or affected deltas should run.

## Cleanup contract — not yet executed

- Original desktop runtime owns reverse-forward session `50436`, relay session `37444`, and local QR session `21999`; these are session identifiers, not TCP ports, and are not transferable to this cloud executor. Inspect before stopping anything.
- Temporary subscription tunnel, proxy and private QR still require bounded cleanup after tests; preserve the operational bridge while needed.
- Restore the canonical current-HEAD API from `/opt/madar-phase7-test/task34-auth-original-api.mjs` only after checking its current-source provenance. Do not deploy an old backup. Temporary field-auth assembly must not remain the final runtime.
- Revoke test subscriptions, credentials and sessions, including any positively identified old test sessions, through real product/application routes. Verify actual removal and access denial. No raw IDs/tokens belong in reports.
- Inspect residual helper files, processes/listeners and secret-safe journal aggregates. Preserve historical evidence logs and both VPSs. Do not alter SSH/firewall or manually authorize Xray.

This cloud continuation has no live retained-field routing/credentials/session reader. It updated evidence and verified GitHub/Cloudflare only; it performed no remote cleanup. Lack of `/opt/madar-phase7-test` in this local container is not proof of absence on Node1. Final safety and cleanup remain BLOCKED until the owning desktop execution environment proves them.
