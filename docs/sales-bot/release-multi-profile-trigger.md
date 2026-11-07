# Madar bot-only production release marker

Approved by project owner in conversation on 2026-11-07: publish the tested
multi-profile sales bot so the administrator can use the live bot to issue
configs and assess readiness.

## Strict production release scope

- Only deploy the sales-bot Worker from exact reviewed green SHA
  `c1d1fb1c0211e2563c5722f92c11b6e29da88dd8`.
- Preserve every existing Cloudflare Worker secret, binding and cron.
- Reuse existing D1 schema with no migrations or data rewrites.
- Keep VPS Ariant, AWS Node1, the quota agent and REALITY public 443 unchanged.
- Optional 2053/8443 and VMess/WSS profiles remain gated by signed policy and
  actual node capability ACK; the current Ariant agent only advertises the
  existing 443 capabilities. Do not issue fictional or unmetered configs.
- Workflow must verify the exact existing production version
  `b6244c85-434b-4c79-96d0-110c62b7f50d`, run CI tests, deploy, verify
  all existing routes and settings, and roll back on failure.
- After Worker publication, the bot admin can inspect the new port controls.
  **Live additional connections still require an authorized node update.**

This release is intended for **bot publication only**, not as proof that
new server-side listeners exist or are ready for customer sales.
