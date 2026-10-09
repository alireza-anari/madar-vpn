# Madar node installation and lifecycle

This runbook documents the current automated node installer and the automated portion of Phase 7 Xray/VLESS/REALITY integration. It **does not** claim that real VPS traffic or v2rayNG connectivity has been verified. Those remain separate field gates.

## Supported environment

The agent validates Ubuntu LTS `22.04`, `24.04`, or `26.04` on `x86_64`/`amd64` or `aarch64`/`arm64`.

Run the installer as `root`. The installer writes Madar files under `/opt/madar-node-agent`, the pinned Xray runtime under `/opt/madar-xray`, state under `/etc/madar-node-agent`, and systemd units under `/etc/systemd/system`.

The installer intentionally **does not change SSH or firewall configuration**.

## Required install inputs

Set only the public/control-plane and non-secret runtime values before running `install.sh install`:

```bash
export MADAR_API_BASE_URL='https://control.example.com'
export MADAR_NODE_ADDRESS='203.0.113.10'
export MADAR_NODE_PORT='443'
export MADAR_NODE_SERVER_NAME='edge.example.com'
export MADAR_REALITY_TARGET='origin.example.com:443'
export MADAR_REALITY_SHORT_ID='<public-client-safe-value>'
```

`MADAR_REALITY_TARGET` is required explicitly. The installer does not invent a target.

Do **not** set `MADAR_REALITY_PUBLIC_KEY`. The installer downloads the reviewed pinned Xray release for the current supported architecture, verifies its pinned SHA-256 digest, generates the REALITY X25519 keypair locally, retains the private key only on the VPS, and sends only the generated public client-safe value during node enrollment.

Do not place the one-time enrollment token in an environment variable, command-line argument, shell history, documentation, logs, or source control. The wrapper reads it silently from the terminal and passes it to the Python installer on file descriptor 3.

The REALITY private key and raw node credential are VPS-only secrets. They must never be pasted into tickets/chat, copied into Git, or sent to the control plane as configuration.

## Install

From the checked-out `node-agent` directory:

```bash
sudo -E ./install.sh install
```

The installer explains the sensitive changes before prompting for the one-time token. During installation it:

1. stages the Madar Node Agent;
2. downloads the pinned Xray runtime for the host architecture and verifies its checksum;
3. generates the REALITY keypair locally;
4. enrolls through the one-time token using only public node parameters;
5. stores the issued node credential with restrictive permissions;
6. stages both systemd units;
7. starts the Node Agent only after successful enrollment.

The node credential is stored at:

```text
/etc/madar-node-agent/node.credential
```

The credential file is written with owner-only `0600` permissions. The local REALITY private key is also owner-only and remains under the node state directory. Neither secret is written to `agent.env`.

`/etc/madar-node-agent/agent.env` is written with `0600` permissions and contains only the API base URL, credential-file path, pinned Xray binary/version, listener port, server name, explicit REALITY target, and public short ID. It does not contain the node credential value, REALITY private key, or REALITY public key.

Failed enrollment must leave no persisted node credential and must not leave a falsely-ready running service.

## Service behavior

The installed agent unit is `madar-node-agent.service` and runs:

```text
/opt/madar-node-agent/venv/bin/python -m madar_agent.service
```

The managed Xray unit is `madar-xray.service`. It runs the pinned binary against the locally managed configuration only when that configuration exists:

```text
/opt/madar-xray/26.3.27/xray run -c /etc/madar-node-agent/xray-config.json
```

The Xray unit is staged during install but is not treated as ready merely because a unit file exists. The Node Agent applies revisioned policy through the Xray adapter, validates candidate Xray configuration before atomic promotion, and restarts the managed Xray service only after a valid configuration is promoted.

The Node Agent cycle performs real control-plane policy fetch/apply/ack, telemetry collection/posting, Xray health checks, authorization freshness checks, and readiness/capacity heartbeat reporting. If authorization becomes stale, environment validation fails, or managed policy is invalid, managed access fails closed rather than remaining enabled on stale state.

Managed Xray configuration also enables `StatsService` with `statsUserOnline` for Phase 7 field observation. The API is bound only to `127.0.0.1:10085`; it is not a public management endpoint. This observation surface is deliberately separate from billing telemetry: the installed Node Agent does not yet convert Xray online-user observations into billable seconds because the exact real-process activity semantics still require field verification.

Systemd hardening includes restrictive umask/home/system protection. Xray configuration and REALITY private-key state are owner-only.

## Status and non-secret diagnosis

```bash
sudo ./install.sh status
```

For the Phase 7 VPS field test, inspect both services without printing secret file contents:

```bash
sudo systemctl status madar-node-agent.service --no-pager
sudo systemctl status madar-xray.service --no-pager
sudo systemctl is-active madar-node-agent.service
sudo systemctl is-active madar-xray.service
sudo journalctl -u madar-node-agent.service --since '15 minutes ago' --no-pager
sudo journalctl -u madar-xray.service --since '15 minutes ago' --no-pager
```

