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
    "UPDATE nodes SET agent_capabilities='quota-v2,per-account-process'",
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

test("first-account WSS can provision without ws-metered, but no premature delivery", async () => {
  await env.SALES_DB.exec(
    "UPDATE nodes SET agent_capabilities='quota-v2,per-account-process,shared-443'",
  );
  const status = await reply(await click(9,"rs:ws:status:n"));
  expect(status.reply_markup.inline_keyboard.flat().some(
    b=>b.callback_data === "rs:ws:trial:n",
  )).toBe(true);
  const created = await reply(await click(9,"rs:ws:trial:n"));
  expect(created.text).toContain("تست اختصاصی VMess/WSS");
  const account = await env.SALES_DB.prepare(
    "SELECT id FROM managed_accounts",
  ).first<string>("id");
  expect(account).toBeTruthy();
  expect(await buildAccountDeliveryArtifact(E,account!,now)).toBeNull();
  await queueAccountDelivery(E,account!,now);
  expect(await env.SALES_DB.prepare(
    "SELECT COUNT(*) FROM outbox WHERE id=?",
  ).bind("account:"+account).first<number>("COUNT(*)")).toBe(0);
});

test("only admin creates per-node 30m 1GB WSS trial; repeated requests are idempotent", async () => {
  const nonadmin = await reply(await click(10,"rs:ws:trial:n"));
  expect(nonadmin.text).not.toContain("تست اختصاصی VMess/WSS");
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

test("admin home: Issue Config → server → protocol → one tap trial, not paid-sale wizard", async () => {
  const home = await reply(await click(9,"rs:home"));
  expect(home.reply_markup.inline_keyboard.flat().some(
    b => b.callback_data === "rs:quick:start",
  )).toBe(true);
  expect(home.reply_markup.inline_keyboard.flat().some(
    b => b.callback_data === "rs:sale",
  )).toBe(true);  // paid-sale workflow remains accessible

  const nodes = await reply(await click(9,"rs:quick:start"));
  expect(nodes.text).toContain("سرور را انتخاب کن");
  expect(nodes.reply_markup.inline_keyboard.flat().some(
    b=>b.callback_data === "rs:quick:node:n",
  )).toBe(true);
  const protocol = await reply(await click(9,"rs:quick:node:n"));
  expect(protocol.text).toContain("پروتکل");
  expect(protocol.reply_markup.inline_keyboard.flat().some(
    b=>b.callback_data === "rs:quick:issue:reality:n",
  )).toBe(true);
  expect(protocol.reply_markup.inline_keyboard.flat().some(
    b=>b.callback_data === "rs:quick:issue:ws:n",
  )).toBe(true);

  const issued = await reply(await click(9,"rs:quick:issue:reality:n"));
  expect(issued.text).toContain("VLESS/REALITY");
  const account = await env.SALES_DB.prepare(
    "SELECT id,request_key,kind,quota_bytes,duration_seconds,state FROM managed_accounts",
  ).first<{
    id:string;request_key:string;kind:string;quota_bytes:number;duration_seconds:number;state:string;
  }>();
  expect(account).toBeTruthy();
  expect(account?.request_key).toBe("admin-reality-trial:n:0");
  expect(account?.kind).toBe("trial");
  expect(account?.quota_bytes).toBe(1_000_000_000);
  expect(account?.duration_seconds).toBe(1800);
  expect(account?.state).toBe("preparing");
  expect(issued.reply_markup.inline_keyboard.flat().some(
    b=>b.callback_data === "rs:quick:get:" + account?.id,
  )).toBe(true);
  const pending = await reply(await click(9,"rs:quick:get:" + account!.id));
  expect(pending.text).toContain("هنوز آماده تحویل نیست");
  await click(9,"rs:quick:issue:reality:n");
  expect(await env.SALES_DB.prepare(
    "SELECT COUNT(*) n FROM managed_accounts",
  ).first<number>("n")).toBe(1);
});

test("REALITY-only quick test never includes VMess even when same node has metered WS", async () => {
  await click(9,"rs:quick:issue:reality:n");
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
  expect(artifact?.profiles.map(p=>p.id)).toEqual(["reality-443"]);
  expect(artifact?.config.startsWith("vless://")).toBe(true);
  expect(artifact?.alternateConfig).toBeUndefined();
  const shown = await reply(await click(9,"rs:quick:get:" + a!.id));
  expect(shown.text).toContain("vless://");
  expect(shown.text).not.toContain("vmess://");
  await queueAccountDelivery(E,a!.id,now);
  const text = (await env.SALES_DB.prepare(
    "SELECT payload FROM outbox WHERE id=?",
  ).bind("account:" + a!.id).first<string>("payload"))!;
  expect(JSON.parse(text).text).not.toContain("vmess://");
});

test("WSS per-node picker issues exact same metered WS-only test", async () => {
  const selected = await reply(await click(9,"rs:quick:node:n"));
  expect(selected.text).toContain("VMess");
  const issued = await reply(await click(9,"rs:quick:issue:ws:n"));
  expect(issued.text).toContain("VMess/WSS");
  const a = await env.SALES_DB.prepare(
    "SELECT id,request_key FROM managed_accounts",
  ).first<{id:string;request_key:string}>();
  expect(a?.request_key).toBe("admin-ws-trial:n:0");
  const blocked = await reply(await click(9,"rs:quick:get:"+a!.id));
  expect(blocked.text).toContain("هنوز آماده تحویل نیست");
});

test("quick chooser denies ordinary users, not-ready WSS, and expired node ACK", async () => {
  const denied = await reply(await click(10,"rs:quick:start"));
  expect(denied.text).toContain("فقط برای مدیر");
  const other = await reply(await click(10,"rs:quick:issue:reality:n"));
  expect(other.text).toContain("فقط برای مدیر");
  expect(await env.SALES_DB.prepare(
    "SELECT COUNT(*) n FROM managed_accounts",
  ).first<number>("n")).toBe(0);

  await env.SALES_DB.exec(
    "UPDATE nodes SET agent_capabilities='quota-v2,per-account-process,shared-443'",
  );
  const notReady = await reply(await click(9,"rs:quick:issue:ws:n"));
  expect(notReady.text).toContain("هنوز آماده نیست");
  expect(await env.SALES_DB.prepare(
    "SELECT COUNT(*) n FROM managed_accounts",
  ).first<number>("n")).toBe(0);
  await env.SALES_DB.exec("UPDATE nodes SET acked_revision=4");
  const stale = await reply(await click(9,"rs:quick:issue:reality:n"));
  expect(stale.text).toContain("ظرفیت یا اتصال");
  expect(await env.SALES_DB.prepare(
    "SELECT COUNT(*) n FROM managed_accounts",
  ).first<number>("n")).toBe(0);
});

test("chooser offers several nodes while never misrouting a test account", async () => {
  await env.SALES_DB.exec(
    "INSERT INTO nodes(id,name,target_ip,vpn_port,state,revision,acked_revision,last_seen,healthy,public_key,short_id,sni,policy_payload,agent_capabilities,max_accounts,max_allocated_bytes) " +
    "VALUES('other','Second VPS','1.1.1.1',443,'ready',5,5,100,1,'" +
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA','1234567890abcdef','www.cloudflare.com','{}'," +
    "'quota-v2,per-account-process,shared-443',20,2000000000)",
  );
  const secondPolicy = JSON.stringify({
    version:2,nodeId:"other",revision:5,expiresAt:400,clients:[],
  });
  await env.SALES_DB.prepare(
    "UPDATE nodes SET policy_payload=? WHERE id='other'",
  ).bind(secondPolicy).run();

  const nodes = await reply(await click(9,"rs:quick:start"));
  const buttons = nodes.reply_markup.inline_keyboard.flat().map(b=>b.callback_data);
  expect(buttons).toContain("rs:quick:node:n");
  expect(buttons).toContain("rs:quick:node:other");
  await click(9,"rs:quick:node:other");
  const wsNotReady = await reply(await click(9,"rs:quick:issue:ws:other"));
  expect(wsNotReady.text).toContain("هنوز آماده نیست");
  await click(9,"rs:quick:issue:reality:other");
  const row = await env.SALES_DB.prepare(
    "SELECT node_id,quota_bytes,kind FROM managed_accounts",
  ).first<{node_id:string;quota_bytes:number;kind:string}>();
  expect(row?.node_id).toBe("other");
  expect(row?.quota_bytes).toBe(1e9);
  expect(row?.kind).toBe("trial");
});
