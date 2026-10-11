# Phase 9 — multi-node field acceptance

Date: 2026-10-11  
Status: **PREPARED — second real node field execution pending.**

## Scope

Task 29 proves that one Madar account can receive multiple eligible VLESS+REALITY nodes, that each node is advertised only while independently fresh/healthy/capacity-eligible and ACKed for the user's current policy revision, and that Free active seconds remain account-global when the same UTC seconds are observed by more than one node.

This task does not prove the Phase 9 per-user speed cap; that is Task 30 and has a separate architecture/field gate.

## Repository evidence

The production subscription path already filters candidates by `ready` status, heartbeat freshness, public REALITY config and per-user policy revision ACK. Node heartbeats map unhealthy or capacity-exhausted nodes away from `ready`. The active-second settlement store already de-duplicates overlapping masks at user/minute scope across different node IDs under concurrent PostgreSQL settlement.

A Phase 9 integration regression was added in `apps/api/integration/multinode-subscription.postgres.test.ts` to exercise the production PostgreSQL node/access/subscription stores together. It covers:

- two fresh healthy capacity-eligible nodes advertised together;
- a stale node excluded;
- an unhealthy node excluded;
- a capacity-exhausted node excluded;
- an unacknowledged node excluded;
- Client ID rotation withholding every node until that node independently ACKs the new user policy revision;
- one node reappearing after its ACK while the other remains withheld;
- both nodes reappearing only after both ACK.

Cross-node accounting is independently covered in `apps/api/integration/usage.postgres.test.ts`, including concurrent identical masks from two node IDs and disjoint masks in the same user-minute.

## Required real field evidence

Phase 9 Task 29 is not PASS until all items below are executed against two real enrolled VPS nodes:

- [ ] Enroll a second supported Ubuntu VPS through a one-time enrollment token; do not clone node credentials or REALITY private material.
- [ ] Pin the approved Xray version and verify both Agents/Xray services healthy with independent node credentials/configs.
- [ ] Publish one fresh user policy to both nodes and wait for the required per-user revision ACK from each.
- [ ] Fetch the real subscription and verify both eligible nodes are present.
- [ ] Refresh the same subscription in real v2rayNG and verify both Madar nodes are displayed.
- [ ] Connect through node A and prove ordinary public traffic exits through node A.
- [ ] Connect through node B and prove ordinary public traffic exits through node B.
- [ ] Make one node stale or unhealthy in a controlled way and prove it disappears while the healthy node remains advertised; restore it and prove recovery only after readiness is fresh again.
- [ ] Put one node into a controlled capacity-excluded state and prove it disappears while the other remains; restore capacity and prove it returns.
- [ ] Rotate the user's Client ID and prove neither node is advertised before its new user revision is ACKed; after only one ACK, only that node may appear; after both ACK, both may appear.
- [ ] Generate overlapping real active UTC seconds for the same account through both nodes and prove both telemetry reports settle but the overlapping account seconds debit only once globally.
- [ ] End with no unexplained `unmapped` masked report, no pending outbox, and no unexpected accumulated activity.
- [ ] Perform a bounded secret/log scan and preserve historical journals.

## Secret/evidence rules

Do not record enrollment tokens, node credentials, client UUIDs, subscription bearer URLs/tokens, REALITY private keys, session/CSRF values or raw per-client StatsService payloads. Use only counts, versions, safe timestamps, node aliases and one-way fingerprints when comparison is necessary.

## PASS rule

Task 29 may be marked PASS only when the real two-node subscription, independent readiness/capacity filtering, per-node rotation ACK behavior, traffic through each node and account-global cross-node active-second de-duplication all pass on one documented field run.

Until then:

- Task 29: **INCOMPLETE**;
- Task 30: not yet implemented/field-proven;
- Phase 9: **INCOMPLETE**;
- Production Ready: **not claimed**.
