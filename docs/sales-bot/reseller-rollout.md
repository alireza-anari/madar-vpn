# Reseller rollout

The current Worker remains in retail mode. This branch is staged code, not a production readiness claim.

## Changes

Admin manages sellers, node purposes and account revocation. Each confirmed sale has independent UUID, quota, duration and request identity; each confirmed new trial is 1800 seconds. No device/IP/concurrent-session limit. Upload plus download across all devices consumes the same decimal-GB quota. Forwarded messages contain a private refreshing usage link; the Telegram message itself is static.

Quota accounts run one pinned Xray subprocess each, on the same designated VPS. This avoids losing another account's counters when cutting an exhausted open stream. Assigned account ports are TCP 20000–20999; StatsService ports 21000–21999 bind only 127.0.0.1 and MUST NOT be exposed publicly. Allow the account port range in the AWS security group before activation. Existing retail port 443 and existing unrelated services are preserved until the explicit owned transition. No firewall automation is hidden in the installer.

Quota state is `/var/lib/madar-sales-node/quota.sqlite`, mode 0600, FULL synchronous SQLite transactions. Total and pending report sequence commit together. An unclean Xray/Agent restart blocks previously observed accounts rather than granting an unproven remaining balance. This intentionally requires support intervention/reissue after ambiguous continuity; automatic balance reset or epoch renewal is not supported. Normal per-account exhaustion/expiry/revocation does not restart another account. Volume polling has a bounded detection window; this is not byte-perfect network shaping.

## Prerequisites and ordered rollout

1. Refresh the already-owned Runner once with checksum-pinned `bootstrap.sh COMMIT --update`. This preserves its key, service secret and unit and never calls removed pairing routes. New signed installation jobs in reseller mode request protocol 2, and fresh installs initialize durable quota state before starting the Agent. Retained existing nodes use the explicit owned updater.
2. Record the exact reviewed source commit and checksum manifest. CI must pass for that commit. Apply migration `0004-reseller-accounts.sql` once using the D1 migration ledger; never rerun raw ALTER statements.
3. Inventory Personal read-only: Ubuntu version, existing units, listeners, ownership manifest. It is not registered in D1 as of 2026-10-15. An unrelated existing VPN service is a migration blocker, not permission to replace it. Runner remains on old Node1.
4. Verify account port range is reachable, and inventory Madar_st1. Its last recorded legacy ACK was stale at the implementation check; an old `healthy=1` flag alone is not proof of current health.
5. Set `quota_protocol_enabled=1` only for controlled protocol preparation while `app_mode` remains retail. Upgrade a matching owned sales node using `update_owned.py --node-id NODE_ID --source-ref COMMIT --manifest-sha256 DIGEST --enable-quota`. Download this updater from that immutable commit and verify its SHA-256 before running it. It checks ownership, source digests, all quota ports and preserves config/keys/quota database. A current v2 config with a missing database is rejected. No retained SSH credentials are assumed.
6. Run the field acceptance checklist below with tiny temporary test accounts. Account creation and policies can be exercised through an authenticated controlled test harness before exposing seller menus. Do not send credentials into logs.
7. Enroll Personal only when safe; assign Personal to `trial` and Madar_st1 to `sale` via admin menus after switching. Admin ID is server configured. Register the seller's numeric Telegram ID through the admin flow; no seller identity is guessed.
8. After automated and genuine device gates pass, set `app_mode=reseller`. Legacy purchase/receipt callbacks become inert. Financial tables are retained. Disabling a seller prevents new issuance and access to its account management; revoke specific accounts separately when required.

## Rollback

Stop the quota Agent before reverting mode; preserve the quota database and all keys. Do not automatically restart old retail access or republish old policies: that could re-enable revoked credentials. Keep D1 historical financial records and quota reports. A return to retail needs an explicit reviewed account migration. No VPS shutdown or Runner relocation is included.
