/** Independent REALITY field acceptance. A listener or SSH install is not a
 * working tunnel. Only an authorized external probe with authenticated VLESS
 * traffic on each operator can publish a route. No Telegram/UI changes.
 */
const NODE=/^[A-Za-z][A-Za-z0-9_-]{2,63}$/;
const ID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8a-f][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const NONCE=/^[a-f0-9]{32}$/;
const HEX=/^[a-f0-9]{64}$/;
const MAX_AGE=10*60*1000;
const encoder=new TextEncoder();
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{
  'content-type':'application/json; charset=utf-8','cache-control':'no-store',
  'x-content-type-options':'nosniff','referrer-policy':'no-referrer',
}});
const hex=bytes=>Array.from(new Uint8Array(bytes),n=>n.toString(16).padStart(2,'0')).join('');
const same=(a,b)=>{
  if(typeof a!=='string'||typeof b!=='string'||a.length!==b.length)return false;
  let diff=0;for(let i=0;i<a.length;i++)diff|=a.charCodeAt(i)^b.charCodeAt(i);
  return diff===0;
};

export function validateFieldSample(sample,nowMs) {
  if(!sample||typeof sample!=='object'||Array.isArray(sample)||
     Object.keys(sample).sort().join(',')!==
       'authenticated,downloadBytes,nodeId,observedMs,operator,port,probeId,revision,uploadBytes')
    return null;
  if(!NODE.test(sample.nodeId??'')||!ID.test(sample.probeId??'')||
     !Number.isSafeInteger(sample.revision)||sample.revision<1||
     !Number.isSafeInteger(sample.observedMs)||
     sample.observedMs<nowMs-120000||sample.observedMs>nowMs+30000||
     !((sample.operator==='mci'&&sample.port===443)||
       (sample.operator==='irancell'&&sample.port===8443))||
     sample.authenticated!==true||
     !Number.isSafeInteger(sample.uploadBytes)||sample.uploadBytes<128||
     !Number.isSafeInteger(sample.downloadBytes)||sample.downloadBytes<128)
    return null;
  return sample;
}

export function completePair(rows,revision,nowMs) {
  if(!Array.isArray(rows))return null;
  const selected={};
  for(const row of rows) {
    if(row.revision!==revision||!Number.isSafeInteger(row.observed_ms)||
       row.observed_ms<nowMs-MAX_AGE||row.observed_ms>nowMs+30000||
       !((row.operator==='mci'&&row.port===443)||
         (row.operator==='irancell'&&row.port===8443)))continue;
    if(!selected[row.operator]||selected[row.operator].observed_ms<row.observed_ms)
      selected[row.operator]=row;
  }
  return selected.mci&&selected.irancell?selected:null;
}

