import { env } from "cloudflare:workers";
import { beforeEach, expect, test } from "vitest";
import { resetDb } from "./db";
import m1 from "../migrations/0001.sql?raw";
import m2 from "../migrations/0002.sql?raw";
import m3 from "../migrations/0003.sql?raw";
import m4 from "../migrations/0004-reseller-accounts.sql?raw";
import m19 from "../migrations/0019-managed-vision-optin.sql?raw";
import {
  createManagedSubscriptionToken,
  managedSubscriptionUrl,
  verifyManagedSubscriptionToken,
} from "../src/managed-subscription-tokens";
import { managedSubscriptionResponse } from "../src/managed-subscriptions";
import { acceptSecondaryAck } from "../src/managed-secondary";
import { parseVlessRealityConfig } from "../src/connection-config";
import { parseManagedVmessWsConfig } from "../src/alternate-transport";

const SECRET = "signed-managed-subscription-key-0123456789";
const BASE = "https://madar-existing.example.com";
const UUID = "11111111-1111-4111-8111-111111111111";
const now = 100;
const endpoint = {
  type: "vmess-ws-aead",
  hostname: "edge.madar.example.com",
  path: "/madar-" + "a".repeat(24),
};

const testEnv = () => ({
  ...env,
  SALES_DB: env.SALES_DB,
  USAGE_LINK_SECRET: SECRET,
  PUBLIC_BASE_URL: BASE,
} as Env);

function signedPolicy(wsFallback?: unknown) {
  return {
    version: 2, nodeId: "n", revision: 5, expiresAt: 400,
    clients: [{
      accountId: "a", uuid: UUID, quotaEpoch: 1,
      quotaBytes: 1000000000, usedBytes: 0, validUntil: 300,
      generation: "a:1", listenPort: 20000, flow: "",
    }],
    ...(wsFallback ? { wsFallback } : {}),
  };
}

beforeEach(async () => {
  await resetDb();
  for (const migration of [m1, m2, m3, m4, m19])
    await env.SALES_DB.exec(migration);
  await env.SALES_DB.prepare(
    "INSERT INTO nodes(id,name,target_ip,vpn_port,state,revision,acked_revision,last_seen,healthy,public_key,short_id,sni,policy_payload,agent_capabilities) VALUES('n','Ariant','8.8.8.8',443,'ready',5,5,100,1,?,'1234567890abcdef','www.cloudflare.com',?,'quota-v2,per-account-process,shared-443')",
  ).bind("A".repeat(43), JSON.stringify(signedPolicy())).run();
  await env.SALES_DB.prepare(
    "INSERT INTO managed_accounts(id,seller_id,request_key,node_id,kind,label,uuid,state,quota_bytes,duration_seconds,started_at,valid_until,prepared_revision,activation_revision,created_at,listen_port) VALUES('a','10','r','n','sale','A',?,'active',1000000000,86400,10,300,5,NULL,1,20000)",
  ).bind(UUID).run();
});

function requestFor(accountId = "a") {
  return new Request(managedSubscriptionUrl(testEnv(), accountId));
}

test("managed subscription token uses separate domain from usage HMAC", () => {
  const token = createManagedSubscriptionToken(SECRET, "a");
  expect(verifyManagedSubscriptionToken(SECRET, token)).toBe("a");
  expect(verifyManagedSubscriptionToken(SECRET + "x", token)).toBeNull();
  expect(verifyManagedSubscriptionToken(SECRET, token.slice(0, -1) + "a")).toBeNull();
  expect(() => createManagedSubscriptionToken(SECRET, "../a")).toThrow();
  expect(() => managedSubscriptionUrl({
    PUBLIC_BASE_URL: "http://insecure.example.com", USAGE_LINK_SECRET: SECRET,
  }, "a")).toThrow();
});

test("existing Worker URL yields REALITY only with no fallback domain", async () => {
  const response = await managedSubscriptionResponse(requestFor(), testEnv(), now);
  expect(response.status).toBe(200);
  const lines = (await response.text()).trim().split("\n");
  expect(lines).toHaveLength(1);
  expect(parseVlessRealityConfig(lines[0]!).port).toBe(443);
  expect(response.headers.get("Cache-Control")).toContain("no-store");
  expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
  expect(response.headers.get("Subscription-Userinfo")).toBe("expire=300");
});

test("changing or removing token cannot reveal a private subscription", async () => {
  const wrong = requestFor("another-account");
  expect((await managedSubscriptionResponse(wrong, testEnv(), now)).status).toBe(503);
  const tampered = new Request(requestFor().url.replace(/.$/, "a"));
  expect((await managedSubscriptionResponse(tampered, testEnv(), now)).status).toBe(404);
  const request = new Request(requestFor(), {method: "POST"});
  expect((await managedSubscriptionResponse(request, testEnv(), now)).status).toBe(405);
  await env.SALES_DB.exec("UPDATE managed_accounts SET state='revoked' WHERE id='a'");
  expect((await managedSubscriptionResponse(requestFor(), testEnv(), now)).status).toBe(503);
});

