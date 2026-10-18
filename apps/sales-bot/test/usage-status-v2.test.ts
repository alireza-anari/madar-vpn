import { env } from "cloudflare:workers";
import { beforeEach, expect, test } from "vitest";
import { resetDb } from "./db";
import m1 from "../migrations/0001.sql?raw";
import m2 from "../migrations/0002.sql?raw";
import m3 from "../migrations/0003.sql?raw";
import m4 from "../migrations/0004-reseller-accounts.sql?raw";
import m14 from "../migrations/0014-on-demand-usage.sql?raw";
import { hash } from "../src/crypto";
import { buildAccountDeliveryArtifact } from "../src/account-delivery";
import { statusResponse } from "../src/status-routes";
import { createUsageToken } from "../src/usage-links";

const now = 100;
const secret = "usage-secret-for-tests-1234567890";
const E = {
  ...env,
  PUBLIC_BASE_URL: "https://example.test",
  USAGE_LINK_SECRET: secret,
} as Env;

beforeEach(async () => {
  await resetDb();
  for (const sql of [m1,m2,m3,m4,m14]) await env.SALES_DB.exec(sql);
  await env.SALES_DB.prepare(
    "INSERT INTO nodes(id,name,target_ip,vpn_port,revision,acked_revision,last_seen,healthy,public_key,short_id,sni,agent_capabilities,policy_payload) VALUES('n','Stockholm','8.8.8.8',443,2,2,100,1,'public','1234','example.com','quota-v2,per-account-process,shared-443',?)",
  ).bind(JSON.stringify({version:2,expiresAt:400,clients:[{accountId:'a',uuid:'uuid-a',validUntil:1000}]})).run();
  await env.SALES_DB.exec(
    "INSERT INTO managed_accounts(id,seller_id,request_key,node_id,kind,label,uuid,state,quota_bytes,used_bytes,duration_seconds,started_at,valid_until,activation_revision,listen_port,created_at) VALUES('a','10','r','n','sale','Client','uuid-a','active',30000000000,5000000000,86400,90,1000,2,20000,80);"
  );
});

test("signed v2 usage URL resolves the same limited status and rejects tampering/revocation", async () => {
  const token = createUsageToken(secret, "a");
  let response = await statusResponse(new Request(`https://example.test/api/usage/v2/${token}`), E, now);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(expect.objectContaining({label:"Client",totalBytes:30e9,usedBytes:5e9,remainingBytes:25e9}));

  response = await statusResponse(new Request(`https://example.test/api/usage/v2/${token}x`), E, now);
  expect(response.status).toBe(404);

  await env.SALES_DB.exec("UPDATE managed_accounts SET state='revoked' WHERE id='a'");
  response = await statusResponse(new Request(`https://example.test/api/usage/v2/${token}`), E, now);
  expect(response.status).toBe(404);
});

test("legacy hashed usage links remain valid", async () => {
  const legacy = "a".repeat(64);
  await env.SALES_DB.prepare("UPDATE managed_accounts SET status_token_hash=? WHERE id='a'").bind(hash(legacy)).run();
  const response = await statusResponse(new Request(`https://example.test/api/usage/${legacy}`), E, now);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(expect.objectContaining({label:"Client",usedBytes:5e9}));
});

test("ready artifact exposes a regenerable v2 usage URL", async () => {
  const artifact = await buildAccountDeliveryArtifact(E, "a", now);
  expect(artifact?.usageUrl).toMatch(/^https:\/\/example\.test\/usage\/v2\/v2\./);
  expect(artifact?.config).toMatch(/^vless:\/\//);
});
