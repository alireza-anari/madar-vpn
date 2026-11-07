# Managed Irancell fallback: implementation and release gates

Status: DRAFT CODE ONLY. No live VPS, Cloudflare Worker, or DNS deployment is accomplished by a PR.

## Architecture

The current VLESS/REALITY public 443 service stays unchanged. The proposed additional VMess AES-128-GCM WebSocket frontend listens exclusively on 127.0.0.1:18080 with its management API at 127.0.0.1:18081. Both ingress routes forward authenticated users to the SAME existing per-account loopback Xray worker (ports 20000–20999) using the same HMAC-derived bridge identity. Only that common backend is allowed to emit authoritative cumulative usage and enforce quota. Alternate frontends never have a direct outbound to the public Internet.

The router is optional: a SIGNED node QuotaPolicy v2 must carry valid wsFallback metadata. Existing policies and all current nodes default to primary REALITY only. Backend manager may add VMess users only for accounts already running the quota-controlled backend. It reports ws-metered ONLY when every active account is attached to the healthy secondary frontend.

## Guarded Telegram customer delivery

The admin must separately confirm stable public hostname and ingress provider commercial terms in the Telegram node screen; a random WS path is generated. The existing settings table stores enabled, terms_approved, hostname and path per node and all changes are audited.

A second VMess config is delivered ONLY when all of the following hold:
- Ready, healthy node with a recent acknowledgment of the exact current quota policy revision
- Current quota-v2, per-account-process, shared-443 and ws-metered capabilities
- The signed policy describes the same valid, permanent WS endpoint as approved node settings
- The account has valid period, active state and matching signed policy client/UUID/quota
- A strict VMess/WSS link round-trip succeeds

Temporary Quick Tunnel hostnames and private addresses are never accepted. Missing or malformed metadata leaves the existing working REALITY delivery intact.

## Multi-profile shared subscription (no domain purchase)

The customer or admin creates **one managed account**. Madar prepares a single
revocation-aware HMAC-signed subscription link using the existing Worker domain.
The link returns between 1 and 4 connection profiles, based on independent,
live agent ACK and signed policy gates:

1. VLESS/REALITY TCP 443: original frontend (always first).
2. VLESS/REALITY TCP 2053: optional owned frontend on the same VPS IP.
3. VLESS/REALITY TCP 8443: optional owned frontend on the same VPS IP.
4. VMess AEAD/WSS 443: optional independent public HTTPS ingress (not ready without a proper permitted public hostname).

The two direct REALITY alternative ports **do not require any domain**;
they remain default-OFF until admin explicitly selects an allowlisted port and
confirms reachability, and the node actually reports `reality-alt-metered`.
Direct alternative inbounds are owned by a **separate Xray child process** with
its own loopback management API at 127.0.0.1:18091. It never binds 443.
No new frontend is allowed a direct Internet outbound. Their only outbound
transport is the existing HMAC-derived VLESS bridge on localhost 20000-20999
which is enforced and metered by the original per-account backend. Existing
MCI user flows are unchanged.

If any additional listener is unavailable or lacks valid policy, it is omitted
from customer delivery and the existing 443 route continues. Any change of
available profiles takes effect when the client refreshes the SAME subscription
URL. Hard quota and expiry apply to the shared account, not individual ports.

The system does NOT attempt to generate Shadowsocks, Trojan, Hysteria2 or
arbitrary protocols with no matching live managed implementation. It must never
issue unmetered or fictional configs. More protocols can use the same profile
interface once their node ingress, client format and common-metering field
tests have passed.

**Important:** All implemented flows in this branch are local code. Real-world
TCP reachability, Iranian carrier compatibility and dual-path concurrent
accounting remain field-test gates. Extra ports also need any applicable
host/cloud firewall policy; none is changed by this PR.

## Managed node onboarding

The sales-runner installer and checksum-pinned node updater now package the optional WS router module. After release, new servers onboarded through the existing authorized SSH enrollment can receive the code automatically. No manual per-server flag is needed: signing the alternate route into policy is the only startup opt-in. The tunnel/ingress provider still needs a proper integration; no DNS, paid plans or tunnels are purchased or created by this code.

## Required production release gates (not completed)

1. Confirm written acceptance of planned commercial proxy traffic by BOTH VPS and public ingress providers. Public Cloudflare Tunnel CDN routes on Free/Pro/Business require specific paid services for video and other large files. VPN users may transfer such content. Quick Tunnel is for development and not suitable as a resale backbone.
2. Obtain a stable public hostname and configure a contract-compliant ingress to the optional localhost service. The connected Cloudflare account currently has zero managed DNS zones.
3. Remove staged experimental canary on Ariant before production use of local port 18080. Do not stop or change the live REALITY 443 unit.
4. Verify source manifest checksums, test the managed Xray dynamic VMess user API on an authorized test node, and validate alternate ingress with Irancell and MCI.
5. Prove a hard shared quota across alternate and primary concurrent streams; validate expiration, revocation, byte continuity, cap exhaustion, WS frontend crashes, agent restarts, and 1 vCPU/1 GiB resource headroom.
6. Only then coordinate a controlled production update: back up VPS agent and quota.sqlite, record Cloudflare Worker version/secrets/bindings and D1 Time Travel bookmark, use canary accounts, and verify MCI works before expanding.
7. Existing owned updater stops the managed agent and can briefly restart the primary REALITY frontend. It does NOT currently guarantee strictly zero interruption; do not run it during critical MCI customer sessions.
8. Rollback: disable the optional route in admin Telegram. Next signed policy refresh stops the secondary frontend; leave the primary 443 config and persistent quota database intact.

## No-domain development and subscription URLs

The managed subscription URL uses the **existing** Madar Worker HTTPS origin stored in PUBLIC_BASE_URL. It does **not** require purchasing a second domain. Each managed account receives a separate HMAC-authenticated bearer URL on `/managed-subscription/v1/`. That URL dynamically returns its canonical REALITY config and appends the VMess/WSS config ONLY if every existing policy/ACK, customer and public-ingress gate succeeds. Revoke or expire the account, and the URL stops returning usable credentials. A separate HMAC context prevents usage-page tokens from being mistaken for subscription credentials. Responses are no-store/no-referrer.

When the optional ingress is disabled (the current default), the subscription URL is useful immediately for the existing REALITY service once this Worker version is released. A proper approved public VPN ingress hostname remains a later prerequisite for the *second* connection; the Worker URL is **not** a VPN hostname.

This branch is not deployed. No server purchases, domains, DNS, or production migration are needed for further source/test work. Do not treat `trycloudflare.com` addresses as durable subscriptions or activate this test endpoint for paid customers.

## Unfinished scope

The new code does not deploy external WSS ingress automatically or purchase a domain. The direct REALITY 2053/8443 alternatives need no domain but require firewall/network testing. Commercial ingress, exact Xray and concurrent cap field tests, and safe production rollout have not been proven. The current updater can restart the active node; do not run it as a zero-downtime procedure.

Official references:
- https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/
- https://developers.cloudflare.com/tunnel/concepts/routing/
- https://www.cloudflare.com/service-specific-terms-application-services/
