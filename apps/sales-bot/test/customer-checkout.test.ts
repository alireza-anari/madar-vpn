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
import upgradeMigration from "../migrations/0017-customer-upgrades.sql?raw";
import { customerApi } from "../src/customer-api";
import { handleUpdate } from "../src/menus";
import { handleCustomerTelegramUpdate } from "../src/customer-telegram";
import { deliverOutbox } from "../src/outbox";
import { customerQrResponse } from "../src/customer-qr";
import { queueAccountDelivery } from "../src/account-delivery";
import {
  approveUpgrade, createCustomerUpgrade, listCustomerUpgrades, notifyReadyUpgrades,
  requestUpgradeReceipt, submitUpgradeReceipt,
} from "../src/customer-upgrades";
import worker from "../src/index";

const now=10_000,token="123456:CUSTOMER_TEST";
const E={...env,BOT_TOKEN:token,ADMIN_TELEGRAM_IDS:"1",PUBLIC_BASE_URL:"https://example.test",USAGE_LINK_SECRET:"test-usage-link-secret"} as Env;
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
  for(const sql of [m1,m2,m3,m4,m5,m6,m7,m8,m9,m10,m11,m12,m13])
    await env.SALES_DB.exec(sql);
  // Cloudflare's test D1 exec splitter mishandles ALTER TABLE followed by multiline CREATE;
  // execute every migration statement through D1 prepare, as Wrangler migrations do.
  for (const statement of customerMigration.split(/;\s*(?:\n|$)/).map(s=>s.trim()).filter(Boolean))
    await env.SALES_DB.prepare(statement).run();
  for (const statement of upgradeMigration.split(/;\s*(?:\n|$)/).map(s=>s.trim()).filter(Boolean))
    await env.SALES_DB.prepare(statement).run();
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
  const notice=JSON.parse((await env.SALES_DB.prepare("SELECT payload FROM outbox WHERE id=?").bind("customer-approved:"+o.id).first<string>("payload"))||"{}");
  expect(notice.text).toContain("همین چت ربات");
  expect(notice.reply_markup.inline_keyboard.flat().some((b:any)=>b.callback_data==="customer:orders:0")).toBe(true);
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
  expect(ready.sellerId).toBeUndefined();
  expect(JSON.stringify(ready)).not.toContain("sellerId");
  expect(ready.config).toContain("vless://");
  expect(await handleCustomerTelegramUpdate(E,{update_id:907,callback_query:{id:"get-config",from:{id:10},message:{message_id:7,chat:{id:10,type:"private"}},data:"customer:config:"+o.id}} as any,now)).toBe(true);
  const configMessage=JSON.parse((await env.SALES_DB.prepare("SELECT payload FROM outbox WHERE id='u907:reply'").first<string>("payload"))||"{}");
  expect(configMessage.parse_mode).toBe("HTML");
  const configButtons=configMessage.reply_markup.inline_keyboard.flat();
  expect(configButtons.some((b:any)=>b.copy_text?.text===ready.config)).toBe(true);
  expect(configButtons.some((b:any)=>b.url===ready.usageUrl)).toBe(true);
  expect(configButtons.some((b:any)=>b.callback_data==="customer:qr:"+o.id)).toBe(true);
  expect(await handleCustomerTelegramUpdate(E,{update_id:908,callback_query:{id:"qr",from:{id:10},message:{message_id:8,chat:{id:10,type:"private"}},data:"customer:qr:"+o.id}} as any,now)).toBe(true);
  const qrPayload=JSON.parse((await env.SALES_DB.prepare("SELECT payload FROM outbox WHERE id='u908:reply'").first<string>("payload"))||"{}");
  expect(qrPayload._method).toBe("sendPhoto");
  expect(qrPayload.photo).toContain("/api/customer/qr/");
  expect(qrPayload.photo).not.toContain(ready.config);
  const qrToken=new URL(qrPayload.photo).pathname.slice("/api/customer/qr/".length);
  const qrResponse=await customerQrResponse(new Request(qrPayload.photo),E,qrToken,now);
  expect(qrResponse.status).toBe(200);
  expect(qrResponse.headers.get("Content-Type")).toBe("image/png");
  expect((await qrResponse.arrayBuffer()).byteLength).toBeGreaterThan(100);
  expect((await customerQrResponse(new Request(qrPayload.photo),E,qrToken+"x",now)).status).toBe(404);
  expect((await call("/api/customer/orders/"+o.id+"/config",11)).status).toBe(404);
});

test("admin sees a distinct customer panel entry without losing seller/admin buttons",async()=>{
  await env.SALES_DB.prepare("INSERT INTO settings(key,value) VALUES('app_mode','reseller')").run();
  await handleUpdate(E,{update_id:601,message:{message_id:1,chat:{id:1,type:"private"},from:{id:1},text:"/start"}},now);
  const raw=await env.SALES_DB.prepare("SELECT payload FROM outbox WHERE id='u601:reply'").first<string>("payload");
  const payload=JSON.parse(raw||"{}") as any;
  const buttons=payload.reply_markup.inline_keyboard.flat();
  expect(buttons.some((b:any)=>b.web_app?.url==="https://example.test/customer")).toBe(true);
  expect(buttons.some((b:any)=>b.web_app?.url==="https://example.test/app")).toBe(true);
});

