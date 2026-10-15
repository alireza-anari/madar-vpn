# Implementation decisions

These decisions accompany the approved reseller plan. Field gates remain in `reseller-acceptance.md`.

- Ruling: Personal inventory and real mobile-network acceptance remain explicit field prerequisites; implement and verify all independent code without claiming field readiness.

- Task 4: Ruling: use one namespaced Xray subprocess per managed account on its own assigned port, rather than restarting a shared quota process — shared-process restarts cannot prove an exact final counter sample and would otherwise ambiguously reset unrelated accounts. This preserves independent cutoff and fail-closed continuity. Cost: more memory and a dedicated inbound port range (20000–20999) must be allowed on the VPS security group before activation. Legacy retail process remains unchanged.

- Task 3: Ruling: Python verification runs with PYTHONPATH=sales-node from repo root; initial task-done command lacked module path and failed collection, not assertions.

- Task 4: Ruling: ambiguous Agent/Xray restart leaves previously observed accounts blocked for support intervention instead of auto-resetting counters — no unverifiable missing bytes are granted. Cost: affected subscriptions need a controlled reissue after crash; normal per-account cutoff does not interrupt siblings.

- Task 5/6: Ruling: delivery module is committed alongside ACK integration, with public routes/UI in Task 6 — required to keep imports reviewable; no business behavior differs.

- Final: Ruling: production readiness remains gated by actual node/device acceptance — local proof cannot establish the deployed service — cost: rollout waits for owner access.

- Final: Ruling: real Telegram forwarding remains an owner check, with copied capability access covered locally — cost: Telegram-specific UI issues may remain until checked.

- Final: Ruling: Personal enrollment waits for read-only inventory — no live access is available and unrelated services must be preserved — cost: no test node until safe onboarding.

- Final: Ruling: deployed Agent/ISP performance remains an explicit field gate — local counter/cutoff probes do not prove Hamrah Aval/Irancell/ADSL or real report freshness — cost: those network limits remain unknown.

- Final: Ruling: exact-head CI will be checked after publishing the reviewed tree — local suites are not substituted for remote CI — cost: deployment waits if CI fails.

No deferred minor findings.
