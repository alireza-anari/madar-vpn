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
- The StatsService change deliberately does not invent billable-seconds semantics. The installed service still does not convert Xray online-user observations into `ObservedActivity` seconds until real-VPS observations establish the exact runtime behavior.
- Logs/tests do not intentionally emit the REALITY private key or node credential.

## TDD evidence for local Xray observation

A regression test was added first in commit `3f6e8428322911126ce081cc2148596d7fc9f6d6` (`test: require local Xray observation API`). GitHub Actions run `37973859930` failed at `pnpm test:python` while the preceding repository/security/PostgreSQL/JavaScript/typecheck/build gates passed. This is the expected RED state.

The minimum implementation followed in commit `db31ad49a229c57b93ad3d765a0866868f6ee4b0` (`feat: expose local Xray observation API`). GitHub Actions run `37974137357` completed successfully, including repository secret scan, PostgreSQL schema and destructive backup/restore, restored Worker smoke, PostgreSQL integration tests, dependency audits, full JavaScript/TypeScript tests, typecheck, production build, and the Python suite.

The observation API is loopback-only. Raw output from `statsgetallonlineusers` can contain Madar client identifiers derived from VLESS client UUIDs and must not be copied into reports, screenshots, chat, tickets, or persistent test artifacts. Real field evidence should retain only redacted/aggregate observations and state transitions.

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
- use repeated loopback-only StatsService observations to establish the exact server-observed online/activity semantics without retaining raw client identifiers;
- define the translation to `ObservedActivity` seconds only after those semantics are demonstrated, then verify telemetry/debit behavior separately;
- revoke the credential and prove live access is removed after policy propagation;
- verify stale-policy fail-closed behavior against the running Xray service;
- verify no node credential, enrollment token, REALITY private key, or raw per-client observation leaks into control-plane data, logs, screenshots, reports, or CI artifacts.

## Release gate

Phase 7 is not complete. Phase 8 must not be marked started/completed on the basis of automated configuration tests alone, and the project is not permitted to claim real VPN integration, real v2rayNG compatibility, usage-debit correctness from live traffic, or Production Ready status until the corresponding field/E2E gates have actual evidence.
