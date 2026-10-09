# Phase 10 — PWA / Web Push device-readiness evidence

**Date:** 2026-10-09  
**Branch:** `impl/phase-1`  
**Automated evidence commit:** `fba10d373b92937e8883d8bdf25c9195ed2e1169`  
**CI run:** `37906847902` — PASS

## Scope

This report records only what is verified by repository tests and CI for the PWA/Web Push prerequisite path. It does **not** mark real-device acceptance complete.

## Automated verification — PASS

- Notification permission is requested only after an explicit user action.
- `denied` / unsupported notification states do not block normal PWA use.
- An authenticated session can bootstrap a fresh CSRF token after reload.
- CSRF bootstrap responses are `Cache-Control: no-store`.
- Issuing a new CSRF token rotates the server-side session hash; the prior token is rejected for protected mutations.
- CSRF rotation is covered against both the in-memory test store and PostgreSQL.
- The authenticated Push bootstrap exposes only the configured **public** VAPID key; no VAPID private key is returned to the browser.
- The VAPID public-key response is `Cache-Control: no-store`.
- The browser bridge converts the VAPID public key, calls `PushManager.subscribe`, and persists the resulting subscription through the protected account API with the current CSRF token.
- If server persistence of a newly-created browser subscription fails, the browser subscription is unsubscribed so the UI does not report a durable state that the control plane does not have.
- The Settings surface receives a real subscription action only when backend account readiness reports Push as available.
- The complete repository CI gate passed: secret scan, PostgreSQL schema/backup/restore, restored-runtime smoke, PostgreSQL integration suite, npm/pip audits, full JS/TS tests, typecheck, build, and Python tests.

## Real-device acceptance — NOT RUN

The following Plan/Design gates still require external hardware/environment evidence and are **not verified by this report**:

- Android PWA installation on a real supported device/browser.
- iPhone Add to Home Screen on a real iPhone/Safari environment.
- Real Web Push subscription against deployed HTTPS production-like infrastructure.
- Delivery and display of an actual Push notification on a real Android device.
- Delivery and display of an actual Push notification on a real iPhone PWA where platform support/configuration permits it.
- Denied-permission behavior observed on the real target devices, beyond automated browser-component tests.

## Release status

`Production Ready` remains **blocked**. This report upgrades the Web Push/PWA path only to **automated implementation verified / ready for real-device acceptance**. Real-device checks above, plus the still-open real VPS / v2rayNG / multi-node / throughput gates from earlier phases, must pass before the final acceptance matrix can be marked complete.
