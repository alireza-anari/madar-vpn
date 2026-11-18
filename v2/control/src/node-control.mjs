import {unwrapClientUuid} from './subscription.mjs';
/** Independently authenticated V2 node desired-state protocol.
 * A node acknowledgement NEVER marks a VPN route ready.
 * NODE_MASTER_KEY is a 32-byte base64url secret stored in Worker secrets only.
 */
const NODE_RE=/^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$/;
const HEX32=/^[a-f0-9]{32}$/;
const HEX64=/^[a-f0-9]{64}$/;
const HEADER='x-madar-node-';
const encoder=new TextEncoder();

const toHex=bytes=>Array.from(bytes).map(b=>b.toString(16).padStart(2,'0')).join('');
const fromBase64Url=x=>{
  if(typeof x!=='string'|| !/^[A-Za-z0-9_-]+$/.test(x)) throw new Error('invalid_key');
  const normal=x.replace(/-/g,'+').replace(/_/g,'/');
  return Uint8Array.from(atob(normal+'='.repeat((4-normal.length%4)%4)),c=>c.charCodeAt(0));
};
const base64Url=bytes=>btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const digest=async bytes=>new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));
const safeJson=(body,status=200)=>new Response(JSON.stringify(body),{
  status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store',
    'x-content-type-options':'nosniff'}
});

export function canonical(value) {
  if(value===null || typeof value==='number' || typeof value==='boolean' || typeof value==='string')
    return JSON.stringify(value);
  if(Array.isArray(value)) return '['+value.map(canonical).join(',')+']';
  if(!value || typeof value!=='object') throw new TypeError('unsupported canonical type');
  return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
}

export async function deriveNodeKey(masterText,nodeId) {
  if(!NODE_RE.test(nodeId??'')) throw new Error('invalid_node_id');
  const raw=fromBase64Url(masterText);
  if(raw.byteLength!==32) throw new Error('invalid_master_length');
  const master=await crypto.subtle.importKey('raw',raw,'HKDF',false,['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({
    name:'HKDF',hash:'SHA-256',salt:encoder.encode('madar-v2/node-hkdf/v1'),
    info:encoder.encode('madar-v2/node/v1:'+nodeId),
  },master,256));
}

async function hmac(key,value) {
  const obj=await crypto.subtle.importKey('raw',key,{name:'HMAC',hash:'SHA-256'},false,['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC',obj,encoder.encode(value)));
}

export async function signNodeRequest(key,method,path,timestamp,nonce,bodyBytes=new Uint8Array()) {
  const hash=toHex(await digest(bodyBytes));
  return base64Url(await hmac(key,[method,path,String(timestamp),nonce,hash].join('\n')));
}

async function sameMac(expected,signature) {
  if(typeof signature!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(signature)) return false;
  const actual=fromBase64Url(signature);
  if(actual.length!==expected.length) return false;
  let diff=0;
  for(let i=0;i<expected.length;i++)diff|=expected[i]^actual[i];
  return diff===0;
}

