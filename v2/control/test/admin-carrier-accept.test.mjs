import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readdirSync,readFileSync} from 'node:fs';
import {manualPair,recordAdminCarrierTest,promoteAdminPair} from '../src/admin-carrier-accept.mjs';
import {nodeFieldAction,nodeDetails,nodeUiRef} from '../src/node-admin.mjs';
import {nodeRoute,deriveNodeKey,signNodeRequest} from '../src/node-control.mjs';
import {nodeHealthRoute} from '../src/node-health.mjs';

const NOW=1800000000000,ID='test_node01',ACTOR='100001';
const master=btoa(String.fromCharCode(...new Uint8Array(32).fill(7)))
  .replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
let seq=0;
function fixture(){
  const raw=new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys=ON');
  for(const name of readdirSync(new URL('../migrations/',import.meta.url)).sort())
    raw.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
  raw.prepare("INSERT INTO nodes(id,provider,region,lifecycle,user_limit,byte_limit,desired_revision,acked_revision) "+
    "VALUES(?,'aws','eu','provisioning',20,536870912000,1,0)").run(ID);
  raw.prepare("INSERT INTO node_bootstrap_jobs(id,node_id,ip,owner_id,mode,state,created_ms,updated_ms) "+
    "VALUES('job-one',?,'8.8.8.8',?,'fresh','installed',?,?)").run(ID,ACTOR,NOW-15000,NOW-15000);
  raw.prepare("INSERT INTO routes(id,node_id,transport,state,listen_port) "+
    "VALUES(?,?,'reality','checking',8443)").run(ID+'_reality',ID);
  for(const [operator,port] of [['mci',443],['irancell',8443]]){
    raw.prepare("INSERT INTO route_carrier_variants(route_id,operator,host,port,server_name,reality_public_key,reality_short_id,published) "+
      "VALUES(?,?,?,?,? ,?,?,0)").run(ID+'_reality',operator,'8.8.8.8',port,'www.cloudflare.com','a'.repeat(43),'abcd');
  }
  const prepare=(sql,params=[])=>({
    bind(...args){return prepare(sql,args);},
    async first(){return raw.prepare(sql).get(...params)??null;},
    async all(){return {results:raw.prepare(sql).all(...params)};},
    async run(){const x=raw.prepare(sql).run(...params);return {meta:{changes:Number(x.changes)}};},
  });
  const DB={prepare,async batch(items){
    raw.exec('BEGIN');try {
      const arr=[];for(const x of items)arr.push(await x.run());
      raw.exec('COMMIT');return arr;
    }catch(e){raw.exec('ROLLBACK');throw e;}
  }};
  return {raw,env:{DB,NODE_MASTER_KEY:master,ADMIN_MANUAL_FIELD_ACCEPT_ENABLED:'true'}};
}
async function signedAck(code='accepted',digest='a'.repeat(64),nowMs=NOW){
  const path='/api/node/v1/ack',body=JSON.stringify({revision:1,status:code,digest});
  const stamp=Math.floor(nowMs/1000),nonce=(++seq).toString(16).padStart(32,'0');
  const sig=await signNodeRequest(await deriveNodeKey(master,ID),
    'POST',path,stamp,nonce,new TextEncoder().encode(body));
  return new Request('https://example.test'+path,{
    method:'POST',body,headers:{'content-type':'application/json',
      'x-madar-node-id':ID,'x-madar-node-nonce':nonce,
      'x-madar-node-timestamp':String(stamp),'x-madar-node-signature':sig}
  });
}
async function signedHealth(nowMs=NOW){
  const path='/api/node/v1/health',
    body=JSON.stringify({revision:1,ports:[443,8443],
      xray_healthy:true,stats_healthy:true,observed_ms:nowMs});
  const stamp=Math.floor(nowMs/1000),nonce=(++seq).toString(16).padStart(32,'0');
  const sig=await signNodeRequest(await deriveNodeKey(master,ID),
    'POST',path,stamp,nonce,new TextEncoder().encode(body));
  return new Request('https://example.test'+path,{
    method:'POST',body,headers:{'content-type':'application/json',
      'x-madar-node-id':ID,'x-madar-node-nonce':nonce,
      'x-madar-node-timestamp':String(stamp),'x-madar-node-signature':sig}
  });
}
test('admin sees minimal existing-panel buttons with double-confirmation, no forgeable readiness',async()=>{
  const {env,raw}=fixture(),ref=await nodeUiRef(ID);
  const panel=await nodeDetails(env.DB,ref,ACTOR,env);
  const labels=panel.replyMarkup.inline_keyboard.flat().map(x=>x.text);
  assert.ok(labels.some(x=>x.includes('ثبت تست همراه اول')));
  assert.ok(labels.some(x=>x.includes('ثبت تست ایرانسل')));
  const denied=await nodeDetails(env.DB,ref,'other-admin',env);
  assert.ok(!denied.replyMarkup.inline_keyboard.flat().some(x=>x.text.includes('ثبت تست')));
  const confirm=await nodeFieldAction(env,ACTOR,ref,'mci',false,NOW);
  assert.match(confirm.text,/آیا خودت/);
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM admin_carrier_tests').get().n,0);
  const applied=await nodeFieldAction(env,ACTOR,ref,'mci',true,NOW);
  assert.match(applied.text,/ثبت شد/);
  assert.equal(raw.prepare("SELECT lifecycle FROM nodes WHERE id=?").get(ID).lifecycle,'provisioning');
  raw.close();
});
test('two manual claims do not mark ready before a real signed node ACK',async()=>{
  const {raw,env}=fixture();
  assert.equal((await recordAdminCarrierTest(env,'999999',ID,'mci',NOW)).ok,false);
  assert.equal((await recordAdminCarrierTest(env,ACTOR,ID,'mci',NOW)).ok,true);
  const second=await recordAdminCarrierTest(env,ACTOR,ID,'irancell',NOW);
  assert.equal(second.ok,true);
  assert.equal(second.paired,true);
  assert.equal(second.ready,false);
  assert.equal(second.reason,'node_ack_pending');
  assert.equal(raw.prepare("SELECT lifecycle FROM nodes").get().lifecycle,'provisioning');
  assert.equal(raw.prepare("SELECT SUM(published) n FROM route_carrier_variants").get().n,0);
  assert.equal(raw.prepare("SELECT COUNT(*) n FROM field_probes").get().n,0);
  raw.close();
});
test('only signed ACK + both distinct current-revision admin claims can promote; health renews',async()=>{
  const {raw,env}=fixture();
  await recordAdminCarrierTest(env,ACTOR,ID,'mci',NOW);
  await recordAdminCarrierTest(env,ACTOR,ID,'irancell',NOW);
  const forged=await nodeRoute(new Request('https://example.test/api/node/v1/ack',{
    method:'POST',body:JSON.stringify({revision:1,status:'accepted',digest:'a'.repeat(64)})}),env,NOW);
  assert.equal(forged.status,401);
  const ack=await nodeRoute(await signedAck(),env,NOW);
  assert.equal(ack.status,200);
  assert.equal((await ack.json()).route_ready,true);
  assert.equal(raw.prepare("SELECT lifecycle FROM nodes").get().lifecycle,'ready');
  assert.equal(raw.prepare("SELECT acked_revision FROM nodes").get().acked_revision,1);
  assert.equal(raw.prepare("SELECT state FROM routes").get().state,'ready');
  assert.equal(raw.prepare("SELECT SUM(published) n FROM route_carrier_variants").get().n,2);
  assert.equal(raw.prepare("SELECT COUNT(*) n FROM field_probes").get().n,0);
  const h=await nodeHealthRoute(await signedHealth(),env,NOW);
  assert.equal(h.status,200);
  assert.equal((await h.json()).carrier_proofs,'owner_manual_attestation');
  assert.equal(raw.prepare("SELECT observed_ms FROM node_health").get().observed_ms,NOW);
  const again=await nodeRoute(await signedAck('accepted','a'.repeat(64),NOW+1000),env,NOW+1000);
  assert.equal(again.status,200);
  assert.equal(raw.prepare("SELECT COUNT(*) n FROM node_acks").get().n,1);
  assert.equal(raw.prepare("SELECT observed_ms FROM node_acks").get().observed_ms,NOW);
  const refreshAt=NOW+120000;
  const refreshed=await nodeRoute(await signedAck('accepted','a'.repeat(64),refreshAt),env,refreshAt);
  assert.equal(refreshed.status,200);
  assert.equal(raw.prepare("SELECT observed_ms FROM node_acks").get().observed_ms,refreshAt);
  raw.close();
});
test('stale admin tests or missing feature flag cannot promote or forge independent proof',async()=>{
  const {raw,env}=fixture();
  await recordAdminCarrierTest(env,ACTOR,ID,'mci',NOW-86400010);
  await recordAdminCarrierTest(env,ACTOR,ID,'irancell',NOW-86400010);
  const ack=await nodeRoute(await signedAck(),env,NOW);
  assert.equal(ack.status,200);
  assert.equal(raw.prepare('SELECT lifecycle FROM nodes').get().lifecycle,'provisioning');
  assert.equal(await manualPair(env.DB,ID,1,NOW),false);
  env.ADMIN_MANUAL_FIELD_ACCEPT_ENABLED='false';
  const refused=await promoteAdminPair(env,ID,NOW);
  assert.equal(refused.reason,'disabled');
  assert.equal(raw.prepare("SELECT SUM(published) n FROM route_carrier_variants").get().n,0);
  raw.close();
});
test('manual attestations from previous config revision cannot approve a changed node',async()=>{
  const {raw,env}=fixture();
  await recordAdminCarrierTest(env,ACTOR,ID,'mci',NOW);
  await recordAdminCarrierTest(env,ACTOR,ID,'irancell',NOW);
  raw.prepare('UPDATE nodes SET desired_revision=2 WHERE id=?').run(ID);
  const status=await promoteAdminPair(env,ID,NOW);
  assert.equal(status.ready,false);
  assert.equal(raw.prepare("SELECT lifecycle FROM nodes").get().lifecycle,'provisioning');
  raw.close();
});

test('after first approval both SIM checks persist, but only fresh signed health renews routes',async()=>{
  const {raw,env}=fixture();
  await recordAdminCarrierTest(env,ACTOR,ID,'mci',NOW);
  await recordAdminCarrierTest(env,ACTOR,ID,'irancell',NOW);
  assert.equal((await nodeRoute(await signedAck(),env,NOW)).status,200);
  const later=NOW+3*86400000;
  assert.equal(await manualPair(env.DB,ID,1,later),false);
  assert.equal(await manualPair(env.DB,ID,1,later,true),true);
  const health=await nodeHealthRoute(await signedHealth(later),env,later);
  assert.equal(health.status,200);
  assert.equal((await health.json()).carrier_proofs,'owner_manual_attestation');
  assert.equal(raw.prepare('SELECT observed_ms FROM node_health').get().observed_ms,later);
  raw.prepare('UPDATE nodes SET desired_revision=2,acked_revision=2').run();
  assert.equal(await manualPair(env.DB,ID,2,later,true),false);
  raw.close();
});
