/** V2 order reservation modeled on V1's durable account lifecycle.
 * No customer access is activated until a signed node client ACK reports
 * the exact UUID installed in Xray. Never uses V1 D1 or modifies Telegram UI.
 */
import {wrapClientUuid} from './subscription.mjs';

const validOrder=id=>typeof id==='string'&&id.length>0&&id.length<=80;
export async function reserveApprovedOrder(env,orderId,nowMs=Date.now()) {
  if(!env.DB||!env.SUBSCRIPTION_CREDENTIAL_KEY||!validOrder(orderId))
    return {status:'not_configured'};
  const db=env.DB;
  const order=await db.prepare(
    "SELECT o.id,o.customer_telegram_id,p.quota_bytes,p.duration_days "+
    "FROM orders o JOIN plans p ON p.id=o.plan_id "+
    "JOIN customers c ON c.telegram_id=o.customer_telegram_id "+
    "WHERE o.id=? AND o.state='approved' AND c.state='active'"
  ).bind(orderId).first();
  if(!order)return {status:'not_approved'};
  // One node quota pool, two separate REALITY carrier endpoints. A route
  // must have current field evidence, current signed ACK and free capacity.
  const node=await db.prepare(
    "SELECT n.id FROM nodes n "+
    "JOIN routes r ON r.node_id=n.id AND r.id=n.id||'_reality' "+
    "JOIN route_carrier_variants m ON m.route_id=r.id AND m.operator='mci' "+
      "AND m.port=443 AND m.published=1 AND m.verified_ms BETWEEN ? AND ? "+
    "JOIN route_carrier_variants i ON i.route_id=r.id AND i.operator='irancell' "+
      "AND i.port=8443 AND i.published=1 AND i.verified_ms BETWEEN ? AND ? "+
    "WHERE n.lifecycle='ready' AND n.desired_revision=n.acked_revision "+
    "AND r.state='ready' AND r.verified_ms BETWEEN ? AND ? "+
    "AND n.user_limit>(SELECT COUNT(*) FROM node_allocations a "+
      "WHERE a.node_id=n.id AND a.state IN ('reserved','active')) "+
    "AND n.byte_limit-(SELECT COALESCE(SUM(a.quota_bytes),0) "+
      "FROM node_allocations a WHERE a.node_id=n.id "+
      "AND a.state IN ('reserved','active'))>=? "+
    "ORDER BY n.id LIMIT 1"
  ).bind(nowMs-600000,nowMs,nowMs-600000,nowMs,
    nowMs-600000,nowMs,order.quota_bytes).first();
  if(!node)return {status:'no_verified_capacity'};
  const subId=crypto.randomUUID(),allocationId=crypto.randomUUID(),uuid=crypto.randomUUID();
  const credential=await wrapClientUuid(uuid,env.SUBSCRIPTION_CREDENTIAL_KEY);
  try {
    const changes=await db.batch([
      db.prepare(
        "UPDATE orders SET state='provisioning',updated_at=CURRENT_TIMESTAMP "+
        "WHERE id=? AND state='approved'"
      ).bind(orderId),
      db.prepare(
        "INSERT INTO subscriptions(id,owner_telegram_id,state,expires_at,order_id,max_bytes,used_bytes) "+
        "SELECT ?,?,'pending',0,?,?,0 WHERE EXISTS("+
        "SELECT 1 FROM orders WHERE id=? AND state='provisioning')"
      ).bind(subId,order.customer_telegram_id,orderId,order.quota_bytes,orderId),
      db.prepare(
        "INSERT INTO subscription_credentials(subscription_id,ciphertext_b64,nonce_b64,key_version) "+
        "VALUES(?,?,?,1)"
      ).bind(subId,credential.ciphertext_b64,credential.nonce_b64),
      db.prepare(
        "INSERT INTO node_allocations(id,node_id,subscription_id,quota_bytes,state) "+
        "VALUES(?,?,?,?,'reserved')"
      ).bind(allocationId,node.id,subId,order.quota_bytes),
    ]);
    if(changes[0]?.meta?.changes!==1)return {status:'concurrent_change'};
  }catch{return {status:'reservation_rejected'};}
  return {status:'reserved',subscriptionId:subId,nodeId:node.id};
}

export async function reconcileApprovedOrders(env,nowMs=Date.now(),limit=3) {
  if(env.PROVISIONING_ENABLED!=='true'||!env.DB||!env.SUBSCRIPTION_CREDENTIAL_KEY)
    return [];
  const pending=(await env.DB.prepare(
    "SELECT id FROM orders WHERE state='approved' ORDER BY updated_at,id LIMIT ?"
  ).bind(Math.min(10,Math.max(1,limit))).all()).results??[];
  const outcomes=[];
  for(const order of pending)outcomes.push({
    id:order.id,...await reserveApprovedOrder(env,order.id,nowMs),
  });
  return outcomes;
}
