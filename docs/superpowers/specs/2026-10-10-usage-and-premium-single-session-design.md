# Madar Usage Accounting and Premium Single-Session Design

**Status:** Product behavior approved in chat; written-spec review pending  
**Date:** 2026-10-10  
**Repository:** `alireza-anari/madar-vpn`  
**Branch:** `impl/phase-1`

## 1. Purpose and authority

This specification is a focused amendment to the approved Madar clean-start design. It changes only the rules described here and leaves all other authentication, entitlement, security, subscription, node, PWA, payment, provider, and operational-readiness requirements unchanged.

This amendment supersedes the previous product rule that distinct simultaneous VPN sessions must multiply free-credit usage. It also supersedes the earlier Phase 7 direction that considered patching Xray solely to obtain raw per-connection multiplicity for free-credit accounting.

The approved product behavior is now:

- Free usage is charged by **account-level active traffic time**, at most once per server-observed UTC second bucket, regardless of how many connections, devices, or nodes contribute traffic during that bucket.
- Premium access is expiration-based and does not consume free credit while Premium is active at the observed usage time.
- A Premium configuration may exist on multiple devices, but at most **one active client instance** may own/use that credential at a time. The first valid active client instance wins; a second distinct client instance must be denied until ownership is released.

These rules are product requirements. They do not by themselves claim the current repository or stock Xray can already enforce every part of them.

## 2. Definitions

### Active free second

An active free second is one server-observed UTC second bucket for which the node has a valid adjacent observation interval and observes a positive authenticated traffic-byte delta for the user's active VPN credential.

The bucket identity is server-authoritative. It is not derived from browser/client timestamps.

Properties:

- one or more positive traffic observations for the same credential in the same bucket still count as exactly one free-credit second;
- an open connection with no positive byte delta counts as zero;
- a retry or duplicate report cannot charge the same bucket again;
- ambiguous intervals caused by sampler failure, process restart, Xray reset, clock discontinuity, or an observation gap are not inferred as active.

### Active client instance

For the Premium concurrency rule, an active client instance means the conceptual VPN client/device currently owning the credential's single-use slot.

An active client instance is **not** equivalent to:

- one TCP connection;
- one Xray transport connection;
- one source IP address;
- one Xray `session.NewID()` value;
- one entry in the Xray online-IP map.

A legitimate single v2rayNG device may create multiple transport connections, while multiple devices may share one public IP through NAT. Therefore neither connection count nor IP count may be used as a device identity.

## 3. Free-credit accounting rule

For an account that is not Premium at the observed usage time, the maximum debit is one second of free credit for each server-observed UTC second bucket that contains authenticated VPN traffic for its active credential.

Examples:

- one connection transferring for ten active buckets -> ten seconds debit;
- multiple connections on one device transferring during those same ten buckets -> ten seconds debit;
- two devices using the same free credential and transferring during the same ten buckets -> ten seconds debit, not twenty;
- overlapping activity on two Madar nodes in the same ten buckets -> ten seconds debit, not twenty;
- an idle open connection -> zero debit while counters do not advance.

When Premium is active for an observed bucket, that bucket does not consume free credit even if its telemetry reaches the control plane later, including after Premium expires. Settlement uses the entitlement applicable to the observed usage time, not merely the account state at report-arrival time.

## 4. Free-usage observation source

Madar continues to use the official pinned Xray per-user cumulative uplink/downlink byte counters as the server-observed activity source.

`onlineUsers`, online-IP count, connection count, access logs, or inferred client-side state are not billing clocks.

The Node Agent retains the conservative observation semantics already implemented:

- the first valid observation establishes a baseline and creates no activity;
- a positive uplink or downlink byte delta across adjacent valid samples marks activity;
- unchanged counters mark no activity;
- a counter decrease/reset, new or missing client, non-monotonic time, observation failure, or excessive sampling gap breaks continuity and marks no inferred activity across the ambiguous interval;
- after process restart, the first valid observation again establishes a zero-charge baseline.

For this accounting model, the sampler **must** schedule observations against a shared UTC one-second cadence and assign every valid adjacent sample interval to one deterministic UTC second bucket. The exact scheduling tolerance and clock-discontinuity rules belong in the implementation plan and must be covered by tests. If the sampler cannot assign an interval to exactly one valid bucket without ambiguity, it records zero activity for that interval rather than guessing.

This is a server-observed accounting model. It does not claim sub-second reconstruction of when individual packets crossed the network.

## 5. Global de-duplication across connections and nodes

The old representation of only a total `seconds` value per report is insufficient for the new rule once the same credential can be observed on more than one node: two reports containing five seconds each do not reveal whether those seconds overlapped.

Therefore telemetry for free accounting must preserve the identity of the observed active UTC second buckets.

The canonical batched representation is a per-UTC-minute active-second bitmap:

