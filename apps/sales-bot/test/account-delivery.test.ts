import visionMigration from "../migrations/0019-managed-vision-optin.sql?raw";
import { env } from "cloudflare:workers";
import { beforeEach, expect, test } from "vitest";
import { resetDb } from "./db";
import a from "../migrations/0001.sql?raw";
import b from "../migrations/0002.sql?raw";
import c from "../migrations/0003.sql?raw";
import d from "../migrations/0004-reseller-accounts.sql?raw";
import { queueAccountDelivery } from "../src/account-delivery";
import { parseVlessRealityConfig } from "../src/connection-config";
import { parseManagedVmessWsConfig } from "../src/alternate-transport";

const accountUuid = "11111111-1111-4111-8111-111111111111";
const publicKey = "A".repeat(43);

beforeEach(async () => {
  await resetDb();
  for (const s of [a, b, c, d, visionMigration]) await env.SALES_DB.exec(s);
});

async function fixture(capabilities: string, vision = false) {
  const policy = JSON.stringify({
    version: 2,
    nodeId: "n",
    revision: 5,
    expiresAt: 400,
    clients: [
      {
        accountId: "a",
        uuid: accountUuid,
        quotaEpoch: 1,
        quotaBytes: 1_000_000_000,
        usedBytes: 0,
        validUntil: 300,
        generation: "a:1",
        listenPort: 20000,
        flow: vision ? "xtls-rprx-vision" : "",
      },
    ],
  });
  await env.SALES_DB.prepare(
    "INSERT INTO nodes(id,name,target_ip,vpn_port,state,revision,acked_revision,last_seen,healthy,public_key,short_id,sni,policy_payload,agent_capabilities) VALUES('n','n','8.8.8.8',443,'ready',5,5,100,1,?,'1234567890abcdef','www.cloudflare.com',?,?)",
  )
    .bind(publicKey, policy, capabilities)
    .run();
  await env.SALES_DB.prepare(
    "INSERT INTO managed_accounts(id,seller_id,request_key,node_id,kind,label,uuid,state,quota_bytes,duration_seconds,started_at,valid_until,prepared_revision,activation_revision,created_at,listen_port) VALUES('a','10','r','n','sale','A',?,'active',1000000000,86400,10,300,5,NULL,1,20000)",
  ).bind(accountUuid).run();
  if (vision)
    await env.SALES_DB.exec(
      "UPDATE managed_accounts SET connection_flow='xtls-rprx-vision' WHERE id='a'",
    );
}

async function deliveredText() {
  const payload = await env.SALES_DB.prepare(
    "SELECT payload FROM outbox WHERE id='account:a'",
  ).first<string>("payload");
  expect(payload).toBeTruthy();
  return JSON.parse(payload!).text as string;
}

async function deliveredConfig() {
  const text = await deliveredText();
  const match = text.match(/<pre>([\s\S]*?)<\/pre>/);
  expect(match?.[1]).toBeTruthy();
  return match![1]!.replace(/&amp;/g, "&");
}

async function outboxCount() {
  return (await env.SALES_DB.prepare(
    "SELECT COUNT(*) n FROM outbox",
  ).first<number>("n")) ?? 0;
}

test("shared-443 delivery exposes the public node port, never the internal account port", async () => {
  await fixture("quota-v2,per-account-process,shared-443");
  await queueAccountDelivery(env, "a", 100);
  const config = parseVlessRealityConfig(await deliveredConfig());
  expect(config.host).toBe("8.8.8.8");
  expect(config.port).toBe(443);
  expect(config.flow).toBe("");
});

test("legacy quota-v2 delivery keeps its account-specific public port", async () => {
  await fixture("quota-v2,per-account-process");
  await queueAccountDelivery(env, "a", 100);
  const config = parseVlessRealityConfig(await deliveredConfig());
  expect(config.port).toBe(20000);
});

test("managed Vision is delivered only when signed policy and live agent capability agree", async () => {
  await fixture("quota-v2,per-account-process,shared-443,vision-metered", true);
  await queueAccountDelivery(env, "a", 100);
  const config = parseVlessRealityConfig(await deliveredConfig());
  expect(config.flow).toBe("xtls-rprx-vision");
  expect(config.port).toBe(443);
});

