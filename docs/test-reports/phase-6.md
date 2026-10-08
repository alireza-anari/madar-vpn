# Phase 6 — Node enrollment + Agent verification

Date: 2026-10-08
Branch: `impl/phase-1`

## Status

- Task 23 — Node enrollment/control-plane APIs: **PASS** for the automated enrollment, authentication, heartbeat/readiness, policy ACK, telemetry idempotency, and secret-redaction boundaries.
- Task 24 — Python Agent core with fail-closed policy: **PASS** for the automated environment validation, policy freshness, Free/Premium policy distinction, telemetry sequencing, and bounded retry behavior.
- Task 25 — Safe installer and lifecycle commands: **PASS** for the automated installer safety, credential permissions, failed-enrollment cleanup, hardened systemd unit, and `status`/`update`/`remove` lifecycle behavior.
- Real Xray/VLESS/REALITY operation: **INTEGRATION-UNVERIFIED**. Phase 6 intentionally uses the Xray adapter boundary/test doubles and does not claim real VPN operation.
- Real VPS installer execution: **INTEGRATION-UNVERIFIED**. Disposable VPS installation and live revoke/fail-closed behavior remain Phase 7 acceptance work.

## Node control-plane evidence

Automated TypeScript tests cover the Task 23 control-plane rules:

- enrollment tokens are short-lived, one-time, and stored hash-only;
- replayed or expired enrollment tokens are rejected;
- issued node credentials are persisted hash-only by the control plane;
- node authentication returns only a safe node principal and rejects invalid credentials;
- public node configuration drops unapproved secret fields such as a REALITY private key or raw credential;
- heartbeat readiness becomes unavailable after the configured stale window;
- only newer policy revisions are returned to a node;
- policy ACK records both the node revision and the per-user policy revisions;
- telemetry is deduplicated by node/window/sequence;
- telemetry persistence drops unapproved node credentials and private-key fields;
- node-facing routes reject unauthorized heartbeat/policy/telemetry calls at the credential boundary.

The schema for this phase is introduced in `apps/api/migrations/0012_node_control.sql` and the service/repository behavior is implemented under `apps/api/src/nodes/`.

## Agent core evidence

Automated Python tests cover the Task 24 agent rules:

- unsupported Ubuntu/environment state is rejected;
- supported architecture/version validation is explicit;
- missing, non-regular, symlinked, wrong-owner, or overly-permissive credential state is treated as invalid;
- Free clients retain an explicit positive speed policy while Premium remains uncapped at this boundary;
- stale policy application disables managed access instead of continuing authorization;
- if an already-applied authorization expires and refresh returns no newer policy, managed access is disabled fail-closed;
- usage collection produces monotonic per-window sequence numbers;
- control-plane request/response parsing is isolated behind the agent API layer;
- retry is bounded, exponential delay is capped, and non-retryable errors fail immediately without sleeping.

The current Xray boundary is deliberately minimal/test-double backed. It supports managed client application, fail-closed disable, and observed-activity collection for Phase 6 tests only; the real pinned Xray runtime is a Phase 7 deliverable.

## Installer and lifecycle evidence

Automated installer tests verify:

- the installer explains sensitive changes before installation;
- the one-time enrollment token is not printed in installer output or enrollment errors;
- the HTTP enrollment request sends the one-time token only as the authorization bearer and not inside the JSON body;
- the installer explicitly states that SSH and firewall configuration are not modified by default;
- the issued node credential is written with owner-only `0600` permissions before service start;
- failed enrollment does not enable/start the service and leaves no credential behind;
- `status`, `update`, and `remove` expose explicit lifecycle behavior;
- the systemd service uses restrictive defaults including `UMask=0077`, `NoNewPrivileges=true`, `PrivateTmp=true`, `ProtectHome=true`, and `ProtectSystem=strict`;
- agent state is restricted to `/etc/madar-node-agent` through the service write-path boundary.

Operational usage and safety constraints are documented in `docs/runbooks/node-install.md`.

## Security interpretation

Phase 6 keeps node secrets out of public/control-plane surfaces:

- enrollment tokens and node credentials are not stored in plaintext by the control plane;
- the node credential is local-only plaintext with restrictive file permissions;
- the REALITY private key is not part of the Phase 6 enrollment public configuration and must never leave the VPS;
- telemetry and public node config are filtered so unapproved credential/private-key fields are not persisted;
- stale authorization is fail-closed rather than permissive.

No credential, enrollment token, REALITY private key, or other bearer secret is recorded in this report.

## Verification gate

Full verification after adding the Phase 6 installer runbook:

- Commit: `64d2ac47df02306fc9a7daa0bcc4dfc8ad1406c8`
- GitHub Actions run: `37822867478`
- `pnpm install --frozen-lockfile`: PASS
- Python dev dependency install: PASS
- `pnpm test`: PASS
- `pnpm typecheck`: PASS
- `pnpm build`: PASS
- `pnpm test:python`: PASS

The immediately preceding implementation head `d9392e98d39baa3395fe6d9b5adfde757a197f13` also completed CI successfully after the fail-closed node-agent service loop was added.

## Gate interpretation

The **Phase 6 automated gate is satisfied**: enrollment, Agent policy/telemetry behavior, installer safety, lifecycle commands, and full repository verification are green.

This status is **Implementation/Tested**, not Xray Integration Verified. Phase 7 must still implement and test the pinned Xray/VLESS/REALITY adapter, REALITY private-key handling, and then run the disposable real-VPS acceptance before any real VPN-operation claim is allowed.
