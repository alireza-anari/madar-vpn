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

## Retry note
The first guarded release stopped in preflight before deployment because curl
cannot combine -f with --fail-with-body. The workflow invocation was corrected;
the expected previous version and release source guard remain unchanged.

## 2026-11-08 sidecar API + admin installer link release

Reviewed Worker source: `7c98512929242841113a64787ae20eee0d60854b`.

- New authenticated `/api/node/secondary-ack` for standalone port health.

- Customer subscription includes extra ports only after signed policy, admin approval, primary ACK and fresh independent secondary heartbeat.

- Admin receives exact pinned, SHA256-checked optional installer command in Telegram.

- Existing VPS, Xray :443, quota agent and active customer traffic are NOT touched by this Worker release.

- Rollback to previously confirmed Cloudflare Worker version `0f0ab17d-7797-4055-b5a3-f59c4f281350` on production smoke failure.

- Server-side optional installer still requires one explicitly initiated SSH execution on the owned Ariant VPS; no credentials are persisted or requested via Telegram.

## 2026-11-08 one-step new-server provisioning rollout

The approved Worker change auto-records optional 2053/8443 from a successful,
attested fresh quota-v2 Telegram Runner install. The customer link is still
gated by the actual signed policy revision and live metered node ACK; no
config becomes downloadable on mere registration. Existing Ariant/AWS Node1
installations are untouched. No migration or secret changes.

Exact new Worker code reviewed: beeee659e51652602deb803e3ed3675118d0eda3
(all bot, special node, and overall CI checks green). Latest approved tree
source containing only docs/workflow changes: 67cee5fa0e86b8fe0b15cac8ccea621fe33a4d64.
Rollback to the current deployed Worker version:
ee397191-59f1-4bdf-ac81-404c1a61de2e.

Important: this Worker release does not update the already running standalone
Runner host. New-node automatic profile creation requires the Runner itself
to run the new installer, which is pinned via sales-runner/bootstrap.sh.

## 2026-11-08 experimental WSS Cloudflare lab admin view

The independent `madar-wss-lab` Worker on workers.dev was deployed and passed
a real WSS handshake from an isolated GitHub Action. Its test page is
`https://madar-wss-lab.alirezaanari117.workers.dev/test`.

This release changes ONLY the Madar sales-bot admin node UI: adds a "Cloudflare
WSS test" button linking to the edge-only probe. It does NOT provision a VPN
origin, alter quota settings, turn on WS customer delivery, or make any request
to legacy servers. The existing node-capability and signed-policy gates remain.

Source: `84cc483829a472454b605ffc0d1ca213e8391b14`.
Rollback Worker version: `e4ab88c3-ea9f-49a3-86a8-2e0620b7113f`.
