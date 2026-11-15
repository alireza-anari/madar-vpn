import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readdirSync,readFileSync} from 'node:fs';
import {resolveBotAction} from '../src/shop.mjs';
import {nodeUiRef} from '../src/node-admin.mjs';
import {wrapClientUuid} from '../src/subscription.mjs';
import {getCarrierFeed} from '../src/carrier-subscription.mjs';
import {getTrialFeed} from '../src/node-auto.mjs';

const KEY=btoa(String.fromCharCode(...new Uint8Array(32).fill(7)))
  .replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const UUID='12345678-1234-4123-8123-123456789012';
const BASE='https://v2.example.test';
function fixture(){
  const raw=new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys=ON');
  for(const file of readdirSync(new URL('../migrations/',import.meta.url)).sort())
    raw.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
  raw.exec("INSERT INTO customers(telegram_id) VALUES('100'),('101'),('200')");
  const prepare=(sql,args=[])=>({
    bind(...next){return prepare(sql,next);},
    async first(){return raw.prepare(sql).get(...args)??null;},
    async all(){return {results:raw.prepare(sql).all(...args)};},
    async run(){return {meta:raw.prepare(sql).run(...args)};},
  });
  const DB={prepare,async batch(steps){
    raw.exec('BEGIN');
    try {const out=[];for(const st of steps)out.push(await st.run());raw.exec('COMMIT');return out;}
    catch(e){raw.exec('ROLLBACK');throw e;}
  }};
  const env={DB,ADMIN_TELEGRAM_IDS:'100,101',SHOP_ENABLED:'false',PROVISIONING_ENABLED:'false',
    SUBSCRIPTION_LINKS_ENABLED:'false',SUBSCRIPTION_API_ENABLED:'false',
    SUBSCRIPTION_CREDENTIAL_KEY:KEY,SUBSCRIPTION_PUBLIC_ORIGIN:BASE};
  const event=(id,key,updateId=10)=>({actorId:String(id),chatId:String(id),
    key,updateId,locale:'fa',inputText:null,photoId:null});
  return {raw,DB,env,event};
}
function carrierRows(raw,node,ready,nowMs){
  raw.prepare("INSERT INTO routes(id,node_id,transport,state,verified_ms) VALUES(?,?,'reality',?,?)")
    .run(node+'_reality',node,ready?'ready':'draft',ready?nowMs-1000:null);
  for(const [operator,port] of [['mci',443],['irancell',8443]])
    raw.prepare(
      "INSERT INTO route_carrier_variants(route_id,operator,host,port,server_name,reality_public_key,reality_short_id,published,verified_ms) "+
      "VALUES(?,?,?,?,? ,?,?,?,?)"
    ).run(node+'_reality',operator,'198.51.100.2',port,'www.cloudflare.com','a'.repeat(43),'aabb',
      ready?1:0,ready?nowMs-1000:null);
}
async function ref(id){
  const hash=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(id)));
  return Array.from(hash.slice(0,12),b=>b.toString(16).padStart(2,'0')).join('');
}
test('config issuance is admin-only and never fabricates a paid subscription',async()=>{
  const {raw,env,event}=fixture(),now=1000000;
  const denied=await resolveBotAction(env,event(200,'admin:configs'),now);
  assert.match(denied.text,/دسترسی به این بخش مجاز نیست/);
  const home=await resolveBotAction(env,event(100,'admin:configs'),now);
  assert.match(home.text,/صدور کانفیگ/);
  assert.match(home.text,/غیرفعال/);
  const buttons=home.replyMarkup.inline_keyboard.flat().map(x=>x.callback_data);
  assert.ok(buttons.includes('v2:admin:configs:trials:0'));
  assert.ok(buttons.includes('v2:admin:configs:subscriptions:0'));
  const subscriptions=await resolveBotAction(env,event(100,'admin:configs:subscriptions:0'),now);
  assert.match(subscriptions.text,/اشتراک فعال و معتبر.*وجود ندارد/);
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM subscription_tokens').get().n,0);
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM node_trial_links').get().n,0);
  raw.close();
});