test("customer page accepts only signed Telegram launch data and explains missing launch context", async () => {
  const script=await (await worker.fetch(new Request("https://example.test/customer.js"),E)).text();
  expect(script).toContain('tgWebAppData');
  expect(script).toContain('new URLSearchParams(raw)');
  expect(script).toContain('MISSING_TELEGRAM_LAUNCH');
  // The optional transport fallback never grants access without a server-side
  // signature check. Normal unsigned requests must still be rejected.
  const unsigned=await customerApi(new Request("https://example.test/api/customer/me"),E,now);
  expect(unsigned.status).toBe(403);
  expect((await unsigned.json() as any).error).toBe("INVALID_SIGNATURE");
});

test("admin can review receipt image, approve or reject from bot inbox; customers cannot",async()=>{
  await setup();
  const o=await order();
  await sendReceipt();
  await env.SALES_DB.prepare("INSERT INTO settings(key,value) VALUES('app_mode','reseller')").run();

  await handleUpdate(E,{update_id:701,message:{message_id:1,chat:{id:1,type:"private"},from:{id:1},text:"/start"}},now);
  const home=JSON.parse((await env.SALES_DB.prepare("SELECT payload FROM outbox WHERE id='u701:reply'").first<string>("payload"))||"{}");
  expect(home.reply_markup.inline_keyboard.flat().some((button:any)=>
    button.text==="💳 رسیدهای مشتریان" && button.callback_data==="cust:inbox:0")).toBe(true);

  const inbox={update_id:702,callback_query:{id:"inbox",from:{id:1},message:{message_id:7,chat:{id:1,type:"private"}},data:"cust:inbox:0"}};
  expect(await handleCustomerTelegramUpdate(E,inbox as any,now)).toBe(true);
  const listing=JSON.parse((await env.SALES_DB.prepare("SELECT payload FROM outbox WHERE id='u702:reply'").first<string>("payload"))||"{}");
  expect(listing.text).toContain("رسیدهای در انتظار");
  expect(listing.reply_markup.inline_keyboard.flat().some((b:any)=>b.callback_data==="cust:review:"+o.id)).toBe(true);

  const unauthorized={...inbox,update_id:703,callback_query:{...inbox.callback_query,from:{id:10},message:{message_id:7,chat:{id:10,type:"private"}}}};
  expect(await handleCustomerTelegramUpdate(E,unauthorized as any,now)).toBe(true);
  const denied=JSON.parse((await env.SALES_DB.prepare("SELECT payload FROM outbox WHERE id='u703:reply'").first<string>("payload"))||"{}");
  expect(denied.text).toContain("فقط برای مدیر");
  expect(denied.text).not.toContain(o.id);

  const review={...inbox,update_id:704,callback_query:{...inbox.callback_query,data:"cust:review:"+o.id}};
  expect(await handleCustomerTelegramUpdate(E,review as any,now)).toBe(true);
  const details=JSON.parse((await env.SALES_DB.prepare("SELECT payload FROM outbox WHERE id='u704:reply'").first<string>("payload"))||"{}");
  const buttons=details.reply_markup.inline_keyboard.flat();
  expect(buttons.some((b:any)=>b.callback_data==="cust:approve:"+o.id)).toBe(true);
  expect(buttons.some((b:any)=>b.callback_data==="cust:reject:"+o.id)).toBe(true);
  expect(buttons.some((b:any)=>b.callback_data==="cust:inbox:0")).toBe(true);
  const proof=JSON.parse((await env.SALES_DB.prepare("SELECT payload FROM outbox WHERE id='u704:customer-proof'").first<string>("payload"))||"{}");
  expect(proof._method).toBe("sendPhoto");
  expect(proof.photo).toBe("receipt-telegram-file");

  expect(await handleCustomerTelegramUpdate(E,{update_id:705,message:{message_id:1,chat:{id:1,type:"private"},from:{id:1},text:"/receipts"}} as any,now)).toBe(true);
  expect((await env.SALES_DB.prepare("SELECT payload FROM outbox WHERE id='u705:reply'").first<string>("payload"))).toContain("رسیدهای در انتظار");
});
test("native Telegram receipt inbox paginates pending orders without a Web App",async()=>{
  await setup();
  for(let i=0;i<8;i++){
    const response=await call("/api/customer/orders",10,{planId:"monthly",nodeId:"n",requestKey:"receipt_order_123456_"+i});
    expect(response.status).toBe(201);
    const {id}=await response.json() as {id:string};
    await env.SALES_DB.batch([
      env.SALES_DB.prepare("INSERT INTO customer_receipts(order_id,file_id,kind) VALUES(?,?,'document')").bind(id,"receipt-file-"+i),
      env.SALES_DB.prepare("UPDATE customer_orders SET state='pending_review' WHERE id=?").bind(id),
    ]);
  }
  for(const [page,count] of [[0,6],[1,2]] as const){
    const update={update_id:720+page,callback_query:{id:"p",from:{id:1},message:{chat:{id:1,type:"private"},message_id:1},data:"cust:inbox:"+page}};
    expect(await handleCustomerTelegramUpdate(E,update as any,now)).toBe(true);
    const raw=await env.SALES_DB.prepare("SELECT payload FROM outbox WHERE id=?").bind("u"+(720+page)+":reply").first<string>("payload");
    const payload=JSON.parse(raw||"{}");
    const buttons=payload.reply_markup.inline_keyboard.flat();
    expect(buttons.filter((b:any)=>b.callback_data?.startsWith("cust:review:")).length).toBe(count);
    if(page===0)expect(buttons.some((b:any)=>b.callback_data==="cust:inbox:1")).toBe(true);
    else expect(buttons.some((b:any)=>b.callback_data==="cust:inbox:0")).toBe(true);
  }
});

