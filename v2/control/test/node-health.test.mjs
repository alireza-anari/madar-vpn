import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readdirSync,readFileSync} from 'node:fs';
import {nodeHealthRoute} from '../src/node-health.mjs';
import {deriveNodeKey,signNodeRequest} from '../src/node-control.mjs';

const now=1800000000000,node='test-node01';
const master=btoa(String.fromCharCode(...new Uint8Array(32).fill(13)))
 .replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
let nonceIndex=0;
async function signed(doc){
 const body=JSON.stringify(doc),ts=Math.floor(now/1000),nonce=(++nonceIndex).toString(16).padStart(32,'0');
 const key=await deriveNodeKey(master,node);
 const signature=await signNodeRequest(key,'POST','/api/node/v1/health',ts,nonce,new TextEncoder().encode(body));
 return new Request('https://example.test/api/node/v1/health',{
   method:'POST',body,headers:{
    'content-type':'application/json','x-madar-node-id':node,
    'x-madar-node-nonce':nonce,'x-madar-node-timestamp':String(ts),
    'x-madar-node-signature':signature
   }
 });
}
const payload=()=>({revision:1,ports:[443,8443],
  xray_healthy:true,stats_healthy:true,observed_ms:now});
function fixture(){
 const raw=new DatabaseSync(':memory:');
 raw.exec('PRAGMA foreign_keys=ON');
 for(const name of readdirSync(new URL('../migrations/',import.meta.url)).sort())
   raw.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
 raw.prepare("INSERT INTO nodes(id,provider,region,lifecycle,user_limit,byte_limit,desired_revision,acked_revision) "+
   "VALUES(?,'test','eu','ready',5,5000000000,1,1)").run(node);
 raw.prepare("INSERT INTO routes(id,node_id,transport,state,verified_ms) "+
   "VALUES(?,?,'reality','ready',?)").run(node+'_reality',node,now-1000);
 for(const [operator,port] of [['mci',443],['irancell',8443]]){
  raw.prepare("INSERT INTO route_carrier_variants(route_id,operator,host,port,server_name,reality_public_key,reality_short_id,published,verified_ms) "+
    "VALUES(?,?,?,?,? ,?,?,1,?)").run(node+'_reality',operator,'8.8.8.8',port,'www.cloudflare.com','a'.repeat(43),'abcd',now-1000);
 }
 const prepare=(sql,params=[])=>({
   bind(...args){return prepare(sql,args);},
   async first(){return raw.prepare(sql).get(...params)??null;},
   async all(){return {results:raw.prepare(sql).all(...params)};},
   async run(){const value=raw.prepare(sql).run(...params);return {meta:{changes:Number(value.changes)}};}
 });
 const DB={prepare,async batch(items){
  raw.exec('BEGIN');try{
   let out=[];for(const v of items)out.push(await v.run());
   raw.exec('COMMIT');return out;
  }catch(e){raw.exec('ROLLBACK');throw e;}
 }};
 return {raw,env:{DB,NODE_MASTER_KEY:master}};
}
test('node health never replaces missing independent carrier proof',async()=>{
 const {raw,env}=fixture();
 const denied=await nodeHealthRoute(await signed(payload()),env,now);
 assert.equal(denied.status,409);
 assert.deepEqual(await denied.json(),{error:'carrier_not_accepted'});
 assert.equal(raw.prepare("SELECT verified_ms FROM routes").get().verified_ms,now-1000);
 raw.close();
});
test('signed healthy REALITY 443+8443 renews operational freshness only after carrier acceptance',async()=>{
 const {raw,env}=fixture();
 for(const [i,operator,port] of [['p1','mci',443],['p2','irancell',8443]]){
  raw.prepare("INSERT INTO field_probes(id,node_id,operator,port,revision,observed_ms,upload_bytes,download_bytes) "+
    "VALUES(?,?,?,?,1,?,1024,1024)").run(i,node,operator,port,now-300000);
 }
 const valid=await nodeHealthRoute(await signed(payload()),env,now);
 assert.equal(valid.status,200);
 assert.equal((await valid.json()).carrier_proofs,'initial_independent_acceptance');
 assert.equal(raw.prepare("SELECT verified_ms FROM routes").get().verified_ms,now);
 assert.deepEqual(raw.prepare("SELECT verified_ms FROM route_carrier_variants ORDER BY operator").all()
  .map(x=>x.verified_ms),[now,now]);
 assert.equal(raw.prepare("SELECT observed_ms FROM node_health").get().observed_ms,now);
 raw.close();
});
test('acceptance older than 24 hours cannot be extended by a healthy VPS alone',async()=>{
 const {raw,env}=fixture();
 for(const [i,operator,port] of [['old-mci','mci',443],['old-irancell','irancell',8443]]){
   raw.prepare("INSERT INTO field_probes(id,node_id,operator,port,revision,observed_ms,upload_bytes,download_bytes) "+
     "VALUES(?,?,?,?,1,?,1024,1024)").run(i,node,operator,port,now-86400001);
 }
 const stale=await nodeHealthRoute(await signed(payload()),env,now);
 assert.equal(stale.status,409);
 assert.deepEqual(await stale.json(),{error:'carrier_not_accepted'});
 raw.close();
});
test('spoofed node request and stale local measurements cannot refresh routes',async()=>{
 const {raw,env}=fixture();
 assert.equal((await nodeHealthRoute(new Request('https://example.test/api/node/v1/health',
   {method:'POST',body:JSON.stringify(payload())}),env,now)).status,401);
 assert.equal((await nodeHealthRoute(await signed({...payload(),observed_ms:now-50000}),
   env,now)).status,409);
 raw.close();
});
