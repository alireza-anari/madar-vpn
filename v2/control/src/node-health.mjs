/** Attested current Xray health, NOT a substitute for independently verified
 * MCI/Irancell observations. Requires a previously accepted two-carrier pair
 * at the same signed desired-state revision.
 */
import {authenticatedNode} from './node-control.mjs';
import {manualPair,manualAttestationEnabled} from './admin-carrier-accept.mjs';

const HEALTH_REFRESH_MS=120_000;
const HEALTH_FRESH_MS=10*60_000;

const json=(obj,status=200)=>new Response(JSON.stringify(obj),{
  status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'},
});
export function validHealth(doc,nowMs){
  if(!doc||typeof doc!=='object'||Array.isArray(doc)||
     Object.keys(doc).sort().join(',')!==
        'observed_ms,ports,revision,stats_healthy,xray_healthy'||
     !Number.isSafeInteger(doc.revision)||doc.revision<1||
     !Number.isSafeInteger(doc.observed_ms)||
     doc.observed_ms<nowMs-30000||doc.observed_ms>nowMs+30000||
     doc.xray_healthy!==true||doc.stats_healthy!==true||
     !Array.isArray(doc.ports)||doc.ports.length!==2||
     doc.ports[0]!==443||doc.ports[1]!==8443)return false;
  return true;
}
export async function nodeHealthRoute(request,env,nowMs=Date.now()){
  if(request.method!=='POST'||new URL(request.url).pathname!=='/api/node/v1/health')
    return json({error:'not_found'},404);
  const auth=await authenticatedNode(request,env,nowMs);
  if(auth.error)return auth.error;
  let doc;
  try{doc=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(auth.raw));}
  catch{return json({error:'bad_request'},400);}
  if(!validHealth(doc,nowMs)||auth.node.lifecycle!=='ready'||
     auth.node.desired_revision!==auth.node.acked_revision||
     doc.revision!==auth.node.desired_revision)
    return json({error:'not_ready'},409);
  const routeId=auth.id+'_reality';
  const fields=(await env.DB.prepare(
    "SELECT operator,port FROM field_probes WHERE node_id=? AND revision=? "+
    "AND observed_ms BETWEEN 1 AND ? "+
    "AND ((operator='mci' AND port=443) OR "+
         "(operator='irancell' AND port=8443)) GROUP BY operator,port"
  ).bind(auth.id,doc.revision,nowMs+30000).all()).results??[];
  const independent=fields.length===2&&fields.some(x=>x.operator==='mci'&&x.port===443)&&
    fields.some(x=>x.operator==='irancell'&&x.port===8443);
  // Carrier approval was a one-time commissioning gate for this revision.
  // Do not request a new mobile-SIM test every day. A fresh, signed Xray
  // health report and same-revision published variants are still mandatory.
  const manual=!independent&&manualAttestationEnabled(env)&&
    await manualPair(env.DB,auth.id,doc.revision,nowMs,true);
  if(!independent&&!manual)return json({error:'carrier_not_accepted'},409);
  const ready=await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM route_carrier_variants v JOIN routes r ON r.id=v.route_id "+
    "WHERE v.route_id=? AND r.state='ready' AND v.published=1 "+
    "AND ((v.operator='mci' AND v.port=443) OR (v.operator='irancell' AND v.port=8443))"
  ).bind(routeId).first();
  if(Number(ready?.n)!==2)return json({error:'route_not_ready'},409);
  const results=await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO node_health(node_id,revision,observed_ms,xray_healthy,stats_healthy) "+
      "VALUES(?,?,?,1,1) ON CONFLICT(node_id) DO UPDATE SET "+
      "revision=excluded.revision,observed_ms=excluded.observed_ms,"+
      "xray_healthy=1,stats_healthy=1 WHERE excluded.revision<>node_health.revision OR "+
      "node_health.xray_healthy<>1 OR node_health.stats_healthy<>1 OR "+
      "excluded.observed_ms>=node_health.observed_ms+?"
    ).bind(auth.id,doc.revision,doc.observed_ms,HEALTH_REFRESH_MS),
    env.DB.prepare(
      "UPDATE routes SET verified_ms=? WHERE id=? AND state='ready' "+
      "AND (verified_ms IS NULL OR verified_ms<=?)"
    ).bind(doc.observed_ms,routeId,doc.observed_ms-HEALTH_REFRESH_MS),
    env.DB.prepare(
      "UPDATE route_carrier_variants SET verified_ms=? WHERE route_id=? "+
      "AND published=1 AND ((operator='mci' AND port=443) OR "+
      "(operator='irancell' AND port=8443)) AND (verified_ms IS NULL OR verified_ms<=?)"
    ).bind(doc.observed_ms,routeId,doc.observed_ms-HEALTH_REFRESH_MS),
  ]);
  // A healthy node reports every 10 seconds, but route freshness is consumed
  // with a 10-minute TTL. Refresh D1 at most every two minutes and verify the
  // persisted state rather than treating an intentional no-op as a failure.
  const state=await env.DB.prepare(
    "SELECT h.revision,h.xray_healthy,h.stats_healthy,h.observed_ms AS health_ms,"+
    "r.state AS route_state,r.verified_ms AS route_ms,COUNT(v.operator) AS variants,"+
    "MIN(v.verified_ms) AS variant_ms FROM node_health h "+
    "JOIN routes r ON r.id=? AND r.node_id=h.node_id "+
    "JOIN route_carrier_variants v ON v.route_id=r.id AND v.published=1 "+
    "AND ((v.operator='mci' AND v.port=443) OR (v.operator='irancell' AND v.port=8443)) "+
    "WHERE h.node_id=? GROUP BY h.node_id"
  ).bind(routeId,auth.id).first();
  if(!state||state.revision!==doc.revision||state.xray_healthy!==1||
     state.stats_healthy!==1||state.health_ms<nowMs-HEALTH_FRESH_MS||
     state.route_state!=='ready'||state.route_ms<nowMs-HEALTH_FRESH_MS||
     Number(state.variants)!==2||state.variant_ms<nowMs-HEALTH_FRESH_MS)
    return json({error:'state_changed'},409);
  return json({ok:true,health_fresh:true,
    carrier_proofs:independent?'initial_independent_acceptance':'owner_manual_attestation'});
}
