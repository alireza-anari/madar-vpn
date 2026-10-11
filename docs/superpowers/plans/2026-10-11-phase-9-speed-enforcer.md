# Phase 9 Speed Enforcer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a fail-closed, per-Client-per-Node Free speed limiter that caps upload and download independently at the policy rate (initially 5 Mbps each), leaves Premium uncapped by Madar, supports TCP and UDP, and is proven on real VLESS+REALITY traffic.

**Architecture:** A new Go process, `madar-speed-enforcer`, is a loopback-only authenticated SOCKS5 proxy with shared per-alias upload/download token buckets. The Python Node Agent derives opaque local SOCKS identities from a Node-local secret, starts and health-checks the sidecar before rendering Xray Free routes to it, and keeps Premium on Xray's direct outbound. Policy apply and systemd lifecycle remain fail-closed: a Free Client never falls back to direct traffic if the limiter is absent or broken.

**Tech Stack:** Go 1.24.x standard library only for the sidecar; Python 3.12 for Agent orchestration; Xray-core 26.3.27; systemd; pytest; GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-11-phase-9-speed-enforcer-design.md`

## Global Constraints

- Free speed is **per Client per Node**, not globally aggregated across Nodes.
- Default Free policy is `speedKbps = 5000`, meaning exactly `625000` payload bytes/second in each direction using decimal networking units.
- Upload and download limits are independent; each uses a burst equal to 0.5 seconds of configured rate.
- TCP and UDP for the same Client share the same two directional buckets.
- All simultaneous connections/associations for one Client on one Node share the same buckets; parallelism must not multiply throughput.
- Premium has `speedKbps = null` and no Madar-imposed application speed cap; Premium must not traverse the sidecar.
- Xray remains pinned to `26.3.27`; do not fork or patch Xray.
- Source IP/NAT identity is never the authoritative speed identity.
- `speedKbps` remains the only control-plane source of truth for speed; do not add a second database field.
- The sidecar listener is loopback-only; the health endpoint is a root-only Unix-domain socket, never public HTTP.
- The sidecar config stores opaque aliases and password verifiers, never raw Client UUIDs or plaintext SOCKS passwords.
- The Xray secret-bearing live config remains root-readable `0600` and may contain the local SOCKS credential Xray must present.
- Node state directories remain `0700`; secret-bearing files remain `0600`.
- Persisted config alone is never authorization; both Xray and the sidecar require ephemeral Agent-owned runtime authorization markers.
- If the current policy contains capped Free Clients and the sidecar is unhealthy, Node readiness is false.
- If the current policy contains zero capped Clients, sidecar unavailability alone does not make the Node unready.
- Free TCP or UDP must never fall back to the Xray `direct` outbound when the sidecar fails.
- Client-ID rotation, Free→Premium, Premium→Free, removal, restart, crash and reboot must preserve fail-closed behavior.
- No secrets or raw per-user payloads may be emitted to logs, CI, reports or screenshots.
- Task 30 cannot PASS from repository tests alone; real sustained VPS throughput evidence is mandatory.
- Phase 9 cannot PASS until both Task 29 multi-node acceptance and Task 30 speed-enforcement acceptance PASS.
- Production Ready is not claimed by this plan.

## Review Focus

- **Very low or very high `speedKbps`:** reject zero/negative/overflowing values; positive values must convert exactly to `speedKbps * 125` bytes/sec without float rounding. Task 5 owns these tests.
- **UDP association abuse/stale state:** fragmented, orphaned, unauthenticated or expired UDP traffic must be dropped and association state must stay bounded. Task 3 owns these tests.
- **Sidecar succeeds but Xray promotion fails:** the system may interrupt service but must close managed access rather than leave Free uncapped or ACK the revision. Task 7 owns this test.
- **Sidecar crash after a successful apply:** existing Free routes must fail, Premium direct traffic may remain, and Node readiness must become false while capped Clients exist. Task 7 owns this test.
- **Identity/config leakage:** sidecar config, health responses and logs must not contain raw UUIDs or plaintext SOCKS passwords; Xray config permissions must remain `0600`. Tasks 4–6 own these tests.

---

## File Structure

New Go sidecar:

- `speed-enforcer/go.mod` — standalone standard-library-only Go module.
- `speed-enforcer/cmd/madar-speed-enforcer/main.go` — CLI, signal handling and process assembly.
- `speed-enforcer/internal/config/config.go` — JSON schema, strict validation and verifier checking helpers.
- `speed-enforcer/internal/limit/bucket.go` — deterministic token bucket primitive.
- `speed-enforcer/internal/limit/registry.go` — shared per-alias upload/download limiter registry.
- `speed-enforcer/internal/socks/address.go` — bounded SOCKS address parsing/encoding.
- `speed-enforcer/internal/socks/server.go` — SOCKS5 negotiation, RFC1929 auth and TCP `CONNECT` proxying.
- `speed-enforcer/internal/socks/udp.go` — authenticated UDP `ASSOCIATE` relay and bounded association state.
- `speed-enforcer/internal/health/server.go` — root-only Unix-socket generation/ready response.
- Tests live beside the package they exercise.

Agent/runtime integration:

- `node-agent/madar_agent/speed.py` — Node-local identity derivation, sidecar config rendering, validation/promotion and health adapter.
- `node-agent/madar_agent/models.py` — local `SpeedRouteCredential` runtime type only; no new wire/database model.
- `node-agent/madar_agent/xray.py` — Free user-aware SOCKS outbounds/routes and Premium direct behavior.
- `node-agent/madar_agent/agent.py` — validate policy first, sidecar-before-Xray apply ordering and atomic ACK boundary.
- `node-agent/madar_agent/lifecycle.py` — generic tested managed-systemd lifecycle plus Xray/Speed wrappers without weakening existing Xray semantics.
- `node-agent/madar_agent/service.py` — construct both runtimes, combined readiness and startup shutdown ordering.
- `node-agent/systemd/madar-speed-enforcer.service` — native fail-closed sidecar unit.
- Existing focused pytest files plus new `node-agent/tests/test_speed.py` cover integration boundaries.

Build/evidence:

- `.github/workflows/ci.yml` — Go setup, race tests, vet and reproducible Linux build.
- `scripts/build-speed-enforcer.sh` — exact static Linux build helper for field deployment; no committed binary.
- `docs/test-reports/phase-9-speed.md` — Task 30 repository/field evidence.
- Existing `docs/test-reports/phase-9-multinode.md` remains Task 29 evidence.

Installer packaging of a published sidecar release asset remains owned by Phase 10 Task 32. Phase 9 field deployment uses a static binary built from the exact CI-green repository SHA and copies it root-owned to the retained disposable VPS; this does not claim installer/recovery acceptance.

---

### Task 1: Go config model and shared directional token buckets

**Files:**
- Create: `speed-enforcer/go.mod`
- Create: `speed-enforcer/internal/config/config.go`
- Create: `speed-enforcer/internal/config/config_test.go`
- Create: `speed-enforcer/internal/limit/bucket.go`
- Create: `speed-enforcer/internal/limit/bucket_test.go`
- Create: `speed-enforcer/internal/limit/registry.go`
- Create: `speed-enforcer/internal/limit/registry_test.go`

**Interfaces:**
- Produces: `config.Load(path string) (Config, error)` and `config.Parse([]byte) (Config, error)`.
- Produces: `limit.NewRegistry(config Config, clock Clock) (*Registry, error)`.
- Produces: `(*Registry).WaitUpload(ctx context.Context, alias string, payloadBytes int) error` and matching `WaitDownload`.
- Later tasks consume aliases already authenticated by SOCKS; registry does not know UUIDs.

- [ ] **Step 1: Write failing config tests**

Cover exact acceptance: `Generation > 0`; listener must be `127.0.0.1:<1..65535>` or `[::1]:<port>`; health socket must be an absolute Unix path; aliases unique/non-empty; verifier exactly lowercase 64-char SHA-256 hex; rates/bursts positive; unknown JSON fields rejected; duplicate aliases rejected; config with zero clients is valid.

- [ ] **Step 2: Run config tests and confirm RED**

Run: `cd speed-enforcer && go test ./internal/config -run Test -v`

Expected: FAIL because config package/types do not exist.

- [ ] **Step 3: Implement strict config types and parsing**

Use only `encoding/json`, `net`, `path/filepath`, `regexp/encoding/hex` or equivalent standard-library helpers. `json.Decoder.DisallowUnknownFields()` is required. Define explicit upload/download bytes-per-second and burst-byte fields rather than a float rate.

- [ ] **Step 4: Write failing token-bucket tests**

Tests must prove: initial burst is bounded; refill follows injected monotonic clock; upload and download are independent; two calls for one alias share budget; two aliases do not share budget; canceled context exits; unknown alias fails; request size larger than burst is chunkable by caller but rejected by a single wait call rather than silently bypassing rate.

- [ ] **Step 5: Run limiter tests and confirm RED**

Run: `cd speed-enforcer && go test ./internal/limit -run Test -v`

Expected: FAIL because bucket/registry are absent.

- [ ] **Step 6: Implement the minimal concurrency-safe limiter**

Implement a mutex-protected token bucket with an injectable clock/timer abstraction. Do not add third-party dependencies. Registry owns one upload bucket and one download bucket per alias for the whole process so all TCP/UDP workers share them.

- [ ] **Step 7: Run Task 1 tests**

Run: `cd speed-enforcer && go test -race ./internal/config ./internal/limit`

Expected: PASS with race detector clean.

- [ ] **Step 8: Commit**

```bash
git add speed-enforcer
git commit -m "feat: add speed limiter core"
```

---

### Task 2: Authenticated SOCKS5 TCP CONNECT path

**Files:**
- Create: `speed-enforcer/internal/socks/address.go`
- Create: `speed-enforcer/internal/socks/address_test.go`
- Create: `speed-enforcer/internal/socks/server.go`
- Create: `speed-enforcer/internal/socks/server_test.go`

**Interfaces:**
- Consumes: Task 1 `limit.Registry`.
- Produces: `socks.NewServer(cfg config.Config, registry *limit.Registry, dial DialFunc, log Logger) *Server`.
- Produces: `(*Server).Serve(listener net.Listener) error`.
- TCP auth yields only the opaque alias; no UUID-aware API exists in Go.

- [ ] **Step 1: Write failing address-parser tests**

Assert IPv4, IPv6 and domain ATYP parsing/encoding; reject zero-length domain, oversized domain, unsupported ATYP, truncated frames and invalid port.

- [ ] **Step 2: Run and confirm RED**

Run: `cd speed-enforcer && go test ./internal/socks -run 'Test.*Address' -v`

Expected: FAIL because parser is absent.

- [ ] **Step 3: Implement bounded SOCKS address parsing**

Read exact RFC1928 lengths; do not allocate from an untrusted length above protocol bounds.

- [ ] **Step 4: Write failing auth/TCP proxy tests**

Use in-process loopback echo/origin fixtures. Assert: only username/password method `0x02` is accepted; no-auth is rejected; unknown alias/wrong password rejected using verifier; valid auth can `CONNECT` IPv4/domain/IPv6; upload waits on upload bucket; response bytes wait on download bucket; two simultaneous connections for one alias consume the same registry budget; different aliases proceed independently; `BIND` is rejected; handshake has a bounded timeout; log capture contains neither alias nor password.

- [ ] **Step 5: Run and confirm RED**

Run: `cd speed-enforcer && go test ./internal/socks -run 'Test.*(Auth|Connect|TCP)' -v`

Expected: FAIL on missing server behavior.

- [ ] **Step 6: Implement RFC1928/RFC1929 negotiation and TCP CONNECT**

Use a fixed 32 KiB copy buffer. Before writing each payload chunk, split to `<= burstBytes` and call the appropriate registry wait. Clear handshake deadlines after a successful tunnel, then use bounded dial timeout plus normal half-close behavior. Do not log target payload or credentials.

- [ ] **Step 7: Run Task 2 tests**

Run: `cd speed-enforcer && go test -race ./internal/socks ./internal/limit`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add speed-enforcer/internal/socks speed-enforcer/internal/limit
git commit -m "feat: proxy capped SOCKS TCP traffic"
```

