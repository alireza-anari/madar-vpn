# Madar node recovery and replacement

This runbook defines the safe recovery path for a Madar VPN node. It complements `docs/runbooks/node-install.md` and the control-plane node-retirement behavior.

The recovery model is **replacement-first**. A failed, lost, compromised, or intentionally replaced node is retired in the control plane, its active node credentials are revoked, and a replacement enrolls with a fresh one-time enrollment token. An old node credential, used enrollment token, or old REALITY private key is never reused as a recovery shortcut.

## Recovery status and verification boundary

Automated tests currently verify:

- one-time enrollment-token consumption and replay rejection;
- hash-only node-credential storage in the control plane;
- explicit node retirement that revokes active credentials and marks the node offline;
- the administrator delete route retires the node before removing the admin surface record;
- stale heartbeat/policy behavior remains fail-closed;
- installer local lifecycle behavior and secret-file permissions;
- pinned Speed Enforcer release selection for Linux `amd64` and `arm64`;
- SHA-256 verification before a Speed Enforcer binary is accepted;
- atomic executable replacement for the Speed Enforcer binary;
- three-service installer ownership for Agent, Xray, and Speed Enforcer;
- `install` and `update` fetch/verify the pinned Speed Enforcer before lifecycle mutation;
- `status`, `observe`, and `remove` never require a release download;
- PostgreSQL backup/restore and restore-smoke behavior in CI.

The operator's Task 32 field handoff records real Node2 update, retirement, old-credential rejection, remove and fresh re-enrollment against installer source `7834fe6c000411e61d22208df4d50f1184a80a2e`. Complete recovery acceptance remains **BLOCKED**: policy/ACK diagnostics used direct SQL, and that source lacks an operational application policy-publication path. Real replacement traffic and final safe recovery/cleanup remain unproved. See `docs/test-reports/phase-10-recovery.md` for historical versus freshly verified evidence. Do not use direct SQL policy seeding or automated coverage to claim field PASS.

## Pinned Speed Enforcer release

The installer uses the versioned release tag:

```text
speed-enforcer-v0.1.0
```

The release contains separate Linux `amd64` and `arm64` binaries. Their SHA-256 digests are pinned in `node-agent/madar_agent/speed_release.py`; the installer does not accept a URL/checksum override from CLI arguments or environment variables.

For `install` and `update`, the installer must:

1. resolve the current host to a supported pinned release asset;
2. download only over HTTPS from the approved GitHub release origins;
3. reject empty, oversized, wrong-origin, or digest-mismatched payloads;
4. complete verification before mutating installer-managed runtime state;
5. install the executable atomically at `/opt/madar-speed-enforcer/madar-speed-enforcer` with executable permissions.

If release verification fails, stop. Do not work around the failure with an unpinned binary, a manually supplied checksum, or a moving `latest` URL.

## When to use replacement recovery

Use this procedure when a node is:

- lost or unrecoverable;
- suspected compromised;
- being rebuilt after OS/VPS replacement;
- intentionally decommissioned and replaced;
- unable to recover cleanly through a trusted local update/restart.

If compromise is suspected, do not copy the old node credential, `/etc/madar-node-agent` state, or REALITY private key to the replacement host.

## Mandatory order: retire server-side first

For a lost or untrusted node, revoke server-side authorization before local cleanup.

1. Confirm another healthy eligible node remains available when service continuity matters.
2. In the Madar admin Servers view, remove/retire the affected node.
3. The control plane must revoke its active node credentials and mark it offline before the admin surface record is removed.
4. Treat the old node credential as permanently invalid after retirement.
5. Do not rely on deleting local files alone: a copied credential could exist elsewhere.

If the control plane cannot confirm retirement, stop the recovery procedure and resolve control-plane availability first. Do not create a replacement while intentionally leaving a known old credential authorized.

## Prove the retired credential is rejected

When the retired VPS remains reachable, prove server-side retirement before local removal. A root-only probe may read the existing credential internally and call a node-authenticated endpoint, but it must print only the HTTP status/classification.

Expected result: the old credential is rejected, normally with HTTP `401`.

Never place the credential in shell arguments, output, logs, screenshots, tickets, or chat messages.

## Clean up the old host when reachable

After server-side retirement and rejection proof, run:

```bash
sudo ./install.sh remove
```

The installer owns all three runtime services and their managed files:

- `madar-node-agent.service`;
- `madar-xray.service`;
- `madar-speed-enforcer.service`.

Removal stops/disables all three services and removes the managed Agent, Xray, Speed Enforcer, systemd-unit, credential, and state paths. It then reloads systemd.

Required cleanup verification includes absence of:

```text
/opt/madar-node-agent
/opt/madar-xray
/opt/madar-speed-enforcer
/etc/madar-node-agent
/etc/systemd/system/madar-node-agent.service
/etc/systemd/system/madar-xray.service
/etc/systemd/system/madar-speed-enforcer.service
```

SSH and firewall configuration are outside installer ownership and must remain unchanged.

If the VPS is compromised or administrative access is untrusted, prefer destroying/reprovisioning the VPS at the provider rather than attempting in-place cleanup.

## Provision the replacement node

