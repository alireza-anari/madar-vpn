import { nodeCapacities, canAllocate, remainingSlots } from "./node-capacity";
import { customerPlans, paymentInstructions } from "./customer-store";
import { enqueue } from "./telegram";
import { requireSalesAdmin, type SalesActor } from "./resellers";
import type { QuotaPolicy } from "./quota-policies";

export type UpgradeKind = "renew" | "traffic";
export type CustomerUpgrade = {
  id: string; user_id: string; base_order_id: string; account_id: string;
  plan_id: string; kind: UpgradeKind; price: number; currency: string;
  delta_bytes: number; delta_seconds: number; request_key: string; state: string;
  reason: string | null; created_at: number; applied_at: number | null; notified_at: number | null;
};

const uuid = /^[a-f0-9-]{36}$/;
const keyPattern = /^[a-zA-Z0-9_-]{8,80}$/;
function integerNow(now: number) {
  if (!Number.isSafeInteger(now) || now < 1) throw Error("INVALID_TIME");
  return now;
}
export async function ownedCustomerService(db: D1Database, actor: SalesActor, orderId: string) {
  if (!uuid.test(orderId)) throw Error("ORDER_NOT_AVAILABLE");
  const row = await db.prepare(
    "SELECT o.id AS order_id,o.account_id,a.node_id,a.state,a.quota_bytes,a.used_bytes,a.valid_until,a.duration_seconds,a.seller_id,a.started_at,a.archived_at " +
    "FROM customer_orders o JOIN managed_accounts a ON a.id=o.account_id " +
    "WHERE o.id=? AND o.user_id=? AND o.state='approved' AND a.kind='sale'"
  ).bind(orderId, actor.telegramId).first<{
    order_id:string;account_id:string;node_id:string;state:string;quota_bytes:number|null;
    used_bytes:number;valid_until:number;duration_seconds:number;seller_id:string;
    started_at:number|null;archived_at:number|null;
  }>();
  if (!row) throw Error("ORDER_NOT_AVAILABLE");
  return row;
}
export async function listCustomerUpgrades(db:D1Database,actor:SalesActor) {
  const rows=await db.prepare(
    "SELECT id,base_order_id,account_id,kind,plan_id,price,currency,delta_bytes,delta_seconds,state,reason,created_at,applied_at,notified_at " +
    "FROM customer_upgrades WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT 50"
  ).bind(actor.telegramId).all<CustomerUpgrade>();
  return rows.results;
}
export async function createCustomerUpgrade(db:D1Database,actor:SalesActor,input:{
  orderId:string;planId:string;kind:UpgradeKind;requestKey:string;
},now:number) {
  integerNow(now);
  if (actor.role!=="ordinary" || !input || !uuid.test(input.orderId) ||
      !/^[a-zA-Z0-9_-]{1,40}$/.test(input.planId) ||
      !["renew","traffic"].includes(input.kind) || !keyPattern.test(input.requestKey))
    throw Error("INVALID_INPUT");
  const prior=await db.prepare("SELECT * FROM customer_upgrades WHERE user_id=? AND request_key=?")
    .bind(actor.telegramId,input.requestKey).first<CustomerUpgrade>();
  if(prior) {
    if(prior.base_order_id!==input.orderId || prior.plan_id!==input.planId || prior.kind!==input.kind)
      throw Error("KEY_REUSED");
    return prior;
  }
  if(!(await paymentInstructions(db))) throw Error("SALES_DISABLED");
  const service=await ownedCustomerService(db,actor,input.orderId);
  if (service.archived_at!==null || service.started_at===null ||
      !["active","exhausted","expired"].includes(service.state) ||
      service.quota_bytes===null || service.quota_bytes<=0) throw Error("SERVICE_UNAVAILABLE");
  if(input.kind==="traffic" && service.valid_until<=now) throw Error("RENEW_FIRST");
  if(input.kind==="renew" && service.quota_bytes<=service.used_bytes) throw Error("TRAFFIC_FIRST");
  const plan=(await customerPlans(db)).find(p=>p.id===input.planId);
  if(!plan) throw Error("PLAN_UNAVAILABLE");
  const bytes=input.kind==="traffic"?plan.quotaBytes:0;
  const seconds=input.kind==="renew"?plan.durationSeconds:0;
  if(service.quota_bytes+bytes>1e12 || service.duration_seconds+seconds>10*31536000)
    throw Error("UPGRADE_LIMIT");
  const capacities=await nodeCapacities(db,now,service.node_id);
  const n=capacities[0];
  if(!n || n.healthy!==1 || n.last_seen<=now-90 ||
      !n.agent_capabilities.split(",").includes("quota-v2")) throw Error("NODE_UNAVAILABLE");
  // Advisory only: the SQL UPDATE during admin approval is the atomic authority.
  if(service.state==="active" && bytes>0 && !canAllocate(n,bytes)) throw Error("NODE_ALLOCATION_FULL");
  if(service.state!=="active" && (remainingSlots(n)!==null && remainingSlots(n)!<=0))
    throw Error("NODE_FULL");
  const id=crypto.randomUUID();
  try {
    await db.prepare(
      "INSERT INTO customer_upgrades(id,user_id,base_order_id,account_id,plan_id,kind,price,currency,delta_bytes,delta_seconds,request_key,created_at) " +
      "SELECT ?,?,o.id,a.id,p.id,?,p.price,p.currency,?,?,?,? FROM customer_orders o " +
      "JOIN managed_accounts a ON a.id=o.account_id JOIN plans p ON p.id=? " +
      "WHERE o.id=? AND o.user_id=? AND o.state='approved' AND p.enabled=1 " +
      "AND p.quota_bytes BETWEEN 1 AND 1000000000000 AND p.price>0 AND a.kind='sale' AND a.archived_at IS NULL"
    ).bind(id,actor.telegramId,input.kind,bytes,seconds,input.requestKey,now,input.planId,input.orderId,actor.telegramId).run();
  } catch(error) {
    if(error instanceof Error && /UNIQUE constraint|unique constraint/i.test(error.message))
      throw Error("PENDING_UPGRADE_EXISTS");
    throw error;
  }
  const result=await db.prepare("SELECT * FROM customer_upgrades WHERE user_id=? AND request_key=?")
    .bind(actor.telegramId,input.requestKey).first<CustomerUpgrade>();
  if(!result) throw Error("SERVICE_UNAVAILABLE");
  return result;
}
export async function requestUpgradeReceipt(db:D1Database,actor:SalesActor,id:string) {
  if(!uuid.test(id)) throw Error("ORDER_NOT_AVAILABLE");
  const row=await db.prepare("SELECT id FROM customer_upgrades WHERE id=? AND user_id=? AND state='awaiting_receipt'")
    .bind(id,actor.telegramId).first();
  if(!row) throw Error("ORDER_NOT_AVAILABLE");
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO users(id) VALUES(?)").bind(actor.telegramId),
    db.prepare("UPDATE users SET conversation=? WHERE id=?").bind("customer-upgrade-receipt:"+id,actor.telegramId),
  ]);
}
export async function submitUpgradeReceipt(db:D1Database,actor:SalesActor,id:string,fileId:string,kind:"photo"|"document") {
  if(!uuid.test(id) || typeof fileId!=="string" || !fileId || fileId.length>1000 ||
    !["photo","document"].includes(kind)) throw Error("INVALID_RECEIPT");
  const row=await db.prepare("SELECT state FROM customer_upgrades WHERE id=? AND user_id=?")
    .bind(id,actor.telegramId).first<{state:string}>();
  if(!row || !["awaiting_receipt","pending_review"].includes(row.state)) throw Error("ORDER_NOT_AVAILABLE");
  if(row.state==="pending_review") return false;
  const r=await db.batch([
    db.prepare("INSERT OR IGNORE INTO customer_upgrade_receipts(upgrade_id,file_id,kind) SELECT id,?,? FROM customer_upgrades WHERE id=? AND user_id=? AND state='awaiting_receipt'")
      .bind(fileId,kind,id,actor.telegramId),
    db.prepare("UPDATE customer_upgrades SET state='pending_review' WHERE id=? AND user_id=? AND state='awaiting_receipt' AND EXISTS(SELECT 1 FROM customer_upgrade_receipts WHERE upgrade_id=?)")
      .bind(id,actor.telegramId,id),
  ]);
  if(!r[1]?.meta.changes) throw Error("ORDER_NOT_AVAILABLE");
  return true;
}
export async function cancelUpgrade(db:D1Database,actor:SalesActor,id:string,now:number) {
  const r=await db.prepare(
    "UPDATE customer_upgrades SET state='rejected',reason='لغو توسط مشتری',decided_at=?,decided_by=? " +
    "WHERE id=? AND user_id=? AND state='awaiting_receipt' AND NOT EXISTS (SELECT 1 FROM customer_upgrade_receipts WHERE upgrade_id=?)"
  ).bind(now,actor.telegramId,id,actor.telegramId,id).run();
  if(!r.meta.changes) throw Error("ORDER_NOT_AVAILABLE");
  await db.batch([
    db.prepare("UPDATE users SET conversation='' WHERE id=? AND conversation=?")
      .bind(actor.telegramId,"customer-upgrade-receipt:"+id),
    db.prepare("INSERT INTO audit_events(actor_id,action,target_id,created_at) VALUES(?,'customer_upgrade_cancel',?,?)")
      .bind(actor.telegramId,id,now),
  ]);
}
export async function adminUpgrade(db:D1Database,actor:SalesActor,id:string) {
  requireSalesAdmin(actor);
  return db.prepare(
    "SELECT u.*,r.file_id,r.kind AS receipt_kind FROM customer_upgrades u LEFT JOIN customer_upgrade_receipts r ON r.upgrade_id=u.id WHERE u.id=?"
  ).bind(id).first<CustomerUpgrade & {file_id:string|null;receipt_kind:"photo"|"document"|null}>();
}