---

### Task 3: Authenticated UDP ASSOCIATE with shared TCP/UDP limits

**Files:**
- Create: `speed-enforcer/internal/socks/udp.go`
- Create: `speed-enforcer/internal/socks/udp_test.go`
- Modify: `speed-enforcer/internal/socks/server.go`
- Modify: `speed-enforcer/internal/socks/server_test.go`

**Interfaces:**
- Consumes: authenticated alias from Task 2 control connection and Task 1 shared registry.
- Produces: UDP ASSOCIATE relay tied to the lifetime of its authenticated TCP control connection.

- [ ] **Step 1: Write failing UDP tests**

Assert: valid authenticated association relays IPv4/domain/IPv6 UDP; upload datagram payload consumes the same alias upload bucket used by TCP; response payload consumes the same download bucket; mixing TCP+UDP cannot exceed one directional budget; `FRAG != 0` is dropped; malformed/truncated datagrams dropped; unauthenticated/orphan traffic is not relayed; association closes when control TCP closes; idle association expires after 120 seconds; state is bounded to one relay worker/socket per control association; logs contain no alias/password/payload.

- [ ] **Step 2: Run and confirm RED**

Run: `cd speed-enforcer && go test ./internal/socks -run 'Test.*UDP' -v`

Expected: FAIL because UDP ASSOCIATE is not implemented.

