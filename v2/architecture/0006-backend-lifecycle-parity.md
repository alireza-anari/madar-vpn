# Madar V2 backend parity and release boundary

This backend-only branch does NOT edit Telegram UI/UX, bot navigation, branding,
Android UI, or V1 production resources. It reuses V1's separation of installation,
policy acknowledgement, and customer activation.

## Implemented control-plane sequence

1. Fresh V2 installer provisions trial REALITY at TCP 8443, then adds TCP 443.
   These listeners share only the initial test UUID. Listening is not a sale.
2. The V2 node must acknowledge its signed desired-state revision through its
   authenticated node API. The current installer does not yet install a
   persistent client provisioning and usage-monitoring agent.
3. An independent field harness, using real MCI or Irancell mobile traffic,
   can submit a short-lived HMAC-SHA256 signed JSON proof to
   POST /api/v2/field/accept. Observations must attest authenticated proxy
   traffic in both directions and the correct port for each operator.
   Both fresh observations are needed before marking a node ready.
   The secret authenticates the harness; real carrier identity must be
   established by the harness, not guessed from the VPS public endpoint.
4. After actual acceptance, feature-gated order reconciliation can reserve
   an approved order transactionally: a pending subscription, encrypted UUID,
   and one reserved node allocation. It does not activate customer access.
5. GET /api/node/v1/clients supplies signed desired customer UUIDs to a
   separately authenticated node. These are desired state, not installation.
6. POST /api/node/v1/clients/ack is accepted only from a signed node; the
   exact UUID digests, revision and dual-port health must match. Only then
   does the Worker activate the reserved order and notify the customer.
7. Commercial subscription feeds require matching fresh per-customer runtime
   ACKs in addition to quota, allocation, route and entitlement checks.
   Rotating or deleting an encrypted customer credential revokes its ACK.

## Still missing; do NOT claim production readiness

- The automated persistent V2 node executor which actually installs/revokes
  each customer's UUID on BOTH Xray listeners, verifies locally, and sends
  the signed runtime ACK. The current V2 poller merely records desired state.
- V1-style server-observed volume/time settlement and quota enforcement.
  Neither the database nor a subscription link enforces physical node traffic.
- Recovery, expiry, revocation and fail-closed policy during an outage.
- Independent carrier field tests and live VPS reboots, with MCI and Irancell,
  exact final SHA, quota exhaustion, and customer activation/deactivation.

KEEP DISABLED until these are implemented and field-verified:
SHOP_ENABLED, SUBSCRIPTION_LINKS_ENABLED, PROVISIONING_ENABLED,
FIELD_PROBE_ENABLED. The latter two default to disabled.

This is isolated V2 D1 only. Never migrate V1 production D1, reuse SSH
secrets across versions, or edit the user-approved bot UI in this workstream.
