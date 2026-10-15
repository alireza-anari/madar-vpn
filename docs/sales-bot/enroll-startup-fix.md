# Enrollment Mini App startup fix — 2026-10-15

Owner screenshot showed the enrollment page inside Telegram with the message asking to open it from the admin menu. The page previously hid the form whenever the external Telegram JavaScript SDK was unavailable, even if the native client supplied signed launch data in the URL fragment.

The SDK now loads asynchronously. Raw tgWebAppData is read from the fragment only when SDK initData is unavailable and is sent unmodified to the existing server validation. HMAC, expiry and admin checks are unchanged; ordinary browser launches without Telegram data still hide the credential form. A Node browser-script test executes the actual inline form code and verifies fallback header delivery, SDK precedence and denial without launch data. The fallback regression failed before the change and passed afterward.

Verification: 44 Worker tests and 3 browser tests PASS; typecheck, Wrangler build, secret scan and diff checks PASS. Deployed Worker version 68abb7ac-bb71-45ec-b6ff-cbe63fdfa2bc, preserving current bindings and secrets. Phone retry and actual node enrollment remain pending; the SDK-loading explanation is supported by the reproduced failure path, not a phone network trace.
