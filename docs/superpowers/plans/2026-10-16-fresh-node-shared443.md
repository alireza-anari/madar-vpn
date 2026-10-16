# Fresh Node Shared-443 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every fresh protocol-v2 VPS installed by the Telegram sales bot expose one VLESS+REALITY frontend on public TCP 443, keep per-account quota workers loopback-only, advertise `shared-443`, and default REALITY SNI to `www.cloudflare.com`.

**Architecture:** Reuse the existing `shared443.py` bridge model that already works for the Personal node. Fresh nodes will own `madar-sales-xray.service` as the persistent public frontend; quota workers remain independent child Xray processes bound only to loopback. The runner will generate a fresh shared-443 config, while AWS ingress will expose only SSH from the runner source and TCP 443 globally.

**Tech Stack:** Python 3.12, pytest 9.0.2, Xray 26.3.27 pinned artifact, Cloudflare Workers/D1, TypeScript/Vitest, systemd, AWS EC2 SigV4/IMDSv2.

**Spec:** `docs/superpowers/specs/2026-10-16-fresh-node-shared443-design.md`

## Global Constraints

- Protocol-v2 fresh nodes must use `port=443`, `shared443=true`, and default `sni=www.cloudflare.com`.
- Public account ports `20000-20999` must never be opened by new AWS enrollment and must never bind outside loopback.
- Stats/API ports `21000-21999` and HandlerService must remain loopback-only.
- `shared-443` may only be advertised while the shared frontend identity/liveness check succeeds.
- Existing Personal adoption keeps using its existing `xray.service`; fresh-node work must not break that path.
- Existing protocol-v1 behavior remains supported; no silent in-place conversion of an already-installed protocol-v2 node without shared-443.
- REALITY private keys, node tokens, policy keys, bridge credentials, SSH credentials and status tokens must never be logged or returned through Telegram/D1 beyond the already-approved public fields.
- Quota durability, expiry/revocation cutoff and fail-closed restart behavior must remain intact.
- No automatic mutation of already-existing broad AWS `20000-20999` ingress during code rollout; remove that rule only after live 443 verification.

## Review Focus

- **Old protocol-v2 recovery without `shared443`:** reject with `PROTOCOL_UPGRADE_REQUIRED`; never silently keep public account ports or overwrite secrets.
- **Fresh frontend restart with stale dynamic users:** owned fresh frontend must restart/clear dynamic users before quota workers are recreated; stale users must not regain traffic.
- **Public frontend failure while no accounts exist:** node must not advertise a healthy `shared-443` runtime merely because the desired account set is empty.
- **Personal compatibility:** shared frontend service discovery must default to existing `xray.service` for Personal and use `madar-sales-xray.service` only for fresh managed nodes.
- **AWS legacy rule:** new code must stop creating public `20000-20999`; field rollout must explicitly verify and then remove the old Stockholm rule without touching SSH/443.

---

### Task 1: Pin the Fresh Installer Contract

**Files:**
- Modify: `sales-runner/tests/test_installer.py`
- Modify: `sales-runner/installer.py`

**Interfaces:**
- Produces: `DEFAULT_REALITY_SNI = "www.cloudflare.com"`.
- Produces: `configure_protocol(config: dict, job: dict) -> dict` that adds the fresh shared-443 protocol-v2 fields without mutating the input.
- Fresh protocol-v2 config fields: `protocolVersion=2`, `shared443=True`, `frontendManaged=True`, `frontendService="madar-sales-xray.service"`, `bridgeKey=<policyKey>`, `port=443`.
- Existing protocol-v2 config missing `shared443=True` is not recoverable in place and raises `PROTOCOL_UPGRADE_REQUIRED` before package application.

- [ ] **Step 1: Write failing installer tests**

Add tests asserting:

