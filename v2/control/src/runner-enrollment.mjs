import {publicV4,reportInstall} from './node-auto.mjs';
import {verifyTelegramSecret} from './telegram.mjs';

const enc=new TextEncoder();
const hex=bytes=>Array.from(new Uint8Array(bytes),x=>x.toString(16).padStart(2,'0')).join('');
export async function hmac(key,value){
  const k=await crypto.subtle.importKey('raw',typeof key==='string'?enc.encode(key):key,{name:'HMAC',hash:'SHA-256'},false,['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC',k,enc.encode(value)));
}
export async function authenticateOwner(raw,env,nowMs=Date.now()){
  if(typeof raw!=='string'||raw.length>8192||!env.BOT_TOKEN)return null;
  try{
    const p=new URLSearchParams(raw);
    if([...p.keys()].some((k,i,a)=>a.indexOf(k)!==i))return null;
    const hash=p.get('hash');p.delete('hash');
    const date=Number(p.get('auth_date')),now=Math.floor(nowMs/1000);
    if(!Number.isSafeInteger(date)||date>now+30||date<now-600||!/^\d+$/.test(p.get('auth_date')??''))return null;
    const text=[...p].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>k+'='+v).join('\n');
    const expected=hex(await hmac(await hmac('WebAppData',env.BOT_TOKEN),text));
    if(!/^[a-f0-9]{64}$/.test(hash??'')||!await verifyTelegramSecret(hash,expected))return null;
    const user=JSON.parse(p.get('user'));
    if(!Number.isSafeInteger(user.id)||user.id<1||user.is_bot)return null;
    const id=String(user.id);
    return (env.ADMIN_TELEGRAM_IDS??'').split(',').map(x=>x.trim()).includes(id)?id:null;
  }catch{return null;}
}
export function validateConnection(b){
  if(!b||!/^test-[A-Za-z0-9_-]{2,55}$/.test(b.nodeId??'')||
     !/^[A-Za-z0-9_.-]{2,64}$/.test(b.provider??'')||! /^[A-Za-z0-9_-]{2,64}$/.test(b.region??'')||
     !publicV4(b.ip)||!Number.isInteger(b.port)||b.port<1||b.port>65535||
     !/^[a-z_][a-z0-9_-]{0,31}$/.test(b.username??'')||
     !Number.isInteger(b.userLimit)||b.userLimit<1||b.userLimit>100000||
     !Number.isInteger(b.capacityGb)||b.capacityGb<1||b.capacityGb>200000)return null;
  if(b.ip==='86.54.42.66'&&b.nodeId!=='test-aria01')return null;
  return {nodeId:b.nodeId,provider:b.provider,region:b.region,ip:b.ip,port:b.port,
    username:b.username,userLimit:b.userLimit,capacityGb:b.capacityGb,
    mode:b.ip==='86.54.42.66'?'aria-cutover':'fresh'};
}
export function validEnvelope(b){
  const base64=s=>typeof s==='string'&&/^[A-Za-z0-9+/]+={0,2}$/.test(s)&&s.length%4===0;
  return !!b&&Object.keys(b).sort().join(',')==='data,iv,key,v'&&b.v===1&&
    base64(b.key)&&b.key.length>=344&&b.key.length<=1024&&
    base64(b.iv)&&b.iv.length===16&&base64(b.data)&&b.data.length>=24&&b.data.length<=18000;
}
export const reply=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{
  'content-type':'application/json; charset=utf-8','cache-control':'no-store',
  'x-content-type-options':'nosniff','referrer-policy':'no-referrer'}});