function capacityGuardedUpdate(now:number) {
  const time=integerNow(now);
  const live=`(x.state IN ('preparing','active','blocked') AND (x.valid_until=0 OR x.valid_until>${time}) AND (x.quota_bytes IS NULL OR x.used_bytes<x.quota_bytes))`;
  const id="(SELECT account_id FROM u)";
  const newQuota="(a.quota_bytes+(SELECT delta_bytes FROM u))";
  return `WITH
    u AS (SELECT * FROM customer_upgrades WHERE id=? AND state='approving' AND applied_at IS NULL),
    target AS (SELECT * FROM managed_accounts WHERE id=${id}),
    node_usage AS (
      SELECT
        COALESCE(SUM(CASE WHEN ${live} THEN 1 ELSE 0 END),0) slots,
        COALESCE(SUM(CASE WHEN ${live} AND x.quota_bytes IS NOT NULL THEN x.quota_bytes ELSE 0 END),0) committed,
        COALESCE(SUM(CASE WHEN ${live} AND x.quota_bytes IS NULL THEN 1 ELSE 0 END),0) uncapped,
        COALESCE(SUM(CASE WHEN NOT ${live} AND x.state='exhausted' AND x.quota_bytes IS NOT NULL
          THEN MIN(x.used_bytes,x.quota_bytes) WHEN NOT ${live} THEN x.used_bytes ELSE 0 END),0) finalized
      FROM managed_accounts x WHERE x.node_id=(SELECT node_id FROM target) AND x.id<>${id}
    ),
    seller_usage AS (
      SELECT
        COALESCE(SUM(CASE WHEN ${live} THEN 1 ELSE 0 END),0) slots,
        COALESCE(SUM(CASE WHEN ${live} AND x.quota_bytes IS NOT NULL THEN x.quota_bytes ELSE 0 END),0) committed,
        COALESCE(SUM(CASE WHEN ${live} AND x.quota_bytes IS NULL THEN 1 ELSE 0 END),0) uncapped
      FROM managed_accounts x WHERE x.seller_id=(SELECT seller_id FROM target) AND x.id<>${id}
    )
    UPDATE managed_accounts AS a SET
      quota_bytes=${newQuota},
      duration_seconds=a.duration_seconds+(SELECT delta_seconds FROM u),
      valid_until=CASE WHEN (SELECT kind FROM u)='renew'
        THEN MAX(a.valid_until,${time})+(SELECT delta_seconds FROM u) ELSE a.valid_until END,
      state='preparing',
      activation_revision=NULL,
      last_customer_upgrade_id=(SELECT id FROM u)
    WHERE a.id=${id}
      AND a.archived_at IS NULL AND a.kind='sale' AND a.started_at IS NOT NULL
      AND a.quota_bytes IS NOT NULL AND a.quota_bytes>0 AND a.used_bytes>=0
      AND a.state IN ('active','expired','exhausted')
      AND (a.last_customer_upgrade_id IS NULL OR a.last_customer_upgrade_id<>(SELECT id FROM u))
      AND ${newQuota} BETWEEN 1 AND 1000000000000
      AND a.duration_seconds+(SELECT delta_seconds FROM u) <= 315360000
      AND ((SELECT kind FROM u)='renew' AND a.quota_bytes>a.used_bytes
        OR (SELECT kind FROM u)='traffic' AND a.valid_until>${time}
          AND ${newQuota}>a.used_bytes)
      AND EXISTS(SELECT 1 FROM nodes n CROSS JOIN node_usage nu CROSS JOIN seller_usage su
        LEFT JOIN reseller_controls sc ON sc.seller_id=a.seller_id
        WHERE n.id=a.node_id AND n.healthy=1 AND n.last_seen>${time}-90
          AND instr(','||n.agent_capabilities||',',',quota-v2,')>0
          AND (n.max_accounts_unlimited=1 OR nu.slots+1<=n.max_accounts)
          AND (n.max_allocated_bytes IS NULL OR
            (nu.uncapped=0 AND nu.committed+nu.finalized+${newQuota}<=n.max_allocated_bytes))
          AND (sc.max_reserved_accounts IS NULL OR su.slots+1<=sc.max_reserved_accounts)
          AND (sc.max_committed_bytes IS NULL OR
            (su.uncapped=0 AND su.committed+${newQuota}<=sc.max_committed_bytes))
      )`;
}
export async function approveUpgrade(env:Env,actor:SalesActor,id:string,now:number) {
  requireSalesAdmin(actor);
  if(!uuid.test(id)) throw Error("ORDER_NOT_AVAILABLE");
  const db=env.SALES_DB;
  const claim=await db.prepare(
    "UPDATE customer_upgrades SET state='approving' WHERE id=? AND state='pending_review' AND EXISTS(SELECT 1 FROM customer_upgrade_receipts WHERE upgrade_id=?)"
  ).bind(id,id).run();
  const upgrade=await adminUpgrade(db,actor,id);
  if(!upgrade || !["approving","applied"].includes(upgrade.state)) throw Error("ORDER_NOT_AVAILABLE");
  if(upgrade.state==="applied") return {id:upgrade.id,state:"applied",accountId:upgrade.account_id};
  const results=await db.batch([
    db.prepare(capacityGuardedUpdate(now)).bind(id),
    db.prepare(
      "UPDATE customer_upgrades SET state='applied',applied_at=?,decided_at=?,decided_by=? " +
      "WHERE id=? AND state='approving' AND applied_at IS NULL AND " +
      "EXISTS(SELECT 1 FROM managed_accounts WHERE id=customer_upgrades.account_id AND last_customer_upgrade_id=customer_upgrades.id)"
    ).bind(now,now,actor.telegramId,id),
    db.prepare(
      "INSERT INTO audit_events(actor_id,action,target_id,created_at) " +
      "SELECT ?,'customer_upgrade_applied',id,? FROM customer_upgrades WHERE id=? AND state='applied' " +
      "AND NOT EXISTS(SELECT 1 FROM audit_events WHERE action='customer_upgrade_applied' AND target_id=?)"
    ).bind(actor.telegramId,now,id,id),
  ]);
  if(!results[1]?.meta.changes) {
    if(claim.meta.changes) await db.prepare("UPDATE customer_upgrades SET state='pending_review' WHERE id=? AND state='approving' AND applied_at IS NULL").bind(id).run();
    throw Error("UPGRADE_CAPACITY_CHANGED");
  }
  await enqueue(db,"customer-upgrade-queued:"+id,upgrade.user_id,{
    text:"✅ پرداخت "+(upgrade.kind==="renew"?"تمدید":"خرید حجم اضافه")+" تأیید شد. تغییر روی همان کانفیگ ثبت شده و منتظر تأیید نهایی سرور است.",
    reply_markup:{inline_keyboard:[[{text:"🌐 سرویس‌های من",callback_data:"customer:services"}]]},
  });
  return {id,state:"applied",accountId:upgrade.account_id};
}
export async function rejectUpgrade(db:D1Database,actor:SalesActor,id:string,reason:string,now:number) {
  requireSalesAdmin(actor);
  if(!uuid.test(id) || !reason?.trim() || reason.length>300) throw Error("INVALID_REASON");
  const r=await db.prepare(
    "UPDATE customer_upgrades SET state='rejected',reason=?,decided_at=?,decided_by=? WHERE id=? AND state IN ('awaiting_receipt','pending_review')"
  ).bind(reason.trim(),now,actor.telegramId,id).run();
  if(!r.meta.changes) throw Error("ORDER_NOT_AVAILABLE");
  const u=await db.prepare("SELECT user_id FROM customer_upgrades WHERE id=?").bind(id).first<{user_id:string}>();
  if(u) await enqueue(db,"customer-upgrade-rejected:"+id,u.user_id,{text:"❌ درخواست تمدید/حجم رد شد: "+reason.trim()+"\nاگر پرداخت کرده‌اید، برای استرداد وجه با پشتیبانی تماس بگیرید."});
}
export async function notifyReadyUpgrades(env:Env,now:number) {
  const db=env.SALES_DB;
  const rows=await db.prepare(
    "SELECT u.id,u.user_id,u.kind,u.account_id,a.node_id,a.quota_bytes,a.valid_until,a.uuid,n.policy_payload,n.acked_revision,n.revision,n.healthy,n.last_seen " +
    "FROM customer_upgrades u JOIN managed_accounts a ON a.id=u.account_id JOIN nodes n ON n.id=a.node_id " +
    "WHERE u.state='applied' AND u.notified_at IS NULL AND a.state='active' AND a.valid_until>? " +
    "AND n.healthy=1 AND n.last_seen>? AND n.acked_revision=n.revision LIMIT 30"
  ).bind(now,now-90).all<{
    id:string;user_id:string;kind:UpgradeKind;account_id:string;node_id:string;
    quota_bytes:number;valid_until:number;uuid:string;policy_payload:string|null;
    acked_revision:number;revision:number;healthy:number;last_seen:number;
  }>();
  for(const u of rows.results) {
    if(!u.policy_payload) continue;
    let policy:QuotaPolicy;
    try { policy=JSON.parse(u.policy_payload) as QuotaPolicy; } catch { continue; }
    if(policy.version!==2 || policy.expiresAt<=now ||
      !policy.clients.some(c=>c.accountId===u.account_id && c.uuid===u.uuid &&
        c.quotaBytes===u.quota_bytes && c.validUntil===u.valid_until)) continue;
    await db.batch([
      db.prepare("UPDATE customer_upgrades SET notified_at=? WHERE id=? AND state='applied' AND notified_at IS NULL")
        .bind(now,u.id),
      db.prepare(
        "INSERT OR IGNORE INTO outbox(id,chat_id,payload,available_at) SELECT ?,user_id,?,0 FROM customer_upgrades " +
        "WHERE id=? AND state='applied' AND notified_at=?"
      ).bind("customer-upgrade-ready:"+u.id,JSON.stringify({
        text:"🟢 "+(u.kind==="renew"?"تمدید اشتراک":"حجم اضافه")+" روی همان کانفیگ تأیید و فعال شد. از «سرویس‌های من» وضعیت و اعتبار جدید را ببینید.",
        reply_markup:{inline_keyboard:[[{text:"🌐 سرویس‌های من",callback_data:"customer:services"}]]},
      }),u.id,now),
    ]);
  }
}
