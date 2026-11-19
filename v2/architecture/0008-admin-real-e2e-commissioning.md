# Madar V2 — Isolated real UUID end-to-end acceptance

Staging only. Owner-authenticated Telegram admin action under **Admin > Issue config > Real UUID test**.
Only applies to an installed, currently ready node whose bootstrap owner matches the acting admin.

## Test and safety controls

- Admin explicitly confirms creation; no automatic paid-order approval and no general storefront.
- Creates one deterministic `e2e-<node-sha24>` zero-price order for the admin and an inactive
  private plan `v2-admin-e2e-100mb-1day`: 100 MiB, one day, zero Toman.
- Reservation uses the ordinary encrypted UUID credential pathway and pins the exact intended node.
- Requires fresh node health, both fresh published 443/8443 carrier routes, signed manifest ACK,
  spare node user and byte capacity; no unsigned or dummy per-client ACK in live deployment.
- Upon node real Xray application, node sends signed `/api/node/v1/clients/ack` for that exact
  subscription UUID digest. Only then is pending changed to active/fulfilled.
- Private link issuance verifies two fresh carrier variants, allocation, active quota and a
  recent signed per-client ACK. The link contains both carrier choices sharing one allowance.
- URL tokens are stored only as hashes and remain private bearer secrets (Telegram DM only).
- The general subscription API/feed, payment, order-provisioning cron and SHOP flags all stay FALSE.
  A narrowly scoped exception allows only the precise zero-price admin E2E token when
  `ADMIN_E2E_TEST_ENABLED=true`. Other active subscriptions remain inaccessible through it.
- Admin can explicitly revoke this test from the same screen. Tokens immediately stop resolving;
  the node separately removes the UUID and issues a revocation ACK before capacity is released.
- One E2E order per node; repetition is idempotent. This is a staging acceptance operation,
  **not** a substitute for production bandwidth, carrier or single-device field verification.

## Operator steps

1. Open V2 dedicated Telegram bot > Manager dashboard > `صدور کانفیگ`.
2. Choose `🔬 تست صدور واقعی UUID · ویژه مدیر` and `Amazon-118`.
3. Confirm `✅ ساخت اشتراک آزمایشی واقعی` once.
4. Use `🔄 تازه‌سازی`; do not claim success while subscription remains pending.
5. After authentic node/client ACK: press `🔗 دریافت لینک دو اپراتور`.
6. In v2rayNG, import the one private link, verify BOTH paths from the real SIMs;
   record traffic/usage and quota locally as well as server telemetry.
7. Choose `🛑 پایان و لغو تست` and confirm. Verify link rejection and signed
   server account removal ACK; do not manually drop the live allocation.

## Field acceptance and limitations

Unit tests simulate signed requests, source-code path and D1. A successful automated unit
test does not mean the external VPS has installed any E2E UUID. Only a live D1 `node_client_acks`
for the test subscription and observed traffic establish actual field installation.
`libxray-android` and CI may test local binary behaviour but do not substitute for the user's
two carrier network tests or billing acceptance. Keep V1 unchanged.

## Release

Control source SHA `ec3dfaefdd965c6ea1aa8bfe6c569f7dd055d4ea`.
Before activating flag, staging sales and API flags were all disabled; old live Worker version
`4399be89-5e5f-470c-b6f1-9754ec855d4e` recorded for rollback.
New script version `40490d21-b125-4756-a9dc-05b84dd1d9b9` deployed with preserved secret/D1
bindings. Dedicated secret `ADMIN_E2E_TEST_ENABLED=true` creates active settings version
`bc3cfb9a-4a4b-4092-ae8a-3659b969b4b7`, script ETag unchanged. Live smoke
health/live=200, health/ready=200, unsigned manifest=401, invalid token=404.