- [ ] **Step 3: Implement UDP ASSOCIATE**

Support SOCKS5 UDP header with `RSV=0`, `FRAG=0`, ATYP IPv4/IPv6/domain. Bind relay to loopback only. Tie relay context to authenticated TCP control connection. Resolve domains with standard resolver. Enforce 120-second idle expiry and reset activity timestamp only for valid associated traffic.

- [ ] **Step 4: Run race/resource tests**

Run: `cd speed-enforcer && go test -race ./internal/socks -run 'Test.*UDP' -count=3`

Expected: PASS repeatedly with no leaked workers/races in test assertions.

- [ ] **Step 5: Commit**

```bash
git add speed-enforcer/internal/socks
git commit -m "feat: cap authenticated SOCKS UDP traffic"
```

---

### Task 4: Sidecar daemon, private health socket and secret-safe process behavior

**Files:**
- Create: `speed-enforcer/internal/health/server.go`
- Create: `speed-enforcer/internal/health/server_test.go`
- Create: `speed-enforcer/cmd/madar-speed-enforcer/main.go`
- Create: `speed-enforcer/cmd/madar-speed-enforcer/main_test.go`

**Interfaces:**
- Produces CLI: `madar-speed-enforcer --config <path> [--test]`.
- `--test` parses/validates and exits without opening TCP/UDP listeners.
- Daemon health Unix socket returns only `{generation, ready}` and uses mode `0600`.
- Daemon is ready only after SOCKS TCP listener and UDP capability initialize and health socket is live.

