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