test("one stable link dynamically includes approved and metered fallback only", async () => {
  const request = requestFor();
  await env.SALES_DB.prepare(
    "UPDATE nodes SET agent_capabilities='quota-v2,per-account-process,shared-443,ws-metered',policy_payload=? WHERE id='n'",
  ).bind(JSON.stringify(signedPolicy(endpoint))).run();
  // With no explicit approval, the additional route cannot be delivered.
  let response = await managedSubscriptionResponse(request, testEnv(), now);
  expect((await response.text()).trim().split("\n")).toHaveLength(1);

  for (const [key, value] of [
    ["enabled", "1"], ["terms_approved", "1"],
    ["hostname", endpoint.hostname], ["path", endpoint.path],
  ]) {
    await env.SALES_DB.prepare("INSERT INTO settings(key,value) VALUES(?,?)")
      .bind("managed_ws:n:" + key, value).run();
  }
  response = await managedSubscriptionResponse(request, testEnv(), now);
  const links = (await response.text()).trim().split("\n");
  expect(links).toHaveLength(2);
  expect(parseVlessRealityConfig(links[0]!).uuid).toBe(UUID);
  expect(parseManagedVmessWsConfig(links[1]!).uuid).toBe(UUID);

  await env.SALES_DB.exec(
    "UPDATE settings SET value='0' WHERE key='managed_ws:n:enabled'",
  );
  response = await managedSubscriptionResponse(request, testEnv(), now);
  expect((await response.text()).trim().split("\n")).toHaveLength(1);
});

test("one managed subscription dynamically returns only approved multi-port profiles", async () => {
  const request = requestFor();
  const policy = signedPolicy(endpoint) as ReturnType<typeof signedPolicy> & {
    realityAltPorts?: number[],
  };
  policy.realityAltPorts = [2053, 8443];
  await env.SALES_DB.prepare(
    "UPDATE nodes SET agent_capabilities='quota-v2,per-account-process,shared-443,reality-alt-metered,ws-metered',policy_payload=? WHERE id='n'",
  ).bind(JSON.stringify(policy)).run();

  for (const [suffix, value] of [
    ["enabled", "1"], ["reachability_confirmed", "1"],
    ["ports", JSON.stringify([2053, 8443])],
  ]) {
    await env.SALES_DB.prepare(
      "INSERT INTO settings(key,value) VALUES(?,?)",
    ).bind("managed_reality_alt:n:" + suffix, value).run();
  }

  let response = await managedSubscriptionResponse(request, testEnv(), now);
  let lines = (await response.text()).trim().split("\n");
  expect(lines).toHaveLength(3);
  expect(lines.map(config => parseVlessRealityConfig(config).port))
    .toEqual([443, 2053, 8443]);

  for (const [key, value] of [
    ["enabled", "1"], ["terms_approved", "1"],
    ["hostname", endpoint.hostname], ["path", endpoint.path],
  ]) {
    await env.SALES_DB.prepare(
      "INSERT INTO settings(key,value) VALUES(?,?)",
    ).bind("managed_ws:n:" + key, value).run();
  }
  response = await managedSubscriptionResponse(request, testEnv(), now);
  lines = (await response.text()).trim().split("\n");
  expect(lines).toHaveLength(4);
  expect(parseManagedVmessWsConfig(lines[3]!).uuid).toBe(UUID);

  await env.SALES_DB.exec(
    "UPDATE settings SET value='0' WHERE key='managed_reality_alt:n:enabled'",
  );
  response = await managedSubscriptionResponse(request, testEnv(), now);
  lines = (await response.text()).trim().split("\n");
  expect(lines).toHaveLength(2);
  expect(parseVlessRealityConfig(lines[0]!).port).toBe(443);
});

test("primary agent stays on 443 while independent sidecar publishes and withdraws ports", async () => {
  const policy = signedPolicy() as ReturnType<typeof signedPolicy> & {
    realityAltPorts?: number[],
  };
  policy.realityAltPorts = [2053, 8443];
  await env.SALES_DB.prepare(
    "UPDATE nodes SET policy_payload=? WHERE id='n'",
  ).bind(JSON.stringify(policy)).run();

  for (const [suffix, value] of [
    ["enabled","1"],["reachability_confirmed","1"],
    ["ports",JSON.stringify([2053,8443])],
  ]) await env.SALES_DB.prepare(
    "INSERT INTO settings(key,value) VALUES(?,?)",
  ).bind("managed_reality_alt:n:"+suffix,value).run();

  // No additional capability is ever added to the existing primary agent.
  expect((await env.SALES_DB.prepare(
    "SELECT agent_capabilities FROM nodes WHERE id='n'",
  ).first<string>("agent_capabilities"))).toBe(
    "quota-v2,per-account-process,shared-443",
  );
  let response = await managedSubscriptionResponse(requestFor(),testEnv(),100);
  expect((await response.text()).trim().split("\n")).toHaveLength(1);

  await acceptSecondaryAck(
    env.SALES_DB, "n", {revision:5,ports:[2053,8443],healthy:true},100,
  );
  response = await managedSubscriptionResponse(requestFor(),testEnv(),101);
  let links = (await response.text()).trim().split("\n");
  expect(links).toHaveLength(3);
  expect(links.map(line=>parseVlessRealityConfig(line).port))
    .toEqual([443,2053,8443]);
  response = await managedSubscriptionResponse(requestFor(),testEnv(),121);
  links = (await response.text()).trim().split("\n");
  expect(links).toHaveLength(1);
  expect(parseVlessRealityConfig(links[0]!).port).toBe(443);
});