- a minute contains 60 billable second positions;
- bit 0 represents second `:00` and bit 59 represents second `:59` of that UTC minute;
- the wire representation is a fixed 16-character lowercase hexadecimal unsigned 64-bit value;
- the hexadecimal string is parsed as an unsigned integer, and bit `n` is active when `(value >> n) & 1 == 1`;
- only the low 60 bits are valid; the high four bits must be zero;
- `seconds`, when retained in the payload for compatibility/validation, must equal the population count of the bitmap;
- a report with malformed bitmap, out-of-window bits, or mismatched `seconds` is rejected.

The report idempotency identity `(nodeId, windowId, sequence)` remains important for delivery retry protection, but debit uniqueness is additionally defined by the user/client credential plus the UTC second-bucket identity.

The authoritative settlement operation performs a logical OR of newly accepted active-second evidence with already-settled evidence for the same client/minute. Only bits that transition from unseen to seen may create a new free-credit debit. This makes overlapping activity from multiple connections or nodes cost one second per server-observed UTC bucket globally.

## 6. Tehran-day and entitlement-time boundaries

The existing free-credit reset rule remains unchanged: free credit is scoped to the `Asia/Tehran` calendar day and Premium is unaffected by midnight.

Each active UTC second bucket is converted to its Tehran calendar day at authoritative settlement time. Delayed telemetry from a previous Tehran day must never debit the new day's free balance.

Entitlement is evaluated for the observed bucket, not for the report-arrival time. A bucket observed while Premium was active produces no free-credit debit even if it is settled after Premium expires. Conversely, a bucket observed while the account was Free is governed by the free-credit day and balance applicable to that observed time.

Settlement logic must work from per-second bucket identity rather than assigning an entire delayed report to a single day or entitlement state based only on its delivery timestamp.

## 7. Durable telemetry and replay safety

The existing local SQLite outbox remains the durability boundary for Node Agent telemetry.

The outbox must evolve, if needed, so that the active-second bitmap itself is durable before transmission. After a process or VPS restart:

- previously persisted active-second evidence must retain the same logical identity;
- a pending report must retain the same window and sequence on retry;
- acknowledgement occurs only after the control plane confirms complete acceptance of the batch;
- retry, duplicate acceptance, or replay cannot create a second debit for already-settled active-second bits.

Sampling continuity is intentionally not reconstructed across restart; ambiguous restart time is zero-charge.

## 8. Premium single-active-client rule

A Premium user keeps the existing expiration-based entitlement model and has no Madar-imposed application speed cap.

For each active Premium VPN credential:

1. the credential may be imported/stored on multiple devices;
2. the first distinct client instance that successfully acquires the active slot becomes its owner;
3. additional transport connections that belong to that same owning client instance must continue to work normally;
4. a second distinct client instance attempting simultaneous use must be denied;
5. after the owning client instance is genuinely inactive and its ownership is safely released, another client instance may acquire the slot;
6. the rule is global across all Madar nodes so changing nodes cannot bypass the single-active-client limit;
7. rotating or revoking the VPN credential invalidates ownership associated with the old credential, and the old credential remains denied as required by the existing rotation rules;
8. Premium expiry, suspension, and revocation must not leave a stale ownership state that preserves unauthorized access.

The limit applies to a client instance, not to raw network connections.

## 9. Premium identity/enforcement boundary

Stock Xray and an identical static VLESS/REALITY configuration do not currently expose a stable, privacy-safe device/client-instance identity that Madar can trust for this rule.

The following shortcuts are explicitly rejected:

- **source-IP lock:** NAT can place multiple devices behind one IP and mobile networks can change a device's IP;
- **raw connection count:** one legitimate client can open multiple VLESS connections;
- **Xray transport session ID:** it identifies a transport connection, not a stable client instance;
- **online-IP count:** it represents unique public IPs, not devices;
- **access-log parsing:** it is not a reliable device identity and conflicts with the established privacy boundary;
- **silently issuing a second simultaneously-active VPN credential for the same Premium subscription:** this bypasses the approved single-config/single-active-client product rule.

Any future client-instance identifier used for this rule must be server-verifiable, revocable or naturally scoped to the credential lifecycle, and privacy-safe. It must not be derived directly from hardware fingerprinting, email, internal user ID, public IP, or another identifier intended for cross-account tracking. It must not be exposed in public subscription output unless the approved client protocol explicitly requires it.

Therefore the Premium single-active-client requirement is an explicit technical/release gate. Madar must not display or advertise it as enforced until a separate approved mechanism provides a stable client-instance signal and real v2rayNG testing proves the behavior.

If stock v2rayNG with an identical copyable configuration cannot supply such a signal, the next design decision must choose an explicit client/provisioning mechanism or revise the product semantics. An IP-only or connection-count fallback is not approved.

The eventual ownership-release rule must be explicit and testable. It may use a bounded server-observed lease/timeout only after the client-instance identity problem is solved; it must not silently transfer ownership while the current owner is still demonstrably active.

