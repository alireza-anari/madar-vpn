# Xray session/accounting boundary

Date: 2026-10-10  
Status: **Accepted boundary; Free accounting path implemented in repository/CI, Premium client-instance gate remains open**  
Pinned upstream: `XTLS/Xray-core v26.3.27`

## Current product rules

The approved usage amendment is:

- Free credit is charged by **account-level server-observed active traffic time**: at most one second per account per UTC second bucket, regardless of connection, device, credential, or node multiplicity.
- Premium remains expiration-based and does not consume Free credit for buckets observed while Premium is active.
- A Premium configuration may be stored on multiple devices, but only one distinct active client instance may own/use it at a time. A second distinct client instance must be denied until ownership is safely released.

The earlier product rule that distinct simultaneous VPN sessions multiply Free-credit usage is superseded by `docs/superpowers/specs/2026-10-10-usage-and-premium-single-session-design.md`.

## What stock Xray exposes

The pinned Xray source was reviewed at `v26.3.27`.

### User traffic counters

When `statsUserUplink` / `statsUserDownlink` are enabled, Xray's dispatcher attaches cumulative byte counters to the authenticated user identity. These counters are cumulative **per user credential**, not per transport connection.

Relevant upstream source:

- `app/dispatcher/default.go` at `v26.3.27`

Madar intentionally sets the VLESS email to a Madar-managed client identifier. The Node Agent consumes these counters only through the loopback StatsService and does not copy raw StatsService output to logs or shared evidence.

These counters are sufficient for the approved conservative Free-account activity rule: a positive byte delta across a valid adjacent UTC-aligned observation interval marks that account/client active for that second bucket. The control plane then de-duplicates the bucket globally at account level.

### Online map

Xray's `OnlineMap` is internally refcount-based: every `AddIP(ip)` increments an internal `refCount` for that IP and `RemoveIP(ip)` decrements it. The stable interface exposes only:

- `Count()` — number of **unique online IPs**;
- `List()` — online IPs;
- `IPTimeMap()` — IP -> last-seen time.

The per-IP connection `refCount` itself is not exposed through the stable interface.

Relevant upstream source:

- `features/stats/stats.go` at `v26.3.27`
- `app/stats/online_map.go` at `v26.3.27`

### StatsService API

`StatsService.GetStatsOnline()` returns `OnlineMap.Count()`, so it reports unique-IP count rather than total connection references. `GetStatsOnlineIpList()` returns only IP/last-seen data. `QueryStats()` visits ordinary counters.

Relevant upstream source:

- `app/stats/command/command.go` at `v26.3.27`

### Metrics endpoint

The stock metrics handler exports registered traffic counters. It does not expose a stable privacy-safe client-instance identity.

Relevant upstream source:

- `app/metrics/metrics.go` at `v26.3.27`

## Consequence for Free accounting

Same-credential connection multiplicity is **no longer required** for Free billing. The approved rule counts a UTC second bucket once at account level if authenticated traffic is observed in that bucket.

The repository/CI implementation therefore uses stock Xray per-user cumulative uplink/downlink counters with a conservative UTC-aligned one-second sampler:

- first valid sample establishes a baseline and creates no activity;
- positive byte delta across adjacent trusted samples marks the exact preceding UTC second bucket active;
- unchanged counters are idle and create zero activity;
- missed boundaries, excessive observation skew, failures, resets/decreases, non-monotonic time, and restart gaps break continuity and create zero inferred activity;
- active seconds are persisted as a low-60-bit per-UTC-minute bitmap in the local SQLite outbox;
- the control plane settles unseen bits transactionally and de-duplicates overlap globally by account/minute;
- no `sessionId` is fabricated.

This implementation is repository/CI verified. It is **not yet field-verified on the current VPS head**, so Phase 7 remains incomplete.

## Consequence for Premium single-active-client enforcement

Stock Xray still cannot reliably distinguish these cases for one copied credential:

1. multiple transport/application connections created by one legitimate client instance;
2. two distinct devices behind the same NAT/public IP;
3. one device whose public IP changes;
4. two devices using the same credential where only one is currently transferring bytes.

Therefore the following shortcuts remain rejected for Premium ownership enforcement:

- **source-IP lock:** NAT collapses distinct devices and mobile networks can change IPs;
- **raw connection count:** one legitimate v2rayNG instance may create multiple transport connections;
- **Xray transport/session ID:** identifies a transport connection, not a stable client instance;
- **online-IP count:** represents unique public IPs, not devices;
- **aggregate byte rate:** does not identify which client instance generated traffic;
- **access-log parsing:** is not a stable client identity and conflicts with the established privacy boundary;
- **silently issuing multiple simultaneously-active credentials:** bypasses the approved one-active-client-instance product rule.

A future Premium ownership mechanism must provide a server-verifiable, privacy-safe client-instance signal, support revocation/credential lifecycle, work across all Madar nodes, and be proven with real production-client behavior including two devices behind the same NAT.

## Xray patch/fork decision

Madar will **not** patch or fork Xray merely to expose raw connection/session counters.

Reasons:

- Free accounting no longer needs connection multiplicity;
- a raw transport-session identifier still cannot tell whether several connections belong to one device or multiple devices;
- therefore a transport counter does not solve the Premium client-instance identity requirement;
- carrying a custom Xray patch would add supply-chain and maintenance risk without satisfying the actual product rule.

The official pinned Xray binary remains preferred unless a future separately reviewed requirement genuinely cannot be met without a core change.

## Release gates

### Free accounting

Repository/CI implementation exists, but Phase 7 requires a real-VPS rerun on one exact current head proving:

- direct VLESS+REALITY traffic creates expected UTC active-second bitmap evidence and exactly-once PostgreSQL debit;
- idle open connection creates no additional active bits/debit;
- overlapping connections in the same UTC seconds do not multiply Free debit;
- reset/restart/gap creates no inferred seconds;
- Agent restart before local acknowledgement preserves the exact pending `(windowId, sequence, seconds, activeSecondsHex)` and retry settles once;
- malformed/incomplete telemetry acceptance leaves pending local evidence intact;
- current boot ordering remains fail-closed and log/outbox privacy/permissions remain correct.

Cross-node overlap de-duplication is a later multi-node field gate unless a second real node is available during the Phase 7 rerun.

### Premium concurrency

Premium single-active-client enforcement remains **unimplemented/unverified** and blocks Production Ready status. It must receive a separate approved identity/provisioning design and real v2rayNG acceptance. No IP-based or raw-connection fallback is approved.

## Forbidden claims

Until the corresponding real gates pass, do not claim:

- Phase 7 PASS;
- live active-second debit correctness on the updated VPS;
- real restart/crash durability of bitmap telemetry;
- Premium single-client/device locking;
- real v2rayNG E2E;
- Production Ready.