- [ ] **Step 1: Write failing health/CLI tests**

Assert: `--test` accepts valid config and rejects invalid/public listeners; health socket path is unlinked safely only if it is a socket/nonexistent, not a directory/symlink; socket mode is `0600`; response contains generation/ready only; graceful SIGTERM closes listener, UDP associations and health socket; startup refuses a pre-existing symlink; stderr/log messages never echo config content, aliases, verifiers or passwords.

- [ ] **Step 2: Run and confirm RED**

Run: `cd speed-enforcer && go test ./internal/health ./cmd/madar-speed-enforcer -v`

Expected: FAIL because health/daemon packages are absent.

- [ ] **Step 3: Implement daemon assembly**

Use standard `flag`, `os/signal`, `context`. `--test` must not mutate runtime files. Runtime creates listener only from validated loopback config, builds one shared registry, serves SOCKS and health, then shuts down on context cancellation.

- [ ] **Step 4: Run full Go suite**

Run: `cd speed-enforcer && go test -race ./... && go vet ./...`

Expected: PASS.

- [ ] **Step 5: Build a local static binary**

Run: `cd speed-enforcer && CGO_ENABLED=0 go build -trimpath -o /tmp/madar-speed-enforcer ./cmd/madar-speed-enforcer`

Expected: exit 0 and executable file produced.

- [ ] **Step 6: Commit**

```bash
git add speed-enforcer
git commit -m "feat: add speed enforcer daemon"
```

---

### Task 5: Node-local speed identity and Python sidecar adapter

**Files:**
- Create: `node-agent/madar_agent/speed.py`
- Create: `node-agent/tests/test_speed.py`
- Modify: `node-agent/madar_agent/models.py`

**Interfaces:**
- Produces `SpeedRouteCredential(client_id: str, alias: str, password: str)` in `models.py`.
- Produces `derive_speed_identity(secret: bytes, client_id: str) -> SpeedRouteCredential`.
- Produces `password_verifier(alias: str, password: str) -> str`.
- Produces `ensure_speed_identity_secret(path: Path) -> bytes`.
- Produces `SpeedEnforcerAdapter.apply_clients(clients: list[ManagedClient], generation: int) -> dict[str, SpeedRouteCredential]`.
- Produces `SpeedEnforcerAdapter.disable_managed_access()`, `.health(expected_generation: int) -> bool`, and `.required`.

