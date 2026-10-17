import { createHmac } from "node:crypto";
import { env } from "cloudflare:workers";
import { beforeEach, expect, test } from "vitest";
import { resetDb } from "./db";
import m1 from "../migrations/0001.sql?raw";
import m2 from "../migrations/0002.sql?raw";
import m3 from "../migrations/0003.sql?raw";
import m4 from "../migrations/0004-reseller-accounts.sql?raw";
import m5 from "../migrations/0005-shared-node-purposes.sql?raw";
import m6 from "../migrations/0006-trial-quota.sql?raw";
import m7 from "../migrations/0007-node-capacity.sql?raw";
import m8 from "../migrations/0008-reseller-invites.sql?raw";
import m9 from "../migrations/0009-node-allocation-cap.sql?raw";
import m10 from "../migrations/0010-capacity-accounting-resellers.sql?raw";
import m11 from "../migrations/0011-node-account-slot-mode.sql?raw";
import { appApi } from "../src/app-api";

const GB = 1e9;
const now = 10_000;
const token = "123456:ADMIN_APP_TEST";
const e = {
  ...env,
  BOT_TOKEN: token,
  ADMIN_TELEGRAM_IDS: "1",
  PUBLIC_BASE_URL: "https://example.test",
} as Env;

function signed(id: number) {
  const p = new URLSearchParams({
    auth_date: String(now),
    query_id: `q-${id}`,
    user: JSON.stringify({ id }),
  });
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const value = [...p.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  p.set("hash", createHmac("sha256", secret).update(value).digest("hex"));
  return p.toString();
}

function request(path: string, id: number, body?: unknown) {
  return new Request(`https://example.test${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "X-Telegram-Init-Data": signed(id),
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeEach(async () => {
  await resetDb();
  for (const sql of [m1, m2, m3, m4, m5, m6, m7, m8, m9, m10, m11])
    await env.SALES_DB.exec(sql);
  await env.SALES_DB.exec(
    "INSERT INTO resellers(telegram_id,enabled,created_at) VALUES('10',1,100),('20',1,100);" +
      "INSERT INTO nodes(id,name,target_ip,vpn_port,state,revision,acked_revision,last_seen,healthy,agent_capabilities,max_accounts,max_allocated_bytes) VALUES('n1','Stockholm','13.51.1.1',443,'ready',12,12,10000,1,'quota-v2,shared-443',20,100000000000),('n2','Frankfurt','1.1.1.1',443,'ready',8,7,10000,1,'quota-v2,shared-443',10,NULL);" +
      "INSERT INTO node_purposes(purpose,node_id) VALUES('sale','n1'),('trial','n2');",
  );
  await env.SALES_DB.prepare(
    `INSERT INTO managed_accounts(
      id,seller_id,request_key,node_id,kind,label,uuid,state,quota_bytes,used_bytes,
      duration_seconds,valid_until,created_at,seller_settlement_epoch
    ) VALUES
      ('live','10','live','n1','sale','Live','uuid-live','active',?, ?,86400,20000,200,0),
      ('rev','10','rev','n2','sale','Rev','uuid-rev','revoked',?, ?,86400,20000,210,0),
      ('other','20','other','n1','sale','Other','uuid-other','active',?, ?,86400,20000,220,0)`,
  )
    .bind(30 * GB, 5 * GB, 20 * GB, 8 * GB, 10 * GB, 1 * GB)
    .run();
});

test("every admin endpoint rejects an enabled seller before target lookup", async () => {
  const calls: Array<[string, unknown?]> = [
    ["/api/app/admin/nodes/missing"],
    ["/api/app/admin/nodes/missing/accounts", { mode: "unlimited" }],
    ["/api/app/admin/nodes/missing/bandwidth", { maxAllocatedBytes: null }],
    ["/api/app/admin/sellers/missing"],
    ["/api/app/admin/sellers/missing/access", { enabled: false }],
    ["/api/app/admin/sellers/missing/limits", { maxReservedAccounts: null, maxCommittedBytes: null }],
    ["/api/app/admin/sellers/missing/settle", {}],
    ["/api/app/admin/sellers/missing/settlements"],
    ["/api/app/admin/reports/overview"],
  ];
  for (const [path, data] of calls) {
    const response = await appApi(request(path, 10, data), e, now);
    expect(response.status, path).toBe(403);
    expect(await response.json(), path).toEqual({ error: "ADMIN_REQUIRED" });
  }
});

test("admin node detail exposes operational fields and true capacity modes", async () => {
  const response = await appApi(request("/api/app/admin/nodes/n1", 1), e, now);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    id: "n1",
    displayName: "Stockholm",
    targetIp: "13.51.1.1",
    vpnPort: 443,
    revision: 12,
    ackedRevision: 12,
    healthy: true,
    maxAllocatedBytes: 100 * GB,
    committedBytes: 40 * GB,
    finalizedUsedBytes: 0,
    sellableBytes: 60 * GB,
    maxAccounts: 20,
    remainingSlots: 18,
    accountSlotsUnlimited: false,
  });
});

test("admin can switch node bandwidth and account slots between finite and unlimited", async () => {
  let response = await appApi(
    request("/api/app/admin/nodes/n1/bandwidth", 1, { maxAllocatedBytes: 250 * GB }),
    e,
    now,
  );
  expect(response.status).toBe(200);
  expect(
    await env.SALES_DB.prepare("SELECT max_allocated_bytes FROM nodes WHERE id='n1'").first(
      "max_allocated_bytes",
    ),
  ).toBe(250 * GB);

  response = await appApi(
    request("/api/app/admin/nodes/n1/bandwidth", 1, { maxAllocatedBytes: null }),
    e,
    now,
  );
  expect(response.status).toBe(200);
  expect(
    await env.SALES_DB.prepare("SELECT max_allocated_bytes FROM nodes WHERE id='n1'").first(
      "max_allocated_bytes",
    ),
  ).toBeNull();

  response = await appApi(
    request("/api/app/admin/nodes/n1/accounts", 1, { mode: "unlimited" }),
    e,
    now,
  );
  expect(response.status).toBe(200);
  expect(
    await env.SALES_DB.prepare("SELECT max_accounts_unlimited FROM nodes WHERE id='n1'").first(
      "max_accounts_unlimited",
    ),
  ).toBe(1);

  response = await appApi(
    request("/api/app/admin/nodes/n1/accounts", 1, { mode: "finite", maxAccounts: 55 }),
    e,
    now,
  );
  expect(response.status).toBe(200);
  expect(
    await env.SALES_DB.prepare(
      "SELECT max_accounts,max_accounts_unlimited FROM nodes WHERE id='n1'",
    ).first(),
  ).toEqual({ max_accounts: 55, max_accounts_unlimited: 0 });
});

test("admin seller detail contains current/all-time stats, limits and per-node breakdown", async () => {
  const response = await appApi(request("/api/app/admin/sellers/10", 1), e, now);
  expect(response.status).toBe(200);
  const result = (await response.json()) as any;
  expect(result.enabled).toBe(true);
  expect(result.current).toMatchObject({ configCount: 2, soldBytes: 50 * GB, usedBytes: 13 * GB });
  expect(result.all).toMatchObject({ configCount: 2, soldBytes: 50 * GB, usedBytes: 13 * GB });
  expect(result.limits).toMatchObject({ maxReservedAccounts: null, maxCommittedBytes: null });
  expect(result.currentNodes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ nodeId: "n1", soldBytes: 30 * GB, usedBytes: 5 * GB }),
      expect.objectContaining({ nodeId: "n2", soldBytes: 20 * GB, usedBytes: 8 * GB }),
    ]),
  );
});

test("admin can enable/disable sellers and set or clear seller limits", async () => {
  let response = await appApi(
    request("/api/app/admin/sellers/10/access", 1, { enabled: false }),
    e,
    now,
  );
  expect(response.status).toBe(200);
  expect(
    await env.SALES_DB.prepare("SELECT enabled FROM resellers WHERE telegram_id='10'").first(
      "enabled",
    ),
  ).toBe(0);

  response = await appApi(
    request("/api/app/admin/sellers/10/access", 1, { enabled: true }),
    e,
    now,
  );
  expect(response.status).toBe(200);

  response = await appApi(
    request("/api/app/admin/sellers/10/limits", 1, {
      maxReservedAccounts: 7,
      maxCommittedBytes: 70 * GB,
    }),
    e,
    now,
  );
  expect(response.status).toBe(200);
  expect(
    await env.SALES_DB.prepare(
      "SELECT max_reserved_accounts,max_committed_bytes FROM reseller_controls WHERE seller_id='10'",
    ).first(),
  ).toEqual({ max_reserved_accounts: 7, max_committed_bytes: 70 * GB });

  response = await appApi(
    request("/api/app/admin/sellers/10/limits", 1, {
      maxReservedAccounts: null,
      maxCommittedBytes: null,
    }),
    e,
    now,
  );
  expect(response.status).toBe(200);
});

test("settlement snapshots history and advances accounting without interrupting active configs", async () => {
  const settled = await appApi(
    request("/api/app/admin/sellers/10/settle", 1, {}),
    e,
    now,
  );
  expect(settled.status).toBe(200);
  expect(await settled.json()).toMatchObject({ closedEpoch: 0 });
  expect(
    await env.SALES_DB.prepare("SELECT state FROM managed_accounts WHERE id='live'").first("state"),
  ).toBe("active");
  expect(
    await env.SALES_DB.prepare(
      "SELECT current_settlement_epoch FROM reseller_controls WHERE seller_id='10'",
    ).first("current_settlement_epoch"),
  ).toBe(1);

  const detail = await appApi(request("/api/app/admin/sellers/10", 1), e, now);
  const detailJson = (await detail.json()) as any;
  expect(detailJson.current.configCount).toBe(0);
  expect(detailJson.all.configCount).toBe(2);

  const history = await appApi(
    request("/api/app/admin/sellers/10/settlements", 1),
    e,
    now,
  );
  expect(history.status).toBe(200);
  const rows = (await history.json()) as any[];
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ epoch: 0, configCount: 2, soldBytes: 50 * GB, usedBytes: 13 * GB });
  expect(rows[0].nodes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ nodeId: "n1", soldBytes: 30 * GB }),
      expect.objectContaining({ nodeId: "n2", soldBytes: 20 * GB }),
    ]),
  );
});

test("admin report overview returns global summary, node capacity and seller cards", async () => {
  const response = await appApi(request("/api/app/admin/reports/overview", 1), e, now);
  expect(response.status).toBe(200);
  const report = (await response.json()) as any;
  expect(report.summary).toMatchObject({ configsInService: 2, activeSellers: 2 });
  expect(report.nodes).toEqual(expect.arrayContaining([expect.objectContaining({ id: "n1" })]));
  expect(report.sellers).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ sellerId: "10", enabled: true }),
      expect.objectContaining({ sellerId: "20", enabled: true }),
    ]),
  );
});
