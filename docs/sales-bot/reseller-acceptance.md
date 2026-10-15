# Acceptance evidence — 2026-10-15

## Automated/local

Real pinned Xray 26.3.27 VLESS/REALITY, empty flow, TLS 1.3 local destination: open-stream counters increase before connection close. A persisted quota observation followed by terminating that account's Xray process closes the existing download. Ten simultaneous independent local client/server probes passed; maximum measured observation-to-stable-receiver cutoff 0.504 seconds. The first concurrent fixture run was 9/10 because ephemeral test port allocation collided; fixed, disjoint test ranges passed 10/10. These are local process/counter probes, not production ISP throughput or the full deployed Agent acceptance.

Worker tests cover role revalidation, independent/idempotent accounts and trials, inert retail callbacks, quota report replay/concurrency, two-stage policy ACK activation, capability delivery and revocation. Python tests cover durable totals/outbox, reset and rollback fail-closed behavior, per-account cutoff without stopping its sibling, liveness and ownership updates. Browser tests cover copied status links, safe text rendering, visibility-aware refresh and stale reports.

## Required field gates — BLOCKED, not executed

- Owned Madar_st1 upgrade and current valid quota-capable ACK.
- Personal read-only inventory and safe enrollment as trial node.
- TCP account-port range reachability through AWS security group.
- Import a new paid/trial config into phone and laptop; actual internet transfer (a client “ping” alone is insufficient).
- Simultaneous usage on both devices adds to one quota; tiny-cap long download is terminated and remains unusable.
- A real 1800-second trial stops at expiry, and expiry starts at valid ready ACK.
- Unclean process/Agent restart, stalled stats CLI, disk failure, API outage, retry/revoke and private status delivery against the deployed node.
- Report freshness <=15 seconds with ten users through real Worker reporting; local network-independent sampling and watchdog cutoff measured on the VPS.
- Forwarded message opened from another Telegram account; it exposes its own usage only and no seller/admin controls.
- Hamrah Aval, Irancell and ADSL tests when those physical networks are available.

Current D1 read-only inventory contains only Madar_st1; Personal is absent. No new quota mode, database migration, node update, VPS stop, Runner move or claim of sales readiness has been made by the implementation session.

## Independent final review and fix pass

A fresh-context reviewer found three Important issues (no Critical/Minor): account startup failure stopped siblings, replayed Telegram text advanced the wizard twice, and failed port preflight stopped the existing service. Each was reproduced by a failing test, fixed and reverified. Conversation state and its reply now commit atomically with an optimistic update version. Account-local startup failure is isolated. Upgrade port checks precede service changes and recognize owned listeners only by executable plus unit cgroup.

Post-fix local verification: Worker 57, browser 5, Node 21 and Runner 28 tests pass; typecheck, dry-run build, source manifests, security scan and diff checks pass. Exact-head CI and the field gates above remain separate checks.