export async function authenticatedNode(request,env,nowMs=Date.now()) {
  if(!env.DB || !env.NODE_MASTER_KEY) return {error:safeJson({error:'not_configured'},503)};
  const url=new URL(request.url);
  if(url.search) return {error:safeJson({error:'unauthorized'},401)};
  const id=request.headers.get(HEADER+'id')??'';
  const nonce=request.headers.get(HEADER+'nonce')??'';
  const timestamp=request.headers.get(HEADER+'timestamp')??'';
  const signature=request.headers.get(HEADER+'signature')??'';
  const sec=Number(timestamp);
  if(!NODE_RE.test(id)||!HEX32.test(nonce)||!/^[0-9]{10}$/.test(timestamp)||
     !Number.isSafeInteger(sec)||Math.abs(nowMs-sec*1000)>90000)
     return {error:safeJson({error:'unauthorized'},401)};
  const raw=await request.arrayBuffer();
  if(raw.byteLength>4096) return {error:safeJson({error:'too_large'},413)};
  const key=await deriveNodeKey(env.NODE_MASTER_KEY,id);
  const expected=await hmac(key,[request.method,url.pathname,timestamp,nonce,
    toHex(await digest(raw))].join('\n'));
  if(!await sameMac(expected,signature))
    return {error:safeJson({error:'unauthorized'},401)};
  const node=await env.DB.prepare(
    "SELECT id,lifecycle,desired_revision,acked_revision,user_limit,byte_limit FROM nodes WHERE id=?"
  ).bind(id).first();
  if(!node || node.lifecycle==='retired'||node.lifecycle==='quarantined')
    return {error:safeJson({error:'unauthorized'},401)};
  // Replay protection with an atomic UNIQUE constraint in D1.
  const saved=await env.DB.prepare(
    'INSERT OR IGNORE INTO node_nonces(node_id,nonce,created_ms) VALUES(?,?,?)'
  ).bind(id,nonce,nowMs).run();
  if(saved.meta?.changes!==1) return {error:safeJson({error:'replay'},409)};
  return {id,key,node,raw};
}

function nonceHex() {
  const b=crypto.getRandomValues(new Uint8Array(16));
  return toHex(b);
}

async function manifest(env,identity,nowMs) {
  const {id,key,node}=identity;
  const rows=(await env.DB.prepare(
    "SELECT id,transport,listen_port,tls_hostname,ws_path FROM routes " +
    "WHERE node_id=? AND state IN ('draft','checking','ready') ORDER BY id LIMIT 8"
  ).bind(id).all()).results??[];
  const routes=[];
  for(const r of rows) {
    if(!Number.isInteger(r.listen_port)||r.listen_port<1||r.listen_port>65535)
      continue;
    const route={id:r.id,transport:r.transport,listen_port:r.listen_port};
    if(r.transport==='wss') {
      if(!r.tls_hostname || !r.ws_path) continue;
      route.tls_hostname=r.tls_hostname;
      route.ws_path=r.ws_path;
    }
    routes.push(route);
  }
  if(!routes.length) return safeJson({error:'no_desired_routes'},409);
  const issued=Math.floor(nowMs/1000);
  const payload={
    node_id:id,revision:node.desired_revision,issued_at:issued,expires_at:issued+300,
    nonce:nonceHex(),routes,user_limit:node.user_limit,byte_limit:node.byte_limit,
  };
  const signature=base64Url(await hmac(key,canonical(payload)));
  return safeJson({payload,signature,status:'provisioning_not_connected'});
}

async function ack(env,identity,nowMs) {
  let data;
  try {data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(identity.raw));}
  catch {return safeJson({error:'bad_request'},400);}
  const revision=data?.revision,code=data?.status,hash=data?.digest;
  if(!Number.isSafeInteger(revision)||revision<1||
     !['accepted','rejected'].includes(code)||typeof hash!=='string'||!HEX64.test(hash))
    return safeJson({error:'bad_request'},400);
  if(revision!==identity.node.desired_revision) return safeJson({error:'stale_revision'},409);
  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO node_acks(node_id,revision,digest,status,observed_ms) VALUES(?,?,?,?,?)')
      .bind(identity.id,revision,hash,code,nowMs),
    env.DB.prepare(
      'UPDATE nodes SET acked_revision=? WHERE id=? AND desired_revision=? AND acked_revision<? AND ?=?'
    ).bind(revision,identity.id,revision,revision,code,'accepted'),
  ]);
  return safeJson({ok:true,route_ready:false});
}

/** The V1-style runtime handshake: desired clients are served only to the
 * authenticated node; the node must apply both REALITY listeners before
 * acknowledging individual UUIDs. A manifest alone NEVER activates users. */