test("ordinary buyer completes plan selection, payment instructions, and receipt in bot chat without a Mini App",async()=>{
  await setup();
  const send=async(update:any)=>handleCustomerTelegramUpdate(E,update,now);
  expect(await send({update_id:801,message:{message_id:1,chat:{id:10,type:"private"},from:{id:10},text:"/start"}})).toBe(true);
  const home=JSON.parse((await env.SALES_DB.prepare("SELECT payload FROM outbox WHERE id='u801:reply'").first<string>("payload"))||"{}");
  const homeButtons=home.reply_markup.inline_keyboard.flat();
  expect(homeButtons.some((b:any)=>b.callback_data==="customer:buy")).toBe(true);
  expect(homeButtons.some((b:any)=>b.callback_data==="customer:orders:0")).toBe(true);
  expect(JSON.stringify(home)).not.toContain("web_app");

  expect(await send({update_id:802,callback_query:{id:"buy",from:{id:10},message:{message_id:2,chat:{id:10,type:"private"}},data:"customer:buy"}})).toBe(true);
  const plans=JSON.parse((await env.SALES_DB.prepare("SELECT payload FROM outbox WHERE id='u802:reply'").first<string>("payload"))||"{}");
  expect(plans.reply_markup.inline_keyboard.flat().some((b:any)=>b.callback_data==="customer:plan:monthly")).toBe(true);

  expect(await send({update_id:803,callback_query:{id:"plan",from:{id:10},message:{message_id:3,chat:{id:10,type:"private"}},data:"customer:plan:monthly"}})).toBe(true);
  const nodes=JSON.parse((await env.SALES_DB.prepare("SELECT payload FROM outbox WHERE id='u803:reply'").first<string>("payload"))||"{}");
  expect(nodes.text).toContain("سرور را انتخاب کن");
  expect(nodes.reply_markup.inline_keyboard.flat().some((b:any)=>b.callback_data==="customer:node:monthly:0")).toBe(true);

  expect(await send({update_id:804,callback_query:{id:"node",from:{id:10},message:{message_id:4,chat:{id:10,type:"private"}},data:"customer:node:monthly:0"}})).toBe(true);
  const order=await env.SALES_DB.prepare("SELECT id,user_id,state,price,quota_bytes,duration_seconds,node_id FROM customer_orders WHERE user_id='10'").first<any>();
  expect(order).toMatchObject({user_id:"10",state:"awaiting_receipt",price:250000,quota_bytes:20e9,duration_seconds:30*86400,node_id:"n"});
  expect(await env.SALES_DB.prepare("SELECT conversation FROM users WHERE id='10'").first("conversation")).toBe("customer-receipt:"+order.id);
  const checkout=JSON.parse((await env.SALES_DB.prepare("SELECT payload FROM outbox WHERE id='u804:reply'").first<string>("payload"))||"{}");
  expect(checkout.text).toContain(order.id);
  expect(checkout.text).toContain("اطلاعات پرداخت");
  expect(checkout.text).toContain("کارت نمونه");
  expect(JSON.stringify(checkout)).not.toContain("web_app");

  expect(await send({update_id:805,message:{message_id:5,chat:{id:10,type:"private"},from:{id:10},photo:[{file_id:"buyer-proof"}]}})).toBe(true);
  expect(await env.SALES_DB.prepare("SELECT state FROM customer_orders WHERE id=?").bind(order.id).first("state")).toBe("pending_review");
  expect(await env.SALES_DB.prepare("SELECT file_id FROM customer_receipts WHERE order_id=?").bind(order.id).first("file_id")).toBe("buyer-proof");
  expect(await env.SALES_DB.prepare("SELECT COUNT(*) n FROM outbox WHERE chat_id='1' AND id=?").bind("customer-review:"+order.id+":1").first("n")).toBe(1);
  const submitted=JSON.parse((await env.SALES_DB.prepare("SELECT payload FROM outbox WHERE id='u805:reply'").first<string>("payload"))||"{}");
  expect(submitted.text).toContain("رسید ثبت شد");

  expect(await send({update_id:806,callback_query:{id:"orders",from:{id:10},message:{message_id:6,chat:{id:10,type:"private"}},data:"customer:orders:0"}})).toBe(true);
  const orders=JSON.parse((await env.SALES_DB.prepare("SELECT payload FROM outbox WHERE id='u806:reply'").first<string>("payload"))||"{}");
  expect(orders.reply_markup.inline_keyboard.flat().some((b:any)=>b.callback_data==="customer:order:"+order.id)).toBe(true);
  expect(orders.text).toContain("سفارش‌های من");
});