test("Vision delivery fails closed when the live agent capability downgrades", async () => {
  await fixture("quota-v2,per-account-process,shared-443", true);
  await queueAccountDelivery(env, "a", 100);
  expect(await outboxCount()).toBe(0);
});

test("delivery fails closed when signed policy Flow differs from the account", async () => {
  await fixture("quota-v2,per-account-process,shared-443,vision-metered", true);
  const original = JSON.parse(
    (await env.SALES_DB.prepare(
      "SELECT policy_payload FROM nodes WHERE id='n'",
    ).first<string>("policy_payload"))!,
  );
  original.clients[0].flow = "";
  await env.SALES_DB.prepare(
    "UPDATE nodes SET policy_payload=? WHERE id='n'",
  ).bind(JSON.stringify(original)).run();
  await queueAccountDelivery(env, "a", 100);
  expect(await outboxCount()).toBe(0);
});

test("delivery fails closed when the signed policy targets a different internal port", async () => {
  await fixture("quota-v2,per-account-process,shared-443");
  const original = JSON.parse(
    (await env.SALES_DB.prepare(
      "SELECT policy_payload FROM nodes WHERE id='n'",
    ).first<string>("policy_payload"))!,
  );
  original.clients[0].listenPort = 20001;
  await env.SALES_DB.prepare(
    "UPDATE nodes SET policy_payload=? WHERE id='n'",
  ).bind(JSON.stringify(original)).run();
  await queueAccountDelivery(env, "a", 100);
  expect(await outboxCount()).toBe(0);
});

test("delivery fails closed when signed quota differs from the account quota", async () => {
  await fixture("quota-v2,per-account-process,shared-443");
  const original = JSON.parse(
    (await env.SALES_DB.prepare(
      "SELECT policy_payload FROM nodes WHERE id='n'",
    ).first<string>("policy_payload"))!,
  );
  original.clients[0].quotaBytes = 2_000_000_000;
  await env.SALES_DB.prepare(
    "UPDATE nodes SET policy_payload=? WHERE id='n'",
  ).bind(JSON.stringify(original)).run();
  await queueAccountDelivery(env, "a", 100);
  expect(await outboxCount()).toBe(0);
});

test("delivery fails closed when the node is not in the ready state", async () => {
  await fixture("quota-v2,per-account-process,shared-443");
  await env.SALES_DB.prepare(
    "UPDATE nodes SET state='verifying' WHERE id='n'",
  ).run();
  await queueAccountDelivery(env, "a", 100);
  expect(await outboxCount()).toBe(0);
});

test("delivery fails closed when endpoint metadata is malformed", async () => {
  await fixture("quota-v2,per-account-process,shared-443");
  await env.SALES_DB.prepare(
    "UPDATE nodes SET public_key='not-a-key' WHERE id='n'",
  ).run();
  await queueAccountDelivery(env, "a", 100);
  expect(await outboxCount()).toBe(0);
});

test("shared-443 capability cannot publish a non-443 port", async () => {
  await fixture("quota-v2,per-account-process,shared-443");
  await env.SALES_DB.prepare(
    "UPDATE nodes SET vpn_port=8443 WHERE id='n'",
  ).run();
  await queueAccountDelivery(env, "a", 100);
  expect(await outboxCount()).toBe(0);
});

const fullWsCapabilities = "quota-v2,per-account-process,shared-443,ws-metered";
const fallback = {
  type: "vmess-ws-aead",
  hostname: "edge.madar.example.com",
  path: "/madar-" + "b".repeat(24),
};

async function prepareWsSettings(termsApproved = true, enabled = true) {
  const rows = [
    ["enabled", enabled ? "1" : "0"],
    ["terms_approved", termsApproved ? "1" : "0"],
    ["hostname", fallback.hostname],
    ["path", fallback.path],
  ];
  for (const [suffix, value] of rows) {
    await env.SALES_DB.prepare(
      "INSERT INTO settings(key,value) VALUES(?,?)",
    ).bind("managed_ws:n:" + suffix, value).run();
  }
}

