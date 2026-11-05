# Madar production Vision rollout — 2026-11-03

## Scope and safety

Baseline: `feat/native-seller-operations-20261028` at `2730f2f311c4f0a780c7bfd1b2fc66ec7d1cb6e9`, matching the 2026-10-28 Cloudflare Worker release. This change preserves native admin/seller/customer workflows, usage links, accounting and database migrations 0010–0018. Migration 0019 is additive with **vision_opt_in=0** for every node and **connection_flow=''** for existing accounts. Personal-VPN (`13.60.255.118`) and other AWS accounts are OUT OF SCOPE.

Evidence: on `madar-node-01` Stockholm (`13.51.138.193`), a same-IP/same-REALITY field A/B showed Vision streaming success on both Iranian mobile operators and improved Irancell playback versus plain. The loopback metering test recorded 31.4 MiB for Vision and 15.6 MiB for Plain, with both temporary credentials removed. No test reached the 200 MiB cap: this is **not proof** of exact hard-quota cutoff under all traffic patterns.

## Delivery contract

A new account pins its Flow atomically on creation. Vision is selected only when all conditions hold: node `vision_opt_in=1`; ready, healthy, fresh ACK; `shared-443` and `vision-metered` capability. Otherwise Flow is empty. Signed QuotaPolicy v2 includes the pinned Flow. Legacy agents must not acknowledge a policy carrying Vision users, and customer delivery refuses an unacknowledged policy, capability downgrade or Flow mismatch. The public VLESS+REALITY frontend uses Vision; the loopback per-account VLESS worker remains empty-Flow for quota counters. Existing accounts are not retroactively altered.

## Safe deployment gates

1. Verify CI and the pinned-source-manifest checksums. Create a D1 production backup before applying migration 0019; do not rerun previously applied migrations. Confirm pre/post account counts, constraints and foreign-key integrity.
2. Deploy the Worker as a build of THIS current-production-based branch. Preserve all existing Cloudflare bindings/secrets, routes and current Worker version as a rollback target. With every `vision_opt_in=0`, verify existing bot menus, checkout, customer receipt, quota policy ACKs and status endpoints before enabling Vision anywhere.
3. Update **only the managed sales agent** on Stockholm, after verifying installed source hash, ownership, services, exact EC2 instance ID and backups. Use the existing guarded updater; never overwrite Personal-VPN or Stockholm 2. Verify `vision-metered` appears in the healthy node capabilities and Xray public port 443 plus loopback API 19999 remain functional. If this gate fails, leave opt-in off.
4. Opt in **only Stockholm** by setting `nodes.vision_opt_in=1` for the exact node ID `c5e6a942-8d8c-4c20-8698-323d08490a2c`. Check fresh ACK and capability immediately before issuing ONE limited canary account; validate the delivered link has `flow=xtls-rprx-vision` and the signed policy entry has exactly the same value.
5. Use a short-duration, low-quota canary. Exercise upload and download; compare local cumulative counters with D1 on-demand refresh; verify expiry, hard cutoff and no impact on sibling accounts. Verify no stale credential remains on the shared frontend after revocation. Only then enable customer sales gradually.
6. Rollback: set `vision_opt_in=0` immediately to stop selecting Vision for new accounts. This does **not** convert already pinned Vision accounts: explicitly revoke any canaries/affected accounts before rolling back the agent. Restore prior Worker version/bindings if needed. Never roll back a database migration by dropping populated columns.

## Prelaunch cleanup

The 52 old managed test accounts, quota reports, trial rows and delivery outbox records were removed from D1. Two legacy entitlements were revoked; customer orders, nodes, plan definitions and seller permissions were retained. Do not delete those retained business records as part of Vision rollout. Local `quota.sqlite` history on AWS is not a release gate but must not be deleted while an agent is running. Verify no unauthorized live worker exists before selling.

## Limitations

No production rollout or EC2 file modification is accomplished by landing this patch. Deployment and end-to-end canary validation are separate, logged operations with rollback. The earlier Visual A/B does not guarantee a fixed ping for all locations or operators.

## Execution log — 2026-11-03

- Pre-migration D1 Time Travel bookmark: `000000ba-0000026c-00005118-4ec31f43516a1100b45d8b3f4faeb8db`.
- Migration `0019-managed-vision-optin.sql` applied and recorded in `d1_migrations`. Schema checks confirm `vision_opt_in=0` for all 5 nodes and `connection_flow=''` default for existing accounts. `PRAGMA foreign_key_check` returned no rows.
- Worker deployed successfully as version **52** (`0b7510ac-92d8-4c1c-b25c-579a32186340`) at 100% traffic. Previous production version **50** (`85af8be4-5112-4d2f-87ff-581b5ea83677`) remains available as rollback target.
- Post-deploy smoke: `/health` returned `{"status":"prepared","telegram":"configured"}`; `/customer` served the customer page; unauthenticated `/api/customer/me` returned HTTP 403. `/app` without Telegram WebApp init data correctly showed the login-required screen.
- Worker bindings were re-read after deployment: D1, BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, RUNNER_SERVICE_SECRET, POLICY_SIGNING_SECRET and USAGE_LINK_SECRET are still present; the one-minute cron remains configured.
- All nodes remain opted out. Stockholm node `c5e6a942-8d8c-4c20-8698-323d08490a2c` is currently reporting `quota-v2,per-account-process,shared-443`, but not yet `vision-metered`. No account has been issued with Vision.
- The managed-agent update on Stockholm is **pending**. Its last recorded managed install is version `26.3.27` from 2026-10-17. Before running `update_owned.py`, an operator must confirm the exact EC2 instance ID and ownership, obtain a fresh authorized AWS/SSM session, and create a local backup of the managed agent files, systemd units and `quota.sqlite`. No EC2 instance, service, or Personal-VPN configuration has been changed in this rollout.
