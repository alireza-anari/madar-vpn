import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readdirSync,readFileSync} from 'node:fs';
import {runnerApi} from '../src/runner-enrollment.mjs';
import {deriveNodeKey} from '../src/node-control.mjs';

const now=1800000000000;
const MASTER=btoa(String.fromCharCode(...new Uint8Array(32).fill(27)))
  .replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
const SECRET='fixture-runner-only-service-secret-not-for-telegram';
const ID='12345678-1234-4123-8123-123456789012';
function fixture(){
  const db=new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  for(const name of readdirSync(new URL('../migrations/',import.meta.url)).sort())
    db.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
  db.exec("INSERT INTO nodes(id,provider,region,lifecycle,user_limit,byte_limit) "+
    "VALUES('test-node01','provider','eu','enrolling',5,10000000)");
  db.prepare("INSERT INTO v2_runner_jobs "+
    "(id,owner_id,kind,spec_json,state,lease_id,lease_until_ms,created_ms,expires_ms) "+
    "VALUES(?,'100','v2-install',?,'leased','lease-only',?,?,?)")
    .run(ID,JSON.stringify({nodeId:'test-node01',mode:'fresh',ip:'8.8.8.8'}),now+100000,now,now+200000);
  const stmt=(sql,params=[])=>({
    bind(...args){return stmt(sql,args);},
    async first(){return db.prepare(sql).get(...params)??null;},
    async all(){return {results:db.prepare(sql).all(...params)};},
    async run(){const row=db.prepare(sql).run(...params);return {meta:{changes:Number(row.changes)}};},
  });
  return {db,env:{DB:{prepare:stmt},NODE_MASTER_KEY:MASTER,
    RUNNER_SERVICE_SECRET:SECRET,RUNNER_ENROLLMENT_ENABLED:'true',
    NODE_RUNTIME_AUTO_ENABLED:'true'}};
}
const request=(leaseId='lease-only',nodeId='test-node01',auth='Bearer '+SECRET)=>
  new Request('https://example.test/api/runner/node-key',{method:'POST',
    headers:{authorization:auth,'content-type':'application/json'},
    body:JSON.stringify({id:ID,leaseId,nodeId})});
test('leased installer only receives derived per-node secret; never master',async()=>{
  const {db,env}=fixture();
  const ok=await runnerApi(request(),env,now);
  assert.equal(ok.status,200);
  const data=await ok.json();
  const key=await deriveNodeKey(MASTER,'test-node01');
  const encoded=btoa(String.fromCharCode(...key))
    .replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
  assert.equal(data.nodeKey,encoded);
  assert.notEqual(data.nodeKey,MASTER);
  assert.equal(data.origin,'https://madar-v2-staging.alirezaanari117.workers.dev');
  assert.equal((await runnerApi(request('wrong'),env,now)).status,409);
  assert.equal((await runnerApi(request('lease-only','test-other'),env,now)).status,403);
  assert.equal((await runnerApi(request('lease-only','test-node01','Bearer wrong'),env,now)).status,401);
  db.close();
});
test('missing runtime flag blocks node key even with valid lease',async()=>{
  const {db,env}=fixture();
  env.NODE_RUNTIME_AUTO_ENABLED='false';
  assert.equal((await runnerApi(request(),env,now)).status,503);
  db.close();
});
