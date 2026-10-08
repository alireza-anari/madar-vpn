# Madar node-agent installation and lifecycle

This runbook documents the current **automated Phase 6 node-agent installer**. It does not claim that Xray/VLESS/REALITY is operational; the installer currently enrolls the node and runs the fail-closed agent while Xray integration remains Phase 7 work.

## Supported environment

The agent validates Ubuntu LTS `22.04`, `24.04`, or `26.04` on `x86_64`/`amd64` or `aarch64`/`arm64`.

Run the installer as `root`. The installer writes Madar files under `/opt/madar-node-agent`, state under `/etc/madar-node-agent`, and the systemd unit at `/etc/systemd/system/madar-node-agent.service`.

The installer intentionally **does not change SSH or firewall configuration**.

## Required install inputs

Set the public/control-plane values before running `install.sh install`:

```bash
export MADAR_API_BASE_URL='https://control.example.com'
export MADAR_NODE_ADDRESS='203.0.113.10'
export MADAR_NODE_PORT='443'
export MADAR_NODE_SERVER_NAME='edge.example.com'
export MADAR_REALITY_PUBLIC_KEY='<public-client-safe-value>'
export MADAR_REALITY_SHORT_ID='<public-client-safe-value>'
```

Do not place the one-time enrollment token in an environment variable, command-line argument, shell history, documentation, logs, or source control. The wrapper reads it silently from the terminal and passes it to the Python installer on file descriptor 3.

The REALITY **private** key must never be supplied to this installer or sent to the control plane. Phase 7 is responsible for generating and retaining that private key on the VPS only.

## Install

From the checked-out `node-agent` directory:

```bash
sudo -E ./install.sh install
```

The installer explains the sensitive changes before prompting for the one-time token. On successful enrollment it stores the issued node credential at:

```text
/etc/madar-node-agent/node.credential
```

The credential file is written with owner-only `0600` permissions. `/etc/madar-node-agent/agent.env` is also written with `0600` permissions and contains only the API base URL and credential-file path.

The service is enabled and started only after enrollment succeeds and the credential is persisted. Failed enrollment must leave no credential and must not leave a falsely-ready running service.

## Service behavior

The installed unit is `madar-node-agent.service` and runs:

```text
/opt/madar-node-agent/venv/bin/python -m madar_agent.service
```

The unit uses `UMask=0077`, `NoNewPrivileges=true`, `PrivateTmp=true`, `ProtectHome=true`, `ProtectSystem=strict`, and permits writes only to `/etc/madar-node-agent`.

The current agent is fail-closed: if its existing authorization expires and no fresh policy is available, managed access is disabled through the Xray adapter boundary rather than continuing on stale authorization.

## Status

```bash
sudo ./install.sh status
```

The command reports the systemd service state exposed by the installer lifecycle implementation.

For additional diagnosis, use normal systemd tooling without printing credential contents:

```bash
sudo systemctl status madar-node-agent.service
sudo journalctl -u madar-node-agent.service --since '15 minutes ago'
```

Do not paste logs into tickets or chat until they have been reviewed for secrets.

## Update

```bash
sudo ./install.sh update
```

The current Phase 6 lifecycle command refreshes the installed files/service assets from the checked-out installer source and restarts `madar-node-agent.service`. It is not yet a remote release updater or an Xray updater.

## Remove

```bash
sudo ./install.sh remove
```

Removal stops/disables the service and removes the node credential, installed agent root, and systemd unit according to the lifecycle implementation.

After removal, inspect `/etc/madar-node-agent` and delete any intentionally retained non-secret state only if operational policy requires it. Never copy the removed credential elsewhere.

## Enrollment and recovery safety rules

- Enrollment tokens are one-time and short-lived; request a new token instead of replaying an old one.
- Node credentials are stored hash-only by the control plane and plaintext only on the node with restrictive permissions.
- Never expose the node credential, enrollment token, REALITY private key, session secrets, or subscription tokens in commands, screenshots, CI logs, or documentation.
- Do not weaken credential file permissions to bypass environment validation.
- Do not mark a node ready merely because systemd is active; readiness also depends on fresh heartbeat/policy state and later Phase 7 Xray health.
- A stale authorization is a fail-closed condition, not a reason to keep managed access enabled.

## Verification scope

Phase 6 automated tests cover installer safety, lifecycle commands, credential permissions, failed-enrollment cleanup, environment validation, policy freshness/fail-closed behavior, telemetry sequencing, node enrollment/authentication, readiness freshness, policy acknowledgements, telemetry deduplication, and secret redaction.

Real Xray installation, REALITY private-key generation, live VPS traffic, revoke behavior against a live Xray process, and v2rayNG connectivity are explicitly outside this runbook's verified scope until the Phase 7 and Phase 8 gates pass.
