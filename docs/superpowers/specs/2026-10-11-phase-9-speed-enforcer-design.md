# Phase 9 — Per-Client Free Speed Enforcer Design

Date: 2026-10-11  
Status: **APPROVED**

## 1. Purpose

Phase 9 must enforce the product speed policy on real VLESS+REALITY traffic without weakening the already-proven fail-closed lifecycle.

The product rule is:

- Free: per Client, per Node, maximum **5 Mbps download** and **5 Mbps upload**, independently;
- all concurrent connections for the same Client on the same Node share those two limits;
- TCP and UDP traffic for that Client share the same per-direction limits;
- the cap is not aggregated globally across Nodes;
- Premium: no Madar-imposed application speed cap;
- the configured Free rate remains administrator-configurable; 5 Mbps is the initial value.

Phase 9 remains incomplete until the mechanism is measured on real VPS traffic. A node-wide aggregate cap, IP-based identity, or an unverified Xray-only setting is not acceptable.

## 2. Existing constraints and evidence

The accepted runtime remains Xray `26.3.27` with VLESS+REALITY. The current managed client identity is already known to Xray after VLESS authentication through the configured per-client email label.

Xray can route authenticated users using user/email-aware routing rules and can use authenticated SOCKS outbounds. Xray also supports static socket marks, but a static outbound mark does not provide a reliable two-direction per-user limiter by itself.

The selected design therefore does **not** fork Xray and does **not** treat source IP, NAT identity, online-user counters, or socket marks as the authoritative speed identity.

The existing Node policy already carries `speedKbps` per managed Client. Phase 9 does not add a second source of truth for speed. The control plane remains authoritative:

- Free default: `speedKbps = 5000`;
- Premium/no Madar cap: `speedKbps = null`.

The Agent converts the integer policy rate to limiter bytes/second using decimal networking units. Invalid policy values fail closed rather than silently becoming unlimited.

## 3. Selected architecture

A new local data-plane process runs on every Madar Node:

`madar-speed-enforcer`

Traffic paths are:

```text
Free:
v2rayNG -> Xray/VLESS/REALITY -> authenticated local SOCKS -> Speed Enforcer -> Internet

Premium:
v2rayNG -> Xray/VLESS/REALITY -> direct outbound -> Internet
```

The Speed Enforcer is implemented in Go. It is a small local authenticated SOCKS5 proxy with per-client bidirectional rate limiting for both TCP `CONNECT` and UDP `ASSOCIATE` traffic.

Reasons for a separate Go sidecar:

- no long-lived Madar fork of Xray;
- no dependency on client IP identity;
- one shared limiter can aggregate many simultaneous connections for one Client;
- data-plane throughput does not run inside the Python control Agent;
- the limiter can be independently unit/integration tested;
- Premium remains physically outside the limiting path.

## 4. Speed semantics

The policy interface remains conceptually:

```text
SpeedEnforcer.apply(client_id, speed_mbps: float | null) -> None
```

The persisted/wire policy remains `speedKbps`; the conceptual `speed_mbps` interface expresses the product boundary, not a new database field.

Semantics:

- positive configured rate: enforce that rate independently in each direction;
- `null`: no Madar-imposed cap; the Client must not be routed through the limiter;
- zero, negative, non-finite, overflowed, or otherwise invalid rates are rejected and must not produce an active policy.

For the initial Free policy:

```text
5000 Kbps = 5 Mbps = 5,000,000 bits/second = 625,000 bytes/second
```

Each Free Client on a Node owns two shared token buckets:

- upload bucket: aggregate payload bytes flowing from Xray/client side toward Internet destinations;
- download bucket: aggregate payload bytes flowing from Internet destinations back toward Xray/client side.

TCP and UDP consume the same two buckets for that Client. All simultaneous TCP connections and UDP associations authenticated as the same internal Client alias share those buckets. Opening more connections, switching to QUIC/UDP, or mixing TCP and UDP must not multiply or bypass the cap.

The limiter accounts bytes at the sidecar proxy boundary. Wire overhead outside that boundary is not part of the product speed number.

The initial burst allowance is 0.5 seconds of configured rate per direction. At 5 Mbps this is 312,500 bytes. The implementation may use an equivalent standard token-bucket formulation, but burst must remain explicitly bounded and testable.

## 5. Internal Client identity

The Speed Enforcer must not require the raw VLESS Client UUID as its protocol username or log identity.

Each Node owns a 32-byte local `speed identity secret`, generated on the VPS and stored `0600` under the Node state directory. It is never sent to the control plane.

