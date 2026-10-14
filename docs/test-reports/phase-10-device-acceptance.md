# Phase 10 — Task 33 device acceptance

Date: 2026-10-14. Branch: `impl/phase-10-task33-pwa-push`.
Task 33: **BLOCKED** (exact iOS version / final-candidate changed-frontend evidence outstanding). Phase 10 incomplete.

Baseline verified locally and through GitHub: `ea0fa64308e9d17703973281c933c0a324ef811d`; full CI `38515671586`, completed/success. Task 32 was not repeated. Its accepted amd64 field scope, both retained VPSs, historical journals and existing SSH bridge were not modified.

## Transport prerequisite

Candidate source: `24aeeeec1d343190dcb92c398b5ce7e6a2e25470`.
Transport/automated prerequisite: **PASS** on exact source above. Full CI [38530267068](https://github.com/alireza-anari/madar-vpn/actions/runs/38530267068), job `115740207637`, completed/success on 2026-10-14 at 07:46Z; every normal step ran successfully, including PostgreSQL schema/integration/backup-restore/restored Worker smoke, frozen pnpm 12.9.1 install, both dependency audits, Go race/vet/build, all TS tests, typecheck/build and 214 Python tests. Physical Android receipt was subsequently verified below; iPhone remains BLOCKED.

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
| Required Android device/OS/browser versions | PASS | Operator supplied Android 16 and Chrome 155, then explicitly confirmed Samsung Galaxy A16 on 2026-10-14 at 09:33Z. Versions are operator-reported major versions; full patch/build strings were not supplied. These identify the physical Android install/activation/receipt/click witnesses in this report. |
| Candidate staging code deployment | PASS | Existing `madar-staging` updated from exact clean HEAD `5c956012d728c1e0e8c4e8ec31b3a364882c3d59`, exact-head full CI `38530860826` success. Cloudflare API upload 200 at `2026-10-14T08:30:31.29391Z`, version `daaf1072-7733-46e1-9f75-4ed746d6a2e3`, deployment `ecd4fe0c-487e-403e-8522-72db0b1ab662`, 100 percent. Existing assets were retained, not newly validated as final-candidate frontend artifacts. |
| Existing VAPID binding presence and secret types | PASS | Connected Cloudflare API returned settings/secrets 200 before and after deploy; PRIVATE/PUBLIC are existing secret_text bindings and SUBJECT existing plain_text. Values were never read/output or changed. Presence alone does not prove validity or delivery. |
| Deployed HTTP health | PASS | Operator real-phone Chrome witness on 2026-10-14 08:35Z: `/api/health` displayed `{"status":"ok"}` on deployed source `5c956012...`, active version then `daaf1072...`. HTTP numeric status not separately captured; result is a direct rendered-body witness. Local/client reachability remains blocked. |
| Runtime Push readiness | PASS | After actual account login, physical PWA screenshot at 09:05Z shows enabled button and successful device activation. The unchanged secure frontend only exposes this flow when authenticated account readiness advertises valid Push config. Actual delivery remains separate. |
| Android explicit button → prompt → Allow | PASS | Physical PWA enabled-state screenshot followed by operator affirmative answer to the prompt/Allow verification on 2026-10-14 at approximately 09:11Z, source `5c956012...`, CI `38530860826`. Device/browser: operator-reported Samsung Galaxy A16, Android 16, Chrome 155. |
| Android subscription persisted | PASS | On 2026-10-14 at approximately 09:14Z operator opened authenticated `GET /api/account/push-subscriptions` in the same phone Chrome and reported nonempty data. No response content, endpoint or keys were requested/recorded. Source `5c956012...`, CI `38530860826`; exact count unknown. |
| Android real notification received/displayed | PASS | Physical-phone operator opened the authenticated own-account test page, invoked the explicit backend-send button and confirmed notification displayed on 2026-10-14 at 09:23Z. Runtime source `9a1ed6243a4fb7ad7f046eebb24744985c1ca947`, exact-head full CI `38540658103`, deployment `97fadc4c-2663-473a-8758-d77d78ce41ea`. Device/browser: operator-reported Samsung Galaxy A16, Android 16, Chrome 155; backend aggregate counts were not supplied. |
| Android notification click | PASS | Operator tapped the received notification and confirmed Madar opened Settings on 2026-10-14 at approximately 09:30Z. Runtime source `9a1ed6243a4fb7ad7f046eebb24744985c1ca947`, CI `38540658103`; existing service-worker assets retained. |
| Real denied-permission usable PWA | PASS | Galaxy A16 / Android 16 / Chrome 155: operator blocked site notifications; physical Chrome screenshot at approximately 09:39Z displays denied-state message. Operator then opened Home and Subscription in installed PWA and confirmed both work without problems at 09:40Z on 2026-10-14. Source `9a1ed6243a4fb7ad7f046eebb24744985c1ca947`, CI `38540658103`; retained frontend assets. Operator confirmed restoring site notification permission to Allow on 2026-10-14 at approximately 10:02Z; no additional delivery is inferred from restoration alone. |
| iPhone Safari Add to Home Screen | PASS | Operator later gained real iPhone access and confirmed instructed Safari installation on 2026-10-14 at 12:55Z; subsequently identified model iPhone 15. Prior unavailability is superseded. Historical staging before neon deploy; no emulator substitute. Exact iOS version remains separately unknown. |
| iPhone standalone/no automatic prompt | PASS | Operator explicitly confirmed Home Screen launch without address bar and without automatic notification prompt at 12:56Z on 2026-10-14. iPhone 15, pre-neon staging; this is historical, not changed-frontend final acceptance. |
| iPhone real supported Push | PASS | Operator confirmed explicit activation/Allow at 12:56Z, own-account backend test notification receipt at 12:59Z and Settings navigation on click at 13:00Z on 2026-10-14. iPhone 15; exact iOS version unknown. Historical staging runtime `9a1ed624...`, CI `38540658103`, before neon deploy; no final-candidate promotion. |

## Current reachability observation

A read-only scratch HTTPS attempt to the staging `/`, `/api/health`, `/manifest.webmanifest` and `/sw.js` returned HTTP errors. This is not candidate-deployment acceptance, and without confirmed target-versus-egress attribution it is not evidence that the Worker itself is unhealthy. The previous operator 200 results remain historical. Recheck health through the authorized target environment after actual candidate deployment.

## Connected staging deployment — 2026-10-14

The operator connected the Cloudflare app. Read-only discovery found one accessible account and the existing staging Worker, including existing VAPID bindings. No key generation, secret mutation, API credential creation, new paid resource or browser login was needed. The checked-out exact-green source was rebuilt. API module SHA-256: `2daedfbbd6850f336a1e0f1d63f79c84f91cc99c1549a34e9713fe7601b085c8`. Upload used multipart main_module, keep_assets and all existing binding types, retaining compatibility date/flags, usage model and observability. Post-deploy settings prove all 12 prior binding names/types remain and invocation_logs=false. Previous version `9a69e7d4-8e43-4fea-a84c-8444a99a3541` remains historical rollback metadata; no rollback was executed.

Cloudflare accepted and activated the version; this is deployment PASS only. Health, public routes, exact retained frontend assets, runtime key validity, account readiness and real Push are not upgraded by API upload success. Browser navigation to the explicit public health endpoint was blocked by the client; no alternate network, proxy or firewall workaround was used. Next manual action is direct Android Chrome health observation, with no secret or authentication input.

## Real email/session prerequisite and activation checkpoint

A direct public-key bootstrap returned `AUTH_REQUIRED` at 08:44Z, establishing that the initial unconfigured Settings screen lacked a valid authenticated session; it did not establish invalid VAPID credentials. Physical Chrome login screenshot showed email unavailable. API inspection confirmed `STAGING_EMAIL_ALLOWLIST` absent despite existing Resend key/from/base bindings. The connected account identity supplied the owner email without asking for any credential. Existing staging settings were patched only to add a one-owner plain_text email allowlist, inheriting all previous bindings. PATCH200, prior binding names/types retained, invocation_logs=false; config version `3a893ff6-7e1e-4719-b3e9-9bc47e377c17` at100 percent, created `2026-10-14T08:47:41.031693Z`. No private key/provider key was read or changed; no admin role was granted; no message was sent by the agent.

The operator requested the actual application login email and attested receipt at08:49Z, then actual link consumption/signed-in state at08:54Z. This proves the configured provider receipt/login path for that account; it does not prove a fresh-account initial grant or replay gate for Task34. At09:05Z, installed Android PWA screenshot showed successful device notification activation. Neither real notification receipt nor permission-prompt appearance is proved by that screenshot.

## Authenticated self-test trigger prerequisite

An ordinary phone session cannot invoke the admin send route and its secrets must not be copied to Work. A bounded diagnostic GET/POST `/api/account/push/test` is therefore implemented under TDD in the API, retaining all installed PWA/static frontend assets. GET requires authentication and returns a no-store nonce-CSP page containing only stored subscription count. It never calls notification permission. The explicit button bootstraps CSRF in browser memory and POST sends only a fixed payload to the authenticated account. Origin/CSRF, existing hashed per-account rate limiting and mandatory request/outcome audit apply; caller target IDs are ignored. The response/UI gives service-acceptance counts and asks for actual device observation. It never claims physical receipt.

TDD: three missing-route RED failures; complete local GREEN API155/Web51, build and scanner; independent review found no Critical/Important issue. New exact-head full CI/deployment must pass before asking the operator to send. No asset/frontend or phone secret transfer is necessary.

## VAPID configuration reference (no mutation needed at this checkpoint)

In Cloudflare: **Workers & Pages → madar-staging → Settings → Variables and Secrets → Add**. Configure matching unpadded base64url P-256 `VAPID_PUBLIC_KEY` (65-byte uncompressed public point), `VAPID_PRIVATE_KEY` (32-byte private scalar, **Secret**), and `VAPID_SUBJECT` (valid mailto contact or HTTPS URL). Use a securely generated matching pair, never values from tests. Do not put private material in plaintext vars, code, argv, chat, screenshots or logs. Existing credentials must not be rotated merely to simplify testing.

[Cloudflare secret configuration](https://developers.cloudflare.com/workers/configuration/secrets/). No browser mutation is authorized until the operator gives explicit approval. After configured candidate deploy, verify health and start one physical-device instruction at a time. Final-candidate Task 34 verification remains a separate required rerun.

## Own-account device test candidate

Source `9a1ed6243a4fb7ad7f046eebb24744985c1ca947`, full exact-head CI `38540658103`: completed/success. Existing RED log records three expected route failures before implementation; GREEN suite reports 155 API tests. Cloudflare settings tag independently verified this source. Deployment `97fadc4c-2663-473a-8758-d77d78ce41ea`, version `b81fe4e4-29ac-4330-ab8f-9d0b321897b9`, 100% traffic, created `2026-10-14T09:17:08.462487Z`. A guarded redundant upload stopped before mutation because this same candidate was already present. `GET /api/account/push/test` provides a safe explicit-button self-send; physical Android receipt/click subsequently PASS by operator observations in the matrix above; iPhone remains BLOCKED.

## Task 34 continuation boundary

The operator instructed continuation despite unavailable iPhone on 2026-10-14 at 10:52Z. Available final audit/automated gates proceeded; Task 33 and Phase 10 remain incomplete. Android permission restored to Allow by operator. This report does not count the historical Android install as the separate final-candidate Task 34 reinstall/rerun. See `final-acceptance.md` for exact required statuses.

## iPhone metadata and changed-frontend boundary

Operator identified iPhone 15 at 13:01Z but lost access before reading exact iOS version at 13:02Z. Do not infer a version from “latest update”. Relevant final-candidate device rechecks remain BLOCKED after neon settings/frontend deployment; only needed affected deltas should be requested. Bootstrap source `836382e...` changes backend account/credential initialization, not notification transport or frontend.
