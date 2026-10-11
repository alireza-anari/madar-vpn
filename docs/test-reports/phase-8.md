# Phase 8 — real v2rayNG E2E

Date: 2026-10-11  
Status: **Phase 8 field E2E PASS; repository fixture/final CI pending.**

## Purpose

Phase 8 freezes Madar's subscription compatibility only after a real current v2rayNG client imports the server-issued subscription, traverses the real VPS, observes correct Free active-second accounting, and survives both independent rotation flows.

The executable acceptance checklist is `tests/e2e/v2rayng-acceptance.md`.

## Repository preparation

Phase 7 is already PASS and is not reopened by this preparation.

A Phase 8 preflight found one product-boundary gap: client credential rotation existed in the domain/PostgreSQL store but had no authenticated user HTTP mutation. TDD evidence:

- RED contract commit: `72d91eeeb3d25ae297b1d30704490bdca9b98088`;
- RED CI: `38086557955` — expected failure, only because `POST /api/account/access/client-id/rotate` returned `404`;
- GREEN implementation commit: `2c842b6486e5ef1aabacb5023c766ff937165a5c`;
- GREEN CI: `38086869526` — SUCCESS.

The new mutation:

- requires the existing authenticated + CSRF mutation boundary;
- rotates through the existing transactional access service;
- increments policy revision and credential version;
- does not rotate the subscription token;
- returns only `{policyRevision, version}`;
- writes audit metadata without either old or new UUID;
- relies on existing subscription eligibility logic to withhold a node until the required new policy revision is ACKed.

No Node Agent, Xray, active-second sampler/outbox, PostgreSQL usage settlement, Premium accounting, or Phase 7 lifecycle code changed in this preparation.

## Existing automated evidence carried into the field test

Repository tests already cover:

- old subscription URL invalidation after token rotation;
- subscription token and client UUID independent state machines;
- transactional PostgreSQL client credential rotation;
- node subscription eligibility gated by per-user policy-revision ACK;
- VLESS+REALITY share-link rendering with bearer-secret `no-store` delivery;
- first verified account Free grant of exactly 1800 seconds with idempotent initial ledger key;
- account reads using authoritative entitlement state.

These tests do **not** establish v2rayNG compatibility. Renderer/parser fixtures remain intentionally unfrozen until the real client accepts the format.

## Email boundary for this phase

Production email delivery is still not configured and is not promoted to verified by Phase 8.

For the VPN compatibility field run, a controlled field sender may capture the one-time magic-link token while still exercising the real auth request/consume service and real PostgreSQL stores. The field run must not create a verified user/session/initial grant directly in SQL. The resulting evidence proves the account/auth semantics needed by the v2rayNG test, while real production email delivery stays an explicit later integration gate.

## Real field evidence

Executed on 2026-10-11 (Asia/Tehran); timestamps below are UTC. The same disposable Ubuntu 24.04 amd64 VPS was retained. Exact tested API/repository SHA: `5f82a12a28fdadb38acb750dabbc0f96e977c7e4`; full CI `38087073156` completed **SUCCESS** for that exact SHA. The deployed Agent source files and both native systemd units were verified byte-identical to this head and the accepted Phase 7 runtime `d4fe18b91a2da26488faedd96b4182190de31861`. Xray remained 26.3.27. No production runtime code or migration changed during this run.

