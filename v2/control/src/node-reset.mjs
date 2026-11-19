/** V2-only re-enrollment gate. Never erase a live account or historical ledger.
 * Existing client records remain for audit; a cleaned node is retired and a
 * new node identifier must be used to install fresh Xray keys.
 */
const RE=/^[A-Za-z][A-Za-z0-9_-]{2,63}$/;
async function count(db,sql,...args){
  const r=await db.prepare(sql).bind(...args).first();
  return Number(r?.n??0);
}
export async function resetEligibility(db,owner,nodeId,nowMs){
  if(!RE.test(nodeId??''))return {ok:false,code:'INVALID_TARGET'};
  const node=await db.prepare(
    "SELECT n.id,n.lifecycle,n.desired_revision,j.ip,j.owner_id FROM nodes n "+
    "JOIN node_bootstrap_jobs j ON j.node_id=n.id AND j.state='installed' "+
    "WHERE n.id=? AND j.owner_id=? LIMIT 1"
  ).bind(nodeId,owner).first();
  if(!node || !['ready','provisioning','degraded','quarantined'].includes(node.lifecycle))
    return {ok:false,code:'NODE_NOT_INSTALLED'};
  const [used,active,installed,claims,liveTrial,unsafeOrders,pending]=await Promise.all([
    count(db,"SELECT COUNT(*) n FROM node_allocations a JOIN subscriptions s ON s.id=a.subscription_id "+
      "WHERE a.node_id=? AND (s.used_bytes<>0 OR s.state IN ('active','suspended') OR a.state='active')",nodeId),
    count(db,"SELECT COUNT(*) n FROM node_usage_reports WHERE node_id=?",nodeId),
    count(db,"SELECT COUNT(*) n FROM node_client_acks WHERE node_id=?",nodeId),
    count(db,"SELECT COUNT(*) n FROM customer_trial_claims WHERE node_id=?",nodeId),
    count(db,"SELECT COUNT(*) n FROM node_trial_links WHERE node_id=? AND expires_ms>?",nodeId,nowMs),
    count(db,"SELECT COUNT(*) n FROM node_allocations a JOIN subscriptions s ON s.id=a.subscription_id "+
      "LEFT JOIN orders o ON o.id=s.order_id WHERE a.node_id=? "+
      "AND (s.state NOT IN ('pending','revoked','expired') "+
      "OR (s.state='pending' AND (o.quoted_amount>0 OR o.state='receipt_submitted' "+
      "OR EXISTS(SELECT 1 FROM receipts r WHERE r.order_id=o.id AND r.state='accepted'))))",nodeId),
    count(db,"SELECT COUNT(*) n FROM node_allocations a JOIN subscriptions s ON s.id=a.subscription_id "+
      "WHERE a.node_id=? AND s.state='pending' AND a.state='reserved'",nodeId),
  ]);
  if(used||active||installed||claims||unsafeOrders)
    return {ok:false,code:'NODE_HAS_ACTIVE_OR_USED_ACCOUNTS'};
  if(liveTrial)return {ok:false,code:'NODE_HAS_LIVE_TRIAL'};
  const issues=await count(db,
    "SELECT COUNT(*) n FROM admin_direct_issues i JOIN orders o ON o.id=i.order_id "+
    "WHERE i.node_id=? AND (o.quoted_amount<>0 OR o.state='receipt_submitted')",nodeId);
  if(issues)return {ok:false,code:'NODE_HAS_PAID_ORDERS'};
  return {ok:true,node,willCancelPending:pending,code:'RESET_ALLOWED'};
}

export async function retireCleanedNode(db,owner,nodeId,jobId,nowMs,completion){
  const gate=await resetEligibility(db,owner,nodeId,nowMs);
  if(!gate.ok||gate.node.lifecycle!=='quarantined')
    return false;
  // Query is evaluated again AFTER the SSH owner verified the exact remote
  // V2 identity and no commercial Xray UUID or usage. D1.batch is atomic.
  const rows=[
    db.prepare("UPDATE orders SET state='cancelled',updated_at=CURRENT_TIMESTAMP "+
      "WHERE state IN ('approved','provisioning') AND id IN "+
      "(SELECT s.order_id FROM subscriptions s JOIN node_allocations a "+
      "ON a.subscription_id=s.id WHERE a.node_id=? AND s.state='pending')")
      .bind(nodeId),
    db.prepare("UPDATE subscription_tokens SET revoked=1 WHERE subscription_id IN "+
      "(SELECT s.id FROM subscriptions s JOIN node_allocations a ON a.subscription_id=s.id "+
      "WHERE a.node_id=? AND s.state='pending')").bind(nodeId),
    db.prepare("UPDATE subscriptions SET state='revoked' WHERE state='pending' AND id IN "+
      "(SELECT subscription_id FROM node_allocations WHERE node_id=? AND state='reserved')").bind(nodeId),
    db.prepare("UPDATE node_allocations SET state='released' WHERE node_id=? AND state='reserved' "+
      "AND subscription_id IN (SELECT id FROM subscriptions WHERE state='revoked')").bind(nodeId),
    db.prepare("UPDATE routes SET state='quarantined' WHERE node_id=?").bind(nodeId),
    db.prepare("UPDATE route_carrier_variants SET published=0 WHERE route_id IN "+
      "(SELECT id FROM routes WHERE node_id=?)").bind(nodeId),
    db.prepare("UPDATE node_trial_links SET expires_ms=? WHERE node_id=? AND expires_ms>?")
      .bind(nowMs,nodeId,nowMs),
    db.prepare("UPDATE nodes SET lifecycle='retired' WHERE id=? AND lifecycle='quarantined'")
      .bind(nodeId),
    db.prepare("INSERT OR IGNORE INTO audit_events(event_id,actor_id,object_type,object_id,verb) "+
      "VALUES(?,?, 'node',?,'v2-owner-remote-reset-complete')")
      .bind('v2reset:'+jobId,owner,nodeId),
  ];
  // Mark the SSH job completed in the SAME transaction as node retirement.
  if(!completion)return false;
  rows.push(completion);
  try{
    const result=await db.batch(rows);
    return Number(result.at(-1)?.meta?.changes)===1;
  }catch{return false;}
}