The Agent derives deterministic internal values with domain-separated HMAC-SHA-256:

```text
alias    = HMAC(node_speed_secret, "alias-v1\0" + client_id)
password = HMAC(node_speed_secret, "password-v1\0" + client_id)
```

The encoded alias/password are used only for the local Xray-to-Sidecar SOCKS authentication boundary.

Properties:

- Client-ID rotation changes both local alias and password;
- two Nodes derive unrelated values because their Node secrets differ;
- the sidecar config contains aliases/rates and a password verifier, not raw UUIDs or recoverable plaintext SOCKS passwords;
- the Xray live config necessarily contains the local SOCKS credential required for its outbound and therefore remains root-readable `0600`, consistent with other managed secret-bearing runtime config;
- logs must never contain SOCKS passwords or raw UUIDs;
- aliases are still treated as sensitive operational identifiers and are represented in logs only through a bounded one-way fingerprint when absolutely necessary.

The exact output encoding and verifier format are implementation details fixed by tests in the implementation plan; the design requires at least 128 bits of effective alias entropy and at least 192 bits of password entropy.

## 6. Xray rendering

For each Free Client, Agent renders:

1. the existing VLESS user entry with the existing Madar user email label;
2. one logical SOCKS outbound pointing to the local Speed Enforcer listener;
3. SOCKS credentials derived for that Client;
4. one routing rule selecting that outbound by the authenticated Xray user/email identity.

Premium Clients remain on the normal direct outbound and receive no Speed Enforcer route.

The local listener is loopback-only. It must never bind a public interface.

The initial design deliberately prefers one logical outbound per Free Client over clever shared routing metadata. It is easier to verify, preserves a direct one-to-one identity boundary, and avoids introducing an Xray patch. If future scale shows configuration size is a real bottleneck, that is a later optimization and cannot weaken the Phase 9 correctness contract.

The SOCKS path must support the destination forms Xray can legitimately send for the product path: IPv4, IPv6, and domain-name destinations. UDP associations inherit the authenticated alias from their SOCKS control connection; orphan or unauthenticated UDP datagrams are dropped.

## 7. Sidecar configuration

The live sidecar configuration is a root-owned `0600` file and contains only what the sidecar requires:

```text
listener address/port
opaque alias
password verifier
upload rate
upload burst
download rate
download burst
config generation
```

No email address, account ID, Client UUID, plaintext internal SOCKS password, subscription token, Node credential, REALITY private key, or database credential belongs in this file.

The state directory is `0700`.

A candidate config is always validated before promotion. Invalid config cannot replace the current live config.

## 8. Apply ordering and atomicity

A new Node policy is not acknowledged until both the Speed Enforcer and Xray are healthy with the new revision.

The apply sequence is:

1. obtain and validate the fresh Node policy;
2. classify Clients into capped Free and uncapped Premium;
3. derive local Free aliases/credentials;
4. render Speed Enforcer candidate config;
5. run sidecar config validation;
6. atomically promote sidecar config;
7. authorize/start or restart the Speed Enforcer;
8. prove local sidecar health and loaded config generation;
9. render Xray candidate config containing the matching Free routes/outbounds;
10. run Xray config validation;
11. atomically promote Xray config;
12. authorize/start or restart Xray using the existing lifecycle boundary;
13. prove Xray health and Sidecar health together;
14. only then ACK the policy revision.

If any step fails after policy fetch, the new revision is not acknowledged.

A brief interruption while switching revisions is acceptable. An uncapped Free fallback is not.

## 9. Fail-closed behavior

### Sidecar unavailable before apply

A Free policy is not promoted into Xray until the sidecar is healthy. A new Free Client must never be routed directly merely because the limiter failed to start.

### Sidecar crash after apply

Free Xray routes still target the loopback sidecar. If it crashes, those Free flows fail rather than falling back to the direct outbound.

There is no automatic routing fallback from a Free per-user SOCKS outbound to `direct` for either TCP or UDP.

Premium flows are not routed through the sidecar and may continue on the direct outbound while Agent remains alive.

### Node readiness

If the sidecar is required by the current policy and is unhealthy, Agent reports the Node as not ready. The control plane therefore excludes it from new subscription output.

For Phase 9, readiness remains conservatively node-wide rather than tier-aware. This may temporarily hide the Node from Premium subscription refreshes too. The simpler fail-safe behavior is preferred over a more complicated tier-specific readiness model.

