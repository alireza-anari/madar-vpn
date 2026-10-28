import { requireSalesAdmin, type SalesActor } from "./resellers";

export type NodeMode="active"|"paused"|"archived";
export type NodeOperationCounts={
  accounts:number;blocking_accounts:number;orders:number;pending_orders:number;pending_jobs:number;
};
export async function nodeMode(db:D1Database,id:string):Promise<NodeMode|null>{
  const exists=await db.prepare("SELECT id FROM nodes WHERE id=?").bind(id).first("id");
  if(!exists)return null;
  const value=await db.prepare("SELECT value FROM settings WHERE key=?").bind("node_status:"+id).first<string>("value");
  return value==="archived"?"archived":value==="paused"?"paused":"active";
}
export async function nodeDependencies(db:D1Database,id:string):Promise<NodeOperationCounts>{
  // Older test fixtures may predate customer checkout. Production has this table.
  const customerTable=await db.prepare(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='customer_orders'",
  ).first<number>("n");
  const base=await db.prepare(
    "SELECT "+
    "(SELECT COUNT(*) FROM managed_accounts WHERE node_id=?) AS accounts,"+
    "(SELECT COUNT(*) FROM managed_accounts WHERE node_id=? AND state IN ('preparing','active','blocked')) AS blocking_accounts,"+
    "(SELECT COUNT(*) FROM installation_jobs WHERE node_id=? AND state NOT IN ('ready','failed')) AS pending_jobs",
  ).bind(id,id,id).first<{accounts:number;blocking_accounts:number;pending_jobs:number}>();
  if(!customerTable)return {...base!,orders:0,pending_orders:0};
  const order=await db.prepare(
    "SELECT COUNT(*) AS orders,COALESCE(SUM(CASE WHEN state IN ('awaiting_receipt','pending_review','approving') THEN 1 ELSE 0 END),0) AS pending_orders FROM customer_orders WHERE node_id=?",
  ).bind(id).first<{orders:number;pending_orders:number}>();
  return {...base!,orders:order?.orders||0,pending_orders:order?.pending_orders||0};
}
export async function updateNodeMode(
  db:D1Database,actor:SalesActor,id:string,expected:NodeMode,next:NodeMode,now:number,
):Promise<void>{
  requireSalesAdmin(actor);
  if(!["active","paused","archived"].includes(next)||!["active","paused","archived"].includes(expected))
    throw Error("INVALID_MODE");
  if(expected===next)throw Error("MODE_UNCHANGED");
  if(next==="archived"){
    const deps=await nodeDependencies(db,id);
    if(deps.blocking_accounts || deps.pending_orders || deps.pending_jobs)throw Error("NODE_HAS_DEPENDENCIES");
  }
  const hasOrders=next==="archived" && !!(await db.prepare(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='customer_orders'",
  ).first<number>("n"));
  const guard=next==="archived"
    ? " AND NOT EXISTS(SELECT 1 FROM managed_accounts WHERE node_id=? AND state IN ('preparing','active','blocked'))"+
      (hasOrders?" AND NOT EXISTS(SELECT 1 FROM customer_orders WHERE node_id=? AND state IN ('awaiting_receipt','pending_review','approving'))":"")+
      " AND NOT EXISTS(SELECT 1 FROM installation_jobs WHERE node_id=? AND state NOT IN ('ready','failed'))"
    : "";
  const query="INSERT OR REPLACE INTO settings(key,value) "+
    "SELECT ?,? WHERE EXISTS(SELECT 1 FROM nodes WHERE id=?) "+
    "AND COALESCE((SELECT value FROM settings WHERE key=?),'active')=?"+guard;
  const args:any[]=["node_status:"+id,next,id,"node_status:"+id,expected];
  if(next==="archived")args.push(id,...(hasOrders?[id]:[]),id);
  const applied=await db.prepare(query).bind(...args).run();
  if(!applied.meta.changes)throw Error("NODE_STATE_CHANGED");
  // Purpose assignment is left in place as historical operator intent.
  // All new allocations are blocked atomically by the node_status gate.
  await db.prepare("INSERT INTO audit_events(actor_id,action,target_id,created_at) VALUES(?,?,?,?)")
    .bind(actor.telegramId,"node_mode_"+next,id,now).run();
}
export async function renameNode(
  db:D1Database,actor:SalesActor,id:string,expectedName:string,name:string,now:number,
):Promise<void>{
  requireSalesAdmin(actor);
  const next=name.trim();
  if(next.length<1||next.length>80||/[<>]/.test(next))throw Error("INVALID_NODE_NAME");
  const updated=await db.prepare("UPDATE nodes SET name=? WHERE id=? AND name=?")
    .bind(next,id,expectedName).run();
  if(!updated.meta.changes)throw Error("NODE_STATE_CHANGED");
  await db.prepare("INSERT INTO audit_events(actor_id,action,target_id,created_at) VALUES(?,'node_rename',?,?)")
    .bind(actor.telegramId,id,now).run();
}
