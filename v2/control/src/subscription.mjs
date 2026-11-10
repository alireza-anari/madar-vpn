/** Revocable token-authenticated V2 subscription API, no bearer tokens in URLs.
 * Delivers structured VLESS route metadata, never server private keys.
 */
const ascii=new TextEncoder();
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN=/^[A-Za-z0-9_-]{43}$/;
const SAFE_HOST=/^[a-zA-Z0-9][a-zA-Z0-9.:-]{1,252}$/;

const hex=bytes=>Array.from(bytes).map(b=>b.toString(16).padStart(2,'0')).join('');
const base64Decode=value=>{
  if(typeof value!=='string'|| !/^[a-zA-Z0-9_-]+$/.test(value))
    throw new TypeError('invalid_b64url');
  const clean=value.replace(/-/g,'+').replace(/_/g,'/');
  return Uint8Array.from(atob(clean+'='.repeat((4-clean.length%4)%4)),x=>x.charCodeAt(0));
};
const json=(obj,status=200)=>new Response(JSON.stringify(obj),{
  status,headers:{
    'content-type':'application/json; charset=utf-8',
    'cache-control':'no-store, private','pragma':'no-cache',
    'x-content-type-options':'nosniff','referrer-policy':'no-referrer',
  },
});

export async function tokenDigest(token) {
  if(!TOKEN.test(token??'')) return null;
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256',ascii.encode(token))));
}

export async function unwrapClientUuid(credential,keyText) {
  const raw=base64Decode(keyText);
  if(raw.length!==32) throw new TypeError('credential_key_length');
  const nonce=base64Decode(credential?.nonce_b64);
  const ciphertext=base64Decode(credential?.ciphertext_b64);
  if(nonce.length!==12 || ciphertext.length<16) throw new TypeError('bad_ciphertext');
  const key=await crypto.subtle.importKey('raw',raw,{name:'AES-GCM'},false,['decrypt']);
  const uuid=new TextDecoder('utf-8',{fatal:true}).decode(
    await crypto.subtle.decrypt({name:'AES-GCM',iv:nonce},key,ciphertext)
  );
  if(!UUID.test(uuid)) throw new TypeError('bad_client_uuid');
  return uuid;
}

export function eligibleEndpoint(row) {
  if(!row || !SAFE_HOST.test(row.host??'') || !Number.isInteger(row.port) ||
     row.port<1||row.port>65535) return false;
  if(row.transport==='reality')
    return typeof row.server_name==='string' && SAFE_HOST.test(row.server_name) &&
      /^[A-Za-z0-9_-]{43}$/.test(row.reality_public_key??'') &&
      /^[a-fA-F0-9]{0,16}$/.test(row.reality_short_id??'');
  if(row.transport==='wss')
    return typeof row.server_name==='string' && SAFE_HOST.test(row.server_name) &&
      typeof row.ws_path==='string' && row.ws_path.startsWith('/') &&
      row.ws_path.length<=256 && !/[\r\n]/.test(row.ws_path);
  return false; // UDP outbounds require a separately audited client adapter
}

async function activeRoutes(db,subId,nowMs) {
  const rows=(await db.prepare(
    "SELECT r.id AS route_id,r.transport,re.host,re.port,re.server_name,re.ws_path," +
    "re.reality_public_key,re.reality_short_id FROM node_allocations a " +
    "JOIN nodes n ON n.id=a.node_id JOIN routes r ON r.node_id=n.id " +
    "JOIN route_endpoints re ON re.route_id=r.id " +
    "WHERE a.subscription_id=? AND a.state='active' AND n.lifecycle='ready' " +
    "AND r.state='ready' AND r.verified_ms BETWEEN ? AND ? AND re.published=1 " +
    "ORDER BY r.id LIMIT 8"
  ).bind(subId,nowMs-600000,nowMs).all()).results??[];
  return rows.filter(eligibleEndpoint);
}

export async function getSubscription(request,env,nowMs=Date.now()) {
  if(request.method!=='GET') return json({error:'method_not_allowed'},405);
  if(env.SUBSCRIPTION_API_ENABLED!=='true') return json({error:'service_not_ready'},503);
  if(!env.DB || !env.SUBSCRIPTION_CREDENTIAL_KEY)
    return json({error:'service_not_ready'},503);
  const header=request.headers.get('authorization')??'';
  if(!header.startsWith('Bearer ')) return json({error:'unauthorized'},401);
  const token=header.slice(7);
  const hash=await tokenDigest(token);
  if(!hash) return json({error:'unauthorized'},401);
  const active=await env.DB.prepare(
    "SELECT s.id,s.state,s.expires_at,s.max_bytes,s.used_bytes " +
    "FROM subscription_tokens t JOIN subscriptions s ON s.id=t.subscription_id " +
    "WHERE t.token_hash=? AND t.revoked=0 AND t.expires_at>? " +
    "AND s.state='active' AND s.expires_at>? LIMIT 1"
  ).bind(hash,nowMs,nowMs).first();
  if(!active) return json({error:'subscription_inactive'},403);
  if(active.max_bytes<=0 || active.used_bytes>=active.max_bytes)
    return json({error:'quota_exhausted'},403);
  const routes=await activeRoutes(env.DB,active.id,nowMs);
  if(!routes.length) return json({error:'no_verified_routes'},503);
  const secrets=await env.DB.prepare(
    'SELECT ciphertext_b64,nonce_b64,key_version FROM subscription_credentials WHERE subscription_id=?'
  ).bind(active.id).first();
  if(!secrets || secrets.key_version!==1) return json({error:'credential_unavailable'},503);
  let id;
  try{id=await unwrapClientUuid(secrets,env.SUBSCRIPTION_CREDENTIAL_KEY);}
  catch{return json({error:'credential_unavailable'},503);}
  return json({
    version:1,subscription_id:active.id,expires_at:active.expires_at,
    quota_bytes:active.max_bytes,used_bytes:active.used_bytes,
    client:{protocol:'vless',uuid:id},
    routes:routes.map(x=>({
      id:x.route_id,protocol:'vless',transport:x.transport,
      endpoint:{host:x.host,port:x.port},
      tls:{server_name:x.server_name,
        ...(x.transport==='reality'?{reality_public_key:x.reality_public_key,
          short_id:x.reality_short_id}: {})},
      ...(x.transport==='wss'?{websocket:{path:x.ws_path}}:{}),
    })),
  });
}
