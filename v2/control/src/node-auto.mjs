/** V2 staging-only server enrollment and remote installer orchestration.
 * Server access is via pre-authorized SSH key in GitHub Actions Secrets.
 * Never receive root passwords, SSH private keys or shell code in Telegram.
 * Installation does not imply mobile carrier acceptance or enable sales.
 */
import {wrapClientUuid,unwrapClientUuid,tokenDigest} from './subscription.mjs';
import {base64Feed} from './carrier-subscription.mjs';

const ID=/^test-[A-Za-z0-9_-]{2,55}$/;
const ERROR=/^[A-Z0-9_]{3,64}$/;
const PUB=/^[A-Za-z0-9_-]{43}$/;
const SID=/^[a-f0-9]{2,16}$/;
const TOKEN=/^[A-Za-z0-9_-]{43}$/;
const EXACT_COMMIT='ec9a19f5cf1925e2ab7b114c35f29345d508f4ba';
const WFLOW='madar-v2-node-provision.yml';

export function publicV4(input) {
  if(typeof input!=='string')return false;
  const p=input.split('.');
  if(p.length!==4||p.some(x=>!/^(0|[1-9]\d{0,2})$/.test(x)||Number(x)>255))return false;
  const n=p.map(Number),[a,b,c]=n;
  return a!==0&&a!==10&&a!==127&&a!==169&&a!==172&&a!==192&&a!==198&&
    a!==224&&a!==225&&a!==226&&a!==227&&a!==228&&a!==229&&
    a!==230&&a!==231&&a!==232&&a!==233&&a!==234&&a!==235&&
    a!==236&&a!==237&&a!==238&&a!==239&&a!==240&&a!==241&&
    a!==242&&a!==243&&a!==244&&a!==245&&a!==246&&a!==247&&
    a!==248&&a!==249&&a!==250&&a!==251&&a!==252&&a!==253&&
    a!==254&&a!==255&&!(a===100&&b>=64&&b<=127)&&
    !(a===172&&b>=16&&b<=31)&&!(a===192&&b===168)&&
    !(a===192&&b===0&&c===0)&&!(a===192&&b===0&&c===2)&&
    !(a===198&&b===51&&c===100)&&!(a===203&&b===0&&c===113);
}

const toBase64url=bytes=>btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const response=(body,status=200,type='application/json; charset=utf-8')=>
  new Response(type.startsWith('application/json')?JSON.stringify(body):body,{status,headers:{
    'content-type':type,'cache-control':'private, no-store','pragma':'no-cache',
    'x-content-type-options':'nosniff','referrer-policy':'no-referrer'
  }});

export function parseAutoNode(raw){
  if(typeof raw!=='string')return null;
  const a=raw.trim().split('|').map(x=>x.trim());
  if(a.length!==6)return null;
  const [id,provider,region,users,gb,ip]=a;
  if(!ID.test(id)||!/[A-Za-z0-9_.-]{2,64}/.test(provider)||
     !/^[A-Za-z0-9_-]{2,64}$/.test(region)||!publicV4(ip)||
     !/^[1-9][0-9]{0,5}$/.test(users)||!/^([1-9][0-9]{0,5})$/.test(gb))
    return null;
  const capacity=Number(gb)*1073741824;
  if(Number(users)>100000||Number(gb)>200000||!Number.isSafeInteger(capacity))
    return null;
  if(ip==='86.54.42.66'&&id!=='test-aria01')return null;
  return {id,provider,region,users:Number(users),bytes:capacity,ip,
    mode:ip==='86.54.42.66'?'aria-cutover':'fresh'};
}

