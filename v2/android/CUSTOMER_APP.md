# Madar subscriber Android app · approved November 15, 2026

## Approved product experience
- Persian, RTL, dark navy + cyan/teal design based on the approved four-screen mockup.
- Original owner-supplied Madar shield logo included as drawable.
- Telegram account sign-in through a six-digit, single-use OTP sent in the private bot chat after opening the app's login link. The app verifies the code over HTTPS; no automatic Telegram approval or configuration import.
- One-tap connection with automatic allocation/route preference, real traffic validation and fallback.
- Local Xray proxy counters for download/upload Mbps; never show invented speed.
- Quota, consumption and expiry from the authenticated subscription API.
- Profile, FAQ, guide and Telegram support. Full-device IPv4/IPv6 VPN via Android VpnService.
- Only subscriptions with valid tokens, quota and server-verified routes can start VPN.

## Activation and safety
This branch is NOT a production VPN release or a verified usable APK.

1. Apply the V2 migration sequence 0016–0020 to V2 D1 ONLY; never the V1 production database. Confirm the live migration ledger and table schema before applying any pending migration.
2. Deploy V2 Worker on isolated staging and provision a dedicated V2 Telegram bot.
3. Set BOT_USERNAME to that bot's exact username, then enable SUBSCRIPTION_API_ENABLED and ANDROID_LOGIN_ENABLED only after verifying active subscriptions, encrypted credentials and tested routes.
4. Provide the release SUBSCRIPTION_API_ORIGIN at build time (release currently deliberately blank), pin and build libXray AAR in existing CI.
5. Pass v2-control unit tests, Android build/tests, emulator TUN and physical carrier traffic tests for MCI and Irancell before distributing.
6. Verify login expiry/replay safety, quota enforcement, logout token revocation, failover and traffic accounting against real backend.

Never embed Telegram bot tokens, node private keys or Cloudflare secrets in the app. Challenge creation is HMAC-rate-limited per Cloudflare client IP. Telegram OTPs expire after three minutes, are HMAC-verified, stored encrypted only for safe webhook retries, and locked after five failed attempts. Each challenge can redeem only one token; logout revokes the device's server-side token. The Android token is stored under Android Keystore AES-GCM, and requests are HTTPS with redirects disabled. Debug APKs are ABI-split (arm64-v8a, armeabi-v7a, x86_64) to avoid shipping all native runtimes in each download.

## Current staging readiness (verified 2026-11-16)
- The isolated `madar-v2-staging` Worker is alive and its health endpoint reports ready; the bound Telegram bot is the dedicated `@Madar_v2_bot`, with its webhook on the V2 Worker.
- Do not enable Android login yet: the isolated D1 currently has 1 active customer but 0 subscriptions, 0 subscription credentials, 0 active node allocations, 0 published endpoints, and no node/route in ready state. `SUBSCRIPTION_API_ENABLED` is currently false.
- The live D1 migration ledger records `0016_support_media.sql` and `0017_customer_trial_claims.sql`. Their authoritative SQL has now been restored into this branch from the V2 Telegram feature branch, and the live table definitions were checked against both files. The Android schema follows as migrations 0018 and 0019.
