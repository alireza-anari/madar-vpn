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

## Unfinished scope

The new code does not deploy external ingress automatically or create a single renewable subscription URL containing multiple configs. Bot delivery initially sends both configs in one Telegram message when policy/agent gates are live. Commercial operation and capacity tests have not been proven.

Official references:
- https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/
- https://developers.cloudflare.com/tunnel/concepts/routing/
- https://www.cloudflare.com/service-specific-terms-application-services/
