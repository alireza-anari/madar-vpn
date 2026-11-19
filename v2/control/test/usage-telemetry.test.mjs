import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readdirSync,readFileSync} from 'node:fs';
import {usageRoute,validateUsageReport} from '../src/usage-telemetry.mjs';
import {deriveNodeKey,signNodeRequest} from '../src/node-control.mjs';
const now=1800000000000,node='test-node01';
const master=btoa(String.fromCharCode(...new Uint8Array(32).fill(12)))
  .replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
const serial={value:0};
async function signed(path,payload){
  const body=JSON.stringify(payload),method='POST',
    sec=Math.floor(now/1000),
    nonce=(++serial.value).toString(16).padStart(32,'0');
  const key=await deriveNodeKey(master,node);
  const sig=await signNodeRequest(key,method,path,sec,nonce,
    new TextEncoder().encode(body));
  return new Request('https://example.test'+path,{
    method,body,headers:{'content-type':'application/json',
      'x-madar-node-id':node,'x-madar-node-nonce':nonce,
      'x-madar-node-timestamp':String(sec),
      'x-madar-node-signature':sig}
  });
}
function fixture(){
  const raw=new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys=ON');
  for(const name of readdirSync(new URL('../migrations/',import.meta.url)).sort())
    raw.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
  raw.prepare("INSERT INTO nodes(id,provider,region,lifecycle,user_limit,byte_limit,desired_revision,acked_revision) "+
    "VALUES(?,'test','eu','ready',3,10000,1,1)").run(node);
  raw.exec("INSERT INTO customers(telegram_id) VALUES('200')");
  raw.exec("INSERT INTO subscriptions(id,owner_telegram_id,state,expires_at,max_bytes,used_bytes) "+
    "VALUES('sub-one','200','active',1900000000000,1000,0)");
  raw.prepare("INSERT INTO node_allocations(id,node_id,subscription_id,quota_bytes,state) "+
    "VALUES('a1',?,'sub-one',1000,'active')").run(node);
  const stmt=(sql,params=[])=>({
    bind(...args){return stmt(sql,args);},
    async first(){return raw.prepare(sql).get(...params)??null;},
    async all(){return {results:raw.prepare(sql).all(...params)};},
    async run(){const row=raw.prepare(sql).run(...params);return {meta:{changes:Number(row.changes)}};},
  });
  const DB={prepare:stmt,async batch(items){
    raw.exec('BEGIN');try{
      let results=[];for(const x of items)results.push(await x.run());
      raw.exec('COMMIT');return results;
    }catch(e){raw.exec('ROLLBACK');throw e;}
  }};
  return {raw,env:{DB,NODE_MASTER_KEY:master}};
}
const payload=(n=100,seq=1)=>({revision:1,reports:[{
  subscription_id:'sub-one',sequence:seq,cumulative_bytes:n,observed_ms:now-1000
}]});
test('cannot submit malformed or double-counting usage batches',()=>{
  assert.ok(validateUsageReport(payload(),now));
  assert.equal(validateUsageReport({...payload(),reports:[payload().reports[0],payload().reports[0]]},now),null);
  assert.equal(validateUsageReport(payload(-1),now),null);
  assert.equal(validateUsageReport({...payload(),reports:[{...payload().reports[0],observed_ms:now-130000}]},now),null);
});
test('node usage increases monotonically, retries do not double-count, cap is enforced',async()=>{
  const {raw,env}=fixture(),path='/api/node/v1/usage';
  const first=await usageRoute(await signed(path,payload(300,1)),env,now);
  assert.equal(first.status,200);
  assert.equal(raw.prepare("SELECT used_bytes FROM subscriptions WHERE id='sub-one'").get().used_bytes,300);
  const again=await usageRoute(await signed(path,payload(300,1)),env,now);
  assert.equal(again.status,200);
  assert.equal(raw.prepare("SELECT used_bytes FROM subscriptions WHERE id='sub-one'").get().used_bytes,300);
  const stale=await usageRoute(await signed(path,payload(150,2)),env,now);
  assert.equal(stale.status,409);
  const burst=await usageRoute(await signed(path,payload(1400,3)),env,now);
  assert.equal(burst.status,200);
  assert.equal(raw.prepare("SELECT used_bytes FROM subscriptions WHERE id='sub-one'").get().used_bytes,1000);
  assert.equal(raw.prepare("SELECT cumulative_bytes FROM node_usage_reports").get().cumulative_bytes,1400);
  const revoked=await usageRoute(await signed('/api/node/v1/clients/revoked',
    {revision:1,subscription_ids:['sub-one']}),env,now);
  assert.equal(revoked.status,200);
  assert.equal(raw.prepare("SELECT state FROM node_allocations WHERE id='a1'").get().state,'released');
  raw.close();
});
test('unsigned fake usage never changes quota',async()=>{
  const {raw,env}=fixture();
  const bad=await usageRoute(new Request('https://example.test/api/node/v1/usage',{
    method:'POST',body:JSON.stringify(payload()),headers:{'content-type':'application/json'}
  }),env,now);
  assert.equal(bad.status,401);
  assert.equal(raw.prepare("SELECT used_bytes FROM subscriptions WHERE id='sub-one'").get().used_bytes,0);
  raw.close();
});
