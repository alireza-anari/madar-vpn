# Madar Usage Accounting and Premium Single-Session Design

**Status:** Approved  
**Date:** 2026-10-10  
**Repository:** `alireza-anari/madar-vpn`  
**Branch:** `impl/phase-1`

## 1. Purpose and authority

This specification is the approved focused amendment to the Madar clean-start design for Free usage accounting and Premium concurrency semantics. It changes only the rules described here. All other authentication, entitlement, security, subscription, node, PWA, payment, provider, and operational-readiness requirements remain unchanged.

This amendment supersedes the previous product rule that distinct simultaneous VPN sessions multiply Free-credit usage. It also supersedes the earlier Phase 7 direction that considered patching Xray solely to obtain raw per-connection multiplicity for Free accounting.

The approved product behavior is:

- Free usage is charged by **account-level active traffic time**, at most once per server-observed UTC second bucket, regardless of how many connections, devices, credentials, or nodes contribute traffic during that bucket.
- Premium access is expiration-based and does not consume Free credit while Premium is active at the observed usage time.
- A Premium configuration may exist on multiple devices, but at most **one active client instance** may own/use that credential at a time. The first valid active client instance wins; a second distinct client instance must be denied until ownership is released.

These are product requirements. Repository/CI implementation of the Free active-second subsystem does not by itself prove the real-VPS Phase 7 gate, and it does not implement the Premium single-active-client rule.

## 2. Definitions

### Active Free second

An active Free second is one server-observed UTC second bucket for which the node has a valid adjacent observation interval and observes a positive authenticated traffic-byte delta for a credential mapped to the account.

The bucket identity is server-authoritative and is not derived from browser/client timestamps.

Properties:

- one or more positive observations for the account in the same UTC second bucket still count as exactly one Free second;
- an open connection with no positive byte delta counts as zero;
- retries, duplicate reports, overlapping nodes, and overlapping credentials cannot charge the same account/bucket again;
- ambiguous intervals caused by sampler failure, process restart, Xray reset, clock discontinuity, missed scheduled boundary, or excessive observation skew are not inferred as active.

### Active client instance

For Premium concurrency, an active client instance means the conceptual VPN client/device currently owning the credential's single-use slot.

It is **not** equivalent to:

- one TCP connection;
- one Xray transport connection;
- one source IP address;
- one Xray internal transport/session identifier;
- one entry in the Xray online-IP map.

A legitimate single v2rayNG client can create multiple transport connections, while multiple devices can share one public IP through NAT. Therefore neither raw connection count nor IP count is an approved device identity.

## 3. Free-credit accounting rule

For an account that is not Premium at the observed usage time, the maximum debit is one second of Free credit for each server-observed UTC second bucket containing authenticated VPN traffic for that account.

Examples:

- one connection transferring for ten active buckets -> ten seconds debit;
- multiple connections on one device transferring during those same ten buckets -> ten seconds debit;
- two devices using the same Free configuration during the same ten buckets -> ten seconds debit, not twenty;
- two credentials for the same account overlapping in the same ten buckets -> ten seconds debit;
- overlapping activity on two Madar nodes in the same ten buckets -> ten seconds debit;
- an idle open connection with unchanged counters -> zero debit.

When Premium is active for an observed bucket, that bucket does not consume Free credit even if its telemetry reaches the control plane after Premium expires. Settlement uses entitlement at the observed usage time, not report-arrival time.

## 4. Free-usage observation source

Madar uses the official pinned Xray per-user cumulative uplink/downlink byte counters as the server-observed activity source.

`onlineUsers`, online-IP count, raw connection count, access logs, and inferred browser/client state are not billing clocks.

The Node Agent uses conservative UTC-aligned sampling:

- first valid observation establishes a baseline and creates no activity;
- a positive uplink or downlink byte delta across adjacent trusted scheduled boundaries marks exactly the preceding UTC second bucket active;
- unchanged counters mark no activity;
- counter decrease/reset, new or missing client, non-monotonic time, query failure, missed scheduled boundary, excessive post-boundary skew, or process restart breaks continuity and creates no inferred activity across the ambiguous interval;
- a delayed worker iteration skips missed buckets rather than fabricating catch-up activity.

The current implementation uses a default maximum post-boundary observation skew of `0.75s`; that tolerance remains subject to real field validation.

This is a server-observed accounting model. It does not claim sub-second reconstruction of packet timing.

## 5. Global de-duplication and canonical bitmap

A total `seconds` value alone is insufficient because overlapping evidence from different nodes cannot be distinguished from non-overlapping evidence. New Free-account telemetry therefore preserves exact UTC second-bucket identity.

The canonical representation is a per-UTC-minute active-second bitmap:

- a minute has 60 possible active-second positions;
- bit 0 represents `:00`, bit 59 represents `:59`;
- the wire representation is exactly 16 lowercase hexadecimal characters;
- only the low 60 bits are valid; the high four bits must be zero;
- all-zero is invalid for a new masked report;
- `seconds` must equal the population count of the bitmap;
- canonical window IDs use `xray-traffic:YYYY-MM-DDTHH:MMZ`;
- malformed bitmap, impossible window, high bits, or mismatched `seconds` is rejected.

