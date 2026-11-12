import test from 'node:test';
import assert from 'node:assert/strict';
import {authenticateOwner,validateConnection,validEnvelope,enrollmentApi,runnerApi} from '../src/runner-enrollment.mjs';
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
test('connection validation rejects shell injection, private targets and arbitrary Aria cutovers',()=>{
  const good={nodeId:'test-new01',provider:'aria',region:'eu',userLimit:20,capacityGb:500,ip:'8.8.8.8',port:22,username:'root'};
  assert.equal(validateConnection(good).mode,'fresh');
  for(const diff of [{ip:'127.0.0.1'},{username:'root;id'},{port:0},{nodeId:'node1'},{provider:'x;id'},{capacityGb:0}])
    assert.equal(validateConnection({...good,...diff}),null);
  assert.equal(validateConnection({...good,ip:'86.54.42.66'}),null);
  assert.equal(validateConnection({...good,nodeId:'test-aria01',ip:'86.54.42.66'}).mode,'aria-cutover');
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
  const spec={nodeId:'test-new01',provider:'aria',region:'eu',userLimit:20,capacityGb:500,ip:'8.8.8.8',port:22,username:'root'};
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
test('Worker serves the secure form and denies unauthenticated enrollment and runner requests',async()=>{
  const page=await worker.fetch(new Request('https://v2/enroll'),{},{});
  assert.equal(page.status,200);assert.match(page.headers.get('content-type'),/text\/html/);
  assert.match(await page.text(),/crypto.subtle.encrypt/);
  const env={DB:database(),RUNNER_ENROLLMENT_ENABLED:'true'};
  assert.equal((await worker.fetch(new Request('https://v2/api/enrollment/session'),env,{})).status,401);
  assert.equal((await worker.fetch(new Request('https://v2/api/runner/lease',{method:'POST'}),env,{})).status,401);
  env.DB.close();
});
