/** Server-observed usage accounting from an independently signed node.
 * Exactly-once per increasing sequence; DB-bounded quota, no client-originated usage.
 */
import {authenticatedNode} from './node-control.mjs';

const JSON_HEADERS={'content-type':'application/json; charset=utf-8','cache-control':'no-store'};
const reply=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:JSON_HEADERS});
const MAX=9007199254740991;
const safeInt=n=>Number.isSafeInteger(n)&&n>=0&&n<=MAX;
const SUB_ID=/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;

export function validateUsageReport(data,nowMs) {
  if(!data||typeof data!=='object'||Array.isArray(data)||
     !Number.isSafeInteger(data.revision)||data.revision<1||
     !Array.isArray(data.reports)||data.reports.length<1||data.reports.length>20)return null;
  const seen=new Set();
  for(const r of data.reports) {
    if(!r||typeof r!=='object'||Array.isArray(r)||
       Object.keys(r).sort().join(',')!=='cumulative_bytes,observed_ms,sequence,subscription_id'||
       !SUB_ID.test(r.subscription_id??'')||seen.has(r.subscription_id)||
       !Number.isSafeInteger(r.sequence)||r.sequence<1||
       !safeInt(r.cumulative_bytes)||
       !Number.isSafeInteger(r.observed_ms)||r.observed_ms>nowMs+30000||
       r.observed_ms<nowMs-120000) return null;
    seen.add(r.subscription_id);
  }
  return data;
}

export async function usageRoute(request,env,nowMs=Date.now()) {
  const path=new URL(request.url).pathname;
  if(request.method!=='POST'||!['/api/node/v1/usage','/api/node/v1/clients/revoked'].includes(path))
    return reply({error:'not_found'},404);
  const auth=await authenticatedNode(request,env,nowMs);
  if(auth.error)return auth.error;
  if(auth.node.lifecycle!=='ready'||auth.node.desired_revision!==auth.node.acked_revision)
    return reply({error:'node_not_ready'},409);
  let b;
  try{b=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(auth.raw));}
  catch{return reply({error:'bad_json'},400);}
  if(path==='/api/node/v1/clients/revoked')return revokeRemovedClients(env.DB,auth,b,nowMs);
  const doc=validateUsageReport(b,nowMs);
  if(!doc||doc.revision!==auth.node.desired_revision)return reply({error:'bad_report'},400);

  const result=[];
  for(const row of doc.reports) {
    const allowed=await env.DB.prepare(
      "SELECT a.id FROM node_allocations a JOIN subscriptions s ON s.id=a.subscription_id "+
      "WHERE a.node_id=? AND a.subscription_id=? AND a.state IN ('reserved','active')"
    ).bind(auth.id,row.subscription_id).first();
    if(!allowed)return reply({error:'allocation_not_found'},409);
    // D1 batch is a transaction: a durable cumulative checkpoint and the
    // customer-facing balance either both commit or neither does.
    const [saved]=await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO node_usage_reports(node_id,subscription_id,sequence,cumulative_bytes,observed_ms) "+
        "VALUES(?,?,?,?,?) ON CONFLICT(node_id,subscription_id) DO UPDATE SET "+
        "sequence=excluded.sequence,cumulative_bytes=excluded.cumulative_bytes,"+
        "observed_ms=excluded.observed_ms WHERE "+
        "excluded.sequence>node_usage_reports.sequence AND "+
        "excluded.cumulative_bytes>=node_usage_reports.cumulative_bytes"
      ).bind(auth.id,row.subscription_id,row.sequence,row.cumulative_bytes,row.observed_ms),
      env.DB.prepare(
        "UPDATE subscriptions SET used_bytes=MIN(max_bytes,MAX(used_bytes,"+
        "(SELECT COALESCE(SUM(cumulative_bytes),0) FROM node_usage_reports "+
        "WHERE subscription_id=?))) WHERE id=?"
      ).bind(row.subscription_id,row.subscription_id),
    ]);
    const actual=await env.DB.prepare(
      "SELECT sequence,cumulative_bytes FROM node_usage_reports "+
      "WHERE node_id=? AND subscription_id=?"
    ).bind(auth.id,row.subscription_id).first();
    if(!actual)return reply({error:'checkpoint_failed'},503);
    if(Number(saved.meta?.changes)!==1&&
       (actual.sequence!==row.sequence||actual.cumulative_bytes!==row.cumulative_bytes))
      return reply({error:'stale_or_regressed_usage'},409);
    result.push({subscription_id:row.subscription_id,
      cumulative_bytes:actual.cumulative_bytes,sequence:actual.sequence});
  }
  return reply({ok:true,received:result});
}

export async function revokeRemovedClients(db,auth,payload,nowMs) {
  if(!payload||payload.revision!==auth.node.desired_revision||
     !Array.isArray(payload.subscription_ids)||payload.subscription_ids.length>100||
     !payload.subscription_ids.every(id=>SUB_ID.test(id??''))||
     new Set(payload.subscription_ids).size!==payload.subscription_ids.length)
    return reply({error:'bad_request'},400);
  let released=0;
  for(const id of payload.subscription_ids) {
    // Removal confirmation must never invalidate a still-active valid user.
    const query=await db.prepare(
      "UPDATE node_allocations SET state='released' "+
      "WHERE node_id=? AND subscription_id=? AND state IN ('reserved','active') "+
      "AND EXISTS(SELECT 1 FROM subscriptions s WHERE s.id=node_allocations.subscription_id "+
      "AND (s.state IN ('expired','suspended','revoked') OR "+
      "(s.state='active' AND (s.expires_at<=? OR s.used_bytes>=s.max_bytes))))"
    ).bind(auth.id,id,nowMs).run();
    released+=Number(query.meta?.changes)===1?1:0;
  }
  return reply({ok:true,released});
}
