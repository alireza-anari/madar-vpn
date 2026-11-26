import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readdirSync,readFileSync} from 'node:fs';
import {nodeRoute,deriveNodeKey,signNodeRequest} from '../src/node-control.mjs';
import {wrapClientUuid} from '../src/subscription.mjs';

const now=1800000000000,id='test-node01';
const master=btoa(String.fromCharCode(...new Uint8Array(32).fill(19)))
  .replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
const credentialKey=btoa(String.fromCharCode(...new Uint8Array(32).fill(23)))
  .replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
const uuid='12345678-1234-4123-8123-123456789012';
const digest=async value=>Array.from(new Uint8Array(await crypto.subtle.digest(
  'SHA-256',new TextEncoder().encode(value))),x=>x.toString(16).padStart(2,'0')).join('');
async function fixture(){
  const raw=new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys=ON');
  for(const name of readdirSync(new URL('../migrations/',import.meta.url)).sort())
    raw.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
  raw.prepare("INSERT INTO nodes(id,provider,region,lifecycle,user_limit,byte_limit,desired_revision,acked_revision) "+
    "VALUES(?,'test','eu','ready',20,10000000000,1,1)").run(id);
  raw.exec("INSERT INTO customers(telegram_id) VALUES('100')");
  raw.exec("INSERT INTO plans(id,title_fa,title_en,price_amount,price_currency,quota_bytes,duration_days) "+
    "VALUES('p1','تست','Test',1000,'IRT',1000000,30)");
  raw.exec("INSERT INTO orders(id,customer_telegram_id,plan_id,idempotency_key,quoted_amount,quoted_currency,state) "+
    "VALUES('o1','100','p1','key',1000,'IRT','provisioning')");
  raw.exec("INSERT INTO subscriptions(id,owner_telegram_id,state,expires_at,order_id,max_bytes,used_bytes) "+
    "VALUES('sub1','100','pending',0,'o1',1000000,0)");
  const wrapped=await wrapClientUuid(uuid,credentialKey);
  raw.prepare("INSERT INTO subscription_credentials(subscription_id,ciphertext_b64,nonce_b64,key_version) "+
    "VALUES('sub1',?,?,1)").run(wrapped.ciphertext_b64,wrapped.nonce_b64);
  raw.prepare("INSERT INTO node_allocations(id,node_id,subscription_id,quota_bytes,state) "+
    "VALUES('a1',?,'sub1',1000000,'reserved')").run(id);
  const prepare=(sql,args=[])=>({
    bind(...values){return prepare(sql,values);},
    async first(){return raw.prepare(sql).get(...args)??null;},
    async all(){return {results:raw.prepare(sql).all(...args)};},
    async run(){const result=raw.prepare(sql).run(...args);return {meta:{changes:Number(result.changes)}};},
  });
  const DB={prepare,async batch(qs){
    raw.exec('BEGIN');try{
      const result=[];for(const q of qs)result.push(await q.run());
      raw.exec('COMMIT');return result;
    }catch(err){raw.exec('ROLLBACK');throw err;}
  }};
  return {raw,env:{DB,NODE_MASTER_KEY:master,SUBSCRIPTION_CREDENTIAL_KEY:credentialKey}};
}
let nonceNumber=1;
async function signed(path,method,payload,at=now){
  const key=await deriveNodeKey(master,id);
  const body=payload?JSON.stringify(payload):'';
  const nonce=(nonceNumber++).toString(16).padStart(32,'0');
  const timestamp=Math.floor(at/1000);
  const signature=await signNodeRequest(key,method,path,timestamp,nonce,
    new TextEncoder().encode(body));
  return new Request('https://example.test'+path,{method,
    headers:{'x-madar-node-id':id,'x-madar-node-nonce':nonce,
      'x-madar-node-timestamp':String(timestamp),
      'x-madar-node-signature':signature,
      ...(method==='POST'?{'content-type':'application/json'}:{})},
    ...(method==='POST'?{body}:{})});
}
test('only signed node identity can retrieve encrypted-at-rest client UUID',async()=>{
  const {raw,env}=await fixture();
  const denied=await nodeRoute(new Request('https://example.test/api/node/v1/clients'),env,now);
  assert.equal(denied.status,401);
  const out=await nodeRoute(await signed('/api/node/v1/clients','GET'),env,now);
  assert.equal(out.status,200);
  const doc=await out.json();
  assert.equal(doc.applied,false);
  assert.equal(doc.payload.clients.length,1);
  assert.equal(doc.payload.clients[0].uuid,uuid);
  assert.equal(doc.payload.clients[0].subscription_id,'sub1');
  assert.match(doc.signature,/^[A-Za-z0-9_-]{43}$/);
  raw.close();
});
test('customer order remains pending until matching signed Xray installation ACK',async()=>{
  const {raw,env}=await fixture();
  const path='/api/node/v1/clients/ack';
  const payload={revision:1,ports:[443,8443],xray_healthy:true,
    clients:[{subscription_id:'sub1',uuid_sha256:'0'.repeat(64)}]};
  const denied=await nodeRoute(await signed(path,'POST',payload),env,now);
  assert.equal(denied.status,409);
  assert.equal(raw.prepare("SELECT state FROM subscriptions WHERE id='sub1'").get().state,'pending');
  payload.clients[0].uuid_sha256=await digest(uuid);
  const accepted=await nodeRoute(await signed(path,'POST',payload),env,now);
  assert.equal(accepted.status,200);
  assert.deepEqual(await accepted.json(),{ok:true,applied:1});
  assert.equal(raw.prepare("SELECT state FROM subscriptions WHERE id='sub1'").get().state,'active');
  assert.equal(raw.prepare("SELECT state FROM node_allocations WHERE id='a1'").get().state,'active');
  assert.equal(raw.prepare("SELECT state FROM orders WHERE id='o1'").get().state,'fulfilled');
  assert.equal(raw.prepare("SELECT count(*) n FROM node_client_acks").get().n,1);
  assert.equal(raw.prepare("SELECT count(*) n FROM telegram_notifications").get().n,1);
  const before=raw.prepare('SELECT total_changes() n').get().n;
  const repeatedAt=now+60_000;
  const repeated=await nodeRoute(await signed(path,'POST',payload,repeatedAt),env,repeatedAt);
  assert.equal(repeated.status,200);
  assert.equal(raw.prepare('SELECT total_changes() n').get().n,before);
  raw.close();
});
