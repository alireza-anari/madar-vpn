# Premium client compatibility and approved release-scope amendment

Date: 2026-10-14. Status: APPROVED. Operator approved the written proposal with «انجام بده» on 2026-10-14 at 15:08 Asia/Tehran (11:38Z).

## Decision and purpose

The operator delegated the choice of client direction. Retain stock v2rayNG and the existing VLESS/REALITY flow for the current Madar release. Do not create a proprietary VPN application solely to close the one-active-client-instance gate.

This approved product-scope amendment supersedes only the current-release Premium device-lock requirement and its release-gate status in the baseline and 2026-10-10 amendment. It implements no enforcement and proves no acceptance. All other requirements remain authoritative.

## Evidence and limits

Inspected official Xray-core v26.3.27 `proxy/vless/encoding/encoding.go` and `addons.proto`, and v2rayNG 2.2.6 `V2rayNG/app/src/main/java/com/v2ray/ang/fmt/VlessFmt.kt`. The inspected VLESS request authenticates the configured credential. The inspected URI import preserves that credential. No authenticated per-install identity is supplied by these paths. A copied credential therefore does not establish which installation opened a connection.

- https://github.com/XTLS/Xray-core/blob/v26.3.27/proxy/vless/encoding/encoding.go
- https://github.com/XTLS/Xray-core/blob/v26.3.27/proxy/vless/encoding/addons.proto
- https://github.com/2dust/v2rayNG/blob/2.2.6/V2rayNG/app/src/main/java/com/v2ray/ang/fmt/VlessFmt.kt

This finding is scoped to the inspected pinned stock flow, not a claim that every possible future transport or client extension is impossible. It agrees with section 11 of the approved 2026-10-10 usage/Premium amendment.

## Approved current-release product behavior

1. Premium stays expiration-based, with no Madar application speed cap.
2. Credential rotation, revocation, suspension and entitlement expiry remain mandatory and enforced on nodes.
3. The current release does not promise or advertise one active device/client instance per Premium configuration. Copying a valid configuration may permit simultaneous use.
4. IP limits, transport connection counts, browser identities, per-import UUIDs and short-lived bearer credentials are not presented as device enforcement.
5. The strict single-active-client subsystem moves to a separately scoped future project with its own approved specification, implementation and real-device acceptance.
6. There is no new app, gateway, Xray fork, dependency, paid resource, or runtime change in this decision.

## Exact approval impact

This approval amends the Premium requirement and its release-gate status in the baseline design, 2026-10-10 amendment, implementation plan and final acceptance matrix. A removed requirement must be recorded as an approved scope exclusion with its approval reference, never as an enforcement PASS.

Former Task 34 item 5 was REQUIRED and BLOCKED before this approval. It is now an explicit scope exclusion, preserved in final acceptance history and never marked enforcement PASS. All other required acceptance items retain their requirements: iPhone, real rewarded provider, final candidate field reruns and security/safe-state checks still block release.

No production-readiness claim follows from approval alone.

## Why this direction

Retains the real client flow already exercised in Phase 8 and avoids introducing a second application lifecycle, distribution/update process and cryptographic admission layer late in acceptance. A companion UI or device key alone cannot stop a copied bearer configuration from bypassing it; enforcement would require binding data-plane admission to proof of the installation key and real cross-node fencing. That work needs separate feasibility and architecture review.

Tradeoff: the proposed current-release scope cannot guarantee prevention of configuration sharing. This cost must be accepted openly before changing the release gate. The operator accepted this tradeoff by approving the written amendment. Reintroducing enforcement needs a separate approved project; no weaker substitute is permitted.

## Verification and next action

This file contains no secrets and changes documentation only. Authoritative documents are updated consistently and the former gate and historical evidence are preserved with this approval reference. Runtime tests are not a substitute for this product decision.