Exact identity format:

- Alias digest: `HMAC-SHA256(node_secret, b"alias-v1\x00" + client_id.encode())`; encode the first 16 digest bytes as unpadded base64url (128 bits).
- Password digest: `HMAC-SHA256(node_secret, b"password-v1\x00" + client_id.encode())`; encode all 32 bytes as unpadded base64url (256 bits).
- Sidecar verifier: lowercase SHA-256 hex of `b"verifier-v1\x00" + alias + b"\x00" + password`.
- `speedKbps` conversion: `bytes_per_second = speed_kbps * 125`; burst is `max(1, bytes_per_second // 2)`.

- [ ] **Step 1: Write failing identity/secret tests**

Assert exact deterministic vectors; alias/password domain separation; different Node secret produces different values; raw UUID is absent from alias/password/verifier; secret file is exactly 32 bytes, root-owner-compatible regular file mode `0600`, parent `0700`; symlink/nonregular/wrong-length/over-permissive secret fails closed; existing valid secret is stable.

- [ ] **Step 2: Run and confirm RED**

Run: `python3 -m pytest node-agent/tests/test_speed.py -q`

Expected: FAIL because module/types do not exist.

- [ ] **Step 3: Implement identity and secret handling**

Use Python `hmac`, `hashlib`, `base64`, `os.urandom`, `os.open` with `O_EXCL`/`O_NOFOLLOW` where available. Never print derived credentials.

- [ ] **Step 4: Add failing adapter tests**

Assert: Free 5000 renders `625000` bytes/sec and `312500` burst each direction; Premium/null creates no sidecar client entry; zero/negative/overflow-like values reject before live promotion; sidecar JSON contains alias+verifier but no UUID/password; candidate is `0600`; binary `--test` runs before promote; promote precedes lifecycle authorization/restart; health requires expected generation; no-Free policy disables sidecar and sets `.required == False`; apply failure revokes marker/stops sidecar and leaves no “required healthy” success state.

- [ ] **Step 5: Implement `SpeedEnforcerAdapter` minimally**

Default paths: state `/etc/madar-node-agent`; live config `/etc/madar-node-agent/speed-enforcer.json`; candidate sibling `.candidate`; identity secret `/etc/madar-node-agent/speed-identity.key`; binary `/opt/madar-speed-enforcer/madar-speed-enforcer`; listener `127.0.0.1:10808`; health socket `/run/madar-node-agent/speed-enforcer.sock`.

Health client uses `socket.AF_UNIX`, bounded timeout, strict JSON shape `{generation:int, ready:true}` and rejects extra/malformed fields.

- [ ] **Step 6: Run Task 5 tests**

Run: `python3 -m pytest node-agent/tests/test_speed.py -q`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add node-agent/madar_agent/speed.py node-agent/madar_agent/models.py node-agent/tests/test_speed.py
git commit -m "feat: add Node speed enforcer adapter"
```

---

### Task 6: Render per-Free-client Xray SOCKS routes without Premium fallback

**Files:**
- Modify: `node-agent/madar_agent/xray.py`
- Modify: `node-agent/tests/test_xray_adapter.py` (use the existing Xray adapter test file name if it differs; do not create a duplicate suite)
- Modify: `node-agent/madar_agent/models.py` only if import placement requires it

**Interfaces:**
- Consumes Task 5 `dict[str, SpeedRouteCredential]` keyed by raw Client ID internally in Agent memory.
- Changes `XrayAdapter.apply_clients` / `PinnedXrayAdapter.apply_clients` to accept the speed-route mapping in addition to managed Clients.
- Free Client without a matching route credential is an error; Premium Client with one is an error.

Xray rendering contract:

- First/default outbound remains `{protocol:"freedom", tag:"direct"}`.
- Each Free Client gets one SOCKS outbound to `127.0.0.1:10808` with exactly one local username/password pair and a non-secret deterministic tag such as `madar-speed-0001` based on sorted Free-client order, not the alias/UUID.
- `routing.rules` contains one rule per Free Client selecting `outboundTag` by Xray authenticated user label `madar:<client_id>`.
- Premium gets no speed outbound and no routing rule, therefore uses default direct.
- No Free rule has a direct fallback target.

- [ ] **Step 1: Write failing Xray renderer tests**

Assert one Free/one Premium shape, multiple Free Clients, stable sorted tags independent of input order, SOCKS credentials exactly match Task 5 mapping, Free route uses the existing authenticated email identity, Premium stays direct, missing/extra route credentials reject, generated config has SOCKS path available for TCP+UDP, and candidate/live config permissions remain `0600`.

- [ ] **Step 2: Run and confirm RED**

Run the focused Xray pytest file with `-q`.

Expected: FAIL because current renderer has only direct outbound.

- [ ] **Step 3: Implement renderer changes**

Do not alter pinned Xray version, VLESS/REALITY inbound, StatsService names or traffic-counter identity. Preserve `email: madar:<client_id>` so Phase 7 accounting remains compatible.

- [ ] **Step 4: Run Xray + activity regressions**

Run: `python3 -m pytest node-agent/tests/test_xray_adapter.py node-agent/tests/test_activity_source.py node-agent/tests/test_activity_runtime.py -q` using actual existing test filename.

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add node-agent/madar_agent/xray.py node-agent/madar_agent/models.py node-agent/tests
git commit -m "feat: route Free clients through speed enforcer"
```

