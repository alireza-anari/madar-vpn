# Madar node recovery and replacement

This runbook defines the safe recovery path for a Madar VPN node. It complements `docs/runbooks/node-install.md` and the control-plane node-retirement behavior.

The current recovery model is **replacement-first**. A failed, lost, or compromised node is retired in the control plane, its active node credentials are revoked, and a replacement enrolls with a fresh one-time enrollment token. An old node credential or used enrollment token is never reused as a recovery shortcut.

## Recovery status and verification boundary

Automated tests verify:

- one-time enrollment-token consumption and replay rejection;
- hash-only node-credential storage in the control plane;
- explicit node retirement that revokes active credentials and marks the node offline;
- the administrator delete route retires the node before removing the admin surface record;
- stale heartbeat/policy behavior remains fail-closed;
- installer local lifecycle behavior and secret-file permissions.

A real disposable VPS is not available in the current execution environment. Therefore real reinstall/re-enroll, real `update`, real `remove`, Xray service behavior, and live replacement traffic remain **BLOCKED / NOT RUN**. This runbook does not turn those external acceptance items into PASS.

## When to use replacement recovery

Use this procedure when a node is:

- lost or unrecoverable;
- suspected compromised;
- being rebuilt after OS/VPS replacement;
- intentionally decommissioned and replaced;
- unable to recover cleanly through a non-secret local service restart.

If compromise is suspected, do not copy the old node credential, `/etc/madar-node-agent` state, or REALITY private key to the replacement host.

## Mandatory order: retire server-side first

For a lost or untrusted node, revoke server-side authorization before local cleanup.

1. In the Madar admin Servers view, remove/retire the affected node.
2. The control plane must revoke its active node credentials and mark it offline before the admin surface record is removed.
3. Treat the old node credential as permanently invalid after retirement.
4. Do not rely on deleting local files alone: a copied credential could exist elsewhere.

If the control plane cannot confirm retirement, stop the recovery procedure and resolve control-plane availability first. Do not create a replacement while intentionally leaving a known old credential authorized.

## Clean up the old host when reachable

If the old VPS is still under trusted administrative control, run the local lifecycle removal after server-side retirement:

```bash
sudo ./install.sh remove
```

The current installer implementation stops/disables `madar-node-agent.service` and removes the node credential, installed agent root, systemd unit, and managed local state according to the lifecycle implementation.

Do not print or copy the credential before removal. Do not weaken file permissions to inspect it.

If the VPS is compromised or access is untrusted, prefer destroying/reprovisioning the VPS at the provider rather than attempting an in-place cleanup.

## Provision the replacement node

Use a clean supported Ubuntu LTS host. Follow `docs/runbooks/node-install.md` for the supported environment and public configuration inputs.

In the admin application:

1. Open Servers.
2. Choose Add Node.
3. Enter the intended node metadata.
4. Generate a **new** short-lived one-time enrollment token.
5. Transfer the token only through the approved interactive installer input. Never put it in a command argument, environment variable, source file, screenshot, ticket, chat message, or shell history.

On the replacement VPS:

```bash
sudo -E ./install.sh install
```

Enter the fresh enrollment token only when prompted. The installer writes the returned node credential to:

```text
/etc/madar-node-agent/node.credential
```

The credential file must remain owner-only (`0600`). The raw node credential belongs only on that VPS; the control plane stores only its hash.

## REALITY key handling during replacement

The REALITY private key is node-local secret material.

- Never send it to the control plane.
- Never place it in source control, CI, screenshots, logs, support tickets, or the admin UI.
- If compromise is suspected, generate fresh REALITY key material on the replacement VPS rather than copying the old private key.
- Only client-safe public REALITY parameters may be published through the control plane/subscription path.

## Readiness after re-enrollment

Enrollment success alone is not Ready.

Do not advertise or treat the replacement as ready until the control plane has real evidence for the required state, including fresh node authentication, fresh heartbeat/health, acceptable capacity, current policy retrieval/acknowledgement, and the later Phase 7 Xray readiness gate.

A running systemd unit by itself is not proof that VPN traffic works.

## Enrollment-token and credential failure cases

- A used enrollment token must be rejected on replay.
- An expired enrollment token must be rejected.
- An invalid node credential must be rejected.
- A retired node credential must be rejected even if a stale copy still exists on disk elsewhere.
- If enrollment fails, request a fresh token instead of trying to reuse an old one.

## Update lifecycle

For a healthy trusted node, the current lifecycle command is:

```bash
sudo ./install.sh update
```

The current implementation refreshes the installed agent/service assets from the checked-out installer source and restarts `madar-node-agent.service`.

It is **not** yet a remote release updater and is **not** an Xray updater. Do not infer successful VPN/Xray upgrade from a successful agent update command.

After update, verify service state and then wait for fresh control-plane health/readiness evidence. Do not preserve an old Ready status across an update without a new heartbeat.

## Remove lifecycle

For a planned decommission:

1. retire/delete the node in the control plane first so active node credentials are revoked;
2. then run:

```bash
sudo ./install.sh remove
```

3. verify the service and managed files are no longer present as expected;
4. destroy/reuse the VPS only according to the infrastructure policy.

Local `remove` without server-side retirement is insufficient for credential revocation.

## Diagnostics without secret exposure

Safe starting points:

```bash
sudo ./install.sh status
sudo systemctl status madar-node-agent.service
sudo journalctl -u madar-node-agent.service --since '15 minutes ago'
```

Before sharing logs, review them for bearer tokens, node credentials, enrollment tokens, subscription URLs, session secrets, and private-key material. The project includes automated redaction/scanning defenses, but operators must still treat raw diagnostic output as sensitive.

## Recovery acceptance checklist

Automated/control-plane checks:

- [x] old active node credential can be explicitly revoked by retirement;
- [x] retired credential is rejected by node authentication;
- [x] admin deletion retires before removing the admin surface record;
- [x] one-time enrollment token replay is rejected;
- [x] credential persistence is hash-only in the control plane;
- [x] installer lifecycle behavior and restrictive secret-file permissions are unit/integration tested.

Real disposable-VPS checks still required:

- [ ] retire an enrolled real disposable node and prove the old agent credential can no longer call node APIs;
- [ ] reinstall/re-enroll a clean replacement with a fresh one-time token;
- [ ] prove no old credential/private key is reused or exposed;
- [ ] run real `update` and verify service recovery plus fresh heartbeat/readiness;
- [ ] run real `remove` and verify service/local managed credential cleanup;
- [ ] verify Xray/VLESS/REALITY and real traffic after replacement through the Phase 7/8 gates.

Until those real-VPS items are executed, Task 32's VPS lifecycle acceptance remains **BLOCKED**, not PASS.