Use a clean supported Ubuntu LTS host. Follow `docs/runbooks/node-install.md` for supported environment and public configuration inputs.

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
- Generate fresh REALITY key material on a clean replacement instead of copying the old private key.
- Only client-safe public REALITY parameters may be published through the control plane/subscription path.

For field acceptance, compare old/new key material only through a one-way local comparison and print a boolean inequality result. Do not print either key or its hash.

## Readiness after re-enrollment

Enrollment success alone is not Ready.

Do not advertise or treat the replacement as ready until the control plane has fresh evidence for the required state, including:

- node authentication with the new credential;
- fresh heartbeat and health after the install/re-enroll time;
- acceptable capacity;
- current policy retrieval and acknowledgement;
- Xray/Speed subordinate state consistent with the policy;
- real VLESS/REALITY traffic through the replacement node.

A running systemd unit by itself is not proof that VPN traffic works.

## Enrollment-token and credential failure cases

- A used enrollment token must be rejected on replay.
- An expired enrollment token must be rejected.
- An invalid node credential must be rejected.
- A retired node credential must be rejected even if a stale copy still exists on disk elsewhere.
- If enrollment fails, request a fresh token instead of trying to reuse an old one.

## Update lifecycle

For a healthy trusted node, run the installer from source pinned to an exact CI-green commit:

```bash
sudo ./install.sh update
```

The update lifecycle:

1. downloads and SHA-256 verifies the pinned Speed Enforcer release before mutation;
2. refreshes Agent files;
3. atomically installs the verified Speed Enforcer binary;
4. refreshes the Agent, Xray, and Speed Enforcer systemd units;
5. reloads systemd;
6. restarts **only** `madar-node-agent.service`.

Xray and Speed Enforcer remain subordinate to Agent authorization/policy lifecycle. The installer must not independently start them just because their unit files are present.

The update command does **not** change the pinned Xray release. Do not infer an Xray version upgrade from a successful installer update.

After update, require a fresh heartbeat/readiness timestamp later than the update start, current policy application/ACK, expected subordinate service state, pinned Speed binary digest match, and a bounded journal scan with zero known-secret matches.

## Remove lifecycle

For a planned decommission:

1. verify another required service path remains healthy if applicable;
2. retire/delete the node in the control plane first so active node credentials are revoked;
3. prove the old node credential is rejected;
4. run `sudo ./install.sh remove`;
5. verify all three services and all installer-managed paths are gone;
6. verify SSH remains available and firewall configuration is unchanged;
7. destroy/reuse the VPS only according to infrastructure policy.

Local `remove` without server-side retirement is insufficient for credential revocation.

## Backup/restore gate

Recovery acceptance also requires the PostgreSQL backup/restore contract to remain green on the exact implementation SHA used for field deployment. CI must pass both:

```text
tests/integration/postgres-backup-restore.sh
apps/api restore-smoke
```

A green database restore test does not replace the node field lifecycle test; both are required for Task 32.

## Diagnostics without secret exposure

Safe starting points:

```bash
sudo ./install.sh status
sudo systemctl status madar-node-agent.service
sudo journalctl -u madar-node-agent.service --since '15 minutes ago'
```

For the three-service lifecycle, service-state checks may include Xray and Speed Enforcer, but do not print their managed config files.

Before sharing logs, review them for bearer tokens, node credentials, enrollment tokens, subscription URLs, client UUIDs, and private-key material. The project includes automated scanning defenses, but operators must still treat raw diagnostic output as sensitive.

## Phase 10 Task 32 field acceptance checklist

Automated/control-plane gates:

- [x] old active node credential can be explicitly revoked by retirement;
- [x] retired credential is rejected by node authentication tests;
- [x] admin deletion retires before removing the admin surface record;
- [x] one-time enrollment-token replay is rejected;
- [x] credential persistence is hash-only in the control plane;
- [x] pinned Speed Enforcer release/checksum verification is tested;
- [x] verified Speed binary installation is atomic;
- [x] three-service installer lifecycle is covered by tests;
- [x] PostgreSQL backup/restore and restore-smoke gates are in CI.

Real Node2 checks still required on the exact CI-green implementation SHA:

- [ ] record safe Node2 baseline and confirm Node1 remains healthy/eligible;
- [ ] run real `install.sh update` and prove fresh heartbeat/readiness/policy recovery;
- [ ] verify installed Speed Enforcer binary matches the pinned digest;
- [ ] run bounded post-update journal privacy scan with zero known-secret matches;
- [ ] obtain explicit operator confirmation immediately before destructive retirement;
- [ ] retire Node2 through the real control-plane/admin path;
- [ ] prove the previous Node2 credential is rejected;
- [ ] run real `install.sh remove` and prove complete three-service/local cleanup;
- [ ] reinstall/re-enroll Node2 using a fresh one-time token;
- [ ] prove old credential and old REALITY private key were not reused;
- [ ] prove fresh heartbeat/readiness/current policy ACK after replacement;
- [ ] prove real VLESS/REALITY traffic through the replacement Node2;
- [ ] scan bounded replacement logs for secret leakage and clean temporary evidence.

Until every real Node2 item above passes, Phase 10 Task 32 remains **INCOMPLETE**, not PASS.