---

### Task 7: Atomic Agent apply ordering, sidecar systemd lifecycle and readiness

**Files:**
- Modify: `node-agent/madar_agent/agent.py`
- Modify: `node-agent/madar_agent/lifecycle.py`
- Modify: `node-agent/madar_agent/service.py`
- Create: `node-agent/systemd/madar-speed-enforcer.service`
- Modify: `node-agent/tests/test_agent_core.py`
- Modify: existing lifecycle/service/systemd test files
- Modify: `node-agent/tests/test_install_assets.py` only to recognize the staged unit asset; do not extend installer packaging to a released binary in this phase

**Interfaces:**
- `NodeAgent` receives both `xray` and `speed_enforcer` adapters.
- `NodeAgent.apply_policy(policy)` validates every Client before side effects, applies sidecar first, then Xray, and sets `_current_policy` only after both succeed.
- Combined disable closes Xray first and sidecar second; failure to prove either closed is an error.
- Runtime health is `xray.health() && (!speed.required || speed.health(current_revision))`.
- Generic systemd primitive keeps the existing `SystemdXrayLifecycle` API unchanged and adds `SystemdSpeedEnforcerLifecycle` for `madar-speed-enforcer.service` + `/run/madar-node-agent/speed-enforcer-authorized`.

- [ ] **Step 1: Write failing policy-ordering tests**

Assert: complete policy validation occurs before calling either adapter; Free apply calls sidecar before Xray; Xray receives exact returned route map; ACK eligibility only follows both success states; sidecar validation/start failure means Xray new config is never promoted; Xray failure after sidecar success disables Xray and sidecar, leaves revision unacknowledged/current revision unchanged; Client-ID rotation prepares new sidecar alias before Xray switch; Free→Premium can remain capped until Xray switch but never uncapped early; Premium→Free sidecar is healthy before Xray switch; zero-Free policy disables sidecar and remains eligible for readiness without it.

- [ ] **Step 2: Run Agent tests and confirm RED**

Run: `python3 -m pytest node-agent/tests/test_agent_core.py -q`

Expected: FAIL because NodeAgent has no speed adapter/order.

- [ ] **Step 3: Implement NodeAgent orchestration**

Do not mutate `_current_policy` before successful dual-runtime apply. Use candidate policy `valid_until` directly for staleness validation. Keep known-revision fetch based on last successfully applied policy so failed revisions are fetched again.

- [ ] **Step 4: Write failing generic/systemd lifecycle tests**

Pin all existing Xray behavior unchanged, then add sidecar equivalents: marker atomic `0600`; reject symlink/nonregular marker; `systemctl show` state parsing; stop→kill→poll verification; restart only when marker valid; failure revokes marker and proves inactive; manual sidecar start without marker fails by unit conditions; both child units use `BindsTo=madar-node-agent.service`; neither child unit has an `[Install]` boot target; sidecar unit conditions require live config + ephemeral marker.

- [ ] **Step 5: Refactor lifecycle minimally and add sidecar unit**