Delivery idempotency remains keyed by `(nodeId, windowId, sequence)`. Reuse of that identity with a contradictory normalized payload is a conflict, not a duplicate.

Debit uniqueness is additionally **account-level UTC second identity**. The authoritative settlement ORs newly accepted active-second evidence with already-settled evidence for the same account/minute. Only previously unseen candidate bits can create a new Free debit.

This makes overlap from multiple connections, nodes, or credential rotations charge once per account/UTC second.

## 6. Tehran-day and observed-time entitlement boundaries

The existing reset rule remains unchanged: Free credit is scoped to the `Asia/Tehran` calendar day; Premium is unaffected by midnight.

Each active UTC bucket is converted to its Tehran calendar day at authoritative settlement time. Delayed telemetry from a previous Tehran day must never debit the new day's Free balance.

Premium is also evaluated at the observed bucket. A bucket observed while Premium was active remains non-billable for Free credit even when delivered after Premium expiry.

If Premium starts or expires inside a one-second bucket, the bucket is conservatively treated as non-billable because Madar does not reconstruct sub-second packet timing.

Premium entitlement history uses authoritative control-plane mutation time. Provider occurrence timestamps remain audit evidence, but a delayed provider callback must not retroactively make Premium effective before the control plane settled it. Premium extension remains based on `max(server settlement now, current expiry)`.

## 7. Durable telemetry and replay safety

The local SQLite outbox is the durability boundary for Node Agent telemetry.

The current schema version is `2` and persists the active-second bitmap before transmission. After Agent/VPS restart:

- persisted active-second evidence retains its logical bucket identity;
- a pending masked report retains the same window, sequence, seconds, bitmap, and timestamps until acknowledgement;
- acknowledgement occurs only after the control plane confirms complete batch accounting;
- exact server duplicate classification may safely acknowledge an already-settled retry;
- malformed/incomplete/contradictory acceptance does not remove pending evidence.

Old outbox aggregate rows do not contain recoverable bucket positions. Migration preserves them as legacy telemetry with no fabricated bitmap bits and no new active-second debit.

Sampling continuity itself is intentionally not reconstructed across restart; the first new Xray sample is baseline-only.

## 8. Mixed-version rollout safety

The new control plane advertises active-second support through an authenticated node capability endpoint.

A new Agent must not submit a report containing `activeSecondsHex` until the authenticated control plane explicitly advertises support. An authenticated `404` from an older server means unsupported: the exact masked pending report remains local and is not stripped/downgraded/ACKed.

Legacy pending reports without a bitmap can continue to be delivered to an older server.

The supported deployment order is therefore server-first:

1. PostgreSQL backup/preflight;
2. apply migration `0002_active_second_accounting.sql` only to an existing `0001` database;
3. deploy the new control plane;
4. verify active-second capability;
5. upgrade Agents.

`0001_core.sql` must not be rerun against an existing database.

## 9. Authoritative settlement transaction

For a new masked report, the PostgreSQL settlement boundary atomically covers:

- raw telemetry insert or exact-duplicate comparison;
- credential-to-account mapping, including delayed reports for revoked credentials;
- account-level active-minute locking/de-duplication;
- observed-time Premium evaluation;
- Tehran-day attribution;
- immutable debit evidence;
- Free credit ledger mutation;
- settlement status.

A failure anywhere after raw telemetry insertion rolls back the raw insert too, so retry cannot become an accepted-but-unbilled duplicate.

An unknown credential is preserved as `unmapped` telemetry with zero debit. Any unexplained `unmapped` masked report from a managed field client blocks Phase 7 PASS.

## 10. Premium single-active-client rule

A Premium user keeps the expiration-based entitlement model and has no Madar-imposed application speed cap.

For each active Premium configuration:

1. the configuration may be imported/stored on multiple devices;
2. the first distinct client instance that successfully acquires the active slot becomes its owner;
3. additional transport connections from that same owner must work normally;
4. a second distinct client instance attempting simultaneous use must be denied;
5. after the owner is genuinely inactive and ownership is safely released, another client instance may acquire the slot;
6. the rule must be global across Madar nodes;
7. credential rotation/revocation invalidates ownership associated with the old credential;
8. Premium expiry, suspension, or revocation must not preserve stale ownership/access.

The limit applies to a client instance/device, not raw network connections.

## 11. Premium identity/enforcement boundary

Stock Xray plus an identical static VLESS/REALITY configuration does not currently expose a stable, privacy-safe device/client-instance identity that Madar can trust for this rule.

Rejected shortcuts:

- source-IP locking;
- raw connection count;
- Xray transport/session IDs;
- online-IP count;
- aggregate byte rate;
- access-log parsing;
- silently issuing additional simultaneously-active credentials for one Premium subscription.

Any future identifier must be server-verifiable, privacy-safe, appropriately scoped/revocable, and proven with the intended real client. It must not be based directly on hardware fingerprinting, email, internal user ID, public IP, or another cross-account tracking identifier.