test("customer order and config callbacks never reveal another user's order",async()=>{
  await setup();
  const orderRow=await order();
  const response=await handleCustomerTelegramUpdate(E,{update_id:811,callback_query:{id:"foreign",from:{id:11},message:{message_id:1,chat:{id:11,type:"private"}},data:"customer:order:"+orderRow.id}} as any,now);
  expect(response).toBe(true);
  const payload=JSON.parse((await env.SALES_DB.prepare("SELECT payload FROM outbox WHERE id='u811:reply'").first<string>("payload"))||"{}");
  expect(payload.text).toContain("پیدا نشد");
  expect(payload.text).not.toContain(orderRow.id);
});

test("reseller-mode dispatcher routes ordinary /start to native customer menu, not the Mini App",async()=>{
  await setup();
  await env.SALES_DB.prepare("INSERT INTO settings(key,value) VALUES('app_mode','reseller')").run();
  await handleUpdate(E,{update_id:821,message:{message_id:1,chat:{id:10,type:"private"},from:{id:10},text:"/start"}} as any,now);
  const payload=JSON.parse((await env.SALES_DB.prepare("SELECT payload FROM outbox WHERE id='u821:reply'").first<string>("payload"))||"{}");
  const buttons=payload.reply_markup.inline_keyboard.flat();
  expect(buttons.some((b:any)=>b.callback_data==="customer:buy")).toBe(true);
  expect(buttons.some((b:any)=>b.callback_data==="customer:orders:0")).toBe(true);
  expect(JSON.stringify(payload)).not.toContain("web_app");
});


test("branded customer start sends the official Madar logo and a clean native menu",async()=>{
  await setup();
  expect(await handleCustomerTelegramUpdate(E,{update_id:901,message:{message_id:1,chat:{id:10,type:"private"},from:{id:10},text:"/start"}} as any,now)).toBe(true);
  const payload=JSON.parse((await env.SALES_DB.prepare("SELECT payload FROM outbox WHERE id='u901:reply'").first<string>("payload"))||"{}");
  expect(payload._method).toBe("sendPhoto");
  expect(payload.photo).toBe("https://example.test/madar-logo.png");
  expect(payload.caption).toContain("مدار | فروشگاه VPN");
  const buttons=payload.reply_markup.inline_keyboard.flat();
  expect(buttons.some((b:any)=>b.callback_data==="customer:buy")).toBe(true);
  expect(buttons.some((b:any)=>b.callback_data==="customer:services")).toBe(true);
  expect(buttons.some((b:any)=>b.callback_data==="customer:orders:0")).toBe(true);
  expect(JSON.stringify(payload)).not.toContain("web_app");
});

test("a buyer with an unpaid order is guided back to that order instead of creating a second receipt target",async()=>{
  await setup();
  const first=await order();
  const result=await call("/api/customer/orders",10,{planId:"monthly",nodeId:"n",requestKey:"key_abcdefghijklmn"});
  expect(result.status).toBe(409);
  expect(await result.json()).toEqual({error:"PENDING_ORDER_EXISTS"});
  expect(await env.SALES_DB.prepare("SELECT COUNT(*) n FROM customer_orders WHERE user_id='10'").first<number>("n")).toBe(1);

  expect(await handleCustomerTelegramUpdate(E,{update_id:902,callback_query:{id:"buy",from:{id:10},message:{message_id:2,chat:{id:10,type:"private"}},data:"customer:buy"}} as any,now)).toBe(true);
  const payload=JSON.parse((await env.SALES_DB.prepare("SELECT payload FROM outbox WHERE id='u902:reply'").first<string>("payload"))||"{}");
  expect(payload.text).toContain("رسید");
  expect(payload.reply_markup.inline_keyboard.flat().some((b:any)=>b.callback_data==="customer:receipt:"+first.id)).toBe(true);
});