Extract an internal/general `SystemdManagedLifecycle` only if needed to avoid duplicate security logic; preserve `SystemdXrayLifecycle` constructor/public behavior and existing error-safe semantics. Add `SystemdSpeedEnforcerLifecycle` with its own unit/marker/error label.

- [ ] **Step 6: Write failing service/startup/readiness tests**

Assert startup proves **both** Xray and sidecar inactive before building service; uncertainty in either returns startup failure and closes the other; normal shutdown closes both; sidecar crash while capped Clients exist makes heartbeat `ready=false/accepting=false`; sidecar crash with zero capped Clients does not by itself make Node unready; Agent SIGKILL relation is encoded in units so systemd binds both children to Agent; existing activity sampler behavior is unchanged.

- [ ] **Step 7: Implement service assembly and combined health**

Build speed lifecycle/adapter before Xray apply path. On startup, fail closed if either managed runtime cannot be verified inactive. Do not change telemetry sampler/counter source semantics.

- [ ] **Step 8: Run full Python suite**

Run: `python3 -m pytest node-agent/tests -q`

Expected: PASS, including all prior Phase 7 lifecycle/accounting tests.

- [ ] **Step 9: Commit**

```bash
git add node-agent/madar_agent node-agent/systemd node-agent/tests
git commit -m "feat: integrate fail-closed speed runtime"
```

---

### Task 8: CI, static build helper and repository acceptance evidence

**Files:**
- Modify: `.github/workflows/ci.yml`
- Create: `scripts/build-speed-enforcer.sh`
- Create: `docs/test-reports/phase-9-speed.md`
- Modify: `scripts/security_scan.py` tests only if the new generated/config patterns require explicit secret coverage

**Interfaces:**
- CI adds `actions/setup-go` with `go-version: '1.24.x'`.
- CI runs from `speed-enforcer`: `go test -race ./...`, `go vet ./...`, and static `CGO_ENABLED=0 go build -trimpath`.
- Build helper accepts output path and optional `GOOS/GOARCH`; defaults Linux + host architecture; uses `-trimpath` and `CGO_ENABLED=0`.

- [ ] **Step 1: Add failing repository/build assertions**

Extend install/security asset tests so they expect the new sidecar systemd unit to exist and reject public listen patterns/known secret field leakage. Add a shell/build smoke check if none exists for scripts.

- [ ] **Step 2: Run affected tests and confirm RED before CI edit**

Expected: at least the new CI/build/asset expectation fails because setup/build helper is not present.

- [ ] **Step 3: Add Go CI steps and build helper**

Do not commit binaries. The build helper must fail on unset/unsupported target values rather than silently producing a host-only artifact under a misleading name.

- [ ] **Step 4: Run complete local-equivalent verification**

Run:

```bash
cd speed-enforcer && go test -race ./... && go vet ./... && CGO_ENABLED=0 go build -trimpath -o /tmp/madar-speed-enforcer ./cmd/madar-speed-enforcer
cd ..
pnpm test
pnpm typecheck
pnpm build
python3 -m pytest node-agent/tests -q
python3 scripts/security_scan.py .
```

Expected: all PASS.

- [ ] **Step 5: Create `phase-9-speed.md` in PREPARED state**

Record exact repository SHA/CI when available, architecture contract, automated evidence, explicit remaining real-VPS checks, secret rules, cleanup requirements, and the statement `Phase 9 INCOMPLETE` until Task 29 and Task 30 field gates pass.

- [ ] **Step 6: Push/observe full GitHub CI and fix only via TDD**

Expected: every existing + new CI step green on one exact head. If a production-code fix is needed, add a failing regression first and obtain a new green head.

- [ ] **Step 7: Commit**

```bash
git add .github/workflows/ci.yml scripts docs/test-reports/phase-9-speed.md
git commit -m "test: gate Phase 9 speed enforcer"
```

---

### Task 9: One real field session for Task 29 multi-node + Task 30 speed enforcement

**Files:**
- Modify after evidence: `docs/test-reports/phase-9-speed.md`
- Modify after evidence: `docs/test-reports/phase-9-multinode.md`
- Modify only after both pass: `docs/superpowers/plans/2026-10-08-madar-implementation-plan.md`

**Interfaces:**
- Consumes exact CI-green SHA from Task 8.
- Consumes existing Task 29 repository evidence and `phase-9-multinode.md` checklist.
- Produces field PASS/FAIL evidence; no repository-only substitute.

