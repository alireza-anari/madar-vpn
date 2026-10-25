import { createAccount } from "./accounts";
import { buildAccountDeliveryArtifact } from "./account-delivery";
import { nodeCapacities, canAllocate, remainingSlots } from "./node-capacity";
import { enqueue } from "./telegram";
import { requireSalesAdmin, type SalesActor } from "./resellers";

type OrderRow = {
  id: string; user_id: string; plan_id: string; node_id: string;
  price: number; currency: string; quota_bytes: number; duration_seconds: number;
  state: string; account_id: string | null; reason: string | null; created_at: number;
};
export const paymentInstructions = async (db: D1Database) =>
  (await db.prepare("SELECT value FROM settings WHERE key='payment'").first<string>("value"))?.trim() || null;

export async function customerPlans(db: D1Database) {
  const rows = await db.prepare("SELECT id,name,price,currency,duration,quota_bytes FROM plans WHERE enabled=1 AND quota_bytes BETWEEN 1 AND 1000000000000 ORDER BY price,id LIMIT 100")
    .all<{ id:string;name:string;price:number;currency:string;duration:number;quota_bytes:number }>();
  return rows.results.map(p => ({ id:p.id,name:p.name,price:p.price,currency:p.currency,durationSeconds:p.duration,quotaBytes:p.quota_bytes }));
}
export async function availableCustomerNodes(db: D1Database, now: number, quotaBytes: number) {
  if (!Number.isSafeInteger(quotaBytes) || quotaBytes<1 || quotaBytes>1e12) throw Error("INVALID_INPUT");
  return (await nodeCapacities(db, now)).filter(n =>
    n.healthy===1 && n.last_seen>now-90 && n.agent_capabilities.split(",").includes("quota-v2") &&
    (remainingSlots(n)===null || remainingSlots(n)!>0) && canAllocate(n,quotaBytes))
    .map(n=>({id:n.id,name:n.name}));
}
export async function createCustomerOrder(db:D1Database,actor:SalesActor,input:{planId:string;nodeId:string;requestKey:string},now:number) {
  if (!input || typeof input.requestKey!=="string" || !/^[a-zA-Z0-9_-]{8,80}$/.test(input.requestKey) ||
    typeof input.planId!=="string" || !/^[a-zA-Z0-9_-]{1,40}$/.test(input.planId) ||
    typeof input.nodeId!=="string" || !input.nodeId || input.nodeId.length>120) throw Error("INVALID_INPUT");
  const prior=await db.prepare("SELECT * FROM customer_orders WHERE user_id=? AND request_key=?")
    .bind(actor.telegramId,input.requestKey).first<OrderRow>();
  if (prior) {
    if (prior.plan_id!==input.planId || prior.node_id!==input.nodeId) throw Error("KEY_REUSED");
    return prior;
  }
  if (!(await paymentInstructions(db))) throw Error("SALES_DISABLED");
  const plan=await db.prepare("SELECT quota_bytes FROM plans WHERE id=? AND enabled=1 AND quota_bytes BETWEEN 1 AND 1000000000000")
    .bind(input.planId).first<{quota_bytes:number}>();
  if (!plan) throw Error("PLAN_UNAVAILABLE");
  const nodes=await availableCustomerNodes(db,now,plan.quota_bytes);
  if (!nodes.some(n=>n.id===input.nodeId)) throw Error("NODE_UNAVAILABLE");
  const id=crypto.randomUUID();
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO users(id) VALUES(?)").bind(actor.telegramId),
    db.prepare("INSERT OR IGNORE INTO customer_orders(id,user_id,plan_id,node_id,price,currency,quota_bytes,duration_seconds,request_key,created_at) SELECT ?,?,id,?,price,currency,quota_bytes,duration,?,? FROM plans WHERE id=? AND enabled=1 AND quota_bytes BETWEEN 1 AND 1000000000000 AND EXISTS(SELECT 1 FROM settings WHERE key='payment' AND length(trim(value))>0) AND NOT EXISTS(SELECT 1 FROM customer_orders WHERE user_id=? AND state='awaiting_receipt')")
      .bind(id,actor.telegramId,input.nodeId,input.requestKey,now,input.planId,actor.telegramId),
  ]);
  const result=await db.prepare("SELECT * FROM customer_orders WHERE user_id=? AND request_key=?")
    .bind(actor.telegramId,input.requestKey).first<OrderRow>();
  if (!result) {
    const pending=await db.prepare("SELECT id FROM customer_orders WHERE user_id=? AND state='awaiting_receipt' ORDER BY created_at DESC LIMIT 1")
      .bind(actor.telegramId).first<{id:string}>();
    if (pending) throw Error("PENDING_ORDER_EXISTS");
    throw Error("SALES_DISABLED");
  }
  if (result.plan_id!==input.planId || result.node_id!==input.nodeId) throw Error("KEY_REUSED");
  return result;
}
export async function listCustomerOrders(db:D1Database,actor:SalesActor) {
  const rows=await db.prepare("SELECT o.*,a.state account_state,a.used_bytes,a.valid_until,p.name AS plan_name,n.name AS server_name FROM customer_orders o LEFT JOIN managed_accounts a ON a.id=o.account_id LEFT JOIN plans p ON p.id=o.plan_id LEFT JOIN nodes n ON n.id=a.node_id WHERE o.user_id=? ORDER BY o.created_at DESC,o.id DESC LIMIT 40")
    .bind(actor.telegramId).all<OrderRow & {account_state:string|null;used_bytes:number|null;valid_until:number|null;plan_name:string|null;server_name:string|null}>();
  return rows.results.map(r=>({id:r.id,planId:r.plan_id,planName:r.plan_name||r.plan_id,serverName:r.server_name,
    state:r.state,price:r.price,currency:r.currency,quotaBytes:r.quota_bytes,durationSeconds:r.duration_seconds,
    createdAt:r.created_at,reason:r.reason,accountId:r.account_id,accountState:r.account_state,
    usedBytes:r.used_bytes,validUntil:r.valid_until}));
}
export async function requestCustomerReceipt(db:D1Database,actor:SalesActor,id:string) {
  if (!(await db.prepare("SELECT id FROM customer_orders WHERE id=? AND user_id=? AND state='awaiting_receipt'")
    .bind(id,actor.telegramId).first())) throw Error("ORDER_NOT_AVAILABLE");
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO users(id) VALUES(?)").bind(actor.telegramId),
    db.prepare("UPDATE users SET conversation=? WHERE id=?").bind("customer-receipt:"+id,actor.telegramId),
  ]);
}
export async function submitCustomerReceipt(db:D1Database,userId:string,id:string,fileId:string,kind:"photo"|"document") {
  if (!fileId || fileId.length>1000 || !["photo","document"].includes(kind)) throw Error("INVALID_RECEIPT");
  const row=await db.prepare("SELECT state FROM customer_orders WHERE id=? AND user_id=?")
    .bind(id,userId).first<{state:string}>();
  if (!row || !["awaiting_receipt","pending_review"].includes(row.state)) throw Error("ORDER_NOT_AVAILABLE");
  if (row.state==="pending_review") return false;
  const results=await db.batch([
    db.prepare("INSERT OR IGNORE INTO customer_receipts(order_id,file_id,kind) SELECT id,?,? FROM customer_orders WHERE id=? AND user_id=? AND state='awaiting_receipt'").bind(fileId,kind,id,userId),
    db.prepare("UPDATE customer_orders SET state='pending_review' WHERE id=? AND user_id=? AND state='awaiting_receipt' AND EXISTS(SELECT 1 FROM customer_receipts WHERE order_id=?)").bind(id,userId,id),
  ]);
  if (!results[1]?.meta.changes) throw Error("ORDER_NOT_AVAILABLE");
  return true;
}
export async function getCustomerOrderForAdmin(db:D1Database,actor:SalesActor,id:string) {
  requireSalesAdmin(actor);
  return db.prepare("SELECT o.*,r.file_id,r.kind FROM customer_orders o LEFT JOIN customer_receipts r ON r.order_id=o.id WHERE o.id=?")
    .bind(id).first<OrderRow & {file_id:string|null;kind:"photo"|"document"|null}>();
}
export async function approveCustomerOrder(env:Env,actor:SalesActor,id:string,now:number) {
  requireSalesAdmin(actor);
  const db=env.SALES_DB;
  const claim=await db.prepare("UPDATE customer_orders SET state='approving' WHERE id=? AND state='pending_review' AND EXISTS(SELECT 1 FROM customer_receipts WHERE order_id=?)").bind(id,id).run();
  const order=await db.prepare("SELECT * FROM customer_orders WHERE id=?").bind(id).first<OrderRow>();
  if (!order || !["approving","approved"].includes(order.state)) throw Error("ORDER_NOT_AVAILABLE");
  if (order.state==="approved") return {accountId:order.account_id,state:"approved"};
  let account:{id:string;state:string};
  try {
    account=await createAccount(db,actor,{
      kind:"sale",label:"مشتری "+order.user_id,quotaBytes:order.quota_bytes,
      durationSeconds:order.duration_seconds,nodeId:order.node_id,requestKey:"customer-order:"+order.id,
    },now);
  } catch(error) {
    if (claim.meta.changes)
      await db.prepare("UPDATE customer_orders SET state='pending_review' WHERE id=? AND state='approving' AND account_id IS NULL").bind(id).run();
    throw error;
  }
  await db.batch([
    db.prepare("UPDATE customer_orders SET state='approved',account_id=?,decided_at=?,decided_by=? WHERE id=? AND state='approving'")
      .bind(account.id,now,actor.telegramId,id),
    db.prepare("INSERT OR IGNORE INTO outbox(id,chat_id,payload) SELECT ?,user_id,? FROM customer_orders WHERE id=? AND state='approved' AND account_id=?")
      .bind("customer-approved:"+id,JSON.stringify({text:"✅ پرداخت تأیید شد. کانفیگ پس از تأیید نهایی سرور در همین چت ربات آماده دریافت است.",reply_markup:{inline_keyboard:[[{text:"📦 سفارش‌های من",callback_data:"customer:orders:0"}]]}}),id,account.id),
  ]);
  return {accountId:account.id,state:"approved"};
}
export async function rejectCustomerOrder(db:D1Database,actor:SalesActor,id:string,reason:string,now:number) {
  requireSalesAdmin(actor);
  if (!reason.trim() || reason.length>300) throw Error("INVALID_REASON");
  const r=await db.prepare("UPDATE customer_orders SET state='rejected',reason=?,decided_at=?,decided_by=? WHERE id=? AND state IN ('pending_review','awaiting_receipt')")
    .bind(reason.trim(),now,actor.telegramId,id).run();
  if (!r.meta.changes) throw Error("ORDER_NOT_AVAILABLE");
  const order=await db.prepare("SELECT user_id FROM customer_orders WHERE id=?").bind(id).first<{user_id:string}>();
  if (order) await enqueue(db,"customer-rejected:"+id,order.user_id,{text:"❌ سفارش رد شد: "+reason.trim()+"\nدر صورت پرداخت با پشتیبانی برای استرداد وجه تماس بگیرید."});
}
export async function customerConfig(env:Env,actor:SalesActor,id:string,now:number) {
  const order=await env.SALES_DB.prepare("SELECT account_id FROM customer_orders WHERE id=? AND user_id=? AND state='approved'")
    .bind(id,actor.telegramId).first<{account_id:string|null}>();
  if (!order) throw Error("ORDER_NOT_AVAILABLE");
  if (!order.account_id) return {ready:false};
  const artifact=await buildAccountDeliveryArtifact(env,order.account_id,now);
  if (!artifact) return {ready:false};
  // Never expose the administrator's Telegram ID or other seller metadata to buyers.
  return {
    ready:true, config:artifact.config, usageUrl:artifact.usageUrl,
    serverName:artifact.serverName, quotaBytes:artifact.quotaBytes,
    durationSeconds:artifact.durationSeconds, validUntil:artifact.validUntil,
  };
}
export async function saveCustomerPlan(db:D1Database,actor:SalesActor,input:{
  id:string;name:string;price:number;currency:string;durationDays:number;quotaGb:number;enabled:boolean
},now:number) {
  requireSalesAdmin(actor);
  if (!input || !/^[a-zA-Z0-9_-]{1,40}$/.test(input.id) ||
    typeof input.name!=="string" || !input.name.trim() || input.name.length>80 ||
    !Number.isSafeInteger(input.price) || input.price<1 || input.price>1e12 ||
    !["IRT","IRR"].includes(input.currency) ||
    !Number.isSafeInteger(input.durationDays) || input.durationDays<1 || input.durationDays>365 ||
    !Number.isSafeInteger(input.quotaGb) || input.quotaGb<1 || input.quotaGb>1000 ||
    typeof input.enabled!=="boolean") throw Error("INVALID_PLAN");
  await db.batch([
    db.prepare("INSERT INTO plans(id,name,price,currency,duration,enabled,quota_bytes) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,price=excluded.price,currency=excluded.currency,duration=excluded.duration,enabled=excluded.enabled,quota_bytes=excluded.quota_bytes")
      .bind(input.id,input.name.trim(),input.price,input.currency,input.durationDays*86400,input.enabled?1:0,input.quotaGb*1e9),
    db.prepare("INSERT INTO audit_events(actor_id,action,target_id,created_at) VALUES(?,'customer_plan',?,?)")
      .bind(actor.telegramId,input.id,now),
  ]);
}
