import test from 'node:test';
import assert from 'node:assert/strict';
import {authenticateOwner,validateConnection,validEnvelope,enrollmentApi,runnerApi,githubExecutorReady,dispatchGithubJob} from '../src/runner-enrollment.mjs';
import worker from '../src/index.mjs';
import {DatabaseSync} from 'node:sqlite';
import {readdirSync,readFileSync} from 'node:fs';

async function initData(token,user,now,extra=[]) {
  const p=new URLSearchParams([['auth_date',String(now)],['user',JSON.stringify({id:user})],...extra]);
  const enc=new TextEncoder();
  const sign=async(k,v)=>new Uint8Array(await crypto.subtle.sign('HMAC',await crypto.subtle.importKey('raw',k,{name:'HMAC',hash:'SHA-256'},false,['sign']),enc.encode(v)));
  const key=await sign(enc.encode('WebAppData'),token);
  const sig=await sign(key,[...p].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>k+'='+v).join('\n'));
  p.set('hash',Array.from(sig,x=>x.toString(16).padStart(2,'0')).join(''));
  return p.toString();
}
test('Mini App accepts only the signed current owner, not forged, expired or duplicate data',async()=>{
  const env={BOT_TOKEN:'test-token',ADMIN_TELEGRAM_IDS:'123'};
  const raw=await initData(env.BOT_TOKEN,123,1000);
  assert.equal(await authenticateOwner(raw,env,1000000),'123');
  assert.equal(await authenticateOwner(raw.replace('1000','1001'),env,1000000),null);
  assert.equal(await authenticateOwner(raw,env,2000000),null);
  assert.equal(await authenticateOwner(raw,env,900000),null);
  assert.equal(await authenticateOwner(await initData(env.BOT_TOKEN,456,1000),env,1000000),null);
  assert.equal(await authenticateOwner(raw+'&auth_date=1000',env,1000000),null);
});
test('fresh AWS connection validation rejects shell injection and private targets',()=>{
  const good={nodeId:'test-aws01',provider:'aws',region:'eu-north-1',userLimit:20,capacityGb:500,ip:'8.8.8.8',port:22,username:'root'};
  assert.equal(validateConnection(good).mode,'fresh');
  assert.equal(validateConnection({...good,ip:'1.1.1.1'}).mode,'fresh');
  for(const diff of [{ip:'127.0.0.1'},{username:'root;id'},{port:0},{nodeId:'node1'},{provider:'x;id'},{capacityGb:0}])
    assert.equal(validateConnection({...good,...diff}),null);
});
test('credential envelope permits bounded ciphertext only, never plaintext secrets',()=>{
  assert.equal(validEnvelope({method:'password',password:'canary'}),false);
  assert.equal(validEnvelope({v:1,key:'A'.repeat(512),iv:'A'.repeat(16),data:'A'.repeat(64)}),true);
  assert.equal(validEnvelope({v:1,key:'A'.repeat(512),iv:'A'.repeat(16),data:'A'.repeat(64),password:'canary'}),false);
});