- [ ] **Step 1: Prepare exact-head field binary without publishing a release**

Build static Linux binary from the exact CI-green SHA, record SHA-256, copy root-owned executable to `/opt/madar-speed-enforcer/madar-speed-enforcer` on each disposable test Node, install the repository sidecar systemd unit, and verify the deployed binary checksum. Do not claim installer packaging acceptance; that belongs to Phase 10 Task 32.

- [ ] **Step 2: Complete Task 29 on a second real VPS**

Enroll second Node through the real one-time path. Prove two healthy ACKed Nodes appear in the same real subscription and both pass traffic; stale/unhealthy and capacity-excluded Node disappears; Client-ID rotation is withheld independently until each Node ACKs; real subscription refresh reflects changes; overlapping active-second evidence from both Nodes is globally de-duplicated at account level. Record only secret-safe evidence.

- [ ] **Step 3: Establish throughput baseline**

Use a controlled endpoint/path whose sustained uncapped/Premium baseline is materially above the Free band; target >= 8 Mbps in the judged direction. If baseline cannot distinguish a 5 Mbps cap from network congestion, mark the quantitative test INCONCLUSIVE and do not pass Task 30.

- [ ] **Step 4: Prove Free TCP cap**

For each quantitative measurement discard >=5 seconds warm-up and measure >=30 seconds sustained. Prove Free download 4.5–5.5 Mbps, Free upload 4.5–5.5 Mbps, simultaneous up/down each independently 4.5–5.5 Mbps, and multiple parallel TCP connections for the same Client do not multiply the cap.

- [ ] **Step 5: Prove per-Client independence**

Run two distinct Free Clients/accounts on the same Node concurrently. Each receives its own approximately 5 Mbps directional cap; they must not share one node-wide 5 Mbps bucket.

- [ ] **Step 6: Prove UDP cannot bypass**

Generate controlled authenticated UDP/QUIC-like traffic through the same imported product path. After burst allowance, sustained application payload goodput must not materially exceed the configured 5 Mbps directional policy. No lower-bound target is required because loss/jitter can reduce UDP goodput.

- [ ] **Step 7: Prove Premium no-Madar-cap**

On the same Node/path, Premium bypasses the sidecar and tracks available baseline rather than clustering near 5 Mbps. Record sidecar connection counters showing the Premium test did not enter the limiter, without identifiers.

- [ ] **Step 8: Prove runtime failure behavior**

With capped Free active, stop/crash sidecar: Free TCP and UDP fail and never become uncapped; Premium direct may remain; Node heartbeat/readiness becomes false and subscription eligibility removes it. Recover sidecar/fresh policy and prove service returns. Reboot and Agent-stop/SIGKILL sanity checks must preserve the established fail-closed invariant for both managed child processes.

- [ ] **Step 9: Privacy and cleanup**

Bounded journals/config scans contain no raw Client UUID, full alias, SOCKS password, subscription bearer, Node credential, REALITY private key or payload. End with test policies/credentials revoked, temporary throughput harness removed, pending telemetry `0`, unexplained `unmapped` `0`, retained historical journals, and retained VPSs unless explicitly requested otherwise.

- [ ] **Step 10: Close docs only if evidence supports it**

If Task 29 and Task 30 both pass on exact CI-green deployed code, mark both reports PASS and main Phase 9 Gate PASS. If either fails/inconclusive, Phase 9 remains INCOMPLETE. If runtime code changes during field work, stop, TDD-fix, obtain a new full green CI SHA, deploy it and rerun every affected field check before PASS.

- [ ] **Step 11: Final evidence CI**

Run/observe full CI on the documentation head. Do not start Phase 10 automatically. Do not claim Production Ready.

---

## Completion Contract

Implementation is complete only when Tasks 1–8 are green on one exact repository SHA. Task 30 is complete only after Task 9 real-VPS evidence passes. Phase 9 closes only if Task 29 multi-node and Task 30 speed evidence are both PASS.

A final implementation review must specifically re-check:

1. no Free direct fallback path in Xray for TCP or UDP;
2. one shared per-alias limiter pair across all TCP/UDP workers;
3. no UUID/plaintext SOCKS password in sidecar config/log/health;
4. sidecar-before-Xray promotion and no ACK before both are healthy;
5. Agent/systemd crash/reboot behavior still satisfies the Phase 7 fail-closed invariant.
