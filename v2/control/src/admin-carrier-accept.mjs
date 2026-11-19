/** Isolated V2 staging: manual operator test attestations.
 * Admin observations are NOT independent field probes and never spoof node ACK.
 * A node becomes ready only with both admin claims and a fresh signed ACK.
 */
const OPERATORS={mci:443,irancell:8443};
const TEST_TTL=24*60*60*1000;
const ACK_TTL=10*60*1000;
const ID=/^[A-Za-z][A-Za-z0-9_-]{2,63}$/;

export function manualAttestationEnabled(env) {
  return env?.ADMIN_MANUAL_FIELD_ACCEPT_ENABLED==='true';
}

/** Fresh confirmation is mandatory at commissioning. Once published, the
 * same revision's one-time accepted carrier pair persists; only signed
 * runtime health expires and must be renewed. Never reuse after reconfiguration.
 */
export async function manualPair(db,nodeId,revision,nowMs=Date.now(),acceptedOnce=false){
  const earliest=acceptedOnce?1:nowMs-TEST_TTL;
  const rows=(await db.prepare(
    "SELECT operator,port,revision,confirmed_ms FROM admin_carrier_tests "+
    "WHERE node_id=? AND revision=? AND confirmed_ms BETWEEN ? AND ?"
  ).bind(nodeId,revision,earliest,nowMs+30000).all()).results??[];
  return rows.length===2 &&
    rows.some(x=>x.operator==='mci'&&x.port===443) &&
    rows.some(x=>x.operator==='irancell'&&x.port===8443);
}

/** Used by the admin callback and the real signed-node /ack handler. */
export async function promoteAdminPair(env,nodeId,nowMs=Date.now()) {
  if(!manualAttestationEnabled(env)||!ID.test(nodeId??''))return {ready:false,reason:'disabled'};
  const db=env.DB;
  const node=await db.prepare(
    "SELECT n.id,n.lifecycle,n.desired_revision,n.acked_revision,j.state AS installed "+
    "FROM nodes n JOIN node_bootstrap_jobs j ON j.node_id=n.id WHERE n.id=?"
  ).bind(nodeId).first();
  if(!node||node.installed!=='installed'||
    !['provisioning','ready'].includes(node.lifecycle))
    return {ready:false,reason:'not_installed'};
  const rev=node.desired_revision;
  if(rev!==node.acked_revision) return {ready:false,reason:'node_ack_pending'};
  const ack=await db.prepare(
    "SELECT 1 AS ok FROM node_acks WHERE node_id=? AND revision=? "+
    "AND status='accepted' AND observed_ms BETWEEN ? AND ? LIMIT 1"
  ).bind(nodeId,rev,nowMs-ACK_TTL,nowMs+30000).first();
  if(!ack) return {ready:false,reason:'node_ack_pending'};
  if(!await manualPair(db,nodeId,rev,nowMs))
    return {ready:false,reason:'carrier_confirmation_missing'};
  const routeId=nodeId+'_reality';
  const variants=(await db.prepare(
    "SELECT operator,port FROM route_carrier_variants WHERE route_id=?"
  ).bind(routeId).all()).results??[];
  if(variants.length!==2||
    !variants.some(x=>x.operator==='mci'&&x.port===443)||
    !variants.some(x=>x.operator==='irancell'&&x.port===8443))
    return {ready:false,reason:'dual_route_missing'};
  const route=await db.prepare(
    "SELECT state FROM routes WHERE id=? AND node_id=? AND transport='reality'"
  ).bind(routeId,nodeId).first();
  if(!route||!['checking','ready'].includes(route.state))
    return {ready:false,reason:'route_not_eligible'};

  // Transactional and revision-guarded: do not publish if agent state changed.
  const guard=
    " AND EXISTS(SELECT 1 FROM nodes n JOIN node_bootstrap_jobs j ON j.node_id=n.id "+
    "WHERE n.id=? AND n.desired_revision=? AND n.acked_revision=? "+
    "AND n.lifecycle IN ('provisioning','ready') AND j.state='installed' "+
    "AND EXISTS(SELECT 1 FROM node_acks a WHERE a.node_id=n.id "+
    "AND a.revision=? AND a.status='accepted' AND a.observed_ms BETWEEN ? AND ?) "+
    "AND (SELECT COUNT(*) FROM admin_carrier_tests a WHERE a.node_id=n.id "+
    "AND a.revision=? AND a.confirmed_ms BETWEEN ? AND ? "+
    "AND ((a.operator='mci' AND a.port=443) OR (a.operator='irancell' AND a.port=8443)))=2)";
  const args=[nodeId,rev,rev,rev,nowMs-ACK_TTL,nowMs+30000,
    rev,nowMs-TEST_TTL,nowMs+30000];
  const result=await db.batch([
    db.prepare(
      "UPDATE route_carrier_variants SET published=1,verified_ms=? "+
      "WHERE route_id=? AND ((operator='mci' AND port=443) OR "+
      "(operator='irancell' AND port=8443))"+guard
    ).bind(nowMs,routeId,...args),
    db.prepare(
      "UPDATE routes SET state='ready',verified_ms=? "+
      "WHERE id=? AND node_id=? AND state IN ('checking','ready') "+
      "AND (SELECT COUNT(*) FROM route_carrier_variants v "+
      "WHERE v.route_id=routes.id AND v.published=1 AND v.verified_ms>=?)=2"+guard
    ).bind(nowMs,routeId,nodeId,nowMs,...args),
    db.prepare(
      "UPDATE nodes SET lifecycle='ready' WHERE id=? AND desired_revision=? "+
      "AND acked_revision=? AND lifecycle IN ('provisioning','ready') "+
      "AND EXISTS(SELECT 1 FROM routes r WHERE r.node_id=nodes.id "+
      "AND r.id=nodes.id||'_reality' AND r.state='ready' AND r.verified_ms>=?)"
    ).bind(nodeId,rev,rev,nowMs),
  ]);
  if(Number(result[0]?.meta?.changes)!==2||
     Number(result[1]?.meta?.changes)!==1||
     Number(result[2]?.meta?.changes)!==1)
    return {ready:false,reason:'state_changed'};
  return {ready:true,source:'admin_manual_plus_signed_agent'};
}