// Actual SQLite exercises claims and uniqueness; only the remote D1 transport is adapted.
function database(){
  const db=new DatabaseSync(':memory:');
  for(const f of readdirSync(new URL('../migrations/',import.meta.url)).sort())db.exec(readFileSync(new URL('../migrations/'+f,import.meta.url),'utf8'));
  const adapt=(sql,args=[])=>({bind(...a){return adapt(sql,a);},async first(){return db.prepare(sql).get(...args)??null;},async all(){return {results:db.prepare(sql).all(...args)};},async run(){return {meta:db.prepare(sql).run(...args)};},sql,args});
  return {prepare:sql=>adapt(sql),async batch(statements){db.exec('BEGIN');try{const out=[];for(const s of statements)out.push(await s.run());db.exec('COMMIT');return out;}catch(e){db.exec('ROLLBACK');throw e;}},close:()=>db.close()};
}
test('real enrollment queue binds owner, fingerprint and ciphertext, signs leases, and refuses stale reports',async()=>{
  const DB=database(),now=1000000;
  const env={DB,BOT_TOKEN:'test-token',ADMIN_TELEGRAM_IDS:'123,456',RUNNER_ENROLLMENT_ENABLED:'true',RUNNER_SERVICE_SECRET:'s'.repeat(48),RUNNER_PUBLIC_KEY:'{}'};
  const owner=await initData(env.BOT_TOKEN,123,1000),other=await initData(env.BOT_TOKEN,456,1000);
  const admin=(path,b,auth=owner,time=now)=>enrollmentApi(new Request('https://v2/api/enrollment/'+path,{method:b?'POST':'GET',headers:{'x-telegram-init-data':auth,'content-type':'application/json'},...(b?{body:JSON.stringify(b)}:{})}),env,time);
  const run=(path,b,time=now,secret=env.RUNNER_SERVICE_SECRET)=>runnerApi(new Request('https://v2/api/runner/'+path,{method:'POST',headers:{authorization:'Bearer '+secret,'content-type':'application/json'},body:JSON.stringify(b)}),env,time);
  assert.equal((await admin('session')).status,503);
  assert.equal((await run('lease',{runnerId:'runner-v2'},now,'bad')).status,401);
  await run('lease',{runnerId:'runner-v2'});
  assert.equal((await admin('session')).status,200);
  const spec={nodeId:'test-new01',provider:'aws',region:'eu-north-1',userLimit:20,capacityGb:500,ip:'8.8.8.8',port:22,username:'root'};
  const {id}=await (await admin('probe',spec)).json();
  assert.ok(id);
  assert.equal((await admin('probe',spec)).status,409);
  assert.equal((await admin('jobs/'+id,null,other)).status,404);
  const signed=await (await run('lease',{runnerId:'runner-v2'})).json();
  const k=await crypto.subtle.importKey('raw',new TextEncoder().encode(env.RUNNER_SERVICE_SECRET),{name:'HMAC',hash:'SHA-256'},false,['verify']);
  assert.equal(await crypto.subtle.verify('HMAC',k,Uint8Array.from(signed.signature.match(/../g),x=>parseInt(x,16)),new TextEncoder().encode(signed.payload)),true);
  const job=JSON.parse(signed.payload),fp='SHA256:'+'a'.repeat(43);
  assert.equal(job.kind,'probe');
  assert.equal((await run('report',{id,leaseId:'wrong',state:'ready',details:{fingerprint:fp}})).status,409);
  assert.equal((await run('report',{id,leaseId:job.leaseId,state:'ready',details:{fingerprint:fp}})).status,200);
  assert.equal((await run('report',{id,leaseId:job.leaseId,state:'failed'})).status,409);
  const install={probeId:id,trust:true,fingerprint:fp,envelope:{v:1,key:'A'.repeat(512),iv:'A'.repeat(16),data:'A'.repeat(64)}};
  assert.equal((await admin('install',{...install,fingerprint:'SHA256:'+'b'.repeat(43)})).status,409);
  const created=await (await admin('install',install)).json();assert.ok(created.id);
  assert.equal((await (await admin('install',install)).json()).id,created.id);
  const leased=JSON.parse((await (await run('lease',{runnerId:'runner-v2'})).json()).payload);
  assert.equal(leased.kind,'v2-install');assert.equal(leased.hostFingerprint,fp);
  assert.equal(JSON.parse(leased.encryptedCredentials).v,1);
  assert.equal((await run('renew',{id:created.id,leaseId:leased.leaseId},now+91000)).status,409);
  const row=await DB.prepare('SELECT state,encrypted_credentials FROM v2_runner_jobs WHERE id=?').bind(created.id).first();
  assert.equal(row.state,'failed');assert.equal(row.encrypted_credentials,null);
  DB.close();
});
test('successful install metadata and queue completion are atomic and a repeated report is acknowledged',async()=>{
  const DB=database(),now=1000000;
  const env={DB,BOT_TOKEN:'t',ADMIN_TELEGRAM_IDS:'123',RUNNER_ENROLLMENT_ENABLED:'true',RUNNER_SERVICE_SECRET:'s'.repeat(48),SUBSCRIPTION_CREDENTIAL_KEY:'A'.repeat(43)};
  const id='12345678-1234-4123-8123-123456789012',spec={nodeId:'test-new01',ip:'8.8.8.8',mode:'fresh'};
  await DB.prepare("INSERT INTO nodes(id,provider,region,lifecycle,user_limit,byte_limit) VALUES('test-new01','aws','eu-north-1','enrolling',20,500)").run();
  await DB.prepare("INSERT INTO node_bootstrap_jobs(id,node_id,ip,owner_id,mode,state,created_ms,updated_ms) VALUES(?,'test-new01','8.8.8.8','123','fresh','dispatching',?,?)").bind(id,now,now).run();
  await DB.prepare("INSERT INTO v2_runner_jobs(id,owner_id,kind,spec_json,state,lease_id,lease_until_ms,created_ms,expires_ms,encrypted_credentials) VALUES(?,'123','v2-install',?,'leased','lease',?,?,?,'ciphertext')").bind(id,JSON.stringify(spec),now+90000,now,now+900000).run();
  const b={id,leaseId:'lease',state:'ready',details:{public_key:'a'.repeat(43),short_id:'aabb',server_name:'www.cloudflare.com',uuid:'12345678-1234-4123-8123-123456789012'}};
  const req=()=>new Request('https://v2/api/runner/report',{method:'POST',headers:{authorization:'Bearer '+env.RUNNER_SERVICE_SECRET,'content-type':'application/json'},body:JSON.stringify(b)});
  const originalBatch=DB.batch.bind(DB);let includesCompletion=false;
  DB.batch=async statements=>{includesCompletion=statements.some(s=>s.sql.includes('UPDATE v2_runner_jobs'));return originalBatch(statements);};
  assert.equal((await runnerApi(req(),env,now)).status,200);
  assert.equal(includesCompletion,true);
  assert.equal((await runnerApi(req(),env,now+1000)).status,200);
  assert.equal((await DB.prepare('SELECT state FROM v2_runner_jobs WHERE id=?').bind(id).first()).state,'ready');
  assert.equal((await DB.prepare('SELECT encrypted_credentials FROM v2_runner_jobs WHERE id=?').bind(id).first()).encrypted_credentials,null);
  assert.equal((await DB.prepare('SELECT COUNT(*) AS n FROM routes').first()).n,1);
  DB.close();
});
test('Worker serves the secure form and denies unauthenticated enrollment and runner requests',async()=>{
  const page=await worker.fetch(new Request('https://v2/enroll'),{},{});
  assert.equal(page.status,200);assert.match(page.headers.get('content-type'),/text\/html/);
  assert.match(await page.text(),/crypto.subtle.encrypt/);
  const env={DB:database(),RUNNER_ENROLLMENT_ENABLED:'true'};
  assert.equal((await worker.fetch(new Request('https://v2/api/enrollment/session'),env,{})).status,401);
  assert.equal((await worker.fetch(new Request('https://v2/api/runner/lease',{method:'POST'}),env,{})).status,401);
  env.DB.close();
});