async function clientManifest(env,identity,nowMs) {
  if(!env.SUBSCRIPTION_CREDENTIAL_KEY)return safeJson({error:'not_configured'},503);
  const rows=(await env.DB.prepare(
    "SELECT s.id,s.state,s.expires_at,s.max_bytes,s.used_bytes,c.ciphertext_b64,c.nonce_b64,c.key_version "+
    "FROM node_allocations a JOIN subscriptions s ON s.id=a.subscription_id "+
    "JOIN subscription_credentials c ON c.subscription_id=s.id "+
    "JOIN customers u ON u.telegram_id=s.owner_telegram_id "+
    "WHERE a.node_id=? AND a.state IN ('reserved','active') "+
    "AND s.state IN ('pending','active') AND u.state='active' "+
    "AND s.max_bytes>s.used_bytes AND (s.state='pending' OR s.expires_at>?) "+
    "ORDER BY s.id LIMIT 1001"
  ).bind(identity.id,nowMs).all()).results??[];
  if(rows.length>1000||rows.length>identity.node.user_limit)
    return safeJson({error:'capacity_exceeded'},409);
  const clients=[];
  try {
    for(const row of rows) {
      if(row.key_version!==1)return safeJson({error:'credential_unavailable'},503);
      const uuid=await unwrapClientUuid(row,env.SUBSCRIPTION_CREDENTIAL_KEY);
      clients.push({subscription_id:row.id,uuid,
        expires_at:row.state==='pending'?nowMs+120000:row.expires_at,
        quota_bytes:row.max_bytes,used_bytes:row.used_bytes,
        remaining_bytes:row.max_bytes-row.used_bytes});
    }
  }catch{return safeJson({error:'credential_unavailable'},503);}
  const issued=Math.floor(nowMs/1000);
  const payload={node_id:identity.id,revision:identity.node.desired_revision,
    issued_at:issued,expires_at:issued+120,
    mode:identity.node.lifecycle==='ready'?'commercial':'test',clients};
  const signature=base64Url(await hmac(identity.key,canonical(payload)));
  return safeJson({payload,signature,applied:false});
}

