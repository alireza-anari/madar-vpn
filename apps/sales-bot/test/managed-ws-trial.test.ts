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
import m19 from "../migrations/0019-managed-vision-optin.sql?raw";

import { handleUpdate } from "../src/menus";
import { buildAccountDeliveryArtifact, queueAccountDelivery } from "../src/account-delivery";
import { parseManagedVmessWsConfig } from "../src/alternate-transport";

const E = { ...env, ADMIN_TELEGRAM_IDS: "9", PUBLIC_BASE_URL: "https://bot.test" };
const endpoint = { type: "vmess-ws-aead", hostname: "ws.example.com", path: "/madar-" + "a".repeat(24) };
const now = 100;
let seq = 12000;
const click = (sender: number, data: string) => {
  const update = seq++;
  return handleUpdate(E, {
    update_id: update,
    callback_query: {
      id: String(update), from: { id: sender },
      message: { chat: { id: sender, type: "private" } }, data,
    },
  }, now).then(() => update);
};
const reply = async (update: number) => JSON.parse(
  (await env.SALES_DB.prepare("SELECT payload FROM outbox WHERE id=?")
    .bind("u" + update + ":reply").first<string>("payload"))!,
) as {text:string;reply_markup:{inline_keyboard:Array<Array<{callback_data?:string}>>}};

beforeEach(async () => {
  await resetDb();
  for (const migration of [m1,m2,m3,m4,m5,m6,m7,m8,m9,m10,m11,m19])
    await env.SALES_DB.exec(migration);
  await env.SALES_DB.exec(
    "INSERT INTO settings(key,value) VALUES('app_mode','reseller');" +
    "INSERT INTO nodes(id,name,target_ip,vpn_port,state,revision,acked_revision,last_seen,healthy,public_key,short_id,sni,policy_payload,agent_capabilities,max_accounts,max_allocated_bytes) " +
    "VALUES('n','Managed WSS','8.8.8.8',443,'ready',5,5,100,1,'" +
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA','1234567890abcdef','www.cloudflare.com','{}'," +
    "'quota-v2,per-account-process,shared-443,ws-metered',20,100000000000);",
  );
  const policy = JSON.stringify({
    version:2, nodeId:"n", revision:5, expiresAt:400,
    wsFallback:endpoint, clients:[],
  });
  await env.SALES_DB.prepare(
    "UPDATE nodes SET policy_payload=? WHERE id='n'",
  ).bind(policy).run();
  for (const [key,val] of [
    ["enabled","1"],["terms_approved","1"],
    ["hostname",endpoint.hostname],["path",endpoint.path],
  ]) await env.SALES_DB.prepare(
    "INSERT INTO settings(key,value) VALUES(?,?)",
  ).bind("managed_ws:n:" + key,val).run();
});

test("per-node protocol menu offers WSS test only with signed live metered ACK", async () => {
  const update = await click(9,"rs:ws:status:n");
  const p = await reply(update);
  expect(p.text).toContain("VMess");
  expect(p.reply_markup.inline_keyboard.flat().some(
    b=>b.callback_data === "rs:ws:trial:n",
  )).toBe(true);
  await env.SALES_DB.exec(
    "UPDATE nodes SET agent_capabilities='quota-v2,per-account-process,shared-443'",
  );
  const after = await reply(await click(9,"rs:ws:status:n"));
  expect(after.reply_markup.inline_keyboard.flat().some(
    b=>b.callback_data === "rs:ws:trial:n",
  )).toBe(false);
  const denied = await reply(await click(9,"rs:ws:trial:n"));
  expect(denied.text).toContain("هیچ کانفیگی صادر نشد");
  expect(await env.SALES_DB.prepare(
    "SELECT COUNT(*) FROM managed_accounts",
  ).first<number>("COUNT(*)")).toBe(0);
});