// GitHub workflow dispatch is fixed to this repository/branch and requires a
// separately configured V2 public key. V1 transport remains the default.
test('on-demand executor fails closed, dispatches only a specific signed job and does not need presence',async()=>{
  const DB=database(),now=1000000;
  const env={DB,BOT_TOKEN:'test-token',ADMIN_TELEGRAM_IDS:'123',
    RUNNER_ENROLLMENT_ENABLED:'true',V2_EXECUTOR_BACKEND:'github-actions',
    RUNNER_SERVICE_SECRET:'s'.repeat(48),
    GITHUB_ACTIONS_DISPATCH_TOKEN:'g'.repeat(48),
    RUNNER_PUBLIC_KEY:JSON.stringify({kty:'RSA',kid:'madar-v2-github-actions',alg:'RSA-OAEP-256',e:'AQAB',n:'A'.repeat(342)})};
  const owner=await initData(env.BOT_TOKEN,123,1000);
  const req=(path,b)=>new Request('https://v2/api/enrollment/'+path,{method:b?'POST':'GET',
    headers:{'x-telegram-init-data':owner,'content-type':'application/json'},
    ...(b?{body:JSON.stringify(b)}:{})});
  assert.equal(githubExecutorReady(env),true);
  assert.equal((await enrollmentApi(req('session'),env,now)).status,200);
  assert.equal(githubExecutorReady({...env,GITHUB_ACTIONS_DISPATCH_TOKEN:''}),false);
  assert.equal(githubExecutorReady({...env,RUNNER_PUBLIC_KEY:'{}'}),false);
  assert.equal((await enrollmentApi(req('session'),{...env,GITHUB_ACTIONS_DISPATCH_TOKEN:''},now)).status,503);
  let dispatched=[];
  const dispatch=async(_env,id)=>{dispatched.push(id);return true};
  const spec={nodeId:'test-aws01',provider:'aws',region:'eu-north-1',userLimit:20,capacityGb:50,ip:'8.8.8.8',port:22,username:'root'};
  const probe=await enrollmentApi(req('probe',spec),env,now,dispatch);
  assert.equal(probe.status,200);
  const {id}=await probe.json();
  assert.deepEqual(dispatched,[id]);
  const runner=b=>runnerApi(new Request('https://v2/api/runner/lease',{method:'POST',
    headers:{'authorization':'Bearer '+env.RUNNER_SERVICE_SECRET,'content-type':'application/json'},
    body:JSON.stringify(b)}),env,now);
  assert.equal((await runner({runnerId:'old-runner',jobId:id})).status,403);
  assert.equal((await runner({runnerId:'v2-github-actions'})).status,403);
  const wrong=JSON.parse((await (await runner({runnerId:'v2-github-actions',jobId:crypto.randomUUID()})).json()).payload);
  assert.equal(wrong,null);
  const job=JSON.parse((await (await runner({runnerId:'v2-github-actions',jobId:id})).json()).payload);
  assert.equal(job.id,id);
  DB.close();
});
test('on-demand dispatcher uses only the fixed V2 workflow and reports rejection',async()=>{
  const env={V2_EXECUTOR_BACKEND:'github-actions',GITHUB_ACTIONS_DISPATCH_TOKEN:'g'.repeat(48),
    RUNNER_SERVICE_SECRET:'s'.repeat(48),RUNNER_PUBLIC_KEY:JSON.stringify({kty:'RSA',kid:'madar-v2-github-actions',alg:'RSA-OAEP-256',e:'AQAB',n:'A'.repeat(342)})};
  const id='12345678-1234-4123-8123-123456789012';
  const calls=[];
  const success=await dispatchGithubJob(env,id,async(url,opts)=>{calls.push({url,opts});return {status:204}});
  assert.equal(success,true);
  assert.equal(calls.length,1);
  assert.match(calls[0].url,/v2-on-demand-executor\.yml\/dispatches$/);
  assert.deepEqual(JSON.parse(calls[0].opts.body).inputs,{job_id:id});
  assert.equal(calls[0].opts.headers.authorization,'Bearer '+env.GITHUB_ACTIONS_DISPATCH_TOKEN);
  assert.equal(await dispatchGithubJob(env,'bad-job-id',async()=>{throw Error('called')}),false);
  assert.equal(await dispatchGithubJob(env,id,async()=>({status:403})),false);
});

