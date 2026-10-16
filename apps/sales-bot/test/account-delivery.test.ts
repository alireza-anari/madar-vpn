import { env } from "cloudflare:workers";
import { beforeEach, expect, test } from "vitest";
import { resetDb } from "./db";
import a from "../migrations/0001.sql?raw";
import b from "../migrations/0002.sql?raw";
import c from "../migrations/0003.sql?raw";
import d from "../migrations/0004-reseller-accounts.sql?raw";
import { queueAccountDelivery } from "../src/account-delivery";

beforeEach(async () => {
  await resetDb();
  for (const s of [a, b, c, d]) await env.SALES_DB.exec(s);
});

async function fixture(capabilities: string) {
  const policy = JSON.stringify({
    version: 2,
    nodeId: "n",
    revision: 5,
    expiresAt: 400,
    clients: [
      {
        accountId: "a",
        uuid: "11111111-1111-4111-8111-111111111111",
        quotaEpoch: 1,
        quotaBytes: 1_000_000_000,
        usedBytes: 0,
        validUntil: 300,
        generation: "a:1",
        listenPort: 20000,
      },
    ],
  });
  await env.SALES_DB.prepare(
    "INSERT INTO nodes(id,name,target_ip,vpn_port,state,revision,acked_revision,last_seen,healthy,public_key,short_id,sni,policy_payload,agent_capabilities) VALUES('n','n','8.8.8.8',443,'ready',5,5,100,1,'public','1234567890abcdef','www.cloudflare.com',?,?)",
  )
    .bind(policy, capabilities)
    .run();
  await env.SALES_DB.prepare(
    "INSERT INTO managed_accounts(id,seller_id,request_key,node_id,kind,label,uuid,state,quota_bytes,duration_seconds,started_at,valid_until,prepared_revision,activation_revision,created_at,listen_port) VALUES('a','10','r','n','sale','A','11111111-1111-4111-8111-111111111111','active',1000000000,86400,10,300,4,5,1,20000)",
  ).run();
}

async function deliveredText() {
  const payload = await env.SALES_DB.prepare(
    "SELECT payload FROM outbox WHERE id='account:a'",
  ).first<string>("payload");
  expect(payload).toBeTruthy();
  return JSON.parse(payload!).text as string;
}

test("shared-443 delivery exposes node port 443, never internal account port", async () => {
  await fixture("quota-v2,per-account-process,shared-443");
  await queueAccountDelivery(env, "a", 100);
  const text = await deliveredText();
  expect(text).toContain(":443?");
  expect(text).not.toContain(":20000?");
});

test("legacy quota-v2 delivery keeps its account-specific public port", async () => {
  await fixture("quota-v2,per-account-process");
  await queueAccountDelivery(env, "a", 100);
  const text = await deliveredText();
  expect(text).toContain(":20000?");
});
