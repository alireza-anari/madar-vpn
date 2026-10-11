# Phase 9 — speed enforcement acceptance

Date: 2026-10-11  
Status: **PREPARED — repository implementation verification in progress; real Task 30 field execution pending.**

## Scope

Task 30 proves that Madar enforces the configured Free speed policy on real VLESS+REALITY traffic without weakening the existing fail-closed Node lifecycle.

The product contract is:

- Free speed is enforced **per Client per Node**;
- the initial policy value is `speedKbps = 5000`, equal to exactly `625000` payload bytes/second independently for upload and download;
- each direction has a bounded 0.5-second burst (`312500` bytes at 5 Mbps);
- all simultaneous TCP connections and UDP associations for one Client share the same two directional limiter buckets;
- Premium has `speedKbps = null`, does not traverse the Madar speed sidecar, and has no Madar-imposed application speed cap;
- Xray remains pinned to `26.3.27` and is not forked or patched;
- Free has no TCP or UDP fallback to Xray `direct` if the limiter is unavailable.

Task 30 cannot PASS from repository tests alone. Real sustained VPS throughput evidence is mandatory.

## Architecture under test

The Free traffic path is:

```text
v2rayNG -> Xray/VLESS/REALITY -> authenticated loopback SOCKS5 -> madar-speed-enforcer -> Internet
```

Premium remains:

```text
v2rayNG -> Xray/VLESS/REALITY -> direct -> Internet
```

The sidecar listens only on loopback, authenticates with Node-local opaque per-Client aliases/passwords, stores only password verifiers in its own config, and uses one shared upload bucket plus one shared download bucket per alias across TCP and UDP.

The Node Agent applies transitions fail-closed using two-phase sidecar membership:

1. validate the complete candidate policy before runtime side effects;
2. apply `current_free ∪ candidate_free` to the sidecar;
3. prove the staged sidecar generation healthy;
4. switch Xray to the candidate policy using only candidate Free route credentials;
5. prune sidecar membership to `candidate_free` only;
6. prove final Xray + sidecar health;
7. only then commit the candidate revision / become ACK-eligible.

A failed stage or final prune closes managed access rather than leaving a Free Client uncapped. An invalid candidate does not disturb a currently valid authorized runtime.

## Repository evidence

Automated coverage includes:

- strict sidecar configuration parsing, loopback listener validation and bounded numeric rate fields;
- independent upload/download token buckets with shared per-alias state and race-detector coverage;
- authenticated SOCKS5 TCP `CONNECT` for IPv4, IPv6 and domain destinations;
- authenticated UDP `ASSOCIATE`, malformed/fragment/orphan rejection, bounded association target state and idle expiry;
- shared TCP/UDP limiter budgets so protocol mixing cannot multiply the configured cap;
- private Unix-socket health response containing only generation/readiness;
- deterministic Node-local opaque identity derivation and password verifiers without raw Client UUIDs/plaintext sidecar passwords;
- sidecar candidate validation/promotion and private `0600` files;
- per-Free-client Xray SOCKS routes while Premium remains direct;
- no Free direct fallback routing rule;
- two-phase Client-ID rotation and Free/Premium transition ordering;
- sidecar/Xray rollback, final-prune failure behavior and revision retry semantics;
- independent systemd authorization markers and fail-closed startup/shutdown for both managed child runtimes;
- combined Node readiness when capped Clients require the sidecar;
- security/log assertions and existing Phase 7 accounting/lifecycle regressions;
- CI Go race tests, `go vet`, and a static `CGO_ENABLED=0` Linux build gate;
- repository build helper `scripts/build-speed-enforcer.sh` restricted to supported Linux `amd64` / `arm64` targets.

Exact CI-green Task 8 implementation SHA and workflow run are intentionally recorded only after the implementation head is green. This report will then be updated once with that evidence; the documentation-only head will receive its own final CI run.

## Required real field evidence

Task 30 remains **INCOMPLETE** until one documented field session proves all items below on exact CI-green deployed code:

- [ ] Build the static Linux sidecar from the exact approved repository SHA and record its SHA-256.
- [ ] Copy the binary root-owned to `/opt/madar-speed-enforcer/madar-speed-enforcer` on each disposable test Node and verify the deployed checksum exactly matches.
- [ ] Establish a controlled uncapped/Premium baseline materially above the Free acceptance band; target at least 8 Mbps sustained in each quantitatively judged direction where the network permits.
- [ ] For quantitative Free TCP measurements, discard at least 5 seconds of warm-up and measure at least 30 seconds sustained.
- [ ] Prove Free TCP download is 4.5–5.5 Mbps.
- [ ] Prove Free TCP upload is 4.5–5.5 Mbps.
- [ ] Prove simultaneous upload and download each independently remain 4.5–5.5 Mbps rather than sharing one combined 5 Mbps budget.
- [ ] Prove multiple parallel TCP connections for one Free Client do not multiply throughput.
- [ ] Prove a second distinct Free Client/account on the same Node receives its own independent approximately-5-Mbps cap rather than sharing a node-wide bucket.
- [ ] Prove controlled authenticated UDP traffic cannot materially exceed the configured cap after burst allowance; no lower-bound UDP target is required because loss/jitter may reduce goodput.
- [ ] Prove Premium on the same Node bypasses the sidecar and tracks the available baseline rather than clustering near 5 Mbps.
- [ ] Stop/crash the sidecar while Free traffic is active and prove Free TCP and UDP fail instead of becoming uncapped; Premium direct traffic may remain.
- [ ] Prove sidecar failure while capped Clients exist makes Node readiness/accepting false and removes subscription eligibility until healthy recovery.
- [ ] Prove Agent stop/SIGKILL and reboot preserve the fail-closed invariant for both Xray and the sidecar.
- [ ] Prove bounded journals/config evidence contains no raw Client UUID, full opaque alias, plaintext SOCKS password, subscription bearer, Node credential, REALITY private key or traffic payload.

If the available network baseline cannot distinguish a 5 Mbps software limit from ordinary network congestion, the quantitative result is **INCONCLUSIVE**, not PASS.

## Task 29 interaction

Task 29 multi-node acceptance remains a separate real-field gate documented in `docs/test-reports/phase-9-multinode.md`. The two field gates may share one session, but neither substitutes for the other.

Speed limiting is intentionally per Client per Node. Account-global active-second accounting remains a separate cross-node de-duplication mechanism.

## Evidence privacy rules

Do not record enrollment tokens, Node credentials, raw Client UUIDs, subscription bearer URLs/tokens, REALITY private keys, session/CSRF values, plaintext local SOCKS passwords, full opaque aliases or raw traffic payloads.

Safe evidence may contain versions, aggregate counts, timestamps, throughput values, process states, non-secret node labels and one-way fingerprints when comparison is necessary.

## Cleanup requirements

The field session must end with:

- test policies/credentials revoked or returned to the intended retained state;
- temporary throughput tooling/harnesses removed;
- pending telemetry outbox count `0`;
- unexplained `unmapped` activity `0`;
- no temporary authorization/debug instrumentation left active;
- historical journals retained for later diagnosis;
- disposable VPSs retained unless explicitly requested otherwise.

## Current gate state

- Task 29: **INCOMPLETE — real two-node field acceptance pending**.
- Task 30: **INCOMPLETE — real speed-enforcement field acceptance pending**.
- Phase 9: **INCOMPLETE**.
- Production Ready: **not claimed**.
