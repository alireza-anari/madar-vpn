import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readdirSync,readFileSync} from 'node:fs';
import {enrollmentApi,runnerApi} from '../src/runner-enrollment.mjs';

const NOW=1800000000000,OWNER='100001',NODE='test-owner01';
const FP='SHA256:'+'a'.repeat(43);
const PROBE='12345678-1234-4123-8123-123456789012';
const INSTALL='22222222-2222-4222-8222-222222222222';
const ENV={v:1,key:'A'.repeat(512),iv:'A'.repeat(16),data:'A'.repeat(64)};
const spec={
  nodeId:NODE,provider:'aws',region:'eu-north-1',ip:'8.8.8.8',
  port:22,username:'root',userLimit:20,capacityGb:500,mode:'fresh',
};
async function signedInit(token,owner,now){
  const data=new URLSearchParams([['auth_date',String(now/1000)],
    ['user',JSON.stringify({id:Number(owner)})]]);
  const enc=new TextEncoder();
  const hmac=async(key,text)=>new Uint8Array(await crypto.subtle.sign('HMAC',
    await crypto.subtle.importKey('raw',key,{name:'HMAC',hash:'SHA-256'},false,['sign']),
    enc.encode(text)));
  const key=await hmac(enc.encode('WebAppData'),token);
  const canonical=[...data].sort(([a],[b])=>a.localeCompare(b)).map(([a,b])=>a+'='+b).join('\n');
  const signature=await hmac(key,canonical);
  data.set('hash',Array.from(signature,b=>b.toString(16).padStart(2,'0')).join(''));
  return data.toString();
}
function database(){
  const raw=new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys=ON');
  for(const file of readdirSync(new URL('../migrations/',import.meta.url)).sort())
    raw.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
  raw.exec("INSERT INTO customers(telegram_id,locale) VALUES('100001','fa')");
  raw.exec("INSERT INTO nodes(id,provider,region,lifecycle,user_limit,byte_limit) "+
    "VALUES('test-owner01','aws','eu','ready',20,536870912000)");
  raw.prepare("INSERT INTO node_bootstrap_jobs(id,node_id,ip,owner_id,mode,state,created_ms,updated_ms) "+
    "VALUES(?,'test-owner01','8.8.8.8',?,'fresh','installed',?,?)")
    .run(INSTALL,OWNER,NOW-10000,NOW-5000);
  raw.exec("INSERT INTO subscriptions(id,owner_telegram_id,state,expires_at,max_bytes,used_bytes) "+
    "VALUES('sub-pending','100001','pending',0,10737418240,0)");
  raw.exec("INSERT INTO node_allocations(id,node_id,subscription_id,quota_bytes,state) "+
    "VALUES('alloc-pending','test-owner01','sub-pending',10737418240,'reserved')");
  raw.prepare("INSERT INTO v2_runner_jobs(id,owner_id,kind,spec_json,fingerprint,state,created_ms,expires_ms) "+
    "VALUES(?,?, 'probe',?,?,'ready',?,?)")
    .run(PROBE,OWNER,JSON.stringify(spec),FP,NOW,NOW+600000);
  const adapt=(sql,args=[])=>({
    bind(...values){return adapt(sql,values);},
    async first(){return raw.prepare(sql).get(...args)??null;},
    async all(){return {results:raw.prepare(sql).all(...args)};},
    async run(){return {meta:raw.prepare(sql).run(...args)};},
  });
  return {raw,DB:{prepare:sql=>adapt(sql),async batch(statements){
    raw.exec('BEGIN');
    try{const o=[];for(const step of statements)o.push(await step.run());raw.exec('COMMIT');return o;}
    catch(e){raw.exec('ROLLBACK');throw e;}}}};
}
function controlRequest(path,auth,body=null){
  return new Request('https://v2.example.invalid/api/enrollment/'+path,{
    method:body===null?'GET':'POST',
    headers:{'x-telegram-init-data':auth,'content-type':'application/json'},
    ...(body!==null?{body:JSON.stringify(body)}:{}),
  });
}
function runnerRequest(action,secret,body){
  return new Request('https://v2.example.invalid/api/runner/'+action,{
    method:'POST',headers:{authorization:'Bearer '+secret,'content-type':'application/json'},
    body:JSON.stringify(body),
  });
}
test('owner resets a prior V2 install only via signed host-key re-probe and remote success',async()=>{
  const {raw,DB}=database();
  const env={DB,BOT_TOKEN:'bot-token',ADMIN_TELEGRAM_IDS:OWNER,
    RUNNER_ENROLLMENT_ENABLED:'true',V2_EXECUTOR_BACKEND:'github-actions',
    GITHUB_ACTIONS_DISPATCH_TOKEN:'g'.repeat(48),RUNNER_SERVICE_SECRET:'s'.repeat(48),
    RUNNER_PUBLIC_KEY:JSON.stringify({kid:'madar-v2-github-actions',kty:'RSA',
      alg:'RSA-OAEP-256',e:'AQAB',n:'A'.repeat(342)})};
  const auth=await signedInit(env.BOT_TOKEN,OWNER,NOW);
  const check=await enrollmentApi(controlRequest(
    'reset-check?nodeId='+NODE,auth),env,NOW);
  assert.equal(check.status,200);
  assert.deepEqual(await check.json(),{ok:true,code:'RESET_ALLOWED',willCancelPending:1});
  const payload={nodeId:NODE,confirmNodeId:NODE,confirm:'RESET_V2_ONLY',probeId:PROBE,
    fingerprint:FP,trust:true,envelope:ENV};
  assert.equal((await enrollmentApi(controlRequest('reset',auth,{...payload,
    confirmNodeId:'another-node'}),env,NOW)).status,400);
  assert.equal((await enrollmentApi(controlRequest('reset',auth,{...payload,
    fingerprint:'SHA256:'+'b'.repeat(43)}),env,NOW)).status,409);
  const dispatched=[];
  const requested=await enrollmentApi(controlRequest('reset',auth,payload),env,NOW,
    async(_,id)=>{dispatched.push(id);return true});
  assert.equal(requested.status,200);
  const {id,willCancelPending}=await requested.json();
  assert.equal(willCancelPending,1);
  assert.deepEqual(dispatched,[id]);
  assert.equal(raw.prepare("SELECT lifecycle FROM nodes WHERE id=?").get(NODE).lifecycle,'quarantined');
  assert.equal(raw.prepare("SELECT state FROM subscriptions WHERE id='sub-pending'").get().state,'pending');
  assert.equal((await enrollmentApi(controlRequest('reset',auth,payload),env,NOW)).status,409);
  const leased=await runnerApi(runnerRequest('lease',env.RUNNER_SERVICE_SECRET,{
    runnerId:'v2-github-actions',jobId:id
  }),env,NOW+1000);
  assert.equal(leased.status,200);
  const job=JSON.parse((await leased.json()).payload);
  assert.equal(job.cleanup,true);
  assert.equal(job.kind,'v2-install');
  assert.equal(job.nodeId,NODE);
  assert.equal(job.hostFingerprint,FP);
  assert.ok(job.encryptedCredentials);
  const withoutProof=await runnerApi(runnerRequest('report',env.RUNNER_SERVICE_SECRET,{
    id,leaseId:job.leaseId,state:'ready'
  }),env,NOW+1000);
  assert.equal(withoutProof.status,409);
  assert.equal(raw.prepare("SELECT lifecycle FROM nodes WHERE id=?").get(NODE).lifecycle,'quarantined');
  const done=await runnerApi(runnerRequest('report',env.RUNNER_SERVICE_SECRET,{
    id,leaseId:job.leaseId,state:'ready',safeCode:'RESET_COMPLETED'
  }),env,NOW+2000);
  assert.equal(done.status,200);
  assert.equal(raw.prepare("SELECT lifecycle FROM nodes WHERE id=?").get(NODE).lifecycle,'retired');
  assert.equal(raw.prepare("SELECT state FROM subscriptions WHERE id='sub-pending'").get().state,'revoked');
  assert.equal(raw.prepare("SELECT state FROM node_allocations WHERE id='alloc-pending'").get().state,'released');
  const terminal=raw.prepare("SELECT state,encrypted_credentials,safe_code FROM v2_runner_jobs WHERE id=?").get(id);
  assert.equal(terminal.state,'ready');
  assert.equal(terminal.encrypted_credentials,null);
  assert.equal(terminal.safe_code,'RESET_COMPLETED');
  // Lease completion is idempotently acknowledged but cannot undelete data.
  assert.equal((await runnerApi(runnerRequest('report',env.RUNNER_SERVICE_SECRET,{
    id,leaseId:job.leaseId,state:'ready',safeCode:'RESET_COMPLETED'
  }),env,NOW+3000)).status,200);
  raw.close();
});
