import { env } from "cloudflare:workers";
import { beforeEach, expect, test } from "vitest";
import { resetDb } from "./db";
import a from "../migrations/0001.sql?raw";
import b from "../migrations/0002.sql?raw";
import c from "../migrations/0003.sql?raw";
import d from "../migrations/0004-reseller-accounts.sql?raw";
import { buildQuotaPolicy, ackQuotaPolicy } from "../src/quota-policies";
beforeEach(async () => {
  await resetDb();
  for (const s of [a, b, c, d]) await env.SALES_DB.exec(s);
  await env.SALES_DB.exec(
    "INSERT INTO nodes(id,name,target_ip) VALUES('n','n','8.8.8.8'); INSERT INTO managed_accounts(id,seller_id,request_key,node_id,kind,label,uuid,quota_bytes,duration_seconds,created_at) VALUES('a','10','r','n','sale','a','11111111-1111-4111-8111-111111111111',100,1800,1);",
  );
});
test("only capable ready ACK starts expiry once and final ACK activates", async () => {
  const p = await buildQuotaPolicy(env.SALES_DB, "n", 100);
  await ackQuotaPolicy(
    env.SALES_DB,
    "n",
    p.revision,
    { healthy: true, capabilities: [] },
    101,
  );
  expect(
    await env.SALES_DB.prepare(
      "SELECT started_at FROM managed_accounts WHERE id='a'",
    ).first("started_at"),
  ).toBe(null);
  await ackQuotaPolicy(
    env.SALES_DB,
    "n",
    p.revision,
    { healthy: true, capabilities: ["quota-v2", "per-account-process"] },
    102,
  );
  expect(
    await env.SALES_DB.prepare(
      "SELECT valid_until FROM managed_accounts WHERE id='a'",
    ).first("valid_until"),
  ).toBe(1902);
  expect(
    await env.SALES_DB.prepare(
      "SELECT state FROM managed_accounts WHERE id='a'",
    ).first("state"),
  ).toBe("preparing");
  const final = await buildQuotaPolicy(env.SALES_DB, "n", 103);
  await ackQuotaPolicy(
    env.SALES_DB,
    "n",
    final.revision,
    { healthy: true, capabilities: ["quota-v2", "per-account-process"] },
    104,
  );
  expect(
    await env.SALES_DB.prepare(
      "SELECT state FROM managed_accounts WHERE id='a'",
    ).first("state"),
  ).toBe("active");
  await ackQuotaPolicy(
    env.SALES_DB,
    "n",
    p.revision,
    { healthy: true, capabilities: ["quota-v2", "per-account-process"] },
    105,
  );
  expect(
    await env.SALES_DB.prepare(
      "SELECT valid_until FROM managed_accounts WHERE id='a'",
    ).first("valid_until"),
  ).toBe(1902);
});
