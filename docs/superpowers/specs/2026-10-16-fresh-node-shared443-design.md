# Fresh Node Shared-443 Provisioning Design

Date: 2026-10-16
Branch: `impl/telegram-sales-bot`

## Problem

The current fresh-VPS sales-node installer provisions protocol v2 accounts as independent public Xray listeners on ports `20000-20999`. The node config keeps `port=443`, but no Xray process actually listens on public TCP 443 after account activation. Delivery therefore emits account-specific public ports unless the node advertises `shared-443`.

Field evidence from the Stockholm node confirms the broken shape:

- protocolVersion: 2
- SNI: `www.microsoft.com`
- configured public port: 443
- `shared443`: false
- listener: public `*:20000`
- stats listener: loopback `127.0.0.1:21000`
- no listener on 443

The owner's existing Personal node works with a different architecture: one public VLESS+REALITY frontend on TCP 443, while per-account quota workers are loopback-only and are reached through internal VLESS bridge routes.

The fresh installer also hardcodes `www.microsoft.com` as the REALITY destination/SNI. Earlier field validation for this project found the Microsoft target unreliable for REALITY on the tested path while `www.cloudflare.com` worked with the same keys.

## Goal

Fresh VPS installation from the Telegram sales bot must produce the same public network shape as the known-working Personal shared-443 design without depending on a pre-existing Xray installation.

Success means:

1. Only TCP 443 is public for VPN traffic.
2. Account bridge ports `20000-20999` bind only to loopback.
3. Stats/API ports `21000-21999` bind only to loopback.
4. Every active account is delivered as `vless://...@node:443?...`.
5. The node advertises `shared-443` only after the shared frontend and quota workers are actually healthy.
6. Account quota, expiry, revocation, process isolation and fail-closed behavior remain unchanged.
7. Fresh nodes default to `www.cloudflare.com` for REALITY SNI/destination unless an explicit reviewed node setting overrides it.
8. AWS automatic ingress opens SSH from the runner source and TCP 443 globally, but never opens `20000-20999` publicly.

## Architecture

### Public frontend

A fresh node owns a single Xray VLESS+REALITY frontend on `0.0.0.0:443`.

The frontend uses the locally generated REALITY private key, short ID and configured SNI. It exposes HandlerService only on loopback, using the same dynamic-user mechanism already implemented for Personal shared-443 adoption.

Managed account users are added and removed from the public frontend without restarting it during normal account lifecycle changes.

### Per-account quota workers

Each account retains an independent Xray child process so a quota, expiry, revocation or metering failure can terminate only that account's streams.

For account port P in `20000-20999`:

- bridge listener: `127.0.0.1:P`
- stats listener: `127.0.0.1:(P+1000)`
- bridge transport: plaintext VLESS over loopback only
- bridge credential: deterministic private credential derived from node policy key and port

The public frontend routes each managed public user to its matching loopback worker.

No account worker may bind an account port to `0.0.0.0` or `::`.

### Capability advertisement

Protocol v2 ACK capabilities become:

- `quota-v2`
- `per-account-process`
- `shared-443`

The `shared-443` capability must only be emitted when the runtime was configured for shared 443 and the shared frontend identity/liveness check succeeds.

Delivery already understands this capability and must continue to use `node.vpn_port` (443) for such nodes rather than `managed_accounts.listen_port`.

## Fresh installation flow

1. Runner performs existing Ubuntu, sudo, disk and ownership preflight checks.
2. Runner verifies TCP 443 is free for a brand-new node, or owned by the same Madar installation for recovery.
3. Runner verifies all bridge/stats ports required by quota v2 are available locally before installation.
4. Runner generates node token, policy key, X25519 keypair and short ID locally.
5. Fresh config is written with:
   - `protocolVersion=2`
   - `port=443`
   - `shared443=true`
   - `sni=www.cloudflare.com` by default
6. Installation initializes durable quota state before agent startup.
7. Agent starts the shared public frontend even when there are no managed accounts, so 443 is a real health boundary rather than a nominal database value.
8. Account workers are created on demand from signed policy.
9. Node ACKs healthy only after the public frontend, policy runtime and required active account workers are healthy.

## Xray configuration rules

Fresh shared frontend must preserve the useful properties of `shared443.py` while not requiring an original third-party config.

The frontend contains:

- one public VLESS+REALITY inbound on 443
- loopback HandlerService inbound
- one loopback VLESS outbound per supported bridge port
- routing by managed user email/tag to the matching bridge outbound
- normal direct outbound retained for non-managed/default traffic only where explicitly required

The per-account backend uses the existing `backend_config` pattern and MUST bind the account inbound to `127.0.0.1`.

The implementation should reuse one shared-443 construction path rather than maintain two subtly different frontend designs for Personal and fresh nodes.

## AWS network policy

The EC2 runner role continues to use temporary IMDSv2 credentials and must not accept or persist AWS access keys.

For a matched running EC2 instance, automatic ingress is limited to:

- SSH port: runner public `/32`
- TCP 443: `0.0.0.0/0`

The previous public rule for `20000-20999` is removed from new enrollment behavior.

This change does not automatically revoke an already-created broad rule during code deployment. Existing Stockholm ingress should be narrowed deliberately during field rollout after the new runtime is confirmed on 443, to avoid creating a rollback dependency.

## REALITY target policy

Default fresh-node SNI/destination changes from `www.microsoft.com` to `www.cloudflare.com` based on the project's prior field result.

The value must live in one explicit installer constant/configuration point rather than being duplicated through rendering code.

The private REALITY key remains local to the VPS and must never be logged, returned through the bot, stored in D1, or passed in command-line arguments.

## Failure behavior

The system remains fail-closed:

- no valid signed policy -> managed account workers are stopped
- expired policy -> managed account workers are stopped
- quota state ambiguity -> affected worker is stopped and blocked
- shared frontend restart/identity loss -> managed users are treated unhealthy and cannot be silently re-authorized
- failed account worker startup -> node health/ACK cannot claim the account is ready
- failed public 443 frontend startup -> node cannot become ready

A fresh install must never fall back to public per-account ports if shared-443 setup fails.

## Test-first changes

Before production code changes, add failing regression tests covering:

1. Fresh installer config defaults to `shared443=true`, `port=443`, `protocolVersion=2` and `sni=www.cloudflare.com`.
2. AWS network configuration requests only SSH and 443 ingress and does not request `20000-20999`.
3. Fresh shared frontend has one public 443 REALITY listener.
4. Per-account quota backend binds account port to `127.0.0.1` and stats port to loopback.
5. Protocol v2 healthy ACK includes `shared-443` for fresh nodes.
6. Account delivery for a fresh shared node contains `:443?` and never `:20000?`.
7. Fresh-node shared frontend can add a managed account, observe positive counters, cut the live stream by stopping the account worker, and keep the frontend alive.

The tests must be observed failing for the expected old behavior before implementation, then the complete sales-runner, sales-node and sales-bot suites must pass.

## Rollout

Code deployment and VPS migration are separate operations.

1. Land tests and implementation on `impl/telegram-sales-bot`.
2. Require green CI for sales-runner, sales-node and Worker/bot tests.
3. Deploy/update the sales Worker and the Runner source used by the live runner.
4. Do not mutate Stockholm in place while old account state is considered valid.
5. Because the current environment is intentionally a test environment, remove/reissue the test account or reset the node through the bot after database/runner compatibility is confirmed.
6. Reinstall Stockholm from the bot with the new fresh shared-443 path.
7. Verify on VPS without printing secrets:
   - `*:443` is listening
   - no public `*:20000-20999` listener exists
   - loopback account and stats listeners exist only after an account is active
8. Verify D1 reports `quota-v2,per-account-process,shared-443` and exact policy revision ACK.
9. Issue a new test account and verify its URI uses 443.
10. Verify real client connectivity and actual data transfer.
11. Verify quota/expiry/revocation cuts an existing stream.
12. Only after 443 field success, remove any old AWS public `20000-20999` ingress rule.

## Non-goals

- No change to seller/admin roles.
- No change to Telegram invitation flow.
- No weakening of quota durability or restart fail-closed rules.
- No exposure of stats or handler APIs outside loopback.
- No automatic adoption of arbitrary existing Xray servers.
- No secret migration through D1 or Telegram.

## Acceptance gate

This bug is not considered fixed merely because CI is green. Completion requires one real fresh-VPS field run where:

- bot installation succeeds,
- public 443 is the only VPN ingress,
- issued URI uses 443,
- a real client transfers data,
- usage counters increase,
- quota/revocation/expiry enforcement is witnessed,
- node remains healthy and ACKed after the test.