test("customer services show remaining quota, usage progress, expiry and config action",async()=>{
  await setup();
  const o=await order();
  await sendReceipt();
  await call("/api/customer/admin/orders/"+o.id+"/approve",1,{});
  const account=await env.SALES_DB.prepare("SELECT id FROM managed_accounts WHERE request_key=?")
    .bind("customer-order:"+o.id).first<{id:string}>();
  await env.SALES_DB.prepare("UPDATE managed_accounts SET state='active',used_bytes=?,valid_until=? WHERE id=?")
    .bind(7e9,now+86400*5,account!.id).run();

  expect(await handleCustomerTelegramUpdate(E,{update_id:903,callback_query:{id:"services",from:{id:10},message:{message_id:3,chat:{id:10,type:"private"}},data:"customer:services"}} as any,now)).toBe(true);
  const services=JSON.parse((await env.SALES_DB.prepare("SELECT payload FROM outbox WHERE id='u903:reply'").first<string>("payload"))||"{}");
  expect(services.reply_markup.inline_keyboard.flat().some((b:any)=>b.callback_data==="customer:order:"+o.id)).toBe(true);

  expect(await handleCustomerTelegramUpdate(E,{update_id:904,callback_query:{id:"detail",from:{id:10},message:{message_id:4,chat:{id:10,type:"private"}},data:"customer:order:"+o.id}} as any,now)).toBe(true);
  const detail=JSON.parse((await env.SALES_DB.prepare("SELECT payload FROM outbox WHERE id='u904:reply'").first<string>("payload"))||"{}");
  expect(detail.parse_mode).toBe("HTML");
  expect(detail.text).toContain("حجم باقی‌مانده");
  expect(detail.text).toContain("مصرف");
  expect(detail.text).toContain("تاریخ انقضا");
  expect(detail.text).toContain("اشتراک فعال");
  expect(detail.reply_markup.inline_keyboard.flat().some((b:any)=>b.callback_data==="customer:config:"+o.id)).toBe(true);
});

test("connection help offers platform-specific guides and official client sources",async()=>{
  expect(await handleCustomerTelegramUpdate(E,{update_id:905,callback_query:{id:"help",from:{id:10},message:{message_id:5,chat:{id:10,type:"private"}},data:"customer:help"}} as any,now)).toBe(true);
  const menu=JSON.parse((await env.SALES_DB.prepare("SELECT payload FROM outbox WHERE id='u905:reply'").first<string>("payload"))||"{}");
  expect(menu.reply_markup.inline_keyboard.flat().some((b:any)=>b.callback_data==="customer:help:android")).toBe(true);
  expect(await handleCustomerTelegramUpdate(E,{update_id:906,callback_query:{id:"android",from:{id:10},message:{message_id:6,chat:{id:10,type:"private"}},data:"customer:help:android"}} as any,now)).toBe(true);
  const guide=JSON.parse((await env.SALES_DB.prepare("SELECT payload FROM outbox WHERE id='u906:reply'").first<string>("payload"))||"{}");
  expect(guide.text).toContain("Import from clipboard");
  expect(guide.reply_markup.inline_keyboard.flat().some((b:any)=>b.url==="https://github.com/2dust/v2rayNG/releases")).toBe(true);
});