Before sharing logs, review and redact any bearer values. Never run `cat` on `node.credential` or `reality.private` for evidence collection.

Useful permission checks that do not reveal contents:

```bash
sudo stat -c '%a %U:%G %n' /etc/madar-node-agent/node.credential
sudo stat -c '%a %U:%G %n' /etc/madar-node-agent/reality.private
sudo stat -c '%a %U:%G %n' /etc/madar-node-agent/agent.env
```

Expected secret-file mode is `600`; the node state directory remains restrictive.

## Local-only Xray activity observation

After a valid managed policy has been applied and Xray is running, the Phase 7 operator may inspect Xray's current online-user observation locally on the VPS:

```bash
sudo /opt/madar-xray/26.3.27/xray api statsgetallonlineusers --server=127.0.0.1:10085
```

This command is for controlled field diagnosis only. Its raw response can contain Madar client identifiers derived from VLESS client UUIDs. **Do not paste, upload, screenshot, or persist the raw response as test evidence.** Record only redacted facts such as the number of observed online users and whether the expected state transition occurred before/after connect or revoke.

The local StatsService proves only that Xray exposes an observation primitive. It does **not** prove a connection-duration model, session boundaries, billable seconds, or usage-debit correctness. During the real-VPS test, compare repeated local observations with known client connect/disconnect/revoke events and document the actual semantics before any runtime adapter is permitted to turn those observations into `ObservedActivity` seconds.

Do not expose port `10085` through the VPS firewall or a public bind. The managed configuration is expected to keep it on loopback only.

## Update

```bash
sudo ./install.sh update
```

The lifecycle command refreshes the checked-out agent/service assets and restarts `madar-node-agent.service`. It is not a general remote release channel. Any real-VPS update result must be recorded separately in the production-readiness lifecycle acceptance.

## Remove

```bash
sudo ./install.sh remove
```

Removal stops/disables both `madar-node-agent.service` and `madar-xray.service`, then removes the node credential, agent files, Xray runtime files, staged units, and node state path according to the lifecycle implementation. It does not alter SSH or firewall configuration.

After removal, verify that Madar-managed paths are gone without copying any deleted secret elsewhere.

## Phase 7 real-VPS acceptance checklist

The automated suite is not a substitute for this field test. On a disposable supported Ubuntu VPS, Task 27 remains incomplete until all of the following are observed against real processes and real traffic:

- install with the real installer;
- successful one-time node enrollment;
- healthy Node Agent and Xray systemd services after a valid managed policy is applied;
- Xray accepts an authorized VLESS client credential;
- revoked credential stops working after policy propagation;
- real traffic/activity produces documented server-observed telemetry semantics;
- repeated local-only StatsService observations are correlated with known connect/disconnect/revoke events without retaining raw client identifiers;
- stale policy expires into fail-closed access;
- no node credential or REALITY private key appears in control-plane data, logs, screenshots, or evidence.

Record the actual field result only in `docs/test-reports/phase-7-vps.md` after the real test is run. A template or automated test result alone is not a PASS.

## Enrollment and recovery safety rules

- Enrollment tokens are one-time and short-lived; issue a new token instead of replaying an old one.
- Node credentials are stored hash-only by the control plane and plaintext only on the node with restrictive permissions.
- REALITY private keys are generated and retained locally on the VPS only.
- Never expose the node credential, enrollment token, REALITY private key, session secrets, subscription tokens, provider secrets, or raw per-client StatsService output in commands shared outside the VPS, screenshots, CI logs, or documentation.
- Do not weaken credential/key permissions to bypass environment validation.
- Do not mark a node ready merely because systemd is active; readiness requires fresh authorization, valid policy, real Xray health, and control-plane acknowledgement state.
- A stale authorization is a fail-closed condition, not a reason to keep managed access enabled.

## Verification scope

Automated tests currently cover installer safety, lifecycle commands, credential permissions, explicit runtime configuration, pinned Xray release/checksum handling, local REALITY key generation/redaction, Xray configuration validation/promotion, client application/revocation boundaries, policy freshness/fail-closed behavior, telemetry sequencing, node enrollment/authentication, policy acknowledgements, readiness/capacity reporting, systemd staging, loopback-only Xray StatsService configuration, and secret redaction.

Still **unverified in the real integration gate**: disposable VPS install/update/remove behavior, live Xray/VLESS/REALITY traffic, live credential revocation, exact real activity/usage observation semantics, translation of verified observations into billable `ObservedActivity` seconds, stale-policy shutdown against a real Xray process, and real v2rayNG compatibility. Do not describe any of those as operational until their respective Phase 7/8 acceptance evidence exists.
