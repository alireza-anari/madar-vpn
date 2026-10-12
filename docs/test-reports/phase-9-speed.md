# Phase 9 — speed enforcement acceptance

Date: 2026-10-12  
Status: **FIELD PASS — Task 30 real acceptance complete on the exact deployed CI-green runtime; final documentation CI for this evidence commit is pending.**

## Scope

Task 30 proves that Madar enforces the configured Free speed policy on real VLESS+REALITY traffic without weakening the existing fail-closed Node lifecycle.

The accepted product contract is:

- Free speed is enforced **per Client per Node**;
- the initial policy value is `speedKbps = 5000`, equal to exactly `625000` payload bytes/second independently for upload and download;
- each direction has a bounded 0.5-second burst (`312500` bytes at 5 Mbps);
- all simultaneous TCP connections and UDP associations for one Client share the same two directional limiter buckets;
- Premium has `speedKbps = null`, does not traverse the Madar speed sidecar, and has no Madar-imposed application speed cap;
- Xray remains pinned to `26.3.27` and is not forked or patched;
- Free has no TCP or UDP fallback to Xray `direct` if the limiter is unavailable.

## Exact field build

The real field session was frozen on the exact CI-green runtime below even though the working branch later advanced with unrelated staging/email/security-test changes:

- deployed repository SHA: `07179e48f0447782745673bb17e1f1fb4867aa13`;
- GitHub Actions CI run: `38166200895` — success;
- Xray: `26.3.27`;
- deployed static Speed Enforcer SHA-256 on both Nodes: `a976df89c4fc99fb8d2f1e03498b906b8734ba0c9e20d8fc50d7c6902ba2f116`;
- Speed Enforcer systemd unit source blob used in the field: `7a540c2e0b4855f37cb38e1d4d028f44f9e9d0df`.

Both VPS installations were checked against the exact field source/unit artifacts before acceptance work continued. The sidecar service includes strict filesystem hardening plus the required writable `/run/madar-node-agent` path for its private health socket.

## Architecture exercised

Free traffic used the real path:

```text
VLESS+REALITY -> Xray authenticated user route -> authenticated loopback SOCKS5 -> madar-speed-enforcer -> origin
```

Premium used the default Xray `direct` outbound and did not require the speed sidecar.

Policy apply exercised the implemented two-phase fail-closed ordering: stage sidecar membership, prove sidecar health, switch Xray, prune the sidecar, prove final runtime health, and only then ACK the revision.

## Real quantitative evidence

All judged Free TCP measurements discarded at least 5 seconds of warm-up and measured at least 30 seconds sustained.

| Scenario | Result |
| --- | --- |
| Premium/uncapped download baseline | `20.002 Mbps` |
| Premium/uncapped upload baseline | `19.993 Mbps` |
| Premium duplex | `20.002 / 20.002 Mbps` |
| Free download | `5.000 Mbps` |
| Free upload | `5.007 Mbps` |
| Free duplex | `5.000 / 4.999 Mbps` |
| Three parallel TCP connections, same Free Client | `4.993 Mbps` aggregate |
| Two distinct Free Clients simultaneously | `5.000 Mbps` each |
| Authenticated Free UDP, controlled 20 Mbps source | `5.000 Mbps`, 15,625 measured packets |

The controlled Premium baseline was therefore materially above the Free acceptance band and distinguished the software cap from ordinary network congestion.

### Premium bypass proof

A dedicated final Premium-only rerun closed the explicit sidecar-counter requirement:

- the Premium policy revision was ACKed with exactly one Premium Client;
- `madar-speed-enforcer.service` remained inactive because there were zero capped Clients;
- the production Xray render contained `0` SOCKS speed outbounds for the Premium-only policy;
- real VLESS+REALITY Premium traffic exceeded `8 Mbps`;
- the maximum established connection count observed on the Speed Enforcer listener during that Premium transfer was `0`;
- the resulting safe assertion was `PREMIUM_BYPASS_COUNTER_PASS=True`.

The first disposable self-connect attempt used the Node's public endpoint and timed out. Diagnostics proved public self-connect TCP/443 was unavailable from that EC2 instance while its private interface TCP/443 was reachable. Only the **disposable client test config** was retargeted to the private address; production configuration was not changed. The rerun then passed.

## Failure and recovery evidence

### Sidecar stop while Free TCP active

During an active capped Free TCP flow, the sidecar was stopped deliberately. The existing flow closed in about 7 seconds. Xray and the Agent remained running, but Node readiness/eligibility failed closed; the affected Node disappeared from the real subscription while the healthy second Node remained. After sidecar recovery and a fresh healthy policy cycle, the Node returned and real traffic worked again.

### Sidecar crash / restart