// No installation job must be left pending after an Actions API rejection.
test('failed GitHub Actions dispatch is terminal and blocks installation',async()=>{
  const DB=database(),now=1000000;
  const env={DB,BOT_TOKEN:'t',ADMIN_TELEGRAM_IDS:'123',RUNNER_ENROLLMENT_ENABLED:'true',
    V2_EXECUTOR_BACKEND:'github-actions',RUNNER_SERVICE_SECRET:'s'.repeat(48),
    GITHUB_ACTIONS_DISPATCH_TOKEN:'g'.repeat(48),
    RUNNER_PUBLIC_KEY:JSON.stringify({kid:'madar-v2-github-actions',kty:'RSA',alg:'RSA-OAEP-256',e:'AQAB',n:'A'.repeat(342)})};
  const owner=await initData(env.BOT_TOKEN,123,1000);
  const req=b=>new Request('https://v2/api/enrollment/probe',{method:'POST',
    headers:{'x-telegram-init-data':owner,'content-type':'application/json'},body:JSON.stringify(b)});
  const spec={nodeId:'test-aws01',provider:'aws',region:'eu-north-1',userLimit:2,
    capacityGb:5,ip:'8.8.8.8',port:22,username:'root'};
  const accepted=await enrollmentApi(req(spec),env,now,async()=>true);
  assert.equal(accepted.status,200);
  const first=await accepted.json();
  await DB.prepare("UPDATE v2_runner_jobs SET state='failed' WHERE id=?").bind(first.id).run();
  const rejected=await enrollmentApi(req(spec),env,now,async()=>false);
  assert.equal(rejected.status,503);
  const row=await DB.prepare("SELECT state,safe_code FROM v2_runner_jobs WHERE safe_code='EXECUTOR_DISPATCH_FAILED'").first();
  assert.equal(row.state,'failed');
  assert.equal(row.safe_code,'EXECUTOR_DISPATCH_FAILED');
  DB.close();
});

