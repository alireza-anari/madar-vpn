# Node1 Heartbeat Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the existing `Stockholm` Node1 heartbeat/quota reporting and real traffic from evidence, without faking health in D1 or disturbing the healthy `AWS Stockholm 2` node.

**Architecture:** Treat Node1 as an operational incident first. Observe systemd, heartbeat state, Worker reachability, quota runtime and shared-443/Xray independently; identify the first failing boundary; apply the smallest repair; then verify fresh ACK/reports in D1 and a real client connection. Code changes are allowed only if evidence proves a reproducible runtime defect shared by the checked-in agent.

**Tech Stack:** Ubuntu/systemd, Python sales-node agent, Xray shared-443 frontend, Cloudflare Worker/D1, AWS EC2.

**Spec:** `docs/superpowers/specs/2026-10-17-miniapp-hardening-design.md`

## Global Constraints

- Do not manually update `nodes.last_seen`, `nodes.healthy`, `acked_revision`, quota reports, or any D1 health field.
- Do not reinstall/adopt Node1 as the first response; preserve its existing config, keys and shared-443 frontend.
- Do not restart the healthy second node.
- Never print `/etc/madar-sales-node/config.json`, node token, policy key, private key, or other secrets into chat/logs.
- Restart only after the failing layer is identified from evidence.
- Preserve the existing Personal/shared-443 traffic configuration unless diagnosis proves that specific layer is broken.
- Acceptance requires fresh Worker ACK, fresh quota report, healthy server detail and a real client traffic test.

## Review Focus

- Agent service active but network loop silently failing: authenticated policy probe should distinguish Worker reachability/token failure from local runtime failure.
- Watchdog stopping service because heartbeat is stale: inspect heartbeat timestamps before restarting.
- Xray active while Madar frontend/processes are broken: verify shared-443/runtime separately rather than treating `xray.service active` as sufficient.
- Revision already equal while last_seen is stale: equality does not mean health; fresh ACK/report timestamps are required.
- Restart appears successful but reports do not resume: stop and diagnose again instead of mutating D1 or repeatedly restarting.

---

### Task 1: Capture a non-destructive incident snapshot

**Files:**
- No repository files modified.

**Interfaces:**
- Produces a timestamped diagnosis snapshot for Node1 before any restart.

- [ ] **Step 1: On Node1 run service-state checks:**
  `sudo systemctl status madar-sales-node.service madar-sales-watchdog.timer madar-sales-watchdog.service xray.service --no-pager -l`
  Record only state/exit codes and non-secret error text.
- [ ] **Step 2: Read recent agent/watchdog journals:**
  `sudo journalctl -u madar-sales-node.service -u madar-sales-watchdog.service --since '-4 hours' --no-pager -n 400`
  Do not paste lines containing credentials or full request headers.
- [ ] **Step 3: Inspect heartbeat metadata without dumping config:**
  `sudo python3 - <<'PY'\nimport json,pathlib,time\np=pathlib.Path('/run/madar-sales-node/quota-heartbeat.json')\nprint('exists=',p.exists())\nif p.exists():\n d=json.loads(p.read_text()); now=int(time.time()); print({k:d.get(k) for k in ('expiresAt','sampledAt','graceUntil')}); print('sample_age=',now-int(d.get('sampledAt',0)),'expires_in=',int(d.get('expiresAt',0))-now)\nPY`
- [ ] **Step 4: Verify local persistent quota state opens:**
  `sudo python3 - <<'PY'\nimport sqlite3\np='/var/lib/madar-sales-node/quota.sqlite'\ncon=sqlite3.connect(p); print(con.execute('select revision from meta where id=1').fetchone()); print(con.execute('select count(*) from accounts').fetchone()); con.close()\nPY`
- [ ] **Step 5: Compare with production D1 read-only evidence** for Node1 `last_seen`, `revision`, `acked_revision`, last quota report timestamp; confirm the incident still reproduces before repair.

### Task 2: Identify the failing boundary

**Files:**
- No repository files modified.

**Interfaces:**
- Produces exactly one primary hypothesis: service dead/crashing, watchdog expiry, Worker/network/auth failure, quota-runtime state failure, or shared-443/Xray failure.

