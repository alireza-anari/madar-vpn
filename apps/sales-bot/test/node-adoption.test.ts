import { env } from "cloudflare:workers";
import { beforeEach, expect, test } from "vitest";
import { resetDb } from "./db";
import a from "../migrations/0001.sql?raw";
import b from "../migrations/0002.sql?raw";
import c from "../migrations/0003.sql?raw";
import d from "../migrations/0004-reseller-accounts.sql?raw";
import worker from "../src/index";
import { hash } from "../src/crypto";
const grant = "a".repeat(64),
  nodeToken = "b".repeat(64);
const body = {
  publicIp: "13.60.255.118",
  nodeToken,
  policyKey: "c".repeat(64),
  publicKey: "d".repeat(43),
  shortId: "abcd",
  sni: "www.example.com",
  instanceId: "i-002a965e30ef88b2f",
};
beforeEach(async () => {
  await resetDb();
  for (const sql of [a, b, c, d]) await env.SALES_DB.exec(sql);
  await env.SALES_DB.prepare(
    "INSERT INTO nodes(id,name,target_ip) VALUES('personal','Personal','13.60.255.118')",
  ).run();
});
const request = (token = grant, data = body) =>
  new Request("https://test/api/adoption/register", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(data),
  });
async function prepare(expiresAt = Math.floor(Date.now() / 1000) + 300) {
  await env.SALES_DB.prepare("INSERT INTO settings(key,value) VALUES(?,?)")
    .bind(
      "adoption:" + hash(grant),
      JSON.stringify({
        nodeId: "personal",
        expiresAt,
        instanceId: body.instanceId,
      }),
    )
    .run();
}
test("adoption requires a scoped unexpired grant", async () => {
  expect((await worker.fetch(request(), env)).status).toBe(401);
  await prepare(1);
  expect((await worker.fetch(request(), env)).status).toBe(401);
});
test("adoption consumes grant and cannot replace existing node credentials", async () => {
  await prepare();
  expect((await worker.fetch(request(), env)).status).toBe(200);
  expect((await worker.fetch(request(), env)).status).toBe(401);
  expect(
    await env.SALES_DB.prepare(
      "SELECT token_hash FROM nodes WHERE id='personal'",
    ).first("token_hash"),
  ).toBe(hash(nodeToken));
});
test("wrong instance does not consume grant or update node", async () => {
  await prepare();
  expect(
    (await worker.fetch(request(grant, { ...body, instanceId: "wrong" }), env))
      .status,
  ).toBe(401);
  expect((await worker.fetch(request(), env)).status).toBe(200);
});
test("adoption records actual publicIP rather than stale inventory", async () => {
  await prepare();
  expect(
    (await worker.fetch(request(grant, { ...body, publicIp: "1.1.1.1" }), env))
      .status,
  ).toBe(200);
  expect(
    await env.SALES_DB.prepare(
      "SELECT target_ip FROM nodes WHERE id='personal'",
    ).first("target_ip"),
  ).toBe("1.1.1.1");
});