```python
def test_protocol_v2_fresh_config_uses_shared_443_cloudflare():
    config = {"policyKey": "a" * 64, "sni": DEFAULT_REALITY_SNI, "port": 443}
    result = configure_protocol(config, {"protocolVersion": 2})
    assert result["protocolVersion"] == 2
    assert result["shared443"] is True
    assert result["frontendManaged"] is True
    assert result["frontendService"] == "madar-sales-xray.service"
    assert result["bridgeKey"] == "a" * 64
    assert result["port"] == 443
    assert result["sni"] == "www.cloudflare.com"
```

Also add a recovery test that an existing v2 config with no `shared443=True` is rejected with `PROTOCOL_UPGRADE_REQUIRED`, while a matching already-shared config keeps its existing node/private/token/policy values.

- [ ] **Step 2: Run the targeted tests and verify RED**

Run:

```bash
cd sales-runner
python -m pytest tests/test_installer.py -q
```

Expected: new shared-443/default-SNI assertions fail against the current Microsoft/public-port-era config behavior.

- [ ] **Step 3: Implement the minimal installer contract**

In `sales-runner/installer.py`:

- add one `DEFAULT_REALITY_SNI` constant;
- generate fresh config with `sni=DEFAULT_REALITY_SNI`;
- make protocol-v2 configuration add the exact shared-443 fields above;
- before applying an existing config, reject protocol-v2 recovery when `shared443` is not true;
- do not rotate/rewrite existing secret fields during same-job recovery.

- [ ] **Step 4: Run targeted tests and verify GREEN**

Run the same pytest command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add sales-runner/installer.py sales-runner/tests/test_installer.py
git commit -m "fix: provision fresh nodes for shared 443"
```

---

### Task 2: Build an Owned Fresh Shared Frontend Safely

**Files:**
- Modify: `sales-node/tests/test_shared443.py`
- Create: `sales-node/tests/test_guard.py`
- Modify: `sales-node/shared443.py`
- Modify: `sales-node/guard.py`

**Interfaces:**
- Produces: `build_fresh_frontend(settings: dict, *, ports=range(20000, 21000), api_port=19999) -> tuple[dict, dict]`.
- `build_fresh_frontend` creates an empty public REALITY base from the fresh settings and delegates bridge routing construction to existing `build_frontend(...)`, so Personal and fresh nodes share one bridge implementation.
- `SharedFrontend` resolves its service from `settings.get("frontendService", "xray.service")`.
- Produces: `start_owned_frontend(settings: dict, binary: str, base: pathlib.Path) -> SharedFrontend` for fresh nodes only. It writes/tests the static zero-managed-user frontend, writes an explicit frontend-only authorization marker, restarts `madar-sales-xray.service`, and verifies identity/liveness.
- Guard permits a fresh owned frontend to start only when config says `shared443=True`, `frontendManaged=True`, the static 443 frontend contains zero managed clients, and the explicit frontend-only marker is present. Legacy protocol-v1 guard behavior remains unchanged.

- [ ] **Step 1: Write failing shared-frontend tests**

Add tests asserting a fresh frontend has:

- exactly one public VLESS+REALITY inbound on 443;
- HandlerService only on `127.0.0.1:19999`;
- bridge outbounds targeting `127.0.0.1:20000...`;
- zero static managed users;
- `SharedFrontend.current_pid()` queries `madar-sales-xray.service` for fresh settings and `xray.service` for Personal settings.

- [ ] **Step 2: Write failing guard tests**

Test that:

- a fresh zero-user static shared frontend with the explicit frontend-only marker is allowed to start;
- the same marker does not authorize a non-shared/protocol-v1 config;
- a static shared frontend containing a managed client is rejected by the frontend-only guard path;
- existing authorization with non-empty clients and unexpired `expiresAt` still works for legacy service behavior.

- [ ] **Step 3: Run tests and verify RED**

```bash
cd sales-node
python -m pytest tests/test_shared443.py tests/test_guard.py -q
```

Expected: fresh builder/service-aware frontend and frontend-only guard tests fail because those interfaces do not exist yet.

- [ ] **Step 4: Implement fresh frontend construction and service-aware identity checks**

Update `shared443.py` with the interfaces above. Use `render_config(settings, [], now)` only as the base REALITY renderer; all bridge routing must still pass through `build_frontend(...)`. Keep backend account listeners loopback-only.

- [ ] **Step 5: Implement the explicit guard branch**

Refactor `guard.py` just enough to make guard decisions testable without weakening legacy rules. Do not treat `shared443=True` alone as authorization; require `frontendManaged=True`, the frontend-only marker, and zero static managed clients in the candidate file.

- [ ] **Step 6: Run tests and verify GREEN**

Run the same pytest command. Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add sales-node/shared443.py sales-node/guard.py sales-node/tests/test_shared443.py sales-node/tests/test_guard.py
git commit -m "feat: add owned shared 443 frontend"
```

