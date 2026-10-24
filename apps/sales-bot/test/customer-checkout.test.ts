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
import customerMigration from "../migrations/0016-customer-checkout.sql?raw";
import { customerApi } from "../src/customer-api";
import { handleCustomerTelegramUpdate } from "../src/customer-telegram";
import { queueAccountDelivery } from "../src/account-delivery";
import worker from "../src/index";

const now=10_000,token="123456:CUSTOMER_TEST";
const E={...env,BOT_TOKEN:token,ADMIN_TELEGRAM_IDS:"1",PUBLIC_BASE_URL:"https://example.test"} as Env;
function signed(id:number) {
  const p=new URLSearchParams({auth_date:String(now),query_id:"q"+id,user:JSON.stringify({id})});
  const secret=createHmac("sha256","WebAppData").update(token).digest();
  const raw=[...p.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>k+"="+v).join("\n");
  p.set("hash",createHmac("sha256",secret).update(raw).digest("hex"));
  return p.toString();
}
function req(path:string,user=10,body?:unknown) {
  return new Request("https://example.test"+path,{
    method:body===undefined?"GET":"POST",
    headers:{"X-Telegram-Init-Data":signed(user),"Content-Type":"application/json"},
    ...(body===undefined?{}:{body:JSON.stringify(body)}),
  });
}
async function call(path:string,user=10,body?:unknown) {
  return customerApi(req(path,user,body),E,now);
}
const key="key_1234567890123456";
beforeEach(async()=>{
  await resetDb();
  for(const sql of [m1,m2,m3,m4,m5,m6,m7,m8,m9,m10,m11,m12,m13,customerMigration])
    await env.SALES_DB.exec(sql);
  await env.SALES_DB.prepare(
    "INSERT INTO nodes(id,name,target_ip,vpn_port,state,revision,acked_revision,last_seen,healthy,agent_capabilities,max_accounts,max_allocated_bytes) VALUES('n','Stockholm','8.8.8.8',443,'ready',1,1,?,1,'quota-v2,shared-443',1,30000000000)",
  ).bind(now).run();
});
async function setup() {
  expect((await call("/api/customer/admin/payment",1,{value:"کارت نمونه"})).status).toBe(200);
  expect((await call("/api/customer/admin/plans",1,{id:"monthly",name:"۳۰ روز ۲۰ گیگ",price:250000,
    currency:"IRT",durationDays:30,quotaGb:20,enabled:true})).status).toBe(200);
}
async function order() {
  const r=await call("/api/customer/orders",10,{planId:"monthly",nodeId:"n",requestKey:key});
  expect(r.status).toBe(201);
  return (await r.json() as {id:string});
}
async function sendReceipt() {
  expect((await call("/api/customer/orders/"+(await order()).id+"/receipt-request",10,{})).status).toBe(200);
  const update={update_id:17,message:{message_id:1,chat:{id:10,type:"private"},from:{id:10},photo:[{file_id:"receipt-telegram-file"}]}};
  expect(await handleCustomerTelegramUpdate(E,update,now)).toBe(true);
}