export async function fieldProbeRoute(request,env,nowMs=Date.now()) {
  if(request.method!=='POST'||new URL(request.url).pathname!=='/api/v2/field/accept')
    return json({error:'not_found'},404);
  if(env.FIELD_PROBE_ENABLED!=='true'||!env.DB||typeof env.FIELD_PROBE_SECRET!=='string'||
     env.FIELD_PROBE_SECRET.length<32)return json({error:'not_configured'},503);
  if(!/^application\/json(?:;|$)/i.test(request.headers.get('content-type')??''))
    return json({error:'bad_content_type'},415);
  const timestamp=request.headers.get('x-madar-field-timestamp')??'';
  const nonce=request.headers.get('x-madar-field-nonce')??'';
  const signature=request.headers.get('x-madar-field-signature')??'';
  if(!/^[0-9]{13}$/.test(timestamp)||!NONCE.test(nonce)||!HEX.test(signature)||
     Math.abs(nowMs-Number(timestamp))>120000)return json({error:'unauthorized'},401);
  let raw;
  try{
    raw=await request.text();
    if(encoder.encode(raw).byteLength>2048)return json({error:'too_large'},413);
  }catch{return json({error:'bad_request'},400);}
  const key=await crypto.subtle.importKey('raw',encoder.encode(env.FIELD_PROBE_SECRET),
    {name:'HMAC',hash:'SHA-256'},false,['sign']);
  const expected=hex(await crypto.subtle.sign('HMAC',key,
    encoder.encode(timestamp+'\n'+nonce+'\n'+raw)));
  if(!same(expected,signature))return json({error:'unauthorized'},401);
  let sample;
  try{sample=validateFieldSample(JSON.parse(raw),nowMs);}
  catch{return json({error:'bad_request'},400);}
  if(!sample)return json({error:'invalid_field_proof'},400);

  // Never accept claims for a node that was merely registered or has a
  // stale/unacknowledged desired-state revision.
  const ready=await env.DB.prepare(
    "SELECT n.id FROM nodes n "+
    "JOIN node_bootstrap_jobs j ON j.node_id=n.id AND j.state='installed' "+
    "JOIN routes r ON r.node_id=n.id AND r.id=n.id||'_reality' "+
    "JOIN route_carrier_variants v ON v.route_id=r.id AND v.operator=? AND v.port=? "+
    "WHERE n.id=? AND n.lifecycle IN ('provisioning','ready','degraded') "+
    "AND n.desired_revision=? AND n.acked_revision=? "+
    "AND EXISTS(SELECT 1 FROM node_acks a WHERE a.node_id=n.id "+
      "AND a.revision=? AND a.status='accepted')"
  ).bind(sample.operator,sample.port,sample.nodeId,sample.revision,
    sample.revision,sample.revision).first();
  if(!ready)return json({error:'not_commissioned'},409);
  const inserted=await env.DB.prepare(
    "INSERT OR IGNORE INTO field_probes(id,node_id,operator,port,revision,observed_ms,upload_bytes,download_bytes) "+
    "VALUES(?,?,?,?,?,?,?,?)"
  ).bind(sample.probeId,sample.nodeId,sample.operator,sample.port,sample.revision,
    sample.observedMs,sample.uploadBytes,sample.downloadBytes).run();
  if(inserted.meta?.changes!==1)return json({error:'replay'},409);
  const rows=(await env.DB.prepare(
    "SELECT operator,port,revision,observed_ms FROM field_probes "+
    "WHERE node_id=? AND revision=? AND observed_ms BETWEEN ? AND ? "+
    "ORDER BY observed_ms DESC LIMIT 16"
  ).bind(sample.nodeId,sample.revision,nowMs-MAX_AGE,nowMs+30000).all()).results??[];
  const pair=completePair(rows,sample.revision,nowMs);
  if(!pair)return json({accepted:true,ready:false,missing:sample.operator==='mci'?'irancell':'mci'},202);
  const route=sample.nodeId+'_reality';
  const results=await env.DB.batch([
    env.DB.prepare("UPDATE route_carrier_variants SET published=1,verified_ms=? "+
      "WHERE route_id=? AND operator='mci' AND port=443")
      .bind(pair.mci.observed_ms,route),
    env.DB.prepare("UPDATE route_carrier_variants SET published=1,verified_ms=? "+
      "WHERE route_id=? AND operator='irancell' AND port=8443")
      .bind(pair.irancell.observed_ms,route),
    env.DB.prepare("UPDATE routes SET state='ready',verified_ms=? "+
      "WHERE id=? AND state IN ('checking','ready','degraded') AND EXISTS("+
      "SELECT 1 FROM nodes n WHERE n.id=routes.node_id AND n.desired_revision=? "+
      "AND n.acked_revision=? AND n.lifecycle IN ('provisioning','ready','degraded'))")
      .bind(Math.min(pair.mci.observed_ms,pair.irancell.observed_ms),route,
        sample.revision,sample.revision),
    env.DB.prepare("UPDATE nodes SET lifecycle='ready' WHERE id=? "+
      "AND desired_revision=? AND acked_revision=? "+
      "AND lifecycle IN ('provisioning','ready','degraded') "+
      "AND EXISTS(SELECT 1 FROM routes r WHERE r.node_id=nodes.id "+
      "AND r.state='ready')")
      .bind(sample.nodeId,sample.revision,sample.revision),
  ]);
  if(results.some(x=>x.meta?.changes!==1))return json({accepted:true,ready:false,error:'state_changed'},409);
  return json({accepted:true,ready:true,revision:sample.revision});
}