The sidecar process was sent `SIGKILL` while Free traffic was active. The flow closed in about 7 seconds. systemd restarted the sidecar under its `Restart=on-failure` policy and a new process became healthy. No uncapped Free fallback was observed.

### UDP fail-closed

Authenticated UDP was active before the fault. Safe packet evidence around a deliberate sidecar stop was:

```text
UDP_PRE_FAULT_PACKETS=776
UDP_FAULT_GRACE_PACKETS=70
UDP_POST_GRACE_PACKETS=0
UDP_POST_GRACE_NONZERO_BUCKETS=0
UDP_FAIL_CLOSED=True
```

Thus traffic present before the fault ceased after the bounded grace period rather than bypassing the limiter.

### Agent stop / crash / reboot

- stopping the Agent made Agent, Xray and Speed Enforcer inactive and removed runtime authorization markers;
- normal Agent start restored authorized children;
- `SIGKILL` of the Agent immediately left Xray/Speed unauthorized/inactive and a later Agent restart restored them only after authorization;
- a real Node reboot preserved the same invariant.

On the first post-reboot apply attempt, the journal recorded Speed Enforcer readiness before Xray, followed by a sidecar health-verification failure. The runtime failed closed, stopped managed children, restarted the Agent, and the second apply cycle recovered. This is retained as an explicit acceptance caveat: reboot recovery was not a single clean first attempt, but the failure path remained fail-closed and automatic retry recovered without exposing uncapped Free traffic.

## Privacy evidence

The field session retained only secret-safe evidence.

Control-plane audit found no stored Node credential or REALITY private-key leak. A full-session bounded journal scan on Node1 checked 14 known secret/Client values and found `0` matches. Node2 checked its locally available secret values and found `0` exact matches, `0` raw UUID-shaped journal matches, and `0` secret-field/value matches. No raw Client UUID, full opaque alias, plaintext SOCKS password, subscription bearer, Node credential, REALITY private key, or traffic payload was intentionally recorded in this report.

Safe evidence files retained on the field host include:

- `phase9-throughput-safe.jsonl`;
- `phase9-udp-safe.jsonl`;
- `phase9-subscription-safe.jsonl`.

## Cleanup and terminal field state

Cleanup completed without deleting either retained VPS:

- all three Phase 9 field Client credentials were revoked;
- all three Phase 9 field subscription tokens were revoked;
- the unrelated pre-existing active credential was preserved;
- temporary throughput, overlap, UDP and Premium harness files/listeners were removed;
- no test listener remained on the temporary ports used during acceptance;
- Node1 final empty policy revision `31` was ACKed with `clients=0`;
- Node2 final empty policy revision `5` was ACKed with `clients=0`;
- both Agents and Xray services remained active and both Nodes were `ready` with fresh heartbeats;
- Speed Enforcer was inactive on both Nodes, which is expected with zero capped Clients;
- Node1 and Node2 telemetry outbox pending counts were `0`;
- unexplained `unmapped` telemetry was `0` reports / `0` seconds;
- historical journals and sanitized evidence were retained;
- both VPSs were retained as requested.

## Task 30 acceptance checklist

- [x] Static Linux sidecar built from the exact approved SHA and checksum recorded.
- [x] Exact sidecar binary deployed and checksum verified on both VPSs.
- [x] Controlled Premium/uncapped baseline materially above the Free band.
- [x] Quantitative Free TCP used >=5 s warm-up and >=30 s measurement.
- [x] Free TCP download within 4.5–5.5 Mbps.
- [x] Free TCP upload within 4.5–5.5 Mbps.
- [x] Duplex upload/download independently stayed within the acceptance band.
- [x] Parallel TCP connections for one Free Client did not multiply throughput.
- [x] Two distinct Free Clients received independent per-Client caps.
- [x] Authenticated UDP could not materially exceed the configured cap.
- [x] Premium tracked the uncapped baseline and explicit sidecar connection counter stayed zero.
- [x] Sidecar stop/crash caused Free TCP/UDP failure instead of uncapped fallback.
- [x] Sidecar failure removed Node readiness/subscription eligibility while capped Clients existed.
- [x] Agent stop/SIGKILL/reboot preserved fail-closed managed-runtime authorization.
- [x] Bounded journal/config privacy scans found no prohibited secret evidence.
- [x] Test credentials/policies/harnesses cleaned up; outboxes and unmapped telemetry ended at zero.

## Gate state

- Task 30 field acceptance: **PASS**.
- Task 29 field acceptance: see `phase-9-multinode.md` — **PASS**.
- Phase 9 field requirements: **PASS**.
- Final Phase 9 repository completion claim: **pending the full CI run triggered by the documentation evidence commit containing this report**.
- Production Ready: **not claimed**; Phase 10 remains a separate gate.