test("customer can safely cancel an unpaid trial purchase and select a different plan",async()=>{
  await setup();
  const first=await order();
  const detail=await handleCustomerTelegramUpdate(E,{
    update_id:981,callback_query:{id:"detail",from:{id:10},message:{message_id:4,chat:{id:10,type:"private"},text:"سفارش"},data:"customer:order:"+first.id},
  } as any,now);
  expect(detail).toBe(true);
  const detailPayload=JSON.parse((await env.SALES_DB.prepare("SELECT payload FROM outbox WHERE id='u981:reply'").first<string>("payload"))||"{}");
  expect(detailPayload._method).toBe("editMessageText");
  expect(detailPayload.message_id).toBe(4);
  expect(detailPayload.reply_markup.inline_keyboard.flat().some((button:any)=>button.callback_data==="customer:cancel-confirm:"+first.id)).toBe(true);

  expect(await handleCustomerTelegramUpdate(E,{update_id:982,callback_query:{id:"confirm",from:{id:10},message:{message_id:4,chat:{id:10,type:"private"},text:"جزئیات سفارش"},data:"customer:cancel-confirm:"+first.id}} as any,now)).toBe(true);
  const confirmation=JSON.parse((await env.SALES_DB.prepare("SELECT payload FROM outbox WHERE id='u982:reply'").first<string>("payload"))||"{}");
  expect(confirmation.text).toContain("اگر هنوز وجهی واریز نکرده‌ای");
  expect(confirmation.reply_markup.inline_keyboard.flat().some((button:any)=>button.callback_data==="customer:cancel:"+first.id)).toBe(true);

  expect(await handleCustomerTelegramUpdate(E,{update_id:983,callback_query:{id:"cancel",from:{id:10},message:{message_id:4,chat:{id:10,type:"private"},text:"انصراف"},data:"customer:cancel:"+first.id}} as any,now)).toBe(true);
  const cancelled=await env.SALES_DB.prepare("SELECT state,reason,account_id FROM customer_orders WHERE id=?").bind(first.id).first<any>();
  expect(cancelled).toMatchObject({state:"rejected",reason:"لغو توسط مشتری",account_id:null});
  expect(await env.SALES_DB.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='customer_cancel_order' AND target_id=?").bind(first.id).first<number>("n")).toBe(1);
  const second=await call("/api/customer/orders",10,{planId:"monthly",nodeId:"n",requestKey:"key_second_pending_123"});
  expect(second.status).toBe(201);
});

test("customer cannot withdraw someone else's order or an already submitted receipt",async()=>{
  await setup();
  const first=await order();
  expect(await handleCustomerTelegramUpdate(E,{update_id:984,callback_query:{id:"bad",from:{id:11},message:{message_id:4,chat:{id:11,type:"private"}},data:"customer:cancel:"+first.id}} as any,now)).toBe(true);
  expect(await env.SALES_DB.prepare("SELECT state FROM customer_orders WHERE id=?").bind(first.id).first<string>("state")).toBe("awaiting_receipt");
  await sendReceipt();
  expect(await handleCustomerTelegramUpdate(E,{update_id:985,callback_query:{id:"late",from:{id:10},message:{message_id:4,chat:{id:10,type:"private"}},data:"customer:cancel:"+first.id}} as any,now)).toBe(true);
  expect(await env.SALES_DB.prepare("SELECT state FROM customer_orders WHERE id=?").bind(first.id).first<string>("state")).toBe("pending_review");
});

test("Telegram callback edits fail over to a normal new message without dropping the action",async()=>{
  await env.SALES_DB.prepare("INSERT INTO outbox(id,chat_id,payload) VALUES('edit-test','10',?)")
    .bind(JSON.stringify({_method:"editMessageText",message_id:5,text:"فروشگاه",reply_markup:{inline_keyboard:[]}})).run();
  const calls:{action:string;body:any}[]=[];
  const fetcher=async (url:RequestInfo|URL,options?:RequestInit) => {
    const action=String(url).split("/").pop()||"";
    const body=JSON.parse(String(options?.body));
    calls.push({action,body});
    return Response.json(calls.length===1?{ok:false,error_code:400,description:"Bad Request: message can't be edited"}:{ok:true,result:{message_id:6}},{
      status:calls.length===1?400:200,
    });
  };
  await deliverOutbox(E,now,fetcher as typeof fetch);
  expect(calls.map(c=>c.action)).toEqual(["editMessageText","sendMessage"]);
  expect(calls[0]!.body.message_id).toBe(5);
  expect(calls[1]!.body.message_id).toBeUndefined();
  expect(await env.SALES_DB.prepare("SELECT state FROM outbox WHERE id='edit-test'").first<string>("state")).toBe("sent");
});

test("editing the same Telegram message is a successful no-op, not another chat message",async()=>{
  await env.SALES_DB.prepare("INSERT INTO outbox(id,chat_id,payload) VALUES('no-change','10',?)")
    .bind(JSON.stringify({_method:"editMessageText",message_id:5,text:"همان پیام"})).run();
  const calls:string[]=[];
  const fetcher=async (url:RequestInfo|URL) => {
    calls.push(String(url).split("/").pop()||"");
    return Response.json({ok:false,error_code:400,description:"Bad Request: message is not modified"},{status:400});
  };
  await deliverOutbox(E,now,fetcher as typeof fetch);
  expect(calls).toEqual(["editMessageText"]);
  expect(await env.SALES_DB.prepare("SELECT state FROM outbox WHERE id='no-change'").first<string>("state")).toBe("sent");
});


async function readyPurchasedService() {
  await setup();
  const o=await order();
  await sendReceipt();
  expect((await call("/api/customer/admin/orders/"+o.id+"/approve",1,{})).status).toBe(200);
  const a=await env.SALES_DB.prepare("SELECT * FROM managed_accounts WHERE request_key=?")
    .bind("customer-order:"+o.id).first<any>();
  expect(a?.id).toBeTruthy();
  await env.SALES_DB.prepare(
    "UPDATE managed_accounts SET state='active',started_at=?,valid_until=?,activation_revision=2,listen_port=20000 WHERE id=?"
  ).bind(now-500,now+86400*15,a.id).run();
  // These upgrade tests need spare volume to buy the whole additional 20-GB plan.
  await env.SALES_DB.prepare("UPDATE nodes SET revision=2,acked_revision=2,max_allocated_bytes=100000000000 WHERE id='n'").run();
  return {orderId:o.id,accountId:a.id,uuid:a.uuid};
}
async function payUpgrade(upgradeId:string) {
  await requestUpgradeReceipt(env.SALES_DB,{telegramId:"10",role:"ordinary"},upgradeId);
  expect(await submitUpgradeReceipt(env.SALES_DB,{telegramId:"10",role:"ordinary"},upgradeId,"receipt-topup","photo")).toBe(true);
}
test("customer renews the same UUID and account after bank receipt and admin approval",async()=>{
  const s=await readyPurchasedService();
  const r=await call("/api/customer/upgrades",10,{
    orderId:s.orderId,planId:"monthly",kind:"renew",requestKey:"renew-key_12345678",price:1,
  });
  expect(r.status).toBe(201);
  const order=await r.json() as any;
  expect(order.price).toBe(250000);
  expect(order.deltaSeconds).toBe(86400*30);
  expect(order.deltaBytes).toBe(0);
  expect(await env.SALES_DB.prepare("SELECT COUNT(*) n FROM managed_accounts").first("n")).toBe(1);
  expect((await call("/api/customer/admin/upgrades/"+order.id+"/approve",1,{})).status).toBe(404);
  await payUpgrade(order.id);
  expect((await call("/api/customer/admin/upgrades/"+order.id+"/approve",10,{})).status).toBe(403);
  const approved=await call("/api/customer/admin/upgrades/"+order.id+"/approve",1,{});
  expect(approved.status).toBe(200);
  const replay=await call("/api/customer/admin/upgrades/"+order.id+"/approve",1,{});
  expect(replay.status).toBe(200);
  const a=await env.SALES_DB.prepare("SELECT id,uuid,quota_bytes,valid_until,state,last_customer_upgrade_id FROM managed_accounts WHERE id=?")
    .bind(s.accountId).first<any>();
  expect(a).toMatchObject({id:s.accountId,uuid:s.uuid,quota_bytes:20e9,valid_until:now+86400*45,state:"preparing",last_customer_upgrade_id:order.id});
  expect(await env.SALES_DB.prepare("SELECT COUNT(*) n FROM managed_accounts").first("n")).toBe(1);
  expect(await env.SALES_DB.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='customer_upgrade_applied'").first("n")).toBe(1);
  const own=await call("/api/customer/upgrades",10);
  expect((await own.json() as any[])[0]).toMatchObject({id:order.id,state:"applied"});
  expect((await call("/api/customer/upgrades",11).then(r=>r.json()))).toEqual([]);
});

test("traffic topup does not reset cumulative use or extend expiry",async()=>{
  const s=await readyPurchasedService();
  await env.SALES_DB.prepare("UPDATE managed_accounts SET used_bytes=18000000000 WHERE id=?").bind(s.accountId).run();
  const order=await createCustomerUpgrade(env.SALES_DB,{telegramId:"10",role:"ordinary"},{
    orderId:s.orderId,planId:"monthly",kind:"traffic",requestKey:"topup-key_12345678",
  },now);
  await payUpgrade(order.id);
  await approveUpgrade(E,{telegramId:"1",role:"admin"},order.id,now);
  const a=await env.SALES_DB.prepare("SELECT quota_bytes,used_bytes,valid_until,uuid,state FROM managed_accounts WHERE id=?").bind(s.accountId).first<any>();
  expect(a).toMatchObject({quota_bytes:40e9,used_bytes:18e9,valid_until:now+86400*15,uuid:s.uuid,state:"preparing"});
  expect((await call("/api/customer/orders",10).then(r=>r.json()) as any[])[0]).toMatchObject({quotaBytes:40e9});
});

test("topup fails closed when available server bytes are no longer sufficient",async()=>{
  const s=await readyPurchasedService();
  const order=await createCustomerUpgrade(env.SALES_DB,{telegramId:"10",role:"ordinary"},{
    orderId:s.orderId,planId:"monthly",kind:"traffic",requestKey:"no-space_12345678",
  },now);
  await payUpgrade(order.id);
  await env.SALES_DB.prepare("UPDATE nodes SET max_allocated_bytes=25000000000 WHERE id='n'").run();
  await expect(approveUpgrade(E,{telegramId:"1",role:"admin"},order.id,now)).rejects.toThrow("UPGRADE_CAPACITY_CHANGED");
  expect(await env.SALES_DB.prepare("SELECT state FROM customer_upgrades WHERE id=?").bind(order.id).first("state")).toBe("pending_review");
  expect(await env.SALES_DB.prepare("SELECT quota_bytes FROM managed_accounts WHERE id=?").bind(s.accountId).first("quota_bytes")).toBe(20e9);
});

test("buyer cannot upgrade another customer's config or submit forged receipt",async()=>{
  const s=await readyPurchasedService();
  const r=await call("/api/customer/upgrades",11,{orderId:s.orderId,planId:"monthly",kind:"traffic",requestKey:"not-yours_123456"});
  expect(r.status).toBe(404);
  const order=await createCustomerUpgrade(env.SALES_DB,{telegramId:"10",role:"ordinary"},{
    orderId:s.orderId,planId:"monthly",kind:"renew",requestKey:"owned-upgrade-1234",
  },now);
  expect((await call("/api/customer/upgrades/"+order.id+"/receipt-request",11,{})).status).toBe(404);
  expect((await call("/api/customer/admin/upgrades/"+order.id+"/approve",10,{})).status).toBe(403);
  expect(await env.SALES_DB.prepare("SELECT state FROM customer_upgrades WHERE id=?").bind(order.id).first("state")).toBe("awaiting_receipt");
});

test("a second outstanding upgrade cannot collect payment for the same customer",async()=>{
  const s=await readyPurchasedService();
  const first=await createCustomerUpgrade(env.SALES_DB,{telegramId:"10",role:"ordinary"},{
    orderId:s.orderId,planId:"monthly",kind:"renew",requestKey:"first-upgrade_1234",
  },now);
  await expect(createCustomerUpgrade(env.SALES_DB,{telegramId:"10",role:"ordinary"},{
    orderId:s.orderId,planId:"monthly",kind:"traffic",requestKey:"second-upgrade_1234",
  },now)).rejects.toThrow("PENDING_UPGRADE_EXISTS");
  const replay=await createCustomerUpgrade(env.SALES_DB,{telegramId:"10",role:"ordinary"},{
    orderId:s.orderId,planId:"monthly",kind:"renew",requestKey:"first-upgrade_1234",
  },now);
  expect(replay.id).toBe(first.id);
});

test("post-ACK server policy notifies the buyer only after the new quota is active",async()=>{
  const s=await readyPurchasedService();
  const order=await createCustomerUpgrade(env.SALES_DB,{telegramId:"10",role:"ordinary"},{
    orderId:s.orderId,planId:"monthly",kind:"traffic",requestKey:"acked-upgrade_1234",
  },now);
  await payUpgrade(order.id);
  await approveUpgrade(E,{telegramId:"1",role:"admin"},order.id,now);
  await notifyReadyUpgrades(E,now);
  expect(await env.SALES_DB.prepare("SELECT COUNT(*) n FROM outbox WHERE id=?").bind("customer-upgrade-ready:"+order.id).first("n")).toBe(0);
  const policy=JSON.stringify({version:2,nodeId:"n",revision:3,expiresAt:now+300,
    clients:[{accountId:s.accountId,uuid:s.uuid,quotaEpoch:1,quotaBytes:40e9,usedBytes:0,validUntil:now+86400*15,
      generation:s.accountId+":1",listenPort:20000}]});
  await env.SALES_DB.prepare("UPDATE managed_accounts SET state='active',activation_revision=3 WHERE id=?").bind(s.accountId).run();
  await env.SALES_DB.prepare("UPDATE nodes SET policy_payload=?,revision=3,acked_revision=3 WHERE id='n'").bind(policy).run();
  await notifyReadyUpgrades(E,now);
  await notifyReadyUpgrades(E,now);
  const msg=await env.SALES_DB.prepare("SELECT chat_id,payload FROM outbox WHERE id=?").bind("customer-upgrade-ready:"+order.id).first<any>();
  expect(msg.chat_id).toBe("10");
  expect(msg.payload).toContain("همان کانفیگ");
  expect(await env.SALES_DB.prepare("SELECT COUNT(*) n FROM outbox WHERE id=?").bind("customer-upgrade-ready:"+order.id).first("n")).toBe(1);
});

test("renew expired with quota remaining, but require renewal before topup after expiry",async()=>{
  const s=await readyPurchasedService();
  await env.SALES_DB.prepare("UPDATE managed_accounts SET state='expired',valid_until=? WHERE id=?").bind(now-10,s.accountId).run();
  const t=await call("/api/customer/upgrades",10,{orderId:s.orderId,planId:"monthly",kind:"traffic",requestKey:"expired-traffic-12"});
  expect(t.status).toBe(409);
  const renew=await call("/api/customer/upgrades",10,{orderId:s.orderId,planId:"monthly",kind:"renew",requestKey:"expired-renew-123"});
  expect(renew.status).toBe(201);
});

test("new Telegram menu displays renewal and extra data without changing original purchase price",async()=>{
  const s=await readyPurchasedService();
  expect(await handleCustomerTelegramUpdate(E,{update_id:251,callback_query:{id:"menu",from:{id:10},message:{message_id:2,chat:{id:10,type:"private"},text:"test"},data:"customer:up:menu:"+s.orderId}} as any,now)).toBe(true);
  const p=JSON.parse((await env.SALES_DB.prepare("SELECT payload FROM outbox WHERE id='u251:reply'").first<string>("payload"))||"{}");
  expect(p.text).toContain("مدیریت اشتراک");
  expect(p.reply_markup.inline_keyboard.flat().some((x:any)=>x.callback_data?.startsWith("customer:up:offer:r:"))).toBe(true);
  expect(p.reply_markup.inline_keyboard.flat().some((x:any)=>x.callback_data?.startsWith("customer:up:offer:t:"))).toBe(true);
  expect((await env.SALES_DB.prepare("SELECT price FROM customer_orders WHERE id=?").bind(s.orderId).first("price"))).toBe(250000);
});