test("only admin creates per-node 30m 1GB WSS trial; repeated requests are idempotent", async () => {
  const nonadmin = await reply(await click(10,"rs:ws:trial:n"));
  expect(nonadmin.text).toContain("فقط برای مدیر");
  const first = await reply(await click(9,"rs:ws:trial:n"));
  expect(first.text).toContain("VMess/WSS");
  const row = await env.SALES_DB.prepare(
    "SELECT id,state,kind,request_key,quota_bytes,duration_seconds,node_id,seller_id FROM managed_accounts",
  ).first<{id:string;state:string;kind:string;request_key:string;quota_bytes:number;duration_seconds:number;node_id:string;seller_id:string}>();
  expect(row?.state).toBe("preparing");
  expect(row?.kind).toBe("trial");
  expect(row?.node_id).toBe("n");
  expect(row?.seller_id).toBe("9");
  expect(row?.request_key).toBe("admin-ws-trial:n:0");
  expect(row?.quota_bytes).toBe(1e9);
  expect(row?.duration_seconds).toBe(1800);
  await click(9,"rs:ws:trial:n");
  expect(await env.SALES_DB.prepare(
    "SELECT COUNT(*) FROM managed_accounts",
  ).first<number>("COUNT(*)")).toBe(1);
});

test("WSS test delivers only the metered VMess profile; stale ACK never falls back to REALITY", async () => {
  await click(9,"rs:ws:trial:n");
  const a = await env.SALES_DB.prepare(
    "SELECT id,uuid,quota_epoch,quota_bytes,connection_flow FROM managed_accounts",
  ).first<{id:string;uuid:string;quota_epoch:number;quota_bytes:number;connection_flow:string}>();
  expect(a).toBeTruthy();
  await env.SALES_DB.prepare(
    "UPDATE managed_accounts SET state='active',started_at=100,valid_until=250,listen_port=20000,activation_revision=5 WHERE id=?",
  ).bind(a!.id).run();
  const policy = JSON.stringify({
    version:2,nodeId:"n",revision:5,expiresAt:400,wsFallback:endpoint,
    clients:[{
      accountId:a!.id,uuid:a!.uuid,quotaEpoch:a!.quota_epoch,
      quotaBytes:a!.quota_bytes,usedBytes:0,validUntil:250,
      generation:a!.id+":"+a!.quota_epoch,listenPort:20000,flow:a!.connection_flow,
    }],
  });
  await env.SALES_DB.prepare("UPDATE nodes SET policy_payload=? WHERE id='n'")
    .bind(policy).run();

  const artifact = await buildAccountDeliveryArtifact(E,a!.id,now);
  expect(artifact?.profiles.map(p=>p.id)).toEqual(["vmess-wss"]);
  expect(artifact?.config.startsWith("vmess://")).toBe(true);
  expect(parseManagedVmessWsConfig(artifact!.config).hostname).toBe(endpoint.hostname);
  await queueAccountDelivery(E,a!.id,now);
  const delivery = await env.SALES_DB.prepare(
    "SELECT payload FROM outbox WHERE id=?",
  ).bind("account:"+a!.id).first<string>("payload");
  const text = JSON.parse(delivery!).text;
  expect(text).toContain("vmess://");
  expect(text).not.toContain("vless://");

  await env.SALES_DB.exec("UPDATE nodes SET agent_capabilities='quota-v2,per-account-process,shared-443'");
  expect(await buildAccountDeliveryArtifact(E,a!.id,now)).toBeNull();
});

test("no WSS config when approved endpoint differs from signed policy", async () => {
  await env.SALES_DB.exec("UPDATE settings SET value='/madar-bbbbbbbbbbbbbbbbbbbbbbbb' WHERE key='managed_ws:n:path'");
  const r = await reply(await click(9,"rs:ws:trial:n"));
  expect(r.text).toContain("هیچ کانفیگی صادر نشد");
  expect(await env.SALES_DB.prepare("SELECT COUNT(*) FROM managed_accounts")
    .first<number>("COUNT(*)")).toBe(0);
});
