# Madar subscriber Android app · approved November 15, 2026

## Approved product experience
- Persian, RTL, dark navy + cyan/teal design based on the approved four-screen mockup.
- Original owner-supplied Madar shield logo included as drawable.
- Telegram account sign-in through a one-time, verified bot deep-link. No configuration import.
- One-tap connection with automatic allocation/route preference, real traffic validation and fallback.
- Local Xray proxy counters for download/upload Mbps; never show invented speed.
- Quota, consumption and expiry from the authenticated subscription API.
- Profile, FAQ, guide and Telegram support. Full-device IPv4/IPv6 VPN via Android VpnService.
- Only subscriptions with valid tokens, quota and server-verified routes can start VPN.

## Activation and safety
This branch is NOT a production VPN release or a verified usable APK.

1. Apply V2 migration 0016 to V2 D1 ONLY; never the V1 production database.
2. Deploy V2 Worker on isolated staging and provision a dedicated V2 Telegram bot.
3. Set BOT_USERNAME to that bot's exact username, then enable SUBSCRIPTION_API_ENABLED and ANDROID_LOGIN_ENABLED only after verifying active subscriptions, encrypted credentials and tested routes.
4. Provide the release SUBSCRIPTION_API_ORIGIN at build time (release currently deliberately blank), pin and build libXray AAR in existing CI.
5. Pass v2-control unit tests, Android build/tests, emulator TUN and physical carrier traffic tests for MCI and Irancell before distributing.
6. Verify login expiry/replay safety, quota enforcement, logout token revocation, failover and traffic accounting against real backend.

Never embed Telegram bot tokens, node private keys or Cloudflare secrets in the app. Challenge creation is HMAC-rate-limited per Cloudflare client IP; logout revokes the device's server-side token. The Android token is stored under Android Keystore AES-GCM, and requests are HTTPS with redirects disabled. Debug APKs are ABI-split (arm64-v8a, armeabi-v7a, x86_64) to avoid shipping all native runtimes in each download.
