# Phase 7 VPS Integration Report

Date: 2026-10-10
Branch: `impl/phase-1`

## Status

**Phase 7: INCOMPLETE after real-VPS execution. Do not mark PASS.**

Task 27 was exercised on a real disposable AWS EC2 Ubuntu VPS. Real installation/enrollment, systemd health, reboot, direct external VLESS+REALITY traffic, aggregate observation, credential revocation, and control-plane-outage expiry were observed. The first field run exposed access-log identifier leakage and a fail-open expiry path; narrow fixes were made and retested. The phase remains incomplete: online connection presence is not active-traffic duration, the installed service still has no verified `ObservedActivity` source, and no live telemetry/debit claim is justified. Earlier client-identifying journal entries are retained at the user's explicit request. Phase 8 was not started.

## Real field environment and scope

- VPS: AWS EC2 `t3.micro`, Stockholm (`eu-north-1`), Ubuntu `24.04`, `x86_64`, Python `3.12.3`; sudo and systemd `running` verified over SSH.
- Checkout: `alireza-anari/madar-vpn`, branch `impl/phase-1`, baseline commit `12e1f5c754a29da7cdb463db4d378eb56b8d8777`, plus the documented field fixes. The installer lacked its executable Git mode at baseline (`100644`); it was corrected to `100755` and direct wrapper execution was verified.
- The user confirmed no control plane had been deployed and explicitly selected a disposable control plane on this VPS. The existing `createDefaultApiApp` Worker assembly and real PostgreSQL stores were bundled into a Node HTTPS host. Its PostgreSQL connection was supplied through the production runtime's Hyperdrive-shaped connection-string binding. This does not exercise Cloudflare Workers or an actual Hyperdrive service.
- A fresh PostgreSQL database used the repository's authoritative schema. Disposable admin/user records and a hashed one-time login bootstrap were provisioned in this isolated database; the real auth consume and CSRF-protected admin enrollment-token routes were then used. This is not a real email-provider/signup acceptance test.
- HTTPS was served only on `127.0.0.1:8443` with a disposable CA explicitly trusted on the VPS. Certificate/hostname verification stayed enabled. PostgreSQL listened only on `127.0.0.1:5432`; Xray StatsService listened only on `127.0.0.1:10085`.
- The pinned Linux Xray `26.3.27` was installed by the real installer and verified against the repository digest. The external Windows client used the official same-version release archive, verified against GitHub's SHA-256 asset digest `d004c39288ce9ada487c6f398c7c545f7d749e44bdfdd59dbc9f865afba4e1ad`.
- The VLESS listener was port `443`, with AWS ingress restricted to the test computer's source address. Successful Windows probes used direct VLESS+REALITY to the VPS; their returned public egress address matched the VPS. SSH forwarding was used only for a failed diagnostic comparison, not for the successful external traffic evidence.
- Policies were explicitly published into the real revisioned PostgreSQL policy table by the disposable field operator; the node fetched and ACKed them through its real HTTPS API. This proves that field path, not an automated production policy-publication scheduler. Credential issuance/rotation used the real `AccessService`/PostgreSQL adapter.

## Field observations (UTC, 2026-10-10)

| Check | Actual evidence | Result / limit |
| --- | --- | --- |
| Real installer and enrollment | `./install.sh install` executed on Ubuntu; fresh token obtained through the authenticated admin API and passed only in memory/stdin; replay returned HTTP `401` | PASS |
| Secret permissions | `node.credential`, `reality.private`, and `agent.env` each mode `0600` | PASS |
| Real policy and service health | Revision 1 ACKed; Node Agent/Xray active; heartbeat `healthy=true`, `ready=true`, `accepting=true` | PASS |
| Reboot | Boot identity changed after real reboot; control plane, agent and Xray active again; fresh policy ACK/readiness returned | PASS for the observed environment |
| Fixed startup during outage | A second reboot with the control-plane unit disabled changed boot identity again; agent/Xray active but managed clients `0`; external credential probe denied at `06:12:04` before the control plane was re-enabled | PASS for the observed post-startup state; no claim about an instantaneous pre-first-cycle boot boundary |
| Direct external traffic | `05:41:16` and subsequent Windows probes traversed direct VLESS+REALITY; public egress matched the VPS | PASS |
| Before / during transfer | Aggregate `0` before sustained transfer, `1` during the first valid active-transfer samples; later samples had scheduling gaps and the transfer had ended | Presence transition observed; delayed samples not used to infer duration |
| Idle open connection | `05:52:43`, `05:52:51`, `05:53:11`, `05:53:41`: aggregate `1` while the controlled HTTP connection stayed open without response payload; actual elapsed samples approximately `4.52`, `12.84`, `32.41`, `62.61` seconds | Online includes idle open connections |
| Disconnect | Client terminated at `05:53:41`; aggregate `0` at `05:53:44`, and again through `05:54:44` | Disconnect transition observed; no exact sub-sample boundary claimed |
| Live revoke | Live transfer online count `1` at `06:06:58`; real credential rotation and replacement policy published at `06:07:01`; revision 5 ACKed by `06:07:21`, old transfer closed, aggregate `0` | PASS for controlled policy propagation |
| Old vs replacement credential | Old credential fresh connection denied at `06:08:06`; replacement direct probe succeeded at `06:08:41` with VPS egress | PASS |
| Baseline outage expiry | Revision 2 short policy ACKed then the real control-plane service stopped; at `06:00:06`, policy `fresh=false` but managed client count still `1`; external traffic also succeeded after expiry | FAIL reproduced; prompted the expiry fix |
| Fixed outage expiry | Repeat with revision 3: at `06:04:48`, policy `fresh=false`, managed client count `0`; external credential probe denied at `06:05:50` while the control plane remained stopped | PASS after fix; cycle/request-bound enforcement, not an instantaneous deadline timer |
| Control-plane secret audit | Actual stored data scanned in memory: raw node credential and REALITY private key absent | PASS for the observed snapshot |
| Baseline log privacy | Runtime journal contained the disposable client UUID via Xray's default access logger even at warning level; no raw identifier copied into this report/chat | FAIL reproduced; historical journal retained by user instruction |
| Fixed log privacy | New runtime logs since `05:57:30` scanned in memory: no node credential, REALITY private key, client UUID, admin session/CSRF secret, bearer pattern or PEM private key | PASS for the bounded post-fix log interval; not a claim that historical journal is clean |
| Live telemetry/debit | Real database still contained `0` telemetry reports and `0` reported seconds; installed `activity_source` is absent | NOT IMPLEMENTED / NOT PASS |

