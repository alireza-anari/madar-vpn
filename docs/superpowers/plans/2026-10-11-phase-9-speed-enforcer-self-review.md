# Phase 9 Speed Enforcer — Self-Review Amendment

Date: 2026-10-11  
Status: **NORMATIVE — supersedes conflicting lines in the implementation plan**

This amendment completes the required self-review of:

- design: `docs/superpowers/specs/2026-10-11-phase-9-speed-enforcer-design.md`
- implementation plan: `docs/superpowers/plans/2026-10-11-phase-9-speed-enforcer.md`

The design was explicitly approved by the user on 2026-10-11. The older `DESIGN — awaiting user review` header in the design document is therefore stale; execution must treat the design as **APPROVED**.

No production code is authorized by this amendment by itself. Implementation still begins only after the implementation plan package is reviewed/accepted.

## 1. Numeric `speedKbps` domain

The implementation plan's phrase "overflow-like values" is made exact here.

For a capped Free Client:

```text
1 <= speedKbps <= INT64_MAX // 125
bytes_per_second = speedKbps * 125
burst_bytes = max(1, bytes_per_second // 2)
```

where `INT64_MAX = 2^63 - 1`.

Requirements:

- `speedKbps` must be an integer, not bool/float/string;
- zero and negative values are invalid;
- any value above `INT64_MAX // 125` is invalid;
- conversion uses integer arithmetic only;
- invalid values fail policy validation before either managed runtime is changed;
- Premium remains exactly `speedKbps = null`.

Task 5 tests must pin the lower boundary, the largest accepted value, and the first rejected overflow value.

## 2. Client-ID rotation and tier transitions use two-phase sidecar membership

The design requirement that the old sidecar identity is removed only **after** Xray no longer accepts/routes the old VLESS credential is normative.

For any policy transition, let:

- `current_free` = capped Free identities from the last successfully applied policy;
- `candidate_free` = capped Free identities from the candidate policy.

The apply sequence is:

1. validate the complete candidate policy with no side effects;
2. render/apply the sidecar with `current_free ∪ candidate_free` using the candidate policy revision as config generation;
3. prove sidecar health for that generation;
4. derive the route credentials needed only by `candidate_free` and render/promote Xray for the candidate policy;
5. prove Xray health while sidecar remains healthy;
6. render/apply the sidecar again with **candidate_free only**, keeping the same policy revision/generation;
7. prove sidecar health again and prove combined runtime health;
8. only now set `_current_policy` to the candidate and allow ACK of the revision.

Consequences:

- Client-ID rotation stages the new alias before Xray switches and prunes the old alias only after the old Xray credential is gone;
- Free → Premium keeps the old capped identity available until Xray has switched the Client to direct, then prunes/disables it;
- Premium → Free prepares and health-checks the capped identity before Xray can route the Client to it;
- removal/suspension follows the same rule: Xray stops accepting the Client before its old sidecar identity is pruned.

A brief interruption is allowed. An uncapped Free interval is not.

If the final sidecar prune/health check fails after Xray has switched:

- do **not** ACK the candidate revision;
- do **not** advance `_current_policy`;
- disable both managed runtimes fail-closed;
- the next cycle refetches/retries the unacknowledged candidate revision.

Leaving an old alias in a loopback-only sidecar is not accepted as successful completion of the policy apply, even though it is not externally reachable after Xray credential removal.

## 3. Required Task 7 regression tests

Task 7 must explicitly prove:

- Client-ID rotation call order is `sidecar union -> Xray candidate -> sidecar candidate-only -> ACK eligibility`;
- the old alias is still present during the Xray switch and absent before ACK;
- Free → Premium does not prune the old capped alias until Xray direct promotion succeeds;
- Premium → Free does not promote Xray until the new capped alias is healthy;
- final prune failure disables both runtimes, leaves `_current_policy` unchanged, and prevents ACK;
- a retry of the same candidate revision is possible from the last successfully applied policy state.

## 4. Self-review result

With the two clarifications above, the plan covers the approved design requirements for:

- per-Client/per-Node independent upload/download caps;
- shared TCP/UDP directional buckets;
- Premium bypass;
- opaque Node-local identity;
- sidecar config privacy;
- user-aware Xray routing with no Free direct fallback;
- atomic/fail-closed lifecycle and readiness;
- rotation/tier-transition ordering;
- CI and real-VPS Task 29 + Task 30 acceptance.

No additional architecture decision is left open before implementation. The unresolved Premium single-active-device release gate remains separate from this Phase 9 speed mechanism.