# Phase 8 — real v2rayNG E2E

Date: 2026-10-11  
Status: **PASS**

## Purpose

Phase 8 proves Madar's real user-subscription contract against a current official v2rayNG client, the retained VPS, VLESS+REALITY, authoritative Free active-second accounting, and both independent rotation flows. It also freezes the successfully consumed renderer shape in a sanitized repository fixture with regression coverage.

The executable acceptance checklist is `tests/e2e/v2rayng-acceptance.md`.

## Field head and client

The real-device run exercised exact repository/API SHA:

`5f82a12a28fdadb38acb750dabbc0f96e977c7e4`

Full CI for that tested SHA: `38087073156` — **SUCCESS**.

The retained Node Agent/systemd/Xray runtime was byte-identical to the already accepted Phase 7 runtime; no production runtime code or migration changed during the Phase 8 field run. Xray remained `26.3.27`.

Physical client evidence:

- Samsung Galaxy A16 / Android 16;
- v2rayNG `2.2.6`;
- official ARM64 APK from the 2dust release;
- VLESS over TCP with REALITY;
- flow `xtls-rprx-vision`.

The phone was human-operated; no ADB automation was used.

## Scope boundary

Phase 8 does **not** establish:

- production email delivery;
- production Cloudflare Worker/Hyperdrive deployment;
- Premium single-active-client/device enforcement;
- multi-node acceptance;
- final Free speed-cap field acceptance;
- real ad/payment/push providers;
- Production Ready.

For this field run, a controlled sender captured the one-time magic-link token while still exercising the real auth request/consume service and real PostgreSQL stores. No user, session, initial grant, client UUID, or subscription token was manufactured directly in SQL.

## Real field evidence

| Check | Result | Evidence summary |
| --- | --- | --- |
| A — fresh account/auth/grant | PASS | Real auth request/consume succeeded; replay was rejected. Two account reads showed exactly 1800 Free seconds. Read-only PostgreSQL verification found exactly one initial grant. |
| B — API-issued URL/import | PASS | Healthy/ready node with ACKed revision; authenticated + CSRF URL issuance; bearer subscription response had `Cache-Control: no-store`; the real URL imported/refreshed successfully in v2rayNG 2.2.6. |
| C — egress/transfer/accounting/replay | PASS | Ordinary phone traffic exited through the retained Madar VPS. Free accounting matched trusted server-observed active UTC seconds. Re-delivery of settled telemetry produced duplicates with zero extra debit. |
| D — actual idle | PASS | With workload isolated to Chrome through the imported profile, aggregate counters stayed unchanged during the measured idle interval; no new active bits or debit appeared. |
| E — Client ID rotation | PASS | Authenticated + CSRF rotation returned only policy/version metadata. Subscription URL stayed stable. Before ACK the node disappeared; after ACK the old config failed, refreshing the same URL obtained the new working config. Credential fingerprints changed without recording raw UUIDs. |
| F — subscription URL rotation | PASS | Previous URL became immediately non-disclosing `404`; new URL refreshed successfully; Client ID fingerprint remained unchanged; connectivity continued. |
| G — renderer compatibility freeze | PASS | Real accepted wire shape was frozen after the field pass in a sanitized deterministic fixture and exact parser/shape regression test; full repository CI passed. |
| H — cleanup | PASS | Empty policy removed all clients; cached config could no longer pass traffic; field subscriptions/profiles and temporary sender/tunnel/bridge material were removed; field credentials/tokens/sessions were revoked; VPS and historical journals were preserved. |

## Final accounting and privacy

Starting Free balance: **1800 seconds**.  
Ending Free balance: **1408 seconds**.  
Authoritative billable active-second delta: **392 seconds**.

All 40 account telemetry reports were settled. The per-minute union contained 392 trusted observed UTC seconds, matching 392 billable seconds and 392 ledger debit. Duplicate billed bits were zero and unexplained `unmapped` reports were zero.

Bounded new journal scans found no known magic-link token, session cookie, CSRF token, field UUID, subscription token, node credential, REALITY private key, raw StatsService output, or raw telemetry-output secret material. Historical Phase 7 journals were retained rather than purged.

## Accepted v2rayNG wire shape

The real v2rayNG 2.2.6 client accepted:

- scheme/protocol: `vless`;
- transport: `type=tcp`;
- security: `reality`;
- flow: `xtls-rprx-vision`;
- encryption: `none`;
- fingerprint: `chrome`;
- query parameter names, in renderer order: `encryption`, `security`, `sni`, `fp`, `pbk`, `sid`, `type`, `flow`.

The authority contains client UUID plus node host/port and the fragment contains the node label. No real field credential or bearer URL is stored in the fixture.

## Repository compatibility freeze

Gate G was closed with a deliberate TDD RED/GREEN cycle after the real device accepted the wire format.

RED:

- commit `9bf42117619ae9f1429e5ba8d9fd60c5d8edcd39`;
- CI `38117632514` — expected **FAILURE**;
- failure reason: the new v2rayNG compatibility regression could not load the intentionally absent sanitized fixture;
- all pre-existing API/web tests remained green before that missing-fixture suite failure.

GREEN:

- sanitized fixture: `tests/fixtures/v2rayng-2.2.6-reality-tcp.json`;
- regression: `apps/api/src/access/v2rayng-compatibility.test.ts`;
- commit `2cd84c1f0e00692e3c242a1923796cc89620f216`;
- full CI `38117746970` — **SUCCESS**.

The fixture uses only test-only values: reserved `.test` hosts, a dummy UUID, dummy public key/short ID, and a non-secret label. The regression requires exact renderer output, scheme/authority/fragment shape, exact query parameter order, and exact accepted parameter values.

## Failed attempts retained as evidence

The first auth runner failed before account creation and was not counted as acceptance. The first idle attempt was not actually idle because background traffic produced active bytes and debits; v2rayNG per-app routing was then used to isolate Chrome and the measured idle test passed. An earlier bounded phone transfer displayed a transient client-side failure despite the origin completing; a later phone rerun received the full bounded payload and supplied the actual acceptance evidence. No production workaround was used to manufacture PASS.

## Release boundary

- Phase 7: **PASS**;
- Phase 8: **PASS**;
- Phase 9: **not started**;
- Premium single-active-client/device enforcement: separate and unresolved;
- production email/provider deployment gates: still open;
- Production Ready: **not claimed**.
