import { env } from "cloudflare:workers";
import { beforeEach, expect, test } from "vitest";
import { resetDb } from "./db";
import a from "../migrations/0001.sql?raw";
import b from "../migrations/0002.sql?raw";
import c from "../migrations/0003.sql?raw";
import d from "../migrations/0004-reseller-accounts.sql?raw";
import m14 from "../migrations/0014-on-demand-usage.sql?raw";
import { acceptQuotaReports } from "../src/quota-reports";
beforeEach(async () => {
  await resetDb();
  for (const s of [a, b, c, d, m14]) await env.SALES_DB.exec(s);
  await env.SALES_DB.exec(
    "INSERT INTO nodes(id,name,target_ip) VALUES('n','n','8.8.8.8'); INSERT INTO managed_accounts(id,seller_id,request_key,node_id,kind,label,uuid,quota_bytes,duration_seconds,created_at,state,valid_until) VALUES('a','10','r','n','sale','a','uuid',100,100,1,'active',1000);",
  );
});
const report = {
  accountId: "a",
  quotaEpoch: 1,
  sequence: 1,
  totalBytes: 30,
  observedAt: 100,
  generation: "a:1",
};
test("cumulative reports never double debit or decrease totals", async () => {
  await acceptQuotaReports(env.SALES_DB, "n", [report], 101);
  await acceptQuotaReports(env.SALES_DB, "n", [report], 102);
  await acceptQuotaReports(
    env.SALES_DB,
    "n",
    [{ ...report, sequence: 3, totalBytes: 110 }],
    103,
  );
  await acceptQuotaReports(
    env.SALES_DB,
    "n",
    [{ ...report, sequence: 2, totalBytes: 40 }],
    104,
  );
  expect(
    await env.SALES_DB.prepare(
      "SELECT used_bytes FROM managed_accounts WHERE id='a'",
    ).first("used_bytes"),
  ).toBe(110);
  expect(
    await env.SALES_DB.prepare(
      "SELECT state FROM managed_accounts WHERE id='a'",
    ).first("state"),
  ).toBe("exhausted");
});
test("foreign account, conflicting replay, bad epoch and unsafe values are rejected", async () => {
  await expect(
    acceptQuotaReports(env.SALES_DB, "other", [report], 101),
  ).rejects.toThrow();
  await acceptQuotaReports(env.SALES_DB, "n", [report], 101);
  for (const patch of [
    { totalBytes: 31 },
    { quotaEpoch: 2 },
    { generation: "other" },
    { sequence: -1 },
    { totalBytes: Number.MAX_SAFE_INTEGER + 1 },
  ])
    await expect(
      acceptQuotaReports(env.SALES_DB, "n", [{ ...report, ...patch }], 101),
    ).rejects.toThrow();
});
test("simultaneous conflicting sequences cannot both be accepted", async () => {
  const results = await Promise.allSettled([
    acceptQuotaReports(env.SALES_DB, "n", [report], 101),
    acceptQuotaReports(env.SALES_DB, "n", [{ ...report, totalBytes: 31 }], 101),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
});
test("expiry wins over a simultaneous local blocked report", async () => {
  await env.SALES_DB.prepare(
    "UPDATE managed_accounts SET valid_until=101 WHERE id='a'",
  ).run();
  await acceptQuotaReports(
    env.SALES_DB,
    "n",
    [{ ...report, observedAt: 101, blocked: true }],
    101,
  );
  expect(
    await env.SALES_DB.prepare(
      "SELECT state FROM managed_accounts WHERE id='a'",
    ).first("state"),
  ).toBe("expired");
});
