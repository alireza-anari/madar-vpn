# Phase 10 — Task 33 device acceptance

Date: 2026-10-14. Branch: `impl/phase-10-task33-pwa-push`.
Task 33: **BLOCKED**. Phase 10 incomplete.

Baseline verified locally and through GitHub: `ea0fa64308e9d17703973281c933c0a324ef811d`; full CI `38515671586`, completed/success. Task 32 was not repeated. Its accepted amd64 field scope, both retained VPSs, historical journals and existing SSH bridge were not modified.

## Transport prerequisite

Candidate source: `24aeeeec1d343190dcb92c398b5ce7e6a2e25470`.
Transport/automated prerequisite: **PASS** on exact source above. Full CI [38530267068](https://github.com/alireza-anari/madar-vpn/actions/runs/38530267068), job `115740207637`, completed/success on 2026-10-14 at 07:46Z; every normal step ran successfully, including PostgreSQL schema/integration/backup-restore/restored Worker smoke, frozen pnpm 12.9.1 install, both dependency audits, Go race/vet/build, all TS tests, typecheck/build and 214 Python tests. Physical receipt remains BLOCKED.

The production PostgreSQL runtime now explicitly supplies `createWebPushTransport()` to `createVapidSender`. The adapter uses only Worker Web Crypto and Fetch, with no new dependency. RFC 8291/8188 AES-128-GCM encryption uses fresh ECDH and salt per message; RFC 8292 ES256 VAPID uses the configured private runtime binding. The public/private pair is imported, signed and verified before runtime availability is advertised. Invalid configuration disables Push while keeping unrelated services available.

Supported service hosts are FCM (`fcm.googleapis.com`), Mozilla (`push.services.mozilla.com` / `updates.push.services.mozilla.com` and their subdomains), and Apple (`web.push.apple.com` and subdomains). HTTPS, default port, no URL credentials/fragment, manual redirects, a ten-second request deadline and a 3993-byte plaintext limit bound sending. Other providers remain unsupported rather than allowing arbitrary subscription-driven server fetches.

HTTP 2xx means **push service accepted the encrypted request**, represented by the existing `delivered` adapter result. It does not prove device receipt. HTTP 404/410 maps to expired and removes the subscription through the Push service; all other statuses/network failures remain failed and retain it. Provider response bodies/errors are neither read nor logged.

A real backend action exists at `POST /api/admin/users/:id/notifications`. It requires admin session, CSRF/origin protection and an available durable audit service; an audit request is recorded before sending and aggregate results afterward. It returns only delivered/expiredRemoved/failed counts with no-store. The service worker and frontend were unchanged.

Standards/runtime references: [RFC 8291](https://www.rfc-editor.org/rfc/rfc8291), [RFC 8292](https://www.rfc-editor.org/rfc/rfc8292), [Worker Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/).

## Observed TDD and review evidence

- Initial real Worker RED: ten expected failures, 136 existing/passing tests. Missing encrypted HTTP send, status handling and strict config validation were reproduced.
- Transport GREEN: 13 tests passed. The receiver independently derives keys with Web Crypto HKDF, decrypts the wire body and verifies title/body/url; JWT claims/signature and public-only authorization are checked.
- Runtime RED: two failures for absent transport wiring and invalid bindings disrupting runtime. Runtime/transport GREEN: 15 tests passed.
- Admin route RED: two missing-route failures; the protected route then passed with the complete suite.
- Independent review identified mismatched/correct-length invalid VAPID readiness and optional audit delivery. Both new regressions were observed RED, then fixed and GREEN. Latest local complete suite: API 152/152, Web 51/51. Build, secret scanner, JavaScript audit and Python requirements audit passed.
- CI `38529764895` on `02c2dc7a688430eaf01391848ed56dd2dffb227b` failed strict typecheck for generic typed-array annotations; PostgreSQL/schema/restore/integration, audits, Go race/vet/build and TS tests had passed. Explicit owned-ArrayBuffer types corrected this without a runtime behavior change. Full suite/build stayed green afterward.
- Local Python attempt: 211 passed, three failed. Go was unavailable; Unix socket creation was prohibited; pytest's generated scanner fixture landed inside the checkout. Generated files were removed and the repository secret scan passed again. No test was skipped or weakened. Complete Python/typecheck/PostgreSQL/Go verification belongs to the candidate's normal CI, not a claimed local PASS.

No test key is a production credential; generated key material existed only in test process memory. Evidence contains no subscription endpoint/key, VAPID private key, session, node credential, enrollment token, database binding or REALITY private key.

## Physical-device and staging matrix

| Gate | Status | Actual evidence / blocker |
| --- | --- | --- |
| Android install | PASS | Operator handoff: `ANDROID_INSTALL=true`, Chrome Install app on a physical Android. Historical accepted evidence; not repeated. Exact installed staging deployment SHA and device/Chrome versions were not supplied, so this is a narrow attested result only. |
| Android standalone | PASS | Operator handoff: `ANDROID_STANDALONE=true`, launched from Home Screen. Same scope limitation. |
| No automatic prompt during Android install/startup | PASS | Operator explicitly observed no automatic prompt. Frontend/service-worker source unchanged; no repeat triggered. |
| Required Android device/OS/browser versions | BLOCKED | Record actual current test phone/Chrome versions; do not assume the Phase 8 phone is this device. |
| Candidate staging deployment + VAPID bindings | BLOCKED | Cloud Browser reached Cloudflare sign-in, not an authenticated dashboard. No deploy/secret mutation occurred. This session cannot establish whether bindings now exist. Earlier operator UI said unconfigured. Requires secure account sign-in/deployment access and explicit approval before any browser secret mutation. |
| Android explicit button → prompt → Allow | BLOCKED | Candidate deployment/configuration prerequisite missing; no physical-device action requested yet. |
| Android subscription persisted | BLOCKED | No device subscription accepted on candidate; future evidence must use counts/opaque test labels only. |
| Android real notification received/displayed | BLOCKED | Service acceptance tests cannot substitute for physical receipt; candidate/backend/device flow not run. |
| Android notification click | BLOCKED | SW handler exists, but actual target navigation on device remains unverified. |
| Real denied-permission usable PWA | BLOCKED | Automated coverage passes; physical-browser denied flow not yet observed. |
| iPhone Safari Add to Home Screen | BLOCKED | No valid physical Safari evidence. Earlier Telegram attempt excluded. |
| iPhone standalone/no automatic prompt | BLOCKED | Actual Safari installation and Home Screen launch needed, with iPhone/iOS/Safari versions. |
| iPhone real supported Push | BLOCKED | Device/version/support, explicit permission, persisted subscription and real receipt/click need evidence. Emulator is excluded. |

## Current reachability observation

A read-only scratch HTTPS attempt to the staging `/`, `/api/health`, `/manifest.webmanifest` and `/sw.js` returned HTTP errors. This is not candidate-deployment acceptance, and without confirmed target-versus-egress attribution it is not evidence that the Worker itself is unhealthy. The previous operator 200 results remain historical. Recheck health through the authorized target environment after actual candidate deployment.

## Staging continuation

In Cloudflare: **Workers & Pages → madar-staging → Settings → Variables and Secrets → Add**. Configure matching unpadded base64url P-256 `VAPID_PUBLIC_KEY` (65-byte uncompressed public point), `VAPID_PRIVATE_KEY` (32-byte private scalar, **Secret**), and `VAPID_SUBJECT` (valid mailto contact or HTTPS URL). Use a securely generated matching pair, never values from tests. Do not put private material in plaintext vars, code, argv, chat, screenshots or logs. Existing credentials must not be rotated merely to simplify testing.

[Cloudflare secret configuration](https://developers.cloudflare.com/workers/configuration/secrets/). No browser mutation is authorized until the operator gives explicit approval. After configured candidate deploy, verify health and start one physical-device instruction at a time. Final-candidate Task 34 verification remains a separate required rerun.