## 10. Xray patch decision

Madar will not patch or fork Xray merely to expose raw transport-session counters for free-credit accounting or Premium device locking.

Reason:

- free accounting no longer needs transport-session multiplicity;
- a transport-session counter still cannot distinguish multiple connections from one device versus connections from multiple devices, so it does not solve the Premium rule.

The official pinned Xray binary remains preferred unless a future, separately reviewed requirement genuinely cannot be met without a core change.

## 11. Data model consequences

The existing authoritative usage model must evolve from "sum every independent session duration" to "settle previously unseen active second buckets" for free accounts.

Required logical state includes:

- raw telemetry report identity for retry/idempotency;
- client/credential identity and account mapping;
- UTC-minute window identity;
- active-second bitmap evidence;
- authoritative settled active-second state or an equivalent representation that can atomically identify newly seen bits;
- entitlement history sufficient to evaluate whether Premium was active at each observed bucket;
- immutable debit events linked to newly settled seconds.

Database transactions must ensure concurrent reports from two nodes cannot both debit the same second.

The exact table/migration names belong in the implementation plan, not this product design.

## 12. Phase and acceptance consequences

### Phase 7 free-account gate

The old Phase 7 blocker requiring exact same-UUID simultaneous-session multiplicity for free debit is removed because it is no longer the product rule.

Phase 7 still cannot pass until the current server-observed path, evolved to preserve second-bucket identity, is field-proven on a real VPS. Required evidence includes:

- real traffic creates the expected active-second buckets and PostgreSQL debit;
- idle open connection creates no additional debit;
- multiple connections overlapping in the same seconds do not multiply debit;
- retry/replay and process restart do not lose accepted evidence or double debit;
- delayed telemetry is charged according to the observed Tehran day and entitlement state, not arrival time.

Cross-node overlap de-duplication is additionally required before multi-node usage accounting can pass its later multi-node gate.

### Premium concurrency gate

Premium single-active-client enforcement remains unresolved and must receive its own design/implementation gate before Production Ready.

Real acceptance must prove with the intended production client flow that:

- the first client instance can use the configuration normally;
- multiple required transport connections from that same client do not self-block;
- a second distinct client instance using the same configuration is denied while the first owns the slot;
- two devices behind the same NAT are still distinguished correctly;
- the rule cannot be bypassed by selecting another Madar node;
- after safe release, a different client instance can acquire the slot;
- credential rotation/revocation and Premium expiry do not leave stale ownership or stale access.

No automated test alone substitutes for this real-client gate.

## 13. Required automated acceptance examples

The implementation plan must include tests equivalent to these cases:

| Scenario | Expected result |
| --- | --- |
| Free: one client active for 10 distinct buckets | 10 seconds debit |
| Free: multiple connections active in the same 10 buckets | 10 seconds debit |
| Free: node A and node B report the same 10 buckets | 10 seconds debit total |
| Free: node A reports 5 non-overlapping buckets and node B reports 5 different buckets | 10 seconds debit total |
| Free: open connection with no byte delta | 0 seconds debit |
| Free: same report retried/duplicated | 0 additional debit |
| Free: previous Tehran-day bucket arrives after midnight | no debit from the new day's balance |
| Premium-period usage report arrives after Premium expiry | no free-credit debit for buckets observed while Premium was active |
| Premium: one client opens multiple legitimate transport flows | allowed as one client instance |
| Premium: second distinct client instance uses same configuration concurrently | denied once exact identity mechanism exists |
| Premium: two devices share the same NAT | still enforce one active client without IP heuristic |

## 14. Non-goals and forbidden claims

This design does not:

- add a browser-side VPN Connect button;
- use browser state as VPN truth;
- infer billable time from `onlineUsers`;
- identify devices by public IP;
- equate Xray transport connections with client devices;
- claim Premium single-client enforcement is currently operational;
- claim the new active-second bitmap settlement has been implemented or field-tested;
- make Phase 7, v2rayNG E2E, or Production Ready pass by documentation alone.

## 15. Documentation follow-up after approval

After this written specification is reviewed and approved, the implementation-planning step must reconcile the repository documentation that still contains the superseded concurrent-session rule, including:

- `docs/superpowers/specs/2026-10-08-madar-clean-start-design.md`;
- `docs/superpowers/plans/2026-10-08-madar-implementation-plan.md`;
- `docs/architecture/xray-session-accounting.md`;
- Phase 7 runbook/test-report language affected by the old multiplicity blocker.

Those updates must distinguish product-rule changes from already-verified field evidence. Historical test evidence must not be rewritten as though the new behavior had been tested at the time.

## 16. Release status

This specification changes the intended product semantics but does not change current operational status.

**Phase 7 remains INCOMPLETE.**  
**Premium single-active-client enforcement is NOT YET VERIFIED OR IMPLEMENTED.**  
**Production Ready remains BLOCKED.**