If a current policy contains no capped Clients, sidecar unavailability does not by itself make the Node unready; there is no Free limiter dependency to satisfy for that revision.

### Agent crash/restart/reboot

The existing lifecycle invariant remains:

`Agent alive + fresh authorization => managed runtime may serve`

The new sidecar joins that invariant. Persisted config alone is never authorization.

On Agent death, restart uncertainty, or reboot before fresh authorization:

- Xray must not serve stale managed access;
- Speed Enforcer must not independently become an authorized managed service;
- old ephemeral authorization markers disappear;
- startup first proves both managed data-plane processes inactive before accepting fresh policy.

## 10. systemd lifecycle

A new native unit is introduced:

`madar-speed-enforcer.service`

It follows the same fail-closed philosophy as the current Xray unit:

- managed by the Agent lifecycle, not an independently useful boot service;
- loopback listener only;
- restrictive filesystem permissions;
- bounded restart policy;
- no secret values in command-line arguments;
- no automatic public fallback;
- stopped when the Agent lifecycle is lost.

The implementation plan will choose the exact unit relationships after testing them against the current native lifecycle. The required outcome is behavioral, not tied to a specific systemd directive: killing/stopping Agent must leave both Xray and the Speed Enforcer unable to provide stale managed access.

The sidecar must use an ephemeral authorization marker owned by the Agent runtime directory or an equivalent mechanism with the same reboot/restart semantics. A persisted sidecar config is never enough to authorize startup.

## 11. Rotation and tier transitions

### Client ID rotation

The new alias/rate entry is prepared in the sidecar before Xray begins routing the new UUID to it. Xray then switches to the new Client credential. Old sidecar identity is removed after the old Xray credential is no longer active.

There must be no uncapped transition window.

### Free -> Premium

The effective policy switch happens when the new Xray config is promoted. Before that moment the previous Free policy may remain capped. After promotion Premium routes direct and has no Madar cap.

A short period of remaining capped service during policy application is acceptable; a period of unauthorized uncapped Free service is not.

### Premium -> Free

The Free sidecar identity and limiter are made healthy before Xray switches the Client from direct to the capped route. The revision is acknowledged only after the capped route is healthy.

### Removal/suspension

A suspended or removed Client is not represented as an enabled sidecar identity and is removed from Xray using the existing policy/revocation behavior.

## 12. Health model

Sidecar health is not merely “process exists”. A valid health check must prove:

- process is active;
- expected loopback listener is reachable;
- the process loaded the current promoted config generation;
- TCP and UDP proxy capability initialized successfully when capped Clients are configured;
- the health mechanism does not expose credentials or Client aliases publicly.

Preferred implementation: a root-only Unix-domain health/control socket or an equivalent local mechanism. A public HTTP health endpoint is not allowed.

The health check does not need to create Internet traffic on every heartbeat.

## 13. Logging and privacy

Allowed operational log fields include:

- config generation;
- number of configured capped Clients;
- listener state;
- aggregate TCP/UDP connection or association counts;
- categorized errors;
- bounded one-way alias fingerprint when necessary for debugging.

Forbidden log fields include:

- raw Client UUID;
- full internal SOCKS username/alias;
- internal SOCKS password;
- subscription URL/token;
- Node credential;
- REALITY private key;
- raw per-user traffic payload.

Access payload contents are never logged.

## 14. Resource and abuse boundaries

The sidecar must have explicit safety limits:

- bounded SOCKS handshake size/time;
- authenticated clients only;
- bounded per-connection buffers;
- bounded UDP association lifetime/state;
- TCP connection deadlines appropriate for proxying;
- no unauthenticated open proxy behavior;
- no listening outside loopback;
- no DNS/control endpoint exposed publicly;
- graceful rejection of unknown aliases;
- orphan UDP datagrams dropped;
- limiter state removed when config no longer contains an alias.

The implementation must avoid one goroutine/task per byte-chunk or other unbounded scheduling patterns. Normal Go connection-per-goroutine proxying plus bounded UDP association workers is acceptable if connection/resource tests remain bounded.

## 15. Automated verification

Implementation uses TDD.

Required repository coverage includes at least:

