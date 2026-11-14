# Madar V2 — one link, two carrier choices (staging only)

## User-facing behavior

A paid, *verified* subscription should provide one HTTPS subscription URL,
not two manually pasted VLESS links. In v2rayNG (or another compatible client)
the user adds the URL in **Subscription settings**, updates the subscription,
and receives two named REALITY profiles:

- **مدار | همراه اول** — intended REALITY port 443
- **مدار | ایرانسل** — intended REALITY port 8443

The names are *hints* based on the requested field behavior; neither carrier
is guaranteed to connect reliably in every area. Routes may be on different
ports or different nodes if the provider later changes its topology; the
actual verified endpoint metadata determines the generated ports.

Madar Android accepts the same HTTPS URL under **اشتراک من**. The user
selects **همراه اول** or **ایرانسل** on the home or servers screen.
The app chooses only field-verified routes explicitly labelled for the
selected operator and never silently switches to a different operator.
Every connection still requires an authenticated tunneled traffic check.

Both profiles use the **same UUID, subscription, expiration, quota record and
one node allocation**. This does not, by itself, prove that live node
accounting/enforcement is complete. A shared physical quota requires
authoritative per-user usage collection and enforcement before paid sales.

## Security / readiness checks

1. V2 staging D1 migrations `0010_carrier_subscription.sql` and
   `0011_route_carrier_variants.sql` only. **Never** apply them to V1 D1.
2. One parent REALITY route per node. Carrier-specific port variants live in
   `route_carrier_variants`, each with its own `verified_ms` and
   `published=1` only *after* real authenticated carrier tests.
3. Endpoint eligibility also requires an active subscription, positive quota,
   ready node, ready parent route, fresh verification within 10 minutes,
   active allocation and encrypted UUID credential.
4. Bot ownership check happens before link issuance; no link is issued for
   pending/suspended/expired plans or until both variants are available.
5. Links are 256-bit random bearer capabilities, whose hashes are stored in
   D1. The same capability URL works as an import address; never post it in
   public groups, analytics or support tickets. URL paths containing bearer
   credentials **can be captured by reverse-proxy / platform access logs**:
   verify access-log minimization or sanitization before enabling this feature.
   A leaked URL needs token revocation/rotation. Avoid link previews.
6. Worker vars `SUBSCRIPTION_LINKS_ENABLED` and
   `SUBSCRIPTION_API_ENABLED` default to `false`; shop/provisioning
   remains independently disabled. Configure and verify
   `SUBSCRIPTION_PUBLIC_ORIGIN` as the actual HTTPS origin, without a path.
7. Network access to the URL itself must work on the target carrier at least
   for initial subscription import/updates. The disposable
   `*.workers.dev` test hostname was inaccessible on the tested
   Irancell cellular network: **do not assume the existing staging origin
   is suitable for product delivery**.
8. The current disposable test VPS is listening for REALITY on **8443** and
   Caddy/WSS on **443**. A second REALITY listener cannot also take TCP 443
   without a separately staged migration. The source change here does
   **not** switch 443, stop Caddy, install another listener or modify AWS
   Node1. Do not claim the 443 profile has passed field acceptance.
9. Before commercial rollout, verify both ports externally with real VLESS
   traffic on relevant mobile networks; test v2rayNG Base64 subscription
   update and native Android connection selection on an actual device.
   Exercise shared quota enforcement, link expiry, revocation and renewals.

## Code location

- `v2/control/src/carrier-subscription.mjs`: strict Base64 two-profile
  feed and checked link issuance.
- `v2/control/src/subscription.mjs`: carrier-verified route selection.
- `v2/control/src/shop.mjs`: private Telegram bot self-service link action.
- `v2/android/.../CarrierRoutes.kt`: explicit operator selection and storage.
- `v2/android/.../MainActivity.kt`: two buttons on home/servers.
- `v2/android/.../MadarVpnService.kt`: selected-operator-only tunnel
  with native authenticated traffic acceptance.

This is implementation work in isolated V2 GitHub staging, **not**
a deployed customer subscription on the live V1 Telegram bot.
