import { env } from "cloudflare:workers";
import { beforeEach, expect, test } from "vitest";
import { resetDb } from "./db";
import b from "../migrations/0001.sql?raw";
import s from "../migrations/0002.sql?raw";
import n from "../migrations/0003.sql?raw";
import { buildPolicy, ackPolicy } from "../src/policies";
import { getSubscription } from "../src/subscriptions";
import { reserveTrial } from "../src/orders";
beforeEach(async () => {
  await resetDb();
  for (const sql of [b, s, n]) await env.SALES_DB.exec(sql);
  await env.SALES_DB.prepare(
    "INSERT INTO nodes(id,name,target_ip,state,public_key,short_id,sni) VALUES('n','new','51.21.199.245','verifying',?,'1234567890abcdef','www.microsoft.com')",
  )
    .bind("a".repeat(43))
    .run();
});
test("old ACK cannot make renewed policy ready", async () => {
  await reserveTrial(env.SALES_DB, { telegramId: "100", role: "customer" });
  const p = await buildPolicy(env.SALES_DB, "n", 100);
  await ackPolicy(env.SALES_DB, "n", p.revision, { healthy: true }, 100);
  const final = await buildPolicy(env.SALES_DB, "n", 101);
  await ackPolicy(env.SALES_DB, "n", p.revision, { healthy: true }, 101);
  expect(
    (await getSubscription(env.SALES_DB, "100", 101)).configs,
  ).toHaveLength(0);
  await ackPolicy(env.SALES_DB, "n", final.revision, { healthy: true }, 101);
  expect(
    (await getSubscription(env.SALES_DB, "100", 101)).configs,
  ).toHaveLength(1);
  expect(
    await env.SALES_DB.prepare("SELECT valid_until FROM entitlements").first(
      "valid_until",
    ),
  ).toBe(1900);
});
test("unhealthy stale and revoked nodes never yield config", async () => {
  await env.SALES_DB.prepare(
    "INSERT INTO entitlements VALUES('100','11111111-1111-4111-8111-111111111111',1000,0)",
  ).run();
  const p = await buildPolicy(env.SALES_DB, "n", 100);
  await ackPolicy(env.SALES_DB, "n", p.revision, { healthy: false }, 100);
  expect(
    (await getSubscription(env.SALES_DB, "100", 100)).configs,
  ).toHaveLength(0);
  await ackPolicy(env.SALES_DB, "n", p.revision, { healthy: true }, 100);
  expect(
    (await getSubscription(env.SALES_DB, "other", 100)).configs,
  ).toHaveLength(0);
  expect(
    (await getSubscription(env.SALES_DB, "100", 1000)).configs,
  ).toHaveLength(0);
  await env.SALES_DB.prepare("UPDATE entitlements SET revoked=1").run();
  expect((await buildPolicy(env.SALES_DB, "n", 101)).clients).toHaveLength(0);
});