---

### Task 3: Tie Shared Frontend Health Into Quota Runtime

**Files:**
- Modify: `sales-node/tests/test_quota_runtime.py`
- Modify: `sales-node/quota_runtime.py`
- Modify only if needed for startup wiring: `sales-node/agent.py`

**Interfaces:**
- `QuotaRuntime` owns one frontend health object whenever `config["shared443"]` is true.
- For fresh config (`frontendManaged=True`) it obtains the object through `start_owned_frontend(...)`; for Personal it attaches to existing `xray.service` without restarting it.
- Produces: `runtime_capabilities(config: dict, frontend) -> list[str]` returning base `quota-v2, per-account-process` plus `shared-443` only after `frontend.check()` succeeds.
- Runtime `healthy` is false if the shared frontend check fails, even when `desired` is empty.
- Account workers continue to use existing `AccountProcess`, `backend_config` and per-account process cutoff behavior.

- [ ] **Step 1: Write failing runtime tests**

Add tests covering:

- fresh shared runtime invokes owned frontend startup exactly once;
- Personal shared runtime attaches to existing frontend and never calls the fresh owned restart path;
- `shared-443` capability is emitted only when `frontend.check()` succeeds;
- a frontend check failure forces runtime health false and stops/blocks active managed workers instead of reporting them ready;
- an empty desired account set cannot hide a dead shared frontend.

Use injected fake frontend/process factories; do not shell out to systemd in unit tests.

- [ ] **Step 2: Run tests and verify RED**

```bash
cd sales-node
python -m pytest tests/test_quota_runtime.py -q
```

Expected: FAIL because current runtime only checks per-account processes and advertises `shared-443` directly from config.

- [ ] **Step 3: Implement frontend ownership and health gating**

Make the smallest changes in `quota_runtime.py` needed to:

- initialize/attach the correct frontend once;
- include frontend liveness in `healthy`;
- generate ACK capabilities through the checked helper;
- preserve all existing durable quota storage and process-generation semantics.

If `agent.py` needs a wiring change, keep protocol-v1 behavior byte-for-byte equivalent in effect.

- [ ] **Step 4: Run quota runtime tests and shared tests**

```bash
cd sales-node
python -m pytest tests/test_quota_runtime.py tests/test_shared443.py tests/test_guard.py -q
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add sales-node/quota_runtime.py sales-node/agent.py sales-node/tests/test_quota_runtime.py
git commit -m "fix: gate shared 443 capability on frontend health"
```

---

### Task 4: Stop Publishing Account-Port AWS Ingress

**Files:**
- Modify: `sales-runner/tests/test_aws_network.py`
- Modify: `sales-runner/aws_network.py`

**Interfaces:**
- `ensure_network(target, ssh_port, ...) -> bool` keeps exact-target matching and temporary IMDSv2 role behavior.
- New ingress requests are exactly: SSH `runner-public-ip/32`, TCP 443 `0.0.0.0/0`.
- No `AuthorizeSecurityGroupIngress` call may contain port 20000, 20999 or that range.

- [ ] **Step 1: Change the existing AWS test first**