// Reopening the form returns the owner's last job and no sensitive material.
test('reopened enrollment form recovers own queued job without leaking credentials',async()=>{
  const DB=database(),now=1000000,secret='s'.repeat(48);
  const env={DB,BOT_TOKEN:'t',ADMIN_TELEGRAM_IDS:'123,456',RUNNER_ENROLLMENT_ENABLED:'true',
    V2_EXECUTOR_BACKEND:'github-actions',RUNNER_SERVICE_SECRET:secret,
    GITHUB_ACTIONS_DISPATCH_TOKEN:'g'.repeat(48),
    RUNNER_PUBLIC_KEY:JSON.stringify({kid:'madar-v2-github-actions',kty:'RSA',alg:'RSA-OAEP-256',e:'AQAB',n:'A'.repeat(342)})};
  const owner=await initData('t',123,1000),other=await initData('t',456,1000);
  const admin=(auth,path,b)=>enrollmentApi(new Request('https://v2/api/enrollment/'+path,{
    method:b?'POST':'GET',headers:{'x-telegram-init-data':auth,'content-type':'application/json'},
    ...(b?{body:JSON.stringify(b)}:{})}),env,now,async()=>true);
  const spec={nodeId:'test-aws01',provider:'aws',region:'eu-north-1',ip:'8.8.8.8',
    port:22,username:'root',userLimit:5,capacityGb:20};
  const created=await (await admin(owner,'probe',spec)).json();
  assert.equal((await (await admin(other,'recent')).json()).job,null);
  const response=await admin(owner,'recent');
  assert.equal(response.status,200);
  const recent=(await response.json()).job;
  assert.equal(recent.id,created.id);
  assert.equal(recent.state,'queued');
  assert.deepEqual(recent.spec,spec);
  assert.equal(JSON.stringify(recent).includes(secret),false);
  assert.equal(Object.hasOwn(recent,'encrypted_credentials'),false);
  const abort=()=>runnerApi(new Request('https://v2/api/runner/abort-queued',{
    method:'POST',headers:{authorization:'Bearer '+secret,'content-type':'application/json'},
    body:JSON.stringify({runnerId:'v2-github-actions',jobId:created.id})}),env,now);
  assert.equal((await abort()).status,200);
  assert.equal((await (await admin(owner,'recent')).json()).job.safe_code,'EXECUTOR_FAILED');
  DB.close();
});
