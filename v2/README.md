# Madar V2 — independent rewrite

The V2 implementation lives in `v2/` and does not reuse the V1 business
logic or production database. The legacy code stays available only as a
migration reference until acceptance tests and a controlled cutover pass.

## Status (2026-11-10)

- Control-plane foundation: implemented and unit tested in CI on the rewrite branch.
- Telegram V2: isolated webhook, transactional outbox and basic commands.
  Sales, support, subscription issuance and admin flows are **not yet migrated**.
- Route diagnostics: deterministic evidence-based classifier and route policy.
  Carrier field acceptance is **not yet performed**.
- Android: new Kotlin/Compose project with a safety-first connection
  state machine. No tunnel engine is integrated; it must not claim a VPN connection.
- V2 D1: **a new isolated staging D1** was provisioned and migrations 0001/0002\n  applied on 2026-11-10; V1 production D1 was not touched.
- V2 Worker: **not deployed**, no production webhook changed.

## Structural boundaries

```text
v2/
  control/         Cloudflare HTTP/Telegram control-plane, D1 and unit tests
  android/         Kotlin Android client + tunnel state machine
  architecture/    architecture, release, field testing and migration gates
```

Run V2 control tests with `cd v2/control && npm test && npm run check`.\nAn Android **debug UX preview APK** is retained as a CI artifact when its build\npasses; it has no VPN tunnel and must never be distributed as a usable VPN.

Do not reuse the production BOT_TOKEN webhook or D1 for staging. For live
testing use a second Telegram bot token, the isolated V2 staging D1 and a distinct
Cloudflare Worker name. Credentials must be stored only in runtime secrets.