export async function enqueueAutoNode(env,actor,input,nowMs=Date.now()){
  const spec=parseAutoNode(input);
  if(!spec)return {error:'bad_input'};
  if(!env.DB)return {error:'not_ready'};
  // Never record an unusable enrollment or tell the admin installation has
  // started when an SSH runner or callback cannot actually be dispatched.
  if(env.NODE_AUTO_ENABLED!=='true'||!env.NODE_AUTO_GH_TOKEN ||
     !env.NODE_PROVISION_CALLBACK_SECRET||!env.SUBSCRIPTION_CREDENTIAL_KEY)
    return {error:'automation_not_configured'};
  const id=crypto.randomUUID();
  try{
    await env.DB.batch([
      env.DB.prepare("INSERT INTO nodes(id,provider,region,lifecycle,user_limit,byte_limit,desired_revision,acked_revision) VALUES(?,?,?,'enrolling',?,?,1,0)")
        .bind(spec.id,spec.provider,spec.region,spec.users,spec.bytes),
      env.DB.prepare("INSERT INTO node_bootstrap_jobs(id,node_id,ip,owner_id,mode,state,created_ms,updated_ms) VALUES(?,?,?,?,?,'pending',?,?)")
        .bind(id,spec.id,spec.ip,actor,spec.mode,nowMs,nowMs),
      env.DB.prepare("INSERT INTO audit_events(event_id,actor_id,object_type,object_id,verb) VALUES(?,?,?,?,?)")
        .bind('autonode:'+spec.id,actor,'node',spec.id,'enroll:queued'),
    ]);
  }catch{return {error:'already_exists'};}
  const dispatched=await tryDispatch(env,{id,node_id:spec.id,ip:spec.ip,mode:spec.mode},nowMs);
  return {id:spec.id,jobId:id,dispatched};
}

export async function tryDispatch(env,job,nowMs=Date.now(),send=fetch){
  if(env.NODE_AUTO_ENABLED!=='true'||!env.NODE_AUTO_GH_TOKEN||
     !env.NODE_PROVISION_CALLBACK_SECRET||!env.SUBSCRIPTION_CREDENTIAL_KEY)
    return false;
  if(!ID.test(job.node_id)||!publicV4(job.ip)||
     !['aria-cutover','fresh'].includes(job.mode))return false;
  const claimed=await env.DB.prepare(
    "UPDATE node_bootstrap_jobs SET state='dispatching',updated_ms=? WHERE id=? AND state='pending'"
  ).bind(nowMs,job.id).run();
  if(claimed.meta?.changes!==1)return false;
  try{
    const r=await send('https://api.github.com/repos/alireza-anari/madar-vpn/actions/workflows/'+WFLOW+'/dispatches',{
      method:'POST',headers:{
        'authorization':'Bearer '+env.NODE_AUTO_GH_TOKEN,
        'accept':'application/vnd.github+json',
        'x-github-api-version':'2022-11-28','user-agent':'madar-v2-staging',
        'content-type':'application/json',
      },body:JSON.stringify({ref:'main',inputs:{
        job_id:job.id,node_id:job.node_id,ip:job.ip,mode:job.mode,
        pinned_sha:EXACT_COMMIT,
      }}),signal:AbortSignal.timeout(10000),
    });
    if(!r.ok)throw Error('dispatch');
    await env.DB.prepare("UPDATE node_bootstrap_jobs SET state='dispatched',updated_ms=? WHERE id=? AND state='dispatching'")
      .bind(nowMs,job.id).run();
    return true;
  }catch{
    // A network timeout after GitHub accepted dispatch can cause a retry.
    // The remote runner MUST use a strict per-node lock/idempotency guard.
    await env.DB.prepare(
      "UPDATE node_bootstrap_jobs SET state='pending',updated_ms=? WHERE id=? AND state='dispatching'"
    ).bind(nowMs,job.id).run();
    return false;
  }
}

export async function retryPending(env,nowMs=Date.now()){
  if(env.NODE_AUTO_ENABLED!=='true'||!env.DB)return;
  const rows=(await env.DB.prepare(
    "SELECT id,node_id,ip,mode FROM node_bootstrap_jobs WHERE state='pending' ORDER BY created_ms LIMIT 2"
  ).all()).results??[];
  for(const job of rows)await tryDispatch(env,job,nowMs);
}

