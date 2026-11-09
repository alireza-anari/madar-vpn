# Explicit, bounded production rollout approval — WSS admin trial

This one-file trigger activates only the guarded workflow:
`.github/workflows/release-admin-wss-trial.yml`.

Approved deployment unit: **Cloudflare Worker `madar-sales-bot` only**.
The previously verified production Cloudflare version at preflight is
`12c0782a-261c-4970-8868-6a542fa029f5`. The release must stop if that
version is no longer at 100%. Exact green application commit:
`ded5ab7bb30db8d4b55017d7be12a0a0ac06bd22`.

New capabilities: admin-only node-specific VMess/WSS **trial requests**,
30 minutes / 1 GB, requiring signed per-node WS endpoint + live quota-v2
shared-backend Agent. Delivery requires `ws-metered` ACK and emits
**only VMess/WSS** for that test. It does not auto-install a new node Agent,
open a port, configure Caddy or give WSS to paying customers.

Guardrails: D1 DB identity, Worker secrets, 1-minute cron and all
customer routes must survive. Existing Loomera website, EC2 test canary,
Ariant VPS, and AWS Node1 must **not** be changed. Roll back the Worker
to the exact previous version if live verification fails.

Do not rerun this trigger after the baseline production version changes.
