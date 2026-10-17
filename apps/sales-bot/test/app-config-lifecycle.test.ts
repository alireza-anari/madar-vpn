import { createHmac } from "node:crypto";
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
import m12 from "../migrations/0012-telegram-profiles.sql?raw";
import m13 from "../migrations/0013-managed-account-archive.sql?raw";
import { appApi } from "../src/app-api";
import { listAppConfigs } from "../src/app-dashboard";
import { nodeCapacities } from "../src/node-capacity";
import { sellerStats } from "../src/seller-accounting";

const now = 10_000;
const botToken = "123456:LIFECYCLE_TEST";
const E = { ...env, BOT_TOKEN: botToken, ADMIN_TELEGRAM_IDS: "1", PUBLIC_BASE_URL: "https://example.test" } as Env;
const admin = { telegramId: "1", role: "admin" as const };

function initData(id: number) {
  const p = new URLSearchParams({auth_date:String(now),query_id:`q-${id}`,user:JSON.stringify({id})});
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const value = [...p.entries()].sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${k}=${v}`).join("\n");
  p.set("hash", createHmac("sha256", secret).update(value).digest("hex"));
  return p.toString();
}

function request(path: string, id: number, method = "GET") {
  return new Request(`https://example.test${path}`, {method,headers:{"X-Telegram-Init-Data":initData(id),"Content-Type":"application/json"},...(method === "POST" ? {body:"{}"}: {})});
}

beforeEach(async () => {
  await resetDb();
  for (const sql of [m1,m2,m3,m4,m5,m6,m7,m8,m9,m10,m11,m12,m13]) await env.SALES_DB.exec(sql);
  await env.SALES_DB.exec(
    "INSERT INTO resellers(telegram_id,enabled,created_at) VALUES('10',1,1);" +
    "INSERT INTO telegram_profiles(telegram_id,username,first_name,last_name,updated_at) VALUES('10','seller10','Ali',NULL,1);" +
    "INSERT INTO nodes(id,name,target_ip,state,revision,acked_revision,last_seen,healthy,agent_capabilities,max_accounts,max_allocated_bytes) VALUES('n','Stockholm','8.8.8.8','ready',2,2,10000,1,'quota-v2,per-account-process,shared-443',20,100000000000);" +
    "INSERT INTO managed_accounts(id,seller_id,request_key,node_id,kind,label,uuid,state,quota_bytes,used_bytes,duration_seconds,valid_until,created_at) VALUES('a','10','r','n','sale','Client','uuid-a','active',30000000000,5000000000,86400,20000,100);"
  );
});

test("admin config detail includes server, remaining quota and seller identity", async () => {
  const response = await appApi(request("/api/app/configs/a", 1), E, now);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    id:"a",sellerId:"10",sellerDisplayName:"@seller10",serverName:"Stockholm",quotaBytes:30e9,usedBytes:5e9,remainingBytes:25e9,archivedAt:null
  });
});

test("seller cannot revoke through admin lifecycle endpoint", async () => {
  const response = await appApi(request("/api/app/configs/a/revoke", 10, "POST"), E, now);
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({error:"ADMIN_REQUIRED"});
  expect(await env.SALES_DB.prepare("SELECT state FROM managed_accounts WHERE id='a'").first("state")).toBe("active");
});

test("revoke is end-to-end and immediately releases live capacity", async () => {
  expect((await nodeCapacities(env.SALES_DB, now, "n"))[0]?.reserved_accounts).toBe(1);
  const response = await appApi(request("/api/app/configs/a/revoke", 1, "POST"), E, now);
  expect(response.status).toBe(200);
  expect((await response.json() as any).state).toBe("revoked");
  expect((await nodeCapacities(env.SALES_DB, now, "n"))[0]?.reserved_accounts).toBe(0);
  expect(await env.SALES_DB.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='revoke_account' AND target_id='a'").first("n")).toBe(1);
});

test("archive revokes live account, preserves history, audits once and hides default list", async () => {
  let response = await appApi(request("/api/app/configs/a/archive", 1, "POST"), E, now);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({id:"a",state:"revoked",archivedAt:now,archivedBy:"1"});

  const list = await listAppConfigs(env.SALES_DB, admin, now);
  expect(list.items).toHaveLength(0);
  expect((await sellerStats(env.SALES_DB, "10", "all", now)).configCount).toBe(1);
  expect(await env.SALES_DB.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='archive_account' AND target_id='a'").first("n")).toBe(1);

  response = await appApi(request("/api/app/configs/a/archive", 1, "POST"), E, now + 1);
  expect(response.status).toBe(200);
  expect(await env.SALES_DB.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='archive_account' AND target_id='a'").first("n")).toBe(1);

  const detail = await appApi(request("/api/app/configs/a", 1), E, now + 1);
  expect(detail.status).toBe(200);
  expect(await detail.json()).toMatchObject({id:"a",archivedAt:now});
});