async function clientAck(env,identity,nowMs) {
  if(!env.SUBSCRIPTION_CREDENTIAL_KEY)return safeJson({error:'not_configured'},503);
  let b;
  try{b=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(identity.raw));}
  catch{return safeJson({error:'bad_request'},400);}
  const members=b?.clients;
  if(!Number.isSafeInteger(b?.revision)||b.revision!==identity.node.desired_revision||
     b.revision!==identity.node.acked_revision||identity.node.lifecycle!=='ready'||
     b.xray_healthy!==true||!Array.isArray(b.ports)||
     b.ports.length!==2||b.ports[0]!==443||b.ports[1]!==8443||
     !Array.isArray(members)||members.length<1||members.length>100||
     new Set(members.map(x=>x?.subscription_id)).size!==members.length)
    return safeJson({error:'not_ready'},409);
  const commands=[];
  for(const member of members) {
    if(typeof member?.subscription_id!=='string'||member.subscription_id.length>80||
       !HEX64.test(member?.uuid_sha256??''))
      return safeJson({error:'bad_request'},400);
    const row=await env.DB.prepare(
      "SELECT c.ciphertext_b64,c.nonce_b64,c.key_version,s.state,s.order_id,s.expires_at,"+
      "o.state AS order_state,p.duration_days,s.owner_telegram_id "+
      "FROM node_allocations a JOIN subscriptions s ON s.id=a.subscription_id "+
      "JOIN subscription_credentials c ON c.subscription_id=s.id "+
      "JOIN customers u ON u.telegram_id=s.owner_telegram_id "+
      "LEFT JOIN orders o ON o.id=s.order_id "+
      "LEFT JOIN plans p ON p.id=o.plan_id "+
      "WHERE a.node_id=? AND a.subscription_id=? AND a.state IN ('reserved','active') "+
      "AND s.state IN ('pending','active') AND u.state='active' "+
      "AND s.max_bytes>s.used_bytes AND (s.state='pending' OR s.expires_at>?)"
    ).bind(identity.id,member.subscription_id,nowMs).first();
    if(!row||row.key_version!==1)return safeJson({error:'not_allocated'},409);
    let uuid;
    try{uuid=await unwrapClientUuid(row,env.SUBSCRIPTION_CREDENTIAL_KEY);}
    catch{return safeJson({error:'credential_unavailable'},503);}
    const current=toHex(await digest(encoder.encode(uuid)));
    if(!sameMacHex(current,member.uuid_sha256))
      return safeJson({error:'credential_mismatch'},409);
    if(row.state==='pending') {
      if(row.order_state!=='provisioning'||!Number.isSafeInteger(row.duration_days)||
         row.duration_days<1||row.duration_days>366)return safeJson({error:'order_not_ready'},409);
      const expires=nowMs+row.duration_days*86400000;
      commands.push(env.DB.prepare(
        "UPDATE node_allocations SET state='active' WHERE node_id=? "+
        "AND subscription_id=? AND state='reserved'"
      ).bind(identity.id,member.subscription_id));
      commands.push(env.DB.prepare(
        "UPDATE subscriptions SET state='active',expires_at=? "+
        "WHERE id=? AND state='pending' AND order_id=?"
      ).bind(expires,member.subscription_id,row.order_id));
      commands.push(env.DB.prepare(
        "UPDATE orders SET state='fulfilled',updated_at=CURRENT_TIMESTAMP "+
        "WHERE id=? AND state='provisioning'"
      ).bind(row.order_id));
      commands.push(env.DB.prepare(
        "INSERT OR IGNORE INTO telegram_notifications(id,chat_id,body,state,due_ms) "+
        "VALUES(?,?,?,'pending',?)"
      ).bind('client-active:'+member.subscription_id,row.owner_telegram_id,
        '✅ اشتراک مدار فعال شد. کانفیگ را از بخش «اشتراک‌های من» دریافت کنید.',nowMs));
    }
    commands.push(env.DB.prepare(
      "INSERT INTO node_client_acks(node_id,subscription_id,revision,credential_sha256,observed_ms) "+
      "VALUES(?,?,?,?,?) ON CONFLICT(node_id,subscription_id) DO UPDATE SET "+
      "revision=excluded.revision,credential_sha256=excluded.credential_sha256,"+
      "observed_ms=excluded.observed_ms"
    ).bind(identity.id,member.subscription_id,b.revision,current,nowMs));
  }
  await env.DB.batch(commands);
  return safeJson({ok:true,applied:members.length});
}
function sameMacHex(a,b) {
  if(typeof a!=='string'||typeof b!=='string'||a.length!==b.length)return false;
  let diff=0;for(let i=0;i<a.length;i++)diff|=a.charCodeAt(i)^b.charCodeAt(i);
  return diff===0;
}

export async function nodeRoute(request,env,nowMs=Date.now()) {
  const path=new URL(request.url).pathname;
  if(path==='/api/node/v1/manifest' && request.method==='GET') {
    const auth=await authenticatedNode(request,env,nowMs);
    return auth.error??manifest(env,auth,nowMs);
  }
  if(path==='/api/node/v1/ack' && request.method==='POST') {
    const auth=await authenticatedNode(request,env,nowMs);
    return auth.error??ack(env,auth,nowMs);
  }
  if(path==='/api/node/v1/clients' && request.method==='GET') {
    const auth=await authenticatedNode(request,env,nowMs);
    return auth.error??clientManifest(env,auth,nowMs);
  }
  if(path==='/api/node/v1/clients/ack' && request.method==='POST') {
    const auth=await authenticatedNode(request,env,nowMs);
    return auth.error??clientAck(env,auth,nowMs);
  }
  return safeJson({error:'not_found'},404);
}
