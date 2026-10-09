# Phase 7 VPS Integration Report

Date: 2026-10-09
Branch: `impl/phase-1`

## Status

**Phase 7: BLOCKED on real-VPS verification.**

The automated Task 26 portion and additional real-service preparation are implemented and CI-verified. Task 27 is intentionally not marked PASS because this execution environment has not exercised a disposable supported Ubuntu VPS with real node credentials and real client traffic. No real Xray/VLESS/REALITY handshake, traffic traversal, live revoke, exact activity-duration semantics, v2rayNG compatibility, or production readiness claim is made here.

## Automated evidence completed

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

## Real-VPS acceptance still required

The following Task 27 items remain **BLOCKED / NOT RUN** until a disposable supported Ubuntu VPS is exercised:

- install through the real installer;
- verify Xray and Madar Agent systemd health with real processes, including reboot behavior;
- enroll with a fresh one-time token;
- apply a real user policy and prove Xray accepts the authorized VLESS credential;
- generate real client traffic through VLESS + REALITY;
- use repeated `sudo ./install.sh observe` aggregate observations before/during/after known client transitions to establish the exact server-observed online/activity semantics without retaining raw client identifiers;
- define the translation to `ObservedActivity` seconds only after those semantics are demonstrated, then verify telemetry/debit behavior separately;
- revoke the credential and prove live access is removed after policy propagation;
- verify stale-policy fail-closed behavior against the running Xray service;
- verify no node credential, enrollment token, REALITY private key, or raw per-client observation leaks into control-plane data, logs, screenshots, reports, or CI artifacts.

## Release gate

Phase 7 is not complete. Phase 8 must not be marked started/completed on the basis of automated configuration tests alone, and the project is not permitted to claim real VPN integration, real v2rayNG compatibility, usage-debit correctness from live traffic, or Production Ready status until the corresponding field/E2E gates have actual evidence.