- independent upload/download token buckets;
- TCP and UDP for one alias share the same directional buckets;
- all concurrent connections for one alias share one cap;
- two different aliases have independent caps;
- invalid/unknown SOCKS authentication is rejected;
- orphan/unauthenticated UDP is rejected;
- IPv4, IPv6, and domain destination parsing;
- Premium/null does not create a limiter entry or Free route;
- `speedKbps` conversion uses decimal networking units and rejects invalid values;
- deterministic alias derivation is domain-separated and never emits raw UUID;
- sidecar stores only a password verifier, while Xray secret-bearing config remains `0600`;
- candidate validation before live promotion;
- config permissions and state permissions;
- Xray renderer creates user-aware Free routes and leaves Premium direct;
- no Free TCP or UDP direct fallback exists;
- Client-ID rotation ordering;
- Free->Premium and Premium->Free ordering;
- sidecar failure marks Node not ready when current policy requires Free limiting;
- a policy with zero capped Clients does not require sidecar readiness;
- Agent startup/restart/reboot lifecycle leaves both managed processes closed before fresh authorization;
- security scan/log tests reject secret leakage.

Full repository CI remains required.

## 16. Real VPS acceptance

Repository tests cannot close Task 30.

Real field acceptance must use real VLESS+REALITY traffic and a network path whose measured uncapped baseline is clearly above the configured 5 Mbps limit.

For quantitative Free checks, discard an initial warm-up of at least 5 seconds and measure a sustained interval of at least 30 seconds.

Required checks:

1. Uncapped/Premium baseline is materially above the Free acceptance band in the direction being judged; target at least 8 Mbps sustained where the environment permits.
2. Free sustained TCP download is near configured 5 Mbps.
3. Free sustained TCP upload is near configured 5 Mbps.
4. Simultaneous TCP upload + download each independently remain near 5 Mbps; they must not share one combined 5 Mbps bucket.
5. Multiple parallel TCP connections for one Free Client do not multiply throughput.
6. A second Free Client/account on the same Node receives its own independent per-client cap.
7. Controlled Free UDP traffic is rate-limited by the same Client policy and cannot bypass the cap; sustained application goodput must not materially exceed the configured cap after burst allowance. UDP is not required to hit a lower-bound throughput target because packet loss/jitter may reduce goodput.
8. Premium on the same Node is not pinned near the Free cap and follows the available network baseline, demonstrating no Madar software cap.
9. Sidecar stop/crash causes Free TCP and UDP traffic to fail, not become uncapped.
10. Sidecar unhealthy state removes Node readiness/subscription eligibility until recovery when capped Clients are present.
11. Restart/reboot behavior preserves the existing fail-closed invariant.
12. No forbidden secret appears in bounded journals/config evidence.

For the default 5 Mbps TCP field run, the sustained acceptance band is **4.5–5.5 Mbps per direction**, provided the uncapped baseline is materially above that range. Short startup bursts are evaluated separately because the design intentionally permits a bounded 0.5-second burst.

If the VPS/network baseline is too low to distinguish a 5 Mbps limiter from ordinary network congestion, the test is inconclusive, not PASS.

## 17. Interaction with Task 29 multi-node acceptance

Task 29 and Task 30 remain separate evidence gates but can share one field session.

The second real Node required by Task 29 may also provide a controlled throughput endpoint for the first Node, then roles may be reversed. This minimizes external field work without changing either acceptance rule.

Cross-node Free accounting remains account-global as already designed. Speed limiting is intentionally **per Client per Node**, not globally aggregated between Nodes.

A user using the same credential on two Nodes at once can therefore receive up to the configured cap independently on each Node. Preventing multi-device/multi-node concurrent use is a separate product mechanism and is not implemented by the speed limiter.

## 18. Explicit non-goals

This design does not:

- enforce a global account-wide 5 Mbps budget across Nodes;
- implement Premium single-device/session locking;
- infer device identity from IP;
- modify Free active-second accounting semantics;
- fork or patch Xray;
- use a node-wide `tc` cap as a substitute for per-client enforcement;
- add production email, ads, payments, or push providers;
- claim Production Ready.

## 19. Phase 9 completion rule

Task 30 is PASS only when:

- the sidecar and Agent/Xray integration are covered by green repository tests;
- full CI is green on the exact deployed code;
- real sustained Free throughput demonstrates the configured per-client per-node cap independently in both directions;
- parallel connections cannot multiply the cap;
- UDP cannot bypass the cap;
- Premium demonstrates no Madar application cap;
- Free fails closed if the limiter is unavailable;
- cleanup leaves no test credentials or temporary instrumentation active.

Phase 9 itself is PASS only when both Task 29 multi-node acceptance and Task 30 speed-enforcement acceptance are PASS.

Until then:

- Phase 9: **INCOMPLETE**;
- Premium single-active-client/device enforcement remains separate;
- Production Ready is not claimed.
