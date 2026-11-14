# Node agent V2 — secure desired-state admission (work in progress)

The first phase only validates and durably records signed desired state.
It deliberately **does not** execute commands or install/modify any VPS.
Use separate per-node 32+ byte secret keys, narrow privileges, certificate
and signed-binary verification before building the executor.

## Security contract

- Canonical HMAC-SHA256; expiry <= 10 minutes; monotonic revision; replay and
  conflicting same-revision payloads rejected
- Node identity, ports, transport fields and quotas strictly validated
- No arbitrary shell, arbitrary URL download, or plaintext private key in
  desired state or logs
- Persistent file written atomically, mode 0600; production agent process
  must run as a dedicated non-root user and secure its state directory
- "Accepted/provisioning" **never** means the route has passed real traffic
  verification. External field tests and a version-pinned installer are needed

Run from this folder: `python3 -m unittest discover -s tests`.

**Not yet implemented:** Xray installer, signed release verification, runtime
reconciliation, telemetry, rollout, recovery and live VPS acceptance.
Never point this code at the existing AWS server.

## Signed polling and controlled key bootstrap

For an **isolated test node**, a trusted operator creates a 32-byte master key
and stores its base64url representation as the Worker secret
\`NODE_MASTER_KEY\`. That master MUST NEVER be copied to a VPS.

On the trusted provisioning runner, derive an individual key with:

\`\`\`bash
python3 -m agent.keys --master-file /secure/master.key \
  --node-id node_01 --output /secure/node_01.key
\`\`\`

Transfer only the derived node key to the test VPS over pinned-host-key SSH
or another authenticated encrypted channel. Install it as a mode-0600
credential owned by the node-agent account.

Then the read-only agent can poll (but not install a VPN) using:

\`\`\`bash
python3 -m agent.poller \
  --server https://madar-v2-staging.alirezaanari117.workers.dev \
  --node-id node_01 --key-file /secure/node.key --state-dir /var/lib/madar-v2
\`\`\`

An acknowledgement means only that the signed desired-state manifest was
accepted. Actual Xray installation, runtime health and carrier tests remain
separate release gates. Do not run the new agent on existing production Node1.
