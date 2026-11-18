import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {resolveBotAction} from '../src/shop.mjs';
import {nodeUiRef} from '../src/node-admin.mjs';
import {deriveNodeKey,signNodeRequest,nodeRoute} from '../src/node-control.mjs';
import {getCarrierFeed} from '../src/carrier-subscription.mjs';

const NOW=1800000000000,ADMIN='100001',NODE='direct-node-01';
const key=btoa(String.fromCharCode(...new Uint8Array(32).fill(31)))
  .replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
const master=btoa(String.fromCharCode(...new Uint8Array(32).fill(17)))
  .replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
let nonce=0, update=20;
const event=(actor,k,inputText=null)=>({actorId:actor,chatId:actor,key:k,inputText,photoId:null,updateId:++update,locale:'fa'});
function setup(){
  const raw=new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys=ON');
  for(const file of readdirSync(new URL('../migrations/',import.meta.url)).sort())
    raw.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
  raw.prepare("INSERT INTO customers(telegram_id,locale,state) VALUES(?,'fa','active')").run(ADMIN);
  raw.prepare("INSERT INTO customers(telegram_id,locale,state) VALUES('100002','fa','active')").run();
  raw.prepare("INSERT INTO nodes(id,provider,region,lifecycle,user_limit,byte_limit,desired_revision,acked_revision) "+
    "VALUES(?,'aws','eu','ready',20,536870912000,1,1)").run(NODE);
  raw.prepare("INSERT INTO node_bootstrap_jobs(id,node_id,ip,owner_id,mode,state,created_ms,updated_ms) "+
    "VALUES('job-direct',?,'198.51.100.2',?,'fresh','installed',?,?)").run(NODE,ADMIN,NOW-5000,NOW-5000);
  raw.prepare("INSERT INTO routes(id,node_id,transport,state,listen_port,verified_ms) "+
    "VALUES(?,?,'reality','ready',8443,?)").run(NODE+'_reality',NODE,NOW-1000);
  for(const [operator,port] of [['mci',443],['irancell',8443]]){
    raw.prepare("INSERT INTO route_carrier_variants(route_id,operator,host,port,server_name,reality_public_key,reality_short_id,published,verified_ms) "+
      "VALUES(?,?,?,?,?,?,?,1,?)").run(NODE+'_reality',operator,
      '198.51.100.2',port,'www.cloudflare.com','a'.repeat(43),'abcd',NOW-1000);
  }
  raw.prepare("INSERT INTO node_health(node_id,revision,observed_ms,xray_healthy,stats_healthy) VALUES(?,1,?,1,1)")
    .run(NODE,NOW-1000);
  const prepare=(sql,args=[])=>({
    bind(...next){return prepare(sql,next);},
    async first(){return raw.prepare(sql).get(...args)??null;},
    async all(){return {results:raw.prepare(sql).all(...args)};},
    async run(){const result=raw.prepare(sql).run(...args);return {meta:{changes:Number(result.changes)}};},
  });
  const DB={prepare,async batch(steps){
    raw.exec('BEGIN');try{
      const outcomes=[];for(const s of steps)outcomes.push(await s.run());
      raw.exec('COMMIT');return outcomes;
    }catch(e){raw.exec('ROLLBACK');throw e;}
  }};
  const env={DB,ADMIN_TELEGRAM_IDS:ADMIN,ADMIN_DIRECT_ISSUE_ENABLED:'true',
    SHOP_ENABLED:'false',PROVISIONING_ENABLED:'false',
    SUBSCRIPTION_LINKS_ENABLED:'false',SUBSCRIPTION_API_ENABLED:'false',
    SUBSCRIPTION_PUBLIC_ORIGIN:'https://v2.example.test/',SUBSCRIPTION_CREDENTIAL_KEY:key,
    NODE_MASTER_KEY:master};
  return {raw,env};
}
async function signed(method,path,data=null){
  const ts=Math.floor(NOW/1000),n=(++nonce).toString(16).padStart(32,'0');
  const body=data===null?'':JSON.stringify(data);
  const signature=await signNodeRequest(await deriveNodeKey(master,NODE),method,path,ts,n,
    new TextEncoder().encode(body));
  return new Request('https://v2.example.test'+path,{
    method,headers:{'x-madar-node-id':NODE,'x-madar-node-timestamp':String(ts),
      'x-madar-node-nonce':n,'x-madar-node-signature':signature,
      ...(method==='POST'?{'content-type':'application/json'}:{})},
    ...(method==='POST'?{body}:{})
  });
}
async function wizard(env){
  const start=await resolveBotAction(env,event(ADMIN,'admin:configs:direct:new'),NOW);
  assert.match(start.text,/نام یا برچسب مشتری/);
  const name=await resolveBotAction(env,event(ADMIN,'','علی رضایی'),NOW);
  assert.match(name.text,/سرور آماده/);
  const ref=await nodeUiRef(NODE);
  const server=await resolveBotAction(env,event(ADMIN,'admin:configs:direct:node:'+ref),NOW);
  assert.match(server.text,/حجم اشتراک/);
  const volume=await resolveBotAction(env,event(ADMIN,'admin:configs:direct:gb:10'),NOW);
  assert.match(volume.text,/مدت اعتبار/);
  const duration=await resolveBotAction(env,event(ADMIN,'admin:configs:direct:days:30'),NOW);
  assert.match(duration.text,/بررسی نهایی/);
  assert.match(duration.text,/علی رضایی/);
  assert.match(duration.text,/Amazon-118|direct-node-01/);
  const nothing=env.DB;
  return await resolveBotAction(env,event(ADMIN,'admin:configs:direct:save'),NOW);
}
test('direct issue is admin-only, disabled by default, and asks name -> ready server -> data -> days',async()=>{
  const {raw,env}=setup();
  const denied=await resolveBotAction(env,event('100002','admin:configs:direct:new'),NOW);
  assert.ok(!denied.replyMarkup?.inline_keyboard?.flat().some(x=>x.callback_data?.includes('direct:save')));
  env.ADMIN_DIRECT_ISSUE_ENABLED='false';
  const homeOff=await resolveBotAction(env,event(ADMIN,'admin:configs'),NOW);
  assert.ok(!homeOff.replyMarkup.inline_keyboard.flat().some(x=>x.callback_data==='v2:admin:configs:direct:new'));
  const off=await resolveBotAction(env,event(ADMIN,'admin:configs:direct:new'),NOW);
  assert.match(off.text,/مجاز نیست/);
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM orders').get().n,0);
  raw.close();
});
test('legacy style wizard reserves one real encrypted UUID; never pretends signed node ACK exists',async()=>{
  const {raw,env}=setup();
  const issued=await wizard(env);
  assert.match(issued.text,/در انتظار تأیید عامل/);
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM admin_direct_issues').get().n,1);
  assert.equal(raw.prepare('SELECT label FROM admin_direct_issues').get().label,'علی رضایی');
  assert.equal(raw.prepare('SELECT quota_bytes FROM admin_direct_issues').get().quota_bytes,10737418240);
  assert.equal(raw.prepare('SELECT duration_days FROM admin_direct_issues').get().duration_days,30);
  assert.equal(raw.prepare('SELECT active FROM plans').get().active,0);
  assert.equal(raw.prepare('SELECT price_amount FROM plans').get().price_amount,0);
  assert.equal(raw.prepare('SELECT state FROM orders').get().state,'provisioning');
  assert.equal(raw.prepare('SELECT state FROM subscriptions').get().state,'pending');
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM subscription_credentials').get().n,1);
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM node_client_acks').get().n,0);
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM subscription_tokens').get().n,0);
  // Replaying the same Telegram callback never creates a second account.
  const replay=await resolveBotAction(env,event(ADMIN,'admin:configs:direct:save'),NOW);
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM subscriptions').get().n,1);
  raw.close();
});
test('only signed node per-client ACK activates direct account and generates named two-port private feed',async()=>{
  const {raw,env}=setup();
  await wizard(env);
  const id=raw.prepare('SELECT id FROM admin_direct_issues').get().id;
  const pre=await resolveBotAction(env,event(ADMIN,'admin:configs:direct:link:'+id),NOW);
  assert.match(pre.text,/در انتظار تأیید عامل/);
  const result=await nodeRoute(await signed('GET','/api/node/v1/clients'),env,NOW);
  assert.equal(result.status,200);
  const snapshot=await result.json();
  assert.equal(snapshot.payload.mode,'commercial');
  assert.equal(snapshot.payload.clients.length,1);
  const client=snapshot.payload.clients[0];
  const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',
    new TextEncoder().encode(client.uuid)));
  const sha=Array.from(digest,x=>x.toString(16).padStart(2,'0')).join('');
  const ack=await nodeRoute(await signed('POST','/api/node/v1/clients/ack',{
    revision:1,ports:[443,8443],xray_healthy:true,
    clients:[{subscription_id:client.subscription_id,uuid_sha256:sha}],
  }),env,NOW);
  assert.equal(ack.status,200);
  assert.equal((await ack.json()).applied,1);
  assert.equal(raw.prepare('SELECT state FROM subscriptions').get().state,'active');
  const delivered=await resolveBotAction(env,event(ADMIN,'admin:configs:direct:link:'+id),NOW);
  const url=delivered.text.match(/https:\/\/v2\.example\.test\/s\/[A-Za-z0-9_-]{43}/)?.[0];
  assert.ok(url);
  const feed=await getCarrierFeed(new Request(url),env,NOW);
  assert.equal(feed.status,200);
  const decoded=atob(await feed.text()).trim().split('\n');
  assert.equal(decoded.length,2);
  assert.ok(decoded.some(x=>x.includes(':443?')));
  assert.ok(decoded.some(x=>x.includes(':8443?')));
  assert.ok(decoded.every(x=>x.startsWith('vless://'+client.uuid+'@')));
  assert.ok(decoded.every(x=>x.includes(encodeURIComponent('علی رضایی'))));
  assert.equal(env.SHOP_ENABLED,'false');
  assert.equal(env.SUBSCRIPTION_API_ENABLED,'false');
  assert.equal(env.SUBSCRIPTION_LINKS_ENABLED,'false');
  const revoke=await resolveBotAction(env,event(ADMIN,'admin:configs:direct:revoke:'+id),NOW);
  assert.match(revoke.text,/لغو شده/);
  assert.equal(raw.prepare('SELECT state FROM subscriptions').get().state,'revoked');
  assert.equal((await getCarrierFeed(new Request(url),env,NOW+1000)).status,503);
  raw.close();
});
test('no ready signed-health node means no direct UUID is reserved; user never re-tests ports',async()=>{
  const {raw,env}=setup();
  raw.prepare('UPDATE node_health SET observed_ms=? WHERE node_id=?').run(NOW-900000,NODE);
  const start=await resolveBotAction(env,event(ADMIN,'admin:configs:direct:new'),NOW);
  await resolveBotAction(env,event(ADMIN,'','مشتری تست'),NOW);
  const rows=await resolveBotAction(env,event(ADMIN,'admin:configs:direct:node:'+await nodeUiRef(NODE)),NOW);
  assert.match(rows.text,/سرور آماده نیست/);
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM orders').get().n,0);
  raw.close();
});