Ordinary TLS success did not establish REALITY suitability: `www.microsoft.com:443` passed verified TLS 1.3 both directly and through Xray fallback, while matching Linux and Windows REALITY clients failed with EOF. The same keys/client worked after changing the explicit target and matching SNI to `www.cloudflare.com`. This is consistent with [upstream issue 6356](https://github.com/XTLS/Xray-core/issues/6356); this test did not enable raw REALITY debug output or prove the upstream internal certificate-record length itself.

## Field fixes and regression verification

- Installer Git executable mode restored so the runbook's direct invocation works.
- Xray managed configurations explicitly set `log.access` to `none`. The new assertion failed against the baseline (`None` rather than `none`), then passed after the minimal configuration change. Real post-fix logs were separately scanned; old logs were not erased or described as clean.
- `NodeAgent.fetch_policy` closes absent/expired authorization before starting the network request and rechecks expiry in `finally`, including when HTTP/retry raises. New tests failed for expiry before retry, expiry during retry, and startup with unavailable control plane. The full Python suite subsequently passed: **58 tests** on the real Ubuntu host. The actual outage was independently rerun, with access closing and fresh traffic denied.
- A separate static review of the narrow source changes reported no critical/important findings; that review did not independently execute the field tests.
- Deployed `agent.py` and `xray.py` were refreshed from the published checkout and their SHA-256 values matched the checkout files exactly; the full Ubuntu Python suite again passed **58 tests**.

## Full CI evidence

Implementation/evidence commit `7806a1a63f624d593a1c9b25232b72d802aa2435` passed the complete GitHub Actions workflow: [run 38030266011](https://github.com/alireza-anari/madar-vpn/actions/runs/38030266011), **SUCCESS**.

All required gates completed successfully: repository secret scan; PostgreSQL schema and destructive backup/restore; restored-Worker HTTP smoke; PostgreSQL driver/rollback smoke and integration suite; JavaScript and Python dependency audits; full JavaScript/TypeScript tests; typecheck; production build; and the full Python suite. This is CI evidence for the actual source fixes; it does not turn the remaining live activity/telemetry/privacy limitations into PASS.

## Safe end-of-test state

Revision 6 with an empty client list was published and ACKed through the real node API. Managed client count and aggregate online count were both `0`; Node Agent, Xray and the loopback-only control plane remained active. The second reboot with the control plane disabled separately demonstrated startup access denial; re-enabling the control plane restored fresh-policy connectivity before the empty cleanup policy was published. The disposable EC2 instance remains allocated for inspection; it was not terminated and historical journals were not erased.

## Verified observation semantics and remaining gate

`sudo ./install.sh observe` exposes aggregate server-observed **online connection presence**. The controlled idle experiment shows that `onlineUsers=1` is compatible with no ongoing response payload. The aggregate count cannot assign duration to an individual client, reveal exact connect/disconnect boundaries, distinguish billable active traffic from idle connections, or establish debit correctness. No raw StatsService/per-client observation was retained as evidence.

Do not generate `ObservedActivity.seconds` from this count by assuming the whole polling interval was active. A separate, verified runtime activity source/algorithm and its telemetry behavior are still required. Real v2rayNG/PWA/provider/production deployment gates are outside this field result. Historical identifier-bearing journal entries remain on the disposable VPS by explicit user choice.

## Historical automated evidence completed before the field run

- Pinned Xray runtime configuration exists for supported architectures and downloaded archives are SHA-256 verified before installation.
- REALITY private key material is generated and retained only in node-local state; the adapter returns only client-safe public parameters.
- Candidate Xray configuration is validated before atomic promotion and service reload.
- Managed-client apply, revoke, fail-closed disable, health and observation contracts are covered by Python tests.
- Enrollment public configuration is resolved lazily and filtered to an explicit client-safe allowlist.
- Node Agent/Xray systemd startup is configured so reboot does not falsely require a pre-existing running process; Xray waits for managed configuration and the agent requests the managed service during startup.
- Managed Xray configuration exposes a `StatsService` observation surface only on `127.0.0.1:10085` and enables `statsUserOnline` for controlled Phase 7 field diagnosis.
- The installer now exposes `sudo ./install.sh observe`, which returns only an aggregate Madar online-user count and never intentionally prints raw StatsService identifiers or captured Xray stdout/stderr.
- The StatsService/observer changes deliberately do not invent billable-seconds semantics. The installed service still does not convert Xray online-user observations into `ObservedActivity` seconds until real-VPS observations establish the exact runtime behavior.
- Logs/tests do not intentionally emit the REALITY private key or node credential.

## TDD evidence for local Xray observation

The first observation-surface regression test was added in commit `3f6e8428322911126ce081cc2148596d7fc9f6d6` (`test: require local Xray observation API`). GitHub Actions run `37973859930` failed at `pnpm test:python` while the preceding repository/security/PostgreSQL/JavaScript/typecheck/build gates passed. The minimum loopback StatsService implementation followed in commit `db31ad49a229c57b93ad3d765a0866868f6ee4b0` (`feat: expose local Xray observation API`), and GitHub Actions run `37974137357` completed successfully.

A second RED cycle added operator-safety tests in commits `0819ad4101f094f2ac8eaf0767b0ccea3e5775bb` (`test: require redacted Xray observation command`) and `0cb4a2d18d86b30c282a4401c45f8af2e237b80b` (`test: expose safe Xray observation through installer entrypoint`). GitHub Actions run `37975197221` passed secret scanning, PostgreSQL checks, dependency audits, JavaScript/TypeScript tests, typecheck and build, then failed at `pnpm test:python` as expected because the safe observer command did not yet exist.

The minimum implementation followed in commits `c5b35875309143e38281a9ffcb657b6d7b7c2efb` (`feat: add redacted Xray observation command`) and `98cbbc822af25b039ac22e28ac605a0d656455a4` (`feat: expose safe Xray observation entrypoint`). GitHub Actions run `37975520891` completed successfully, including secret scan, PostgreSQL schema and destructive backup/restore, restored Worker smoke, PostgreSQL integration tests, JavaScript and Python dependency audits, full JavaScript/TypeScript tests, typecheck, production build, and the Python suite.

The field-facing observer invokes the pinned Xray CLI locally, counts only Madar-managed online-user entries, and prints compact aggregate JSON such as `{"onlineUsers":1}`. If Xray observation fails or returns malformed data, the wrapper emits only `local Xray observation unavailable`; it does not include captured Xray output in the error. Raw `statsgetallonlineusers` output can contain client identifiers derived from VLESS UUIDs and must not be copied into reports, screenshots, chat, tickets, or persistent test artifacts.

## Other recent Phase 7 preparation

- `28fddaaa2035842539a68689c2ea3673ee854dd6` — `feat: run real node service cycle`
- `c93149fa3a62094b7dba42cb0791cc96bf160ec6` — `docs: update node install runbook for Xray bootstrap`
- `9f8449834b92add0dd7a67533b0d49fed3654cfb` — `test: require reboot-safe Xray startup`
- `6c7356240a82efbd5cfc661935f8b3891bb3248c` — `feat: make Xray startup reboot-safe`
- GitHub Actions run `37967785745` on `6c735624...` — PASS

These commits improve the automated/systemd/runtime preparation but are not substitutes for Task 27 field evidence.

## Acceptance still required after the field run

The install/enrollment, direct protocol traffic, aggregate-presence, revoke and corrected outage-expiry checks above were run against real processes. Remaining gates are:

- define and implement a verified per-client activity source and its explicit observation-window algorithm without treating an idle online connection as proof of active traffic;
- demonstrate the resulting real `ObservedActivity`/telemetry path and separately verify debit behavior before claiming usage correctness;
- resolve the retained historical identifier-bearing journal before making a clean-environment privacy claim; do not silently erase logs against the user's instruction;
- validate actual Cloudflare/Hyperdrive deployment and complete the independent v2rayNG/production gates in their proper phases.

## Release gate

Phase 7 is not complete. The direct VLESS+REALITY transport and the bounded checks above now have field evidence, but they do not establish live usage-debit correctness, real v2rayNG compatibility, or Production Ready status. Phase 8 was not started and must not be marked started/completed from this partial field result.