test('installed V2 node offers exactly one private two-carrier trial link, blocked on quarantine',async()=>{
  const {raw,env,event}=fixture(),now=1000000,id='trial-node';
  raw.prepare("INSERT INTO nodes(id,provider,region,lifecycle,user_limit,byte_limit) VALUES(?,'Webdade','test','provisioning',20,10737418240)").run(id);
  raw.prepare(
    "INSERT INTO node_bootstrap_jobs(id,node_id,ip,owner_id,mode,state,created_ms,updated_ms) "+
    "VALUES('job-1',?,'198.51.100.2','100','fresh','installed',1,1)"
  ).run(id);
  carrierRows(raw,id,false,now);
  const credential=await wrapClientUuid(UUID,KEY);
  raw.prepare("INSERT INTO node_trial_credentials(node_id,ciphertext_b64,nonce_b64,key_version,created_ms) "+
    "VALUES(?,?,?,?,?)").run(id,credential.ciphertext_b64,credential.nonce_b64,1,1);
  const list=await resolveBotAction(env,event(100,'admin:configs:trials:0',200),now);
  const token=await nodeUiRef(id);
  assert.ok(list.replyMarkup.inline_keyboard.flat().some(x=>x.callback_data==='v2:admin:configs:trial:'+token));
  const other=await resolveBotAction(env,event(101,'admin:configs:trial:'+token,201),now);
  assert.match(other.text,/صدور تست وجود ندارد/);
  const issued=await resolveBotAction(env,event(100,'admin:configs:trial:'+token,202),now);
  const url=issued.text.match(/https:\/\/v2\.example\.test\/t\/[a-zA-Z0-9_-]{43}/)?.[0];
  assert.ok(url);
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM node_trial_links').get().n,1);
  const feed=await getTrialFeed(new Request(url),env,now);
  assert.equal(feed.status,200);
  const entries=atob(await feed.text()).trim().split('\n');
  assert.equal(entries.length,2);
  assert.ok(entries.some(x=>x.includes(':443?')));
  assert.ok(entries.some(x=>x.includes(':8443?')));
  raw.prepare("UPDATE nodes SET lifecycle='quarantined' WHERE id=?").run(id);
  assert.equal((await getTrialFeed(new Request(url),env,now+1)).status,403);
  const rejected=await resolveBotAction(env,event(100,'admin:configs:trial:'+token,203),now+2);
  assert.match(rejected.text,/امکان صدور تست وجود ندارد/);
  raw.close();
});

test('one real carrier subscription link is issued only for active quota and two verified routes',async()=>{
  const {raw,env,event}=fixture(),now=1000000,id='ready-node';
  raw.prepare("INSERT INTO nodes(id,provider,region,lifecycle,user_limit,byte_limit) "+
    "VALUES(?,'Webdade','test','ready',20,10737418240)").run(id);
  carrierRows(raw,id,true,now);
  raw.prepare("INSERT INTO subscriptions(id,owner_telegram_id,state,expires_at,max_bytes,used_bytes) "+
    "VALUES('active-sub','200','active',5000000,2147483648,0)").run();
  raw.prepare("INSERT INTO node_allocations(id,node_id,subscription_id,quota_bytes,state) "+
    "VALUES('alloc-1',?,'active-sub',2147483648,'active')").run(id);
  const encoded=await wrapClientUuid(UUID,KEY);
  raw.prepare("INSERT INTO subscription_credentials(subscription_id,ciphertext_b64,nonce_b64,key_version) "+
    "VALUES('active-sub',?,?,1)").run(encoded.ciphertext_b64,encoded.nonce_b64);
  const token=await ref('active-sub');
  const sub=await resolveBotAction(env,event(100,'admin:configs:subscription:'+token,300),now);
  assert.match(sub.text,/تأیید صدور کانفیگ/);
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM subscription_tokens').get().n,0);
  const disabled=await resolveBotAction(env,event(100,'admin:configs:issue:'+token,301),now);
  assert.match(disabled.text,/کانفیگ صادر نشد/);
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM subscription_tokens').get().n,0);
  env.SUBSCRIPTION_API_ENABLED='true';
  env.SUBSCRIPTION_LINKS_ENABLED='true';
  const issued=await resolveBotAction(env,event(100,'admin:configs:issue:'+token,302),now);
  const url=issued.text.match(/https:\/\/v2\.example\.test\/s\/[a-zA-Z0-9_-]{43}/)?.[0];
  assert.ok(url);
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM subscription_tokens').get().n,1);
  const feed=await getCarrierFeed(new Request(url),env,now);
  assert.equal(feed.status,200);
  const entries=atob(await feed.text()).trim().split('\n');
  assert.equal(entries.length,2);
  assert.ok(entries.some(x=>x.includes(':443?')));
  assert.ok(entries.some(x=>x.includes(':8443?')));
  assert.ok(entries.every(x=>x.startsWith('vless://'+UUID+'@')));
  raw.prepare("UPDATE customers SET state='suspended' WHERE telegram_id='200'").run();
  const denied=await resolveBotAction(env,event(100,'admin:configs:issue:'+token,303),now+1);
  assert.match(denied.text,/اشتراک فعال و دارای سهمیه نیست/);
  assert.equal((await getCarrierFeed(new Request(url),env,now+1)).status,403);
  raw.close();
});
