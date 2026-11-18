/** Attested current Xray health, NOT a substitute for independently verified
 * MCI/Irancell observations. Requires a previously accepted two-carrier pair
 * at the same signed desired-state revision.
 */
import {authenticatedNode} from './node-control.mjs';

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
    "AND ((operator='mci' AND port=443) OR "+
         "(operator='irancell' AND port=8443)) GROUP BY operator,port"
  ).bind(auth.id,doc.revision).all()).results??[];
  if(fields.length!==2||!fields.some(x=>x.operator==='mci'&&x.port===443)||
     !fields.some(x=>x.operator==='irancell'&&x.port===8443))
    return json({error:'carrier_not_accepted'},409);
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
      "xray_healthy=1,stats_healthy=1 WHERE excluded.observed_ms>=node_health.observed_ms"
    ).bind(auth.id,doc.revision,doc.observed_ms),
    env.DB.prepare(
      "UPDATE routes SET verified_ms=? WHERE id=? AND state='ready'"
    ).bind(doc.observed_ms,routeId),
    env.DB.prepare(
      "UPDATE route_carrier_variants SET verified_ms=? WHERE route_id=? "+
      "AND published=1 AND ((operator='mci' AND port=443) OR "+
      "(operator='irancell' AND port=8443))"
    ).bind(doc.observed_ms,routeId),
  ]);
  if(results[0]?.meta?.changes!==1||results[1]?.meta?.changes!==1||
     results[2]?.meta?.changes!==2)return json({error:'state_changed'},409);
  return json({ok:true,health_fresh:true,carrier_proofs:'initial_independent_acceptance'});
}