Premium single-active-client enforcement is therefore an explicit separate technical/release gate. Madar must not display or advertise it as enforced until a separately approved mechanism and real v2rayNG testing prove it.

## 12. Xray patch decision

Madar will not patch or fork Xray merely to expose raw transport-session counters for Free accounting or Premium device locking.

Free accounting no longer needs transport-session multiplicity, while raw transport-session identity still cannot distinguish several connections from one device versus connections from several devices.

The official pinned Xray binary remains preferred unless a future separately reviewed requirement genuinely cannot be met without a core change.

## 13. Data model consequences

Authoritative usage state includes:

- raw telemetry report identity and normalized payload;
- credential-to-account mapping;
- UTC-minute window identity;
- active-second bitmap evidence;
- account-level settled active-minute masks;
- Premium entitlement history sufficient for observed-time evaluation;
- immutable debit evidence linked to newly settled bits;
- immutable Free ledger mutations.

Database transactions must ensure concurrent reports from multiple nodes/credentials cannot both debit the same account/UTC second.

## 14. Automated acceptance

Repository/CI acceptance covers, among other cases:

| Scenario | Expected result |
| --- | --- |
| Free: one account active for 10 distinct buckets | 10 seconds debit |
| Free: multiple connections active in same 10 buckets | 10 seconds debit |
| Free: node A and node B report same 10 buckets | 10 seconds total |
| Free: two credentials of same account overlap | overlapping seconds debit once |
| Free: two nodes report disjoint five-bit masks | 10 seconds total |
| Free: open connection with unchanged bytes | 0 seconds debit |
| Same delivery retried exactly | 0 additional debit |
| Same delivery identity with changed payload | conflict; no ACK |
| Previous Tehran-day bucket arrives after midnight | no debit from new day's balance |
| Premium-period bucket arrives after Premium expiry | no Free debit |
| Agent restarts with pending bitmap | identical pending identity/payload survives |
| New Agent meets old server | masked report remains pending |
| Local old aggregate outbox migrates | no invented bitmap seconds |

Automation is necessary but does not replace the real-VPS gate.

## 15. Phase 7 Free-account field gate

The old Phase 7 blocker requiring exact same-UUID simultaneous-session multiplicity for Free debit is removed because it is no longer the product rule.

Phase 7 still cannot pass until one exact current head is field-proven on the real disposable VPS. Required evidence includes:

- real pinned Xray counters under the managed config;
- sustained direct VLESS+REALITY traffic creates expected UTC bitmap evidence and exactly-once PostgreSQL debit;
- idle open connection creates no additional bit/debit;
- overlapping connections in the same seconds do not multiply debit;
- reset/restart/gap/missed boundary does not infer activity;
- Agent restart before local ACK preserves the exact pending `(windowId, sequence, seconds, activeSecondsHex)` and retry settles once;
- malformed/incomplete acceptance leaves the pending report intact;
- outbox permissions/log privacy remain correct;
- current boot ordering prevents stale persisted Xray authorization before fresh policy;
- no masked field report remains unexplained `unmapped`;
- delayed Premium/day behavior is proven against the real disposable control-plane/PostgreSQL field environment.

Cross-node overlap is a later multi-node field gate unless a second real node is available during the rerun.

## 16. Premium concurrency field gate

Premium single-active-client enforcement remains unresolved and requires a separate approved design/implementation gate before Production Ready.

Real acceptance must prove with the intended production client flow that:

- the first client instance works normally;
- multiple required transport connections from that same client do not self-block;
- a second distinct client instance using the copied configuration is denied while the first owns the slot;
- two devices behind the same NAT are still distinguished correctly;
- another Madar node cannot bypass the rule;
- safe release permits a different client instance to acquire the slot;
- credential rotation/revocation and Premium expiry do not leave stale ownership/access.

No automated test alone substitutes for this real-client gate.

## 17. Non-goals and forbidden claims

This design does not:

- add a browser-side VPN Connect button;
- use browser state as VPN truth;
- infer billing from `onlineUsers`;
- identify Premium devices by public IP;
- equate Xray transport connections with client devices;
- claim Premium single-client enforcement is operational;
- claim the new active-second path has passed its real-VPS field gate;
- make Phase 7, v2rayNG E2E, or Production Ready pass from CI/documentation alone.

## 18. Implementation status

As of the current repository work on 2026-10-10:

- active-second PostgreSQL migration/data model: repository/CI implemented;
- canonical bitmap contract and replay-conflict semantics: repository/CI implemented;
- authoritative Premium history for observed-time Free billing: repository/CI implemented;
- atomic account-level PostgreSQL settlement: repository/CI implemented;
- UTC-aligned Xray sampler: repository/CI implemented;
- SQLite outbox v2 + safe v1 migration: repository/CI implemented;
- active-second capability negotiation and end-to-end Agent/control-plane wiring: repository/CI implemented;
- current real-VPS active-second field rerun: **not yet performed**;
- Premium single-active-client enforcement: **not yet implemented or verified**.

**Phase 7 remains INCOMPLETE.**  
**Premium single-active-client enforcement remains an open release gate.**  
**Production Ready remains BLOCKED.**