test("worker serves a separate signed customer storefront",async()=>{
  for(const path of ["/customer","/customer.css","/customer.js"]) {
    const r=await worker.fetch(new Request("https://example.test"+path),E);
    expect(r.status).toBe(200);
  }
  const html=await (await worker.fetch(new Request("https://example.test/customer"),E)).text();
  expect(html).toContain("/madar-logo.png");
  expect(html).toContain("پنل مشتری");
});
test("admin configures price, volume and payment; unauthorized users cannot",async()=>{
  expect((await call("/api/customer/admin/plans",10,{id:"bad"})).status).toBe(403);
  expect((await call("/api/customer/admin/payment",10,{value:"hijack"})).status).toBe(403);
  expect((await call("/api/customer/orders",10,{planId:"monthly",nodeId:"n",requestKey:key})).status).toBe(409);
  await setup();
  const plans=await (await call("/api/customer/plans")).json() as any;
  expect(plans.plans[0]).toMatchObject({id:"monthly",price:250000,quotaBytes:20e9,durationSeconds:30*86400});
  const nodes=await (await call("/api/customer/nodes?planId=monthly")).json() as any[];
  expect(nodes).toEqual([{id:"n",name:"Stockholm"}]);
  expect(JSON.stringify(nodes)).not.toContain("target_ip");
});
test("customer cannot forge price, provision before receipt, or duplicate a checkout",async()=>{
  await setup();
  const first=await call("/api/customer/orders",10,{planId:"monthly",nodeId:"n",requestKey:key,price:1,quotaBytes:1});
  const a=await first.json() as any;
  expect(a.price).toBe(250000);
  expect(a.quotaBytes).toBe(20e9);
  const second=await order();
  expect(second.id).toBe(a.id);
  expect(await env.SALES_DB.prepare("SELECT COUNT(*) n FROM managed_accounts").first("n")).toBe(0);
  expect((await call("/api/customer/orders/"+a.id+"/config",11)).status).toBe(404);
  expect((await call("/api/customer/orders/"+a.id+"/receipt-request",11,{})).status).toBe(404);
});
test("receipt goes to admin; admin approval uses quota-v2 and is idempotent",async()=>{
  await setup();
  const o=await order();
  await sendReceipt();
  expect(await env.SALES_DB.prepare("SELECT state FROM customer_orders WHERE id=?").bind(o.id).first("state"))
    .toBe("pending_review");
  expect(await env.SALES_DB.prepare("SELECT COUNT(*) n FROM outbox WHERE chat_id='1'").first("n")).toBe(1);
  expect((await call("/api/customer/admin/orders/"+o.id+"/approve",10,{})).status).toBe(403);
  expect((await call("/api/customer/admin/orders/"+o.id+"/approve",1,{})).status).toBe(200);
  expect((await call("/api/customer/admin/orders/"+o.id+"/approve",1,{})).status).toBe(200);
  const row=await env.SALES_DB.prepare(
    "SELECT seller_id,quota_bytes,duration_seconds FROM managed_accounts WHERE request_key=?",
  ).bind("customer-order:"+o.id).first();
  expect(row).toMatchObject({seller_id:"1",quota_bytes:20e9,duration_seconds:30*86400});
  expect(await env.SALES_DB.prepare("SELECT COUNT(*) n FROM managed_accounts").first("n")).toBe(1);
  expect(await (await call("/api/customer/orders/"+o.id+"/config")).json()).toEqual({ready:false});
});
test("capacity still fails closed on admin approval when last slot is consumed",async()=>{
  await setup();
  const o=await order();
  await sendReceipt();
  await env.SALES_DB.prepare(
    "INSERT INTO managed_accounts(id,seller_id,request_key,node_id,kind,label,uuid,quota_bytes,duration_seconds,created_at) VALUES('other','1','other','n','sale','Other','00000000-0000-4000-8000-000000000001',20000000000,86400,?)",
  ).bind(now).run();
  expect((await call("/api/customer/admin/orders/"+o.id+"/approve",1,{})).status).toBe(409);
  expect(await env.SALES_DB.prepare("SELECT state FROM customer_orders WHERE id=?").bind(o.id).first("state"))
    .toBe("pending_review");
  expect(await env.SALES_DB.prepare("SELECT COUNT(*) n FROM managed_accounts").first("n")).toBe(1);
});
test("on ready node ACK the private VPN config is addressed to the buying customer",async()=>{
  await setup();const o=await order();await sendReceipt();
  await call("/api/customer/admin/orders/"+o.id+"/approve",1,{});
  const account=await env.SALES_DB.prepare("SELECT id,uuid FROM managed_accounts WHERE request_key=?")
    .bind("customer-order:"+o.id).first<{id:string;uuid:string}>();
  const policy=JSON.stringify({version:2,nodeId:"n",revision:2,expiresAt:now+300,
    clients:[{accountId:account!.id,uuid:account!.uuid,validUntil:now+200,quotaEpoch:1,quotaBytes:20e9,usedBytes:0,generation:"v1",listenPort:20000}]});
  await env.SALES_DB.prepare("UPDATE managed_accounts SET state='active',valid_until=?,activation_revision=2,listen_port=20000 WHERE id=?")
    .bind(now+200,account!.id).run();
  await env.SALES_DB.prepare("UPDATE nodes SET revision=2,acked_revision=2,public_key='pub',short_id='1234567890abcdef',sni='www.cloudflare.com',policy_payload=? WHERE id='n'")
    .bind(policy).run();
  await queueAccountDelivery(E,account!.id,now);
  const payload=await env.SALES_DB.prepare("SELECT chat_id,payload FROM outbox WHERE id=?")
    .bind("account:"+account!.id).first<{chat_id:string;payload:string}>();
  expect(payload?.chat_id).toBe("10");
  expect(payload?.payload).toContain("vless://");
  const ready=await (await call("/api/customer/orders/"+o.id+"/config",10)).json() as any;
  expect(ready.ready).toBe(true);
  expect(ready.config).toContain("vless://");
  expect((await call("/api/customer/orders/"+o.id+"/config",11)).status).toBe(404);
});