- [ ] **Step 1: Verify Worker public reachability from Node1 without secrets:** load only `baseUrl` from config in Python and request `/app`; print HTTP status only.
- [ ] **Step 2: Perform an authenticated `policy-v2` probe using the existing config but never print credentials:** run a small local Python snippet that imports `/opt/madar-sales-node/agent.py`, calls its `request(config,'policy-v2')`, and prints only whether a signed envelope was returned plus payload revision after verification.
- [ ] **Step 3: If the authenticated probe fails, classify the exception locally** as DNS/connect timeout, HTTP status, TLS failure or authorization failure; do not restart until this boundary is understood.
- [ ] **Step 4: If policy retrieval succeeds, verify runtime/frontend:** check `xray.service`, listener 443, local runtime processes, and `frontend_ready` evidence from journal; do not expose keys/config.
- [ ] **Step 5: State one hypothesis in the incident record** in the form `Root cause candidate X because evidence Y`; if evidence is ambiguous, gather one more targeted observation instead of changing the system.

### Task 3: Apply the smallest repair

**Files:**
- Modify repository code only if Task 2 proves a reproducible checked-in runtime defect.
- Possible code files if required: `sales-node/agent.py`, `sales-node/quota_runtime.py`, `sales-node/shared443.py`, matching `sales-node/tests/*`.

**Interfaces:**
- Produces a running Node1 with no secret/config replacement and no effect on Node2.

- [ ] **Step 1: If service is stopped solely because of a transient resolved dependency, start/restart only `madar-sales-node.service`** and leave Xray untouched unless Xray itself is the failing layer.
- [ ] **Step 2: If watchdog/timer is broken, repair/enable only `madar-sales-watchdog.timer`** after confirming the agent heartbeat can become fresh.
- [ ] **Step 3: If shared-443/Xray is the failing layer, validate its current config with the installed Xray binary before any restart; preserve the existing frontend config and keys.
- [ ] **Step 4: If a code defect is proven, first write a failing Python test** under `sales-node/tests/` reproducing the exact failure from Task 2, run it to verify FAIL, implement the minimal fix, then run the focused test to PASS.
- [ ] **Step 5: For any code fix, run the complete sales-node Python test suite** using the repository's existing test command/convention before deploying the changed source.
- [ ] **Step 6: Deploy only the tested changed node files through the existing pinned update path**; do not replace `/etc/madar-sales-node/config.json`.
- [ ] **Step 7: Commit a code fix only if one was actually required** with a root-cause-specific message; otherwise make no source commit for an operational restart/repair.

### Task 4: Verify fresh liveness and policy flow

**Files:**
- No repository files modified unless Task 3 required code.

**Interfaces:**
- Produces evidence that Node1 is genuinely live rather than cosmetically marked healthy.

- [ ] **Step 1: Verify `madar-sales-node.service` remains active for at least two polling cycles** and journal shows no restart loop.
- [ ] **Step 2: Verify heartbeat freshness**: `sample_age` stays within the runtime's expected few-second window and `expiresAt` remains in the future.
- [ ] **Step 3: Query production D1 read-only** and confirm Node1 `last_seen` advances to current time and `healthy=1` comes from a fresh ACK.
- [ ] **Step 4: Confirm a new `account_quota_reports.observed_at` row/time appears for Node1** after repair.
- [ ] **Step 5: Confirm `revision` and `acked_revision` remain equal after a fresh cycle**; if a new policy revision is issued, verify it becomes freshly ACKed rather than only reading the old 2037 value.
- [ ] **Step 6: Open Mini App server detail** and verify `Stockholm` changes from stale-heartbeat/out-of-access to healthy only after backend evidence becomes fresh.

### Task 5: Field traffic acceptance and closeout

**Files:**
- No repository files modified unless a tested repair commit exists.

**Interfaces:**
- Produces final incident acceptance evidence.

- [ ] **Step 1: Use an existing authorized Node1 config or a deliberately created small test config** and establish a real VPN connection through Node1; do not create unnecessary production accounts.
- [ ] **Step 2: Generate a small amount of traffic** and verify the corresponding account usage report increases in D1.
- [ ] **Step 3: Verify an existing Node2 client still works** to prove the repair did not disturb the healthy second node.
- [ ] **Step 4: Record root cause, exact repair action, pre/post `last_seen`, pre/post quota-report timestamp, service state and any code commit SHA**.
- [ ] **Step 5: If liveness fails again during acceptance, reopen Task 1**; do not declare success based on a single transient ACK.