async function matchesSecret(raw,expected){
  if(typeof raw!=='string'||typeof expected!=='string'||expected.length<32||
     raw.length!==expected.length)return false;
  let diff=0;
  for(let i=0;i<raw.length;i++)diff|=raw.charCodeAt(i)^expected.charCodeAt(i);
  return diff===0;
}

function validReport(b){
  if(!b||typeof b!=='object'||!ID.test(b.node_id)||
    !/^[0-9a-f-]{36}$/.test(b.job_id??'')||!publicV4(b.ip))return false;
  if(b.status==='failed')return ERROR.test(b.error_code??'');
  return b.status==='installed'&&PUB.test(b.public_key??'')&&
    SID.test(b.short_id??'')&&
    /^(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,63}$/.test(b.server_name??'')&&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(b.uuid??'');
}

export async function reportInstall(req,env,nowMs=Date.now(),completionStatements=[]){
  if(req.method!=='POST'||env.NODE_AUTO_ENABLED!=='true'||!env.DB||
     !env.NODE_PROVISION_CALLBACK_SECRET||!env.SUBSCRIPTION_CREDENTIAL_KEY)
    return response({error:'not_found'},404);
  if(!await matchesSecret(req.headers.get('x-madar-deploy-auth'),
      env.NODE_PROVISION_CALLBACK_SECRET))
    return response({error:'unauthorized'},401);
  if(Number(req.headers.get('content-length'))>2048)return response({error:'large'},413);
  let data;
  try{
    const payload=await req.text();
    if(payload.length>2048)return response({error:'large'},413);
    data=JSON.parse(payload);
  }catch{return response({error:'bad_request'},400);}
  if(!validReport(data))return response({error:'bad_request'},400);
  const job=await env.DB.prepare(
    "SELECT id,node_id,ip,mode,state FROM node_bootstrap_jobs WHERE id=? AND node_id=? AND ip=?"
  ).bind(data.job_id,data.node_id,data.ip).first();
  if(!job||!['dispatched','dispatching'].includes(job.state))
    return response({error:'not_pending'},409);
  if(data.status==='failed'){
    await env.DB.batch([env.DB.prepare(
      "UPDATE node_bootstrap_jobs SET state='failed',error_code=?,updated_ms=? WHERE id=? AND state IN ('dispatched','dispatching')"
    ).bind(data.error_code,nowMs,job.id),...completionStatements]);
    return response({accepted:true,installed:false});
  }
  const encoded=await wrapClientUuid(data.uuid,env.SUBSCRIPTION_CREDENTIAL_KEY);
  const route=data.node_id+'_reality';
  const statements=[
    env.DB.prepare(
      "INSERT INTO routes(id,node_id,transport,state,listen_port,operator_hint) VALUES(?,?,'reality','checking',8443,NULL)"
    ).bind(route,data.node_id),
    env.DB.prepare(
      "INSERT INTO route_endpoints(route_id,host,port,server_name,reality_public_key,reality_short_id,published) VALUES(?,?,?,?,?,?,0)"
    ).bind(route,data.ip,8443,data.server_name,data.public_key,data.short_id),
    ...[['mci',443],['irancell',8443]].map(([operator,port])=>
      env.DB.prepare(
        "INSERT INTO route_carrier_variants(route_id,operator,host,port,server_name,reality_public_key,reality_short_id,published,verified_ms) VALUES(?,?,?,?,?,?,?,0,NULL)"
      ).bind(route,operator,data.ip,port,data.server_name,data.public_key,data.short_id)),
    env.DB.prepare(
      "INSERT INTO node_trial_credentials(node_id,ciphertext_b64,nonce_b64,key_version,created_ms) VALUES(?,?,?,?,?)"
    ).bind(data.node_id,encoded.ciphertext_b64,encoded.nonce_b64,1,nowMs),
    env.DB.prepare("UPDATE nodes SET lifecycle='provisioning' WHERE id=? AND lifecycle='enrolling'")
      .bind(data.node_id),
    env.DB.prepare(
      "UPDATE node_bootstrap_jobs SET state='installed',updated_ms=? WHERE id=? AND state IN ('dispatched','dispatching')"
    ).bind(nowMs,job.id),
    ...completionStatements,
  ];
  try{await env.DB.batch(statements);}
  catch{return response({error:'write_failed'},503);}
  return response({accepted:true,installed:true,carrier_field_verified:false});
}