async function setSignedWsPolicy(candidate: unknown = fallback) {
  const original = JSON.parse(
    (await env.SALES_DB.prepare(
      "SELECT policy_payload FROM nodes WHERE id='n'",
    ).first<string>("policy_payload"))!,
  );
  original.wsFallback = candidate;
  await env.SALES_DB.prepare(
    "UPDATE nodes SET policy_payload=? WHERE id='n'",
  ).bind(JSON.stringify(original)).run();
}

test("customer receives both paths only with ready, metered and approved WS route", async () => {
  await fixture(fullWsCapabilities);
  await setSignedWsPolicy();
  await prepareWsSettings();
  await queueAccountDelivery(env, "a", 100);
  const body = await deliveredText();
  const links = [...body.matchAll(/<pre>(.*?)<\/pre>/gs)].map((match) => match[1]!);
  expect(links).toHaveLength(2);
  expect(parseVlessRealityConfig(links[0]!.replace(/&amp;/g, "&")).port).toBe(443);
  const ws = parseManagedVmessWsConfig(links[1]!);
  expect(ws.uuid).toBe(accountUuid);
  expect(ws.hostname).toBe(fallback.hostname);
  expect(ws.path).toBe(fallback.path);
});

test("WS path does not appear if capability is missing (normal deployment)", async () => {
  await fixture("quota-v2,per-account-process,shared-443");
  await setSignedWsPolicy();
  await prepareWsSettings();
  await queueAccountDelivery(env, "a", 100);
  expect((await deliveredText()).match(/<pre>/g)).toHaveLength(1);
});

test("disabled or unapproved WS path leaves normal REALITY delivery intact", async () => {
  for (const [approved, enabled] of [[false, true], [true, false]] as const) {
    await resetDb();
    for (const s of [a, b, c, d, visionMigration]) await env.SALES_DB.exec(s);
    await fixture(fullWsCapabilities);
    await setSignedWsPolicy();
    await prepareWsSettings(approved, enabled);
    await queueAccountDelivery(env, "a", 100);
    expect((await deliveredText()).match(/<pre>/g)).toHaveLength(1);
  }
});

test("stale or mismatched WS endpoint cannot appear in delivered config", async () => {
  await fixture(fullWsCapabilities);
  await setSignedWsPolicy();
  await prepareWsSettings();
  await env.SALES_DB.prepare(
    "UPDATE settings SET value=? WHERE key='managed_ws:n:path'",
  ).bind("/madar-" + "a".repeat(24)).run();
  await queueAccountDelivery(env, "a", 100);
  expect((await deliveredText()).match(/<pre>/g)).toHaveLength(1);
});

test("Quick Tunnel is never delivered as a commercial WS path", async () => {
  await fixture(fullWsCapabilities);
  await setSignedWsPolicy({
    ...fallback, hostname: "temporary.trycloudflare.com",
  });
  await prepareWsSettings();
  await env.SALES_DB.prepare(
    "UPDATE settings SET value='temporary.trycloudflare.com' WHERE key='managed_ws:n:hostname'",
  ).run();
  await queueAccountDelivery(env, "a", 100);
  expect((await deliveredText()).match(/<pre>/g)).toHaveLength(1);
});
test("Telegram delivery offers a renewable subscription URL on the existing Worker host", async () => {
  await fixture("quota-v2,per-account-process,shared-443");
  const currentEnv = {
    ...env,
    SALES_DB: env.SALES_DB,
    PUBLIC_BASE_URL: "https://madar-bot.example.com",
    USAGE_LINK_SECRET: "secure-subscription-signing-secret-012345",
  } as Env;
  await queueAccountDelivery(currentEnv, "a", 100);
  const raw = await env.SALES_DB.prepare(
    "SELECT payload FROM outbox WHERE id='account:a'",
  ).first<string>("payload");
  expect(raw).toBeTruthy();
  const reply = JSON.parse(raw!);
  const buttons = (reply.reply_markup?.inline_keyboard || []).flat();
  const subscription = buttons.find((button: {text:string;url?:string}) =>
    button.text.includes("به‌روزشونده"));
  expect(subscription?.url).toMatch(
    /^https:\/\/madar-bot\.example\.com\/managed-subscription\/v1\/m1\./,
  );
  expect(buttons.some((button: {text:string}) =>
    button.text.includes("مصرف و اعتبار"))).toBe(true);
});