Update `test_exact_target_opens_only_required_ports_and_limits_ssh_to_runner` to expect only `['22', '443']`, and explicitly assert no call has `FromPort`/`ToPort` in the account range.

- [ ] **Step 2: Run and verify RED**

```bash
cd sales-runner
python -m pytest tests/test_aws_network.py -q
```

Expected: FAIL because current code creates a third `20000-20999` ingress rule.

- [ ] **Step 3: Remove only the account-port ingress request**

Change `ensure_network(...)` to authorize SSH and 443 only. Do not add revoke logic here; legacy rule cleanup remains a field rollout action.

- [ ] **Step 4: Run and verify GREEN**

Run the same pytest command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add sales-runner/aws_network.py sales-runner/tests/test_aws_network.py
git commit -m "fix: keep account bridge ports private"
```

---

### Task 5: Lock Telegram Delivery To 443 For Shared Nodes

**Files:**
- Create: `apps/sales-bot/test/account-delivery.test.ts`
- Modify only if the regression exposes a bug: `apps/sales-bot/src/account-delivery.ts`

**Interfaces:**
- Existing delivery rule remains: if node capability contains `shared-443`, public URI port is `node.vpn_port`; otherwise legacy nodes retain `managed_accounts.listen_port`.
- Fresh shared-node fixture uses `vpn_port=443`, capability string `quota-v2,per-account-process,shared-443`, matching signed/ACKed policy and active account with internal `listen_port=20000`.

- [ ] **Step 1: Add the regression test**

Build the minimum D1 fixture using existing migrations and `resetDb()`. Call `queueAccountDelivery(...)`, read the outbox payload, and assert:

```ts
expect(payload.text).toContain(":443?");
expect(payload.text).not.toContain(":20000?");
```

Also keep one legacy fixture asserting a non-`shared-443` node still emits its account-specific port so this change does not silently alter legacy compatibility.

- [ ] **Step 2: Run the focused bot test**

```bash
cd apps/sales-bot
pnpm exec vitest run test/account-delivery.test.ts
```

Expected: the shared-443 case may already pass because the delivery branch exists; if so, keep it as a regression test and do not make unnecessary production changes. The legacy case must also pass.

- [ ] **Step 3: Fix production delivery only if the test exposes a real mismatch**

No refactor is allowed merely to make this task produce a code diff.

- [ ] **Step 4: Commit**

```bash
git add apps/sales-bot/test/account-delivery.test.ts apps/sales-bot/src/account-delivery.ts
git commit -m "test: pin shared 443 account delivery"
```

---

### Task 6: Add a Real-Xray Fresh Shared-443 Probe

**Files:**
- Create: `sales-node/tests/probe_fresh_shared443.py`
- Modify: `scripts/verify_sales_quota_probe.py`

**Interfaces:**
- Probe uses only the pinned Xray artifact downloaded by `sales-runner/artifacts.py`.
- Probe creates temporary local TLS/REALITY fixtures and no persistent credentials.
- Probe must prove: public shared frontend accepts a managed REALITY client; managed counter becomes positive; stopping the loopback backend stops the live managed stream; frontend process remains alive; bridge/stats listeners are loopback.

- [ ] **Step 1: Write the probe using the new fresh frontend builder**

Reuse the existing `probe_shared443.py` transfer/cutoff mechanics, but construct the frontend through `build_fresh_frontend(...)` rather than a pre-existing Personal config.

- [ ] **Step 2: Wire the probe into `verify_sales_quota_probe.py`**

Run the fresh probe after the existing live-stats and Personal shared-443 probes. Keep a bounded timeout and redact temporary keys/UUIDs from failure logs exactly as the existing probe does.

- [ ] **Step 3: Execute the probe locally/CI-capable environment**

```bash
python scripts/verify_sales_quota_probe.py
```

Expected: all probes print PASS/exit 0.

- [ ] **Step 4: Commit**

```bash
git add sales-node/tests/probe_fresh_shared443.py scripts/verify_sales_quota_probe.py
git commit -m "test: probe fresh shared 443 traffic"
```

---

### Task 7: Full Verification Before Live Rollout

**Files:**
- No production code unless a failing suite reveals a regression.

**Interfaces:**
- All branch tests and build checks must be green before any Stockholm reinstall.

- [ ] **Step 1: Run the complete Python suites**

```bash
cd sales-runner && python -m pytest
cd ../sales-node && python -m pytest
```

Expected: all tests pass.

- [ ] **Step 2: Run bot verification**

```bash
cd apps/sales-bot
pnpm test
pnpm run typecheck
pnpm run build
```

Expected: all commands exit 0.

- [ ] **Step 3: Run the pinned Xray probes**

From repo root:

```bash
python scripts/verify_sales_quota_probe.py
```

Expected: PASS and exit 0.

- [ ] **Step 4: Push/observe the existing `Telegram sales bot` GitHub Actions workflow**

The workflow already runs bot types/typecheck/test/build, sales-runner pytest, sales-node pytest, Personal install tests and `verify_sales_quota_probe.py`. Do not call the implementation complete until the branch-head workflow is green.

- [ ] **Step 5: Record the exact green branch HEAD and workflow run ID**

Use these identifiers for the live runner update and field acceptance report.

---

### Task 8: Live Stockholm Reinstall and Field Acceptance

**Files:**
- No repo files required unless field evidence uncovers a bug.

**Interfaces:**
- This task is intentionally manual/field-only because it requires live SSH/AWS access and real client connectivity.
- Never paste SSH private keys, node tokens, policy keys, REALITY private keys, bot token or D1 secrets into chat/logs.

- [ ] **Step 1: Update the live sales runner to the exact green branch HEAD**

Verify its deployed source revision before creating a new install job.

- [ ] **Step 2: Reset/reissue only the current test Stockholm node/account state through the bot/database workflow**

Do not mutate a production/customer account in place.

- [ ] **Step 3: Reinstall Stockholm through the Telegram bot**

Expected D1/node state: install ready, then exact policy revision ACK with capabilities containing `quota-v2,per-account-process,shared-443`.

- [ ] **Step 4: Verify listener shape on the VPS without printing secrets**

Run:

```bash
sudo ss -ltnp | grep -E ':(443|19999|20000|21000) ' || true
```

Expected after one active account:

- public `*:443` owned by the fresh frontend;
- `127.0.0.1:19999` HandlerService;
- account bridge `127.0.0.1:20000` only;
- stats `127.0.0.1:21000` only;
- no public `*:20000`.

- [ ] **Step 5: Issue a new test account and inspect only its public URI metadata**

Expected URI host port is `:443`; SNI is `www.cloudflare.com`; do not paste the full UUID-bearing URI into public logs.

- [ ] **Step 6: Perform real client acceptance**

Verify actual transfer, increasing usage counters, quota cutoff, revocation cutoff and expiry cutoff. A ping-only check is insufficient; actual traffic must pass.

- [ ] **Step 7: Remove the old AWS `20000-20999` public ingress rule only after Step 6 succeeds**

Keep SSH restricted to the approved source and keep TCP 443 public.

- [ ] **Step 8: Capture acceptance evidence**

Record non-secret evidence only: green code SHA, CI run, node ID/name, capabilities, listener shape, policy revision/ACK, transfer success, quota/revocation/expiry result.

## Self-Review Result

- Spec coverage: all eight success criteria and rollout gates are mapped to Tasks 1-8.
- Step scan: implementation decisions are pinned at interface/value level; function bodies are intentionally left to execution.
- Type consistency: fresh config flags (`shared443`, `frontendManaged`, `frontendService`, `bridgeKey`) are introduced once in Task 1 and consumed consistently in Tasks 2-3.
- Review Focus: old-node recovery, stale dynamic users, empty-account health, Personal compatibility and legacy AWS rule cleanup each have an owning test or explicit rollout gate.
- Proportion: plan stays at test/signature/verification level and does not duplicate the implementation source.