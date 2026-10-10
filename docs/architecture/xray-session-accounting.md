# Xray session accounting boundary

Date: 2026-10-10
Status: **Accepted limitation / Phase 7 gate remains open**
Pinned upstream: `XTLS/Xray-core v26.3.27`

## Requirement

Madar's approved design requires distinct simultaneous VPN sessions to consume their actual combined observed usage. The design also requires one active client UUID/credential per user, so issuing a separate active UUID per device/session is not an acceptable shortcut.

The Node Agent must therefore derive usage from server-observed Xray behavior without fabricating session state.

## What stock Xray exposes

The pinned Xray source was reviewed at `v26.3.27`.

### User traffic counters

When `statsUserUplink` / `statsUserDownlink` are enabled, Xray's dispatcher attaches byte counters named by the authenticated user email. These counters are cumulative **per user**, not per connection/session.

Relevant upstream source:

- `app/dispatcher/default.go` at `v26.3.27`

Madar intentionally sets the VLESS email to `madar:<clientId>`, so these counters are suitable for conservative per-client traffic activity but do not reveal same-credential session multiplicity.

### Online map

Xray's `OnlineMap` is internally refcount-based: every `AddIP(ip)` increments an internal `refCount` for that IP and `RemoveIP(ip)` decrements it. However the stable interface exposes:

- `Count()` — number of **unique online IPs**;
- `List()` — online IPs;
- `IPTimeMap()` — IP -> last-seen time.

The per-IP connection `refCount` itself is not exposed through the stable interface.

Relevant upstream source:

- `features/stats/stats.go` at `v26.3.27`
- `app/stats/online_map.go` at `v26.3.27`

### StatsService API

`StatsService.GetStatsOnline()` returns `OnlineMap.Count()`, so it returns unique-IP count rather than total connection refs. `GetStatsOnlineIpList()` returns only IP/last-seen data. `QueryStats()` visits ordinary counters only.

Relevant upstream source:

- `app/stats/command/command.go` at `v26.3.27`

### Metrics endpoint

The stock metrics handler exports registered traffic counters. It does not expose the hidden per-IP connection ref counts.

Relevant upstream source:

- `app/metrics/metrics.go` at `v26.3.27`

## Consequence

With the official pinned binary, Madar cannot exactly distinguish these cases for one UUID:

1. one active session from one public IP;
2. two simultaneous sessions behind the same NAT/public IP;
3. multiple Xray transport/application connections created by one client instance;
4. two client instances where only one is currently transferring bytes.

Therefore the following shortcuts are rejected:

- **Multiply traffic activity by `onlineUsers`: rejected.** `onlineUsers` is not session count and can over/under-charge.
- **Treat unique online IPs as sessions: rejected.** NAT collapses independent devices/sessions.
- **Infer sessions from aggregate byte rate: rejected.** Byte volume does not reveal how many sessions produced it.
- **Re-enable Xray access logs and parse them: rejected.** The real field test already demonstrated client-identifier leakage, and access lines do not provide a reliable privacy-safe per-session active-duration primitive.
- **Issue multiple simultaneously-active client UUIDs per user: rejected.** This conflicts with the approved one-active-client-credential model and credential-rotation semantics.

## Current accepted implementation

Madar currently uses the stock per-user cumulative uplink/downlink counters with a conservative one-second delta sampler:

- positive byte delta => one observed client activity second;
- unchanged bytes => zero;
- gaps/failures/resets => no inferred seconds;
- no fabricated `sessionId`.

This is an honest server-observed activity fallback and must **not** be described as exact simultaneous-session accounting.

## Candidate exact path

If the product requirement for combined same-credential simultaneous sessions remains mandatory, the technically direct path is a **small, pinned Madar instrumentation patch to Xray** that exposes privacy-safe per-session traffic counters through a loopback-only existing stats mechanism.

Any such path must be treated as a separate security/supply-chain change and must satisfy all of the following before adoption:

1. patch an exact reviewed upstream commit/tag, never floating `main`;
2. generate server-side opaque session IDs that do not contain email, user ID, client UUID, source IP, or destination;
3. count uplink/downlink bytes per authenticated inbound session/connection without enabling access logging;
4. expose counters only on the existing loopback StatsService boundary;
5. garbage-collect closed-session counters after a bounded grace interval long enough for the Node Agent sampler to observe the final delta;
6. preserve the existing aggregate user counters for independent reconciliation;
7. reproducibly build the patched binary in CI, pin its digest, and verify the digest in the installer;
8. test ordinary VLESS, REALITY, mux/non-mux behavior and same-NAT concurrency on a real VPS;
9. prove two independent active sessions can produce two distinct `sessionId` usage streams while replay of either stream remains idempotent;
10. perform security review before replacing the official pinned binary in the installer.

This candidate is **not implemented or approved as operational** by this ADR. The immediate Phase 7 field gate remains verification of the already-implemented stock-Xray activity -> telemetry -> debit path. Exact same-credential session multiplicity remains a separate unresolved Phase 7 requirement and blocks Production Ready status.
