import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {resolveBotAction} from '../src/shop.mjs';
import {nodeUiRef} from '../src/node-admin.mjs';
import {deriveNodeKey,signNodeRequest,nodeRoute} from '../src/node-control.mjs';
import {getCarrierFeed} from '../src/carrier-subscription.mjs';

const NOW=1800000000000,ADMIN='100001',NODE='e2e-node-01';
const key=btoa(String.fromCharCode(...new Uint8Array(32).fill(9)))
  .replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
const master=btoa(String.fromCharCode(...new Uint8Array(32).fill(19)))
  .replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
let nonce=0;
const event=(actor,key,updateId=12)=>({actorId:actor,chatId:actor,key,updateId,locale:'fa',inputText:null,photoId:null});
function fixture(){
  const raw=new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys=ON');
  for(const file of readdirSync(new URL('../migrations/',import.meta.url)).sort())
    raw.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
  raw.prepare("INSERT INTO customers(telegram_id,locale,state) VALUES(?,'fa','active')").run(ADMIN);
  raw.prepare("INSERT INTO customers(telegram_id,locale,state) VALUES('100002','fa','active')").run();
  raw.prepare("INSERT INTO nodes(id,provider,region,lifecycle,user_limit,byte_limit,desired_revision,acked_revision) "+
    "VALUES(?,'aws','eu','ready',20,536870912000,1,1)").run(NODE);
  raw.prepare("INSERT INTO node_bootstrap_jobs(id,node_id,ip,owner_id,mode,state,created_ms,updated_ms) "+
    "VALUES('job-e2e',?,'198.51.100.2',?,'fresh','installed',?,?)").run(NODE,ADMIN,NOW-1000,NOW-1000);
  raw.prepare("INSERT INTO routes(id,node_id,transport,state,listen_port,verified_ms) "+
    "VALUES(?,?,'reality','ready',8443,?)").run(NODE+'_reality',NODE,NOW-1000);
  for(const [operator,port] of [['mci',443],['irancell',8443]]){
    raw.prepare("INSERT INTO route_carrier_variants(route_id,operator,host,port,server_name,reality_public_key,reality_short_id,published,verified_ms) "+
      "VALUES(?,?,?,?,?,?,?,1,?)"
    ).run(NODE+'_reality',operator,'198.51.100.2',port,'www.cloudflare.com','a'.repeat(43),'abcd',NOW-1000);
  }
  raw.prepare("INSERT INTO node_health(node_id,revision,observed_ms,xray_healthy,stats_healthy) VALUES(?,1,?,1,1)")
    .run(NODE,NOW-1000);
  const prepare=(sql,args=[])=>({
    bind(...next){return prepare(sql,next);},
    async first(){return raw.prepare(sql).get(...args)??null;},
    async all(){return {results:raw.prepare(sql).all(...args)};},
    async run(){const result=raw.prepare(sql).run(...args);return {meta:{changes:Number(result.changes)}};},
  });
  const DB={prepare,async batch(stmts){
    raw.exec('BEGIN');try {
      const result=[];for(const s of stmts)result.push(await s.run());
      raw.exec('COMMIT');return result;
    }catch(e){raw.exec('ROLLBACK');throw e;}
  }};
  const env={DB,ADMIN_TELEGRAM_IDS:ADMIN,ADMIN_E2E_TEST_ENABLED:'true',
    SHOP_ENABLED:'false',PROVISIONING_ENABLED:'false',
    SUBSCRIPTION_LINKS_ENABLED:'true',SUBSCRIPTION_API_ENABLED:'true',
    SUBSCRIPTION_PUBLIC_ORIGIN:'https://v2.example.test/',SUBSCRIPTION_CREDENTIAL_KEY:key,
    NODE_MASTER_KEY:master};
  return {raw,env};
}
async function signed(method,path,data=null){
  const ts=Math.floor(NOW/1000);
  const n=(++nonce).toString(16).padStart(32,'0');
  const body=data===null?'':JSON.stringify(data);
  const h=await signNodeRequest(await deriveNodeKey(master,NODE),method,path,ts,n,
    new TextEncoder().encode(body));
  return new Request('https://v2.example.test'+path,{
    method,headers:{
      'x-madar-node-id':NODE,'x-madar-node-timestamp':String(ts),
      'x-madar-node-nonce':n,'x-madar-node-signature':h,
      ...(method==='POST'?{'content-type':'application/json'}:{})
    },...(method==='POST'?{body}:{})
  });
}
test('manager-only E2E button is scoped to staging flag and never enables store',async()=>{
  const {raw,env}=fixture();
  const home=await resolveBotAction(env,event(ADMIN,'admin:configs'),NOW);
  assert.match(home.text,/صدور کانفیگ/);
  assert.ok(home.replyMarkup.inline_keyboard.flat().some(b=>b.callback_data==='v2:admin:configs:e2e:list'));
  assert.equal(env.SHOP_ENABLED,'false');
  assert.equal(env.PROVISIONING_ENABLED,'false');
  const outsider=await resolveBotAction(env,event('100002','admin:configs:e2e:list'),NOW);
  assert.match(outsider.text,/دسترسی به این بخش مجاز نیست/);
  env.ADMIN_E2E_TEST_ENABLED='false';
  const off=await resolveBotAction(env,event(ADMIN,'admin:configs'),NOW);
  assert.ok(!off.replyMarkup.inline_keyboard.flat().some(b=>b.callback_data==='v2:admin:configs:e2e:list'));
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM orders').get().n,0);
  raw.close();
});
test('one admin confirmation creates real sealed pending UUID exactly once, without a payment receipt',async()=>{
  const {raw,env}=fixture(),ref=await nodeUiRef(NODE);
  const list=await resolveBotAction(env,event(ADMIN,'admin:configs:e2e:list'),NOW);
  assert.ok(list.replyMarkup.inline_keyboard.flat().some(b=>b.callback_data==='v2:admin:configs:e2e:view:'+ref));
  const pre=await resolveBotAction(env,event(ADMIN,'admin:configs:e2e:view:'+ref),NOW);
  assert.match(pre.text,/۱۰۰ مگابایت/);
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM orders').get().n,0);
  const started=await resolveBotAction(env,event(ADMIN,'admin:configs:e2e:start:'+ref,200),NOW);
  assert.match(started.text,/ACK/);
  const again=await resolveBotAction(env,event(ADMIN,'admin:configs:e2e:start:'+ref,201),NOW);
  assert.match(again.text,/ACK/);
  assert.deepEqual(raw.prepare('SELECT price_amount,active,quota_bytes,duration_days FROM plans').get(),
    {price_amount:0,active:0,quota_bytes:104857600,duration_days:1});
  assert.equal(raw.prepare("SELECT COUNT(*) n FROM orders WHERE quoted_amount=0 AND state='provisioning'").get().n,1);
  assert.equal(raw.prepare("SELECT COUNT(*) n FROM subscriptions WHERE state='pending'").get().n,1);
  assert.equal(raw.prepare("SELECT COUNT(*) n FROM subscription_credentials").get().n,1);
  assert.equal(raw.prepare("SELECT COUNT(*) n FROM node_allocations WHERE node_id=? AND state='reserved'").get(NODE).n,1);
  assert.equal(raw.prepare("SELECT COUNT(*) n FROM receipts").get().n,0);
  assert.equal(raw.prepare("SELECT COUNT(*) n FROM subscription_tokens").get().n,0);
  raw.close();
});
test('only real signed node client ACK activates customer and exposes two-port link; revoke disables it',async()=>{
  const {raw,env}=fixture(),ref=await nodeUiRef(NODE);
  await resolveBotAction(env,event(ADMIN,'admin:configs:e2e:start:'+ref),NOW);
  const pending=await resolveBotAction(env,event(ADMIN,'admin:configs:e2e:link:'+ref),NOW);
  assert.match(pending.text,/هنوز/);
  const manifest=await nodeRoute(await signed('GET','/api/node/v1/clients'),env,NOW);
  assert.equal(manifest.status,200);
  const snapshot=await manifest.json();
  assert.equal(snapshot.payload.mode,'commercial');
  assert.equal(snapshot.payload.clients.length,1);
  const client=snapshot.payload.clients[0];
  const sha=new Uint8Array(await crypto.subtle.digest('SHA-256',
    new TextEncoder().encode(client.uuid)));
  const hex=Array.from(sha,b=>b.toString(16).padStart(2,'0')).join('');
  const ack=await nodeRoute(await signed('POST','/api/node/v1/clients/ack',{
    revision:1,ports:[443,8443],xray_healthy:true,
    clients:[{subscription_id:client.subscription_id,uuid_sha256:hex}]
  }),env,NOW);
  assert.equal(ack.status,200);
  assert.equal((await ack.json()).applied,1);
  assert.equal(raw.prepare('SELECT state FROM subscriptions').get().state,'active');
  assert.equal(raw.prepare('SELECT state FROM orders').get().state,'fulfilled');
  const issued=await resolveBotAction(env,event(ADMIN,'admin:configs:e2e:link:'+ref),NOW);
  const url=issued.text.match(/https:\/\/v2\.example\.test\/s\/[a-zA-Z0-9_-]{43}/)?.[0];
  assert.ok(url);
  const result=await getCarrierFeed(new Request(url),env,NOW);
  assert.equal(result.status,200);
  const links=atob(await result.text()).trim().split('\n');
  assert.equal(links.length,2);
  assert.ok(links.some(x=>x.includes(':443?')));
  assert.ok(links.some(x=>x.includes(':8443?')));
  assert.ok(links.every(x=>x.startsWith('vless://'+client.uuid+'@')));
  const prompt=await resolveBotAction(env,event(ADMIN,'admin:configs:e2e:end:'+ref),NOW);
  assert.match(prompt.text,/لغو/);
  assert.equal(raw.prepare('SELECT state FROM subscriptions').get().state,'active');
  const revoked=await resolveBotAction(env,event(ADMIN,'admin:configs:e2e:revoke:'+ref),NOW);
  assert.match(revoked.text,/لغو آزمایش ثبت شد/);
  assert.equal(raw.prepare('SELECT state FROM subscriptions').get().state,'revoked');
  assert.equal(raw.prepare('SELECT revoked FROM subscription_tokens').get().revoked,1);
  assert.equal((await getCarrierFeed(new Request(url),env,NOW+1000)).status,403);
  raw.close();
});
test('unhealthy node cannot create new test, but admin can revoke an existing E2E account',async()=>{
  const {raw,env}=fixture(),ref=await nodeUiRef(NODE);
  raw.prepare("UPDATE node_health SET observed_ms=? WHERE node_id=?").run(NOW-700000,NODE);
  const blocked=await resolveBotAction(env,event(ADMIN,'admin:configs:e2e:start:'+ref),NOW);
  assert.match(blocked.text,/no_verified_capacity/);
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM subscriptions').get().n,0);
  // No test subscription is created even though the synthetic order remains approved.
  raw.close();
});