async function body(req){
  if(!/^application\/json(?:;|$)/i.test(req.headers.get('content-type')??''))throw Error('BAD_BODY');
  const reader=req.body?.getReader();if(!reader)throw Error('BAD_BODY');
  let bytes=0,text='';const decoder=new TextDecoder();
  try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.length;
    if(bytes>24000){await reader.cancel();throw Error('BODY_LIMIT');}text+=decoder.decode(value,{stream:true});}
    return JSON.parse(text+decoder.decode());}finally{reader.releaseLock();}
}
export async function cleanupRunnerJobs(db,now){
  // Leased expired jobs are terminal, never retried while an old installer may still run.
  await db.prepare("UPDATE v2_runner_jobs SET state='failed',safe_code='EXPIRED',encrypted_credentials=NULL WHERE state IN ('queued','leased') AND (expires_ms<=? OR (state='leased' AND lease_until_ms<=?))").bind(now,now).run();
}
export async function enrollmentApi(req,env,now=Date.now()){
  if(!env.DB||env.RUNNER_ENROLLMENT_ENABLED!=='true')return reply({error:'RUNNER_NOT_CONFIGURED'},503);
  const actor=await authenticateOwner(req.headers.get('x-telegram-init-data'),env,now);
  if(!actor)return reply({error:'AUTH_EXPIRED'},401);
  const path=new URL(req.url).pathname;
  await cleanupRunnerJobs(env.DB,now);
  if(path==='/api/enrollment/session'&&req.method==='GET'){
    const presence=await env.DB.prepare('SELECT MAX(last_seen_ms) AS seen FROM v2_runner_presence').first();
    let publicKey;try{publicKey=JSON.parse(env.RUNNER_PUBLIC_KEY);}catch{}
    if(!publicKey||!env.RUNNER_SERVICE_SECRET||!presence?.seen||presence.seen<now-60000)
      return reply({error:'RUNNER_OFFLINE'},503);
    return reply({publicKey});
  }
  if(path.startsWith('/api/enrollment/jobs/')&&req.method==='GET'){
    const id=path.slice('/api/enrollment/jobs/'.length);
    const job=await env.DB.prepare('SELECT id,kind,state,safe_code,fingerprint FROM v2_runner_jobs WHERE id=? AND owner_id=?')
      .bind(id,actor).first();return job?reply(job):reply({error:'NOT_FOUND'},404);
  }
  if(req.method!=='POST')return reply({error:'NOT_FOUND'},404);
  let b;try{b=await body(req);}catch{return reply({error:'BAD_BODY'},400);}
  if(path==='/api/enrollment/probe'){
    const spec=validateConnection(b);if(!spec)return reply({error:'INVALID_TARGET'},400);
    const presence=await env.DB.prepare('SELECT MAX(last_seen_ms) AS seen FROM v2_runner_presence').first();
    if(!presence?.seen||presence.seen<now-60000)return reply({error:'RUNNER_OFFLINE'},503);
    const active=await env.DB.prepare("SELECT id FROM v2_runner_jobs WHERE owner_id=? AND state IN ('queued','leased') LIMIT 1").bind(actor).first();
    if(active)return reply({error:'JOB_ALREADY_PENDING',id:active.id},409);
    const id=crypto.randomUUID();
    await env.DB.prepare("INSERT INTO v2_runner_jobs(id,owner_id,kind,spec_json,state,created_ms,expires_ms) VALUES(?,?,'probe',?,'queued',?,?)")
      .bind(id,actor,JSON.stringify(spec),now,now+600000).run();return reply({id});
  }
  if(path==='/api/enrollment/install'){
    if(!validEnvelope(b.envelope)||b.trust!==true||!/^SHA256:[A-Za-z0-9+/]{43}$/.test(b.fingerprint??''))
      return reply({error:'ENCRYPTED_CREDENTIALS_REQUIRED'},400);
    const probe=await env.DB.prepare("SELECT id,spec_json,fingerprint FROM v2_runner_jobs WHERE id=? AND owner_id=? AND kind='probe' AND state='ready' AND expires_ms>?")
      .bind(b.probeId,actor,now).first();
    if(!probe||probe.fingerprint!==b.fingerprint)return reply({error:'PROBE_REQUIRED'},409);
    const existing=await env.DB.prepare("SELECT id FROM v2_runner_jobs WHERE probe_id=?").bind(probe.id).first();
    if(existing)return reply({id:existing.id});
    const spec=JSON.parse(probe.spec_json),id=crypto.randomUUID();
    try{await env.DB.batch([
      env.DB.prepare("INSERT INTO nodes(id,provider,region,lifecycle,user_limit,byte_limit,desired_revision,acked_revision) VALUES(?,?,?,'enrolling',?,?,1,0)")
        .bind(spec.nodeId,spec.provider,spec.region,spec.userLimit,spec.capacityGb*1073741824),
      env.DB.prepare("INSERT INTO node_bootstrap_jobs(id,node_id,ip,owner_id,mode,state,created_ms,updated_ms) VALUES(?,?,?,?,?,'dispatching',?,?)")
        .bind(id,spec.nodeId,spec.ip,actor,spec.mode,now,now),
      env.DB.prepare("INSERT INTO v2_runner_jobs(id,owner_id,kind,spec_json,probe_id,fingerprint,encrypted_credentials,state,created_ms,expires_ms) VALUES(?,?,'v2-install',?,?,?,?,'queued',?,?)")
        .bind(id,actor,probe.spec_json,probe.id,probe.fingerprint,JSON.stringify(b.envelope),now,now+900000),
    ]);}catch{return reply({error:'NODE_ALREADY_EXISTS'},409);}
    return reply({id});
  }
  return reply({error:'NOT_FOUND'},404);
}
export async function runnerApi(req,env,now=Date.now()){
  if(!env.DB||env.RUNNER_ENROLLMENT_ENABLED!=='true')return reply({error:'DISABLED'},503);
  if(req.method==='GET'&&new URL(req.url).pathname==='/api/runner/pair'){
    const row=await env.DB.prepare("SELECT envelope_json FROM v2_runner_pairing WHERE id='existing-runner' AND expires_ms>?").bind(now).first();
    return row?reply({envelope:JSON.parse(row.envelope_json)}):reply({error:'PAIRING_UNAVAILABLE'},404);
  }
  if(!env.RUNNER_SERVICE_SECRET||env.RUNNER_SERVICE_SECRET.length<32||
    !await verifyTelegramSecret(req.headers.get('authorization'), 'Bearer '+env.RUNNER_SERVICE_SECRET))
    return reply({error:'UNAUTHORIZED'},401);
  if(req.method!=='POST')return reply({error:'NOT_FOUND'},404);
  let b;try{b=await body(req);}catch{return reply({error:'BAD_BODY'},400);}
  const action=new URL(req.url).pathname.slice('/api/runner/'.length);
  await cleanupRunnerJobs(env.DB,now);
  if(action==='lease'){
    if(!/^[A-Za-z0-9_-]{3,64}$/.test(b.runnerId??''))return reply({error:'BAD_RUNNER'},400);
    await env.DB.prepare('INSERT INTO v2_runner_presence(id,last_seen_ms) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET last_seen_ms=excluded.last_seen_ms').bind(b.runnerId,now).run();
    await env.DB.prepare("DELETE FROM v2_runner_pairing WHERE id='existing-runner'").run();
    const lease=crypto.randomUUID();
    const row=await env.DB.prepare("UPDATE v2_runner_jobs SET state='leased',lease_id=?,lease_until_ms=? WHERE id=(SELECT id FROM v2_runner_jobs WHERE state='queued' AND expires_ms>? ORDER BY created_ms LIMIT 1) AND state='queued' RETURNING *")
      .bind(lease,now+90000,now).first();
    let job=null;
    if(row){const s=JSON.parse(row.spec_json);job={id:row.id,leaseId:lease,kind:row.kind,
      nodeId:s.nodeId,targetIp:s.ip,port:s.port,username:s.username,mode:s.mode,
      hostFingerprint:row.fingerprint,encryptedCredentials:row.encrypted_credentials,
      credentialsExpireAt:Math.floor(row.expires_ms/1000)};}
    const payload=JSON.stringify(job);return reply({payload,signature:hex(await hmac(env.RUNNER_SERVICE_SECRET,payload))});
  }
  const row=await env.DB.prepare("SELECT * FROM v2_runner_jobs WHERE id=? AND lease_id=? AND state='leased' AND lease_until_ms>? AND expires_ms>?")
    .bind(b.id,b.leaseId,now,now).first();
  if(!row){
    // The sender may have lost the first acknowledgement after a committed transaction.
    const done=action==='report'&&['ready','failed'].includes(b.state)?await env.DB.prepare(
      "SELECT id FROM v2_runner_jobs WHERE id=? AND lease_id=? AND state=?"
    ).bind(b.id,b.leaseId,b.state).first():null;
    return done?reply({ok:true}):reply({error:'LEASE_EXPIRED'},409);
  }
  if(action==='renew'){
    await env.DB.prepare("UPDATE v2_runner_jobs SET lease_until_ms=? WHERE id=? AND lease_id=? AND state='leased' AND lease_until_ms>?")
      .bind(now+90000,row.id,b.leaseId,now).run();return reply({ok:true});
  }
  if(action!=='report'||!['ready','failed'].includes(b.state))return reply({error:'BAD_REPORT'},400);
  const fingerprint=b.details?.fingerprint;
  if(b.state==='ready'&&row.kind==='probe'&&!/^SHA256:[A-Za-z0-9+/]{43}$/.test(fingerprint??''))return reply({error:'BAD_FINGERPRINT'},400);
  const code=b.state==='ready'?'OK':'INSTALLATION_FAILED';
  const completion=env.DB.prepare("UPDATE v2_runner_jobs SET state=?,safe_code=?,fingerprint=COALESCE(?,fingerprint),encrypted_credentials=NULL,lease_until_ms=0 WHERE id=? AND lease_id=? AND state='leased'")
    .bind(b.state,code,row.kind==='probe'?fingerprint??null:null,row.id,b.leaseId);
  if(row.kind==='v2-install'){
    const spec=JSON.parse(row.spec_json);
    const result=await reportInstall(new Request('https://internal/report',{method:'POST',headers:{'x-madar-deploy-auth':env.RUNNER_SERVICE_SECRET},body:JSON.stringify({
      ...b.details,job_id:row.id,node_id:spec.nodeId,ip:spec.ip,status:b.state==='ready'?'installed':'failed',error_code:'INSTALLATION_FAILED'
    })}),{...env,NODE_AUTO_ENABLED:'true',NODE_PROVISION_CALLBACK_SECRET:env.RUNNER_SERVICE_SECRET},now,[completion]);
    if(!result.ok)return reply({error:'METADATA_REJECTED'},409);
  }else await completion.run();
  return reply({ok:true});
}