export async function recordAdminCarrierTest(env,actor,nodeId,operator,nowMs=Date.now()) {
  if(!manualAttestationEnabled(env))return {ok:false,reason:'disabled'};
  if(!ID.test(nodeId??'')||!Object.hasOwn(OPERATORS,operator)||
     !/^[0-9]{5,20}$/.test(String(actor??'')))
    return {ok:false,reason:'invalid'};
  const db=env.DB;
  const node=await db.prepare(
    "SELECT n.desired_revision,n.lifecycle,j.state,j.owner_id FROM nodes n "+
    "JOIN node_bootstrap_jobs j ON j.node_id=n.id WHERE n.id=?"
  ).bind(nodeId).first();
  if(!node||node.state!=='installed'||node.owner_id!==String(actor)||
     !['provisioning','ready'].includes(node.lifecycle))
    return {ok:false,reason:'not_owner_or_not_installed'};
  const variant=await db.prepare(
    "SELECT 1 AS ok FROM route_carrier_variants WHERE route_id=? "+
    "AND operator=? AND port=? AND EXISTS(SELECT 1 FROM routes r "+
    "WHERE r.id=route_carrier_variants.route_id AND r.state IN ('checking','ready'))"
  ).bind(nodeId+'_reality',operator,OPERATORS[operator]).first();
  if(!variant)return {ok:false,reason:'route_missing'};
  const stored=await db.prepare(
    "INSERT INTO admin_carrier_tests(node_id,operator,port,revision,actor_id,confirmed_ms) "+
    "VALUES(?,?,?,?,?,?) ON CONFLICT(node_id,operator) DO UPDATE SET "+
    "port=excluded.port,revision=excluded.revision,actor_id=excluded.actor_id,"+
    "confirmed_ms=excluded.confirmed_ms"
  ).bind(nodeId,operator,OPERATORS[operator],node.desired_revision,String(actor),nowMs).run();
  if(Number(stored.meta?.changes)!==1)return {ok:false,reason:'save_failed'};
  const paired=await manualPair(db,nodeId,node.desired_revision,nowMs);
  const promotion=paired?await promoteAdminPair(env,nodeId,nowMs):{ready:false,
    reason:'carrier_confirmation_missing'};
  return {ok:true,operator,paired,...promotion};
}