export async function issueTrialLink(env,owner,nodeId,nowMs=Date.now()){
  if(!env.DB||!env.SUBSCRIPTION_CREDENTIAL_KEY||
     !/^[0-9]{1,20}$/.test(owner??'')||!ID.test(nodeId))return null;
  const base=env.SUBSCRIPTION_PUBLIC_ORIGIN;
  if(typeof base!=='string'||!/^https:\/\/[a-z0-9.-]+$/i.test(base))return null;
  const job=await env.DB.prepare(
    "SELECT node_id FROM node_bootstrap_jobs WHERE node_id=? AND owner_id=? AND state='installed'"
  ).bind(nodeId,owner).first();
  if(!job)return null;
  const entropy=crypto.getRandomValues(new Uint8Array(32));
  const token=toBase64url(entropy);
  const digest=await tokenDigest(token);
  await env.DB.prepare(
    "INSERT INTO node_trial_links(token_hash,node_id,owner_id,expires_ms) VALUES(?,?,?,?)"
  ).bind(digest,nodeId,owner,nowMs+3600000).run();
  return base+'/t/'+token;
}

export async function getTrialFeed(req,env,nowMs=Date.now()){
  if(req.method!=='GET'||!env.DB||!env.SUBSCRIPTION_CREDENTIAL_KEY)
    return response('Not ready',503,'text/plain; charset=utf-8');
  const u=new URL(req.url),token=u.pathname.startsWith('/t/')?u.pathname.slice(3):'';
  if(u.search||u.hash||!TOKEN.test(token))
    return response('Not found',404,'text/plain; charset=utf-8');
  const h=await tokenDigest(token);
  const trial=await env.DB.prepare(
    "SELECT l.node_id FROM node_trial_links l JOIN node_bootstrap_jobs j ON j.node_id=l.node_id WHERE l.token_hash=? AND l.expires_ms>? AND j.state='installed'"
  ).bind(h,nowMs).first();
  if(!trial)return response('Expired',403,'text/plain; charset=utf-8');
  const c=await env.DB.prepare(
    "SELECT ciphertext_b64,nonce_b64,key_version FROM node_trial_credentials WHERE node_id=?"
  ).bind(trial.node_id).first();
  if(!c||c.key_version!==1)return response('Not ready',503,'text/plain; charset=utf-8');
  const routes=(await env.DB.prepare(
    "SELECT operator,host,port,server_name,reality_public_key,reality_short_id FROM route_carrier_variants WHERE route_id=? ORDER BY operator"
  ).bind(trial.node_id+'_reality').all()).results??[];
  const uuid=await unwrapClientUuid(c,env.SUBSCRIPTION_CREDENTIAL_KEY);
  const snapshot={client:{uuid},routes:routes.map(x=>({
    id:trial.node_id+':'+x.operator,transport:'reality',operator_hint:x.operator,
    endpoint:{host:x.host,port:x.port},
    tls:{server_name:x.server_name,reality_public_key:x.reality_public_key,short_id:x.reality_short_id},
  }))};
  const feed=base64Feed(snapshot);
  return feed===null
    ?response('Not ready',503,'text/plain; charset=utf-8')
    :response(feed,200,'text/plain; charset=utf-8');
}