The operator exercised and checked the server. The human operated the physical Samsung Galaxy A16, Android 16, on the same Wi-Fi as the laptop; the device was not controlled or inspected through ADB. The human confirmed installed v2rayNG **2.2.6**. The supplied official ARM64 build was `v2rayNG_2.2.6_arm64-v8a.apk` from [2dust's official 2.2.6 release](https://github.com/2dust/v2rayNG/releases/tag/2.2.6); its downloaded SHA256 matched the official release asset digest, `62b0675c0986a8613f1bb67f1a68c366c6357e04a68687a3bd907170594c437d`. Device version/installation and actions are human-confirmed evidence, not an ADB package or CPU-ABI measurement.

The temporary API used the actual repository routes, auth/access services and PostgreSQL stores. A controlled sender captured the one-time login token privately. Public subscription delivery used a temporary Cloudflare Quick Tunnel after explicit human authorization for bearer-token transit through Cloudflare. The bridge exposed subscription delivery, health and the bounded transfer harness; authenticated account/admin/node routes were not exposed through it. VLESS+REALITY traffic itself went directly to the existing VPS. This does not establish the production Cloudflare Worker/Hyperdrive deployment or production email delivery.

| Check | Field result | Actual evidence |
| --- | --- | --- |
| A — fresh account/auth/grant | PASS | Real auth request and consume returned 200; replay returned 401. Two authenticated account reads returned exactly 1800 Free seconds. Read-only PostgreSQL checks found one initial ledger event, sum 1800, one total ledger event before traffic and a verified account. No user/session/verification/credit was inserted directly in SQL. |
| B — API-issued URL/import | PASS | Fresh policy 17 with user revision 1 was ACKed; heartbeat was healthy/ready. Authenticated + CSRF URL issuance returned 201; bearer endpoint returned 200, one VLESS entry and `Cache-Control: no-store`. The actual URL was transferred as a private local QR and imported/refreshed in real v2rayNG. Human screenshot showed the expected node under the subscription group with VLESS/reality. |
| C — egress/transfer/accounting/replay | PASS | Ordinary phone Chrome traffic returned the same VPS public egress. The successful bounded phone retry received exactly 1,179,649 bytes; safe origin trace recorded transfer start 05:50:07.913, idle start 05:50:25.918 and completion 05:51:00.918 UTC. Before/after Free was 1451/1441; observed/billable/ledger seconds increased 349→359, exactly 10. Two re-deliveries of a real settled phone report each returned HTTP 200, accepted 0, duplicates 1, with zero extra debit. |
| D — actual idle | PASS after workload isolation | With only Chrome routed through the same imported v2rayNG profile, browser closed and VPN still on, 31 actual aggregate counter samples across 05:43:41.633–05:44:12.046 UTC were fixed: both byte deltas zero. The 28 interior UTC seconds had zero new active bits and zero debit; Free stayed 1482/1482 and aggregate online users remained 1. |
| E — Client ID rotation | PASS | Actual authenticated + CSRF route returned 201 with only policyRevision/version (2/2); private one-way fingerprints differed and the subscription token/URL stayed unchanged. Before ACK, the same subscription returned 200 with zero node entries. Audit metadata contained neither UUID. Policy 18 ACKed user revision 2; live Xray contained the new credential and not the old one. Human Chrome with the old profile showed no Internet; updating the same URL and reconnecting restored ordinary VPS egress, supplying the recovery control. |
| F — URL rotation | PASS | Actual authenticated account API issued subscription version 2. Previous URL immediately returned 404 with only `Not found`; new URL returned 200/one node/no-store. Private Client ID fingerprints before/after were identical. Human imported/refreshed the new URL in real v2rayNG and confirmed connectivity. |
| G — successful wire shape | Field evidence recorded; repository fixture deferred | The real client accepted the wire shape below. No real field values were made into a fixture. Sanitized fixture and parser/shape regression CI remain pending, as explicitly requested. |
| H — cleanup | PASS | Empty policy 19 removed all clients; the human's still-cached latest profile could no longer access a fresh public probe. Human then disabled VPN, deleted only the two field subscriptions/profiles and closed the private QR tab. Pending telemetry and accumulated activity were both zero; all 40 account reports were settled, unmapped zero. Cleanup revoked every field credential/token/session and suspended that account; both old/latest URLs returned non-disclosing 404. Temporary sender, bridge, tunnel, remote private exports and local QR were removed; normal API assembly restored. VPS and historical journals preserved. |

### Final accounting and privacy

At final settled verification, 06:06:28 UTC, starting Free was **1800**, ending Free **1408**, and billable active-second delta **392**. All 40 reports settled; their per-minute union contained 392 trusted observed UTC seconds, matching 392 billable seconds and 392 ledger debit. Popcounts and settlement observation masks matched telemetry, debits contained only new bits, duplicate billed bits were zero, and no report was unexplained `unmapped`. These totals include ordinary browsing, handshakes, earlier attempts and rotation probes, not only the final bounded transfer. The 18-second origin send schedule does not imply 18 billable seconds: billing used actual server-observed network activity.

Bounded new journal scans across the Agent, Xray, API, tunnel and bridge found no known magic-link token, session cookie, CSRF token, field UUID, subscription token, node credential or REALITY private key; raw StatsService and telemetry-output pattern checks were also negative. Root state remained 0700 and schema-2 outbox 0600. Historical Phase 7 journals were retained rather than purged.

Cleanup used direct database revocation/deletion only for the already-created field account's credentials, tokens and sessions, plus suspension. This is teardown evidence; it was not used to create the account, grant credit, emulate auth, or manufacture a passing result.

### Accepted wire shape

- Scheme/protocol: `vless` / VLESS.
- Transport: query `type=tcp`.
- Flow: `xtls-rprx-vision`.
- Security: `reality`.
- Encryption: `none`.
- Fingerprint choice: `chrome`.
- Query parameter names in the actually accepted renderer: `encryption`, `security`, `sni`, `fp`, `pbk`, `sid`, `type`, `flow`.
- Authority contains the client UUID and node host/port; fragment contains the node label. No field values are reproduced here. This records the accepted parameter set, not an omission-based proof that each parameter is individually mandatory.

### Failed attempts retained

The first auth runner failed immediately after service restart, before a private mail capture or account state existed. Readiness was subsequently confirmed and the real auth sequence passed; that first execution was not counted as a pass.

The first screen-off idle attempt was not idle: actual aggregate counter deltas were 1180 uplink and 5379 downlink bytes; its 27 interior seconds produced 7 active bits and 7 debits. Other app background traffic was excluded using v2rayNG's official Per-app proxy setting (Chrome only, Bypass Mode off), then the measured idle check passed. This was workload isolation, not a runtime workaround.

The first bounded phone transfer displayed a failure despite the origin finishing its response. No bridge traceback/reset/broken-pipe error was found. An independent laptop request received HTTP 200 and all 1,179,649 bytes in 53.662183 seconds; it is diagnostic evidence, not phone acceptance. Safe stage/status/byte-count diagnostics were added to the temporary page, and the actual phone rerun then received every byte. The original phone-side transient failure's precise cause remains undetermined; no production fix or hidden success was claimed.

### Remaining boundary

**Phase 8 field E2E PASS; repository fixture/final CI pending.** A–F and teardown passed with human-operated real v2rayNG plus server-side evidence. This report does not complete G's sanitized fixture/regression gate. The evidence-only documentation CI also does not substitute for that fixture's future CI. No Phase 9 work was started and no Production Ready claim is made.

## Release boundary

Until the field run and post-pass fixture/CI are complete:

- Phase 8: **INCOMPLETE**;
- Phase 9: not started by this work;
- Premium single-active-client/device: still separate and unresolved;
- Production Ready: not claimed.
