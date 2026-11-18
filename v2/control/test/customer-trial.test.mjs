import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readdirSync,readFileSync} from 'node:fs';
import {resolveBotAction} from '../src/shop.mjs';
import {botMenu} from '../src/bot-ux.mjs';
import {wrapClientUuid,unwrapClientUuid} from '../src/subscription.mjs';
import {getTrialFeed} from '../src/node-auto.mjs';

const KEY=btoa(String.fromCharCode(...new Uint8Array(32).fill(7)))
  .replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const UUID='12345678-1234-4123-8123-123456789012';
const ORIGIN='https://v2.example.test';

function fixture(){
  const raw=new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys=ON');
  for(const file of readdirSync(new URL('../migrations/',import.meta.url)).sort())
    raw.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
  raw.exec("INSERT INTO customers(telegram_id) VALUES('100'),('200'),('300'),('400')");
  raw.exec("INSERT INTO telegram_bot_activations(telegram_id,channel_id,activated_ms,last_verified_ms) "+
    "VALUES('100','-1001234567890',1,1),('200','-1001234567890',1,1),"+
    "('300','-1001234567890',1,1),('400','-1001234567890',1,1)");
  const prepare=(sql,args=[])=>({
    bind(...next){return prepare(sql,next);},
    async first(){return raw.prepare(sql).get(...args)??null;},
    async all(){return {results:raw.prepare(sql).all(...args)};},
    async run(){return {meta:raw.prepare(sql).run(...args)};},
  });
  const DB={prepare,async batch(steps){
    raw.exec('BEGIN');
    try{const out=[];for(const step of steps)out.push(await step.run());raw.exec('COMMIT');return out;}
    catch(error){raw.exec('ROLLBACK');throw error;}
  }};
  const env={DB,ADMIN_TELEGRAM_IDS:'100',SUBSCRIPTION_CREDENTIAL_KEY:KEY,
    SUBSCRIPTION_PUBLIC_ORIGIN:ORIGIN,SHOP_ENABLED:'false',PROVISIONING_ENABLED:'false'};
  const event=(id,key,updateId=10)=>({actorId:String(id),chatId:String(id),
    key,updateId,locale:'fa',inputText:null,photoId:null});
  return {raw,DB,env,event};
}
async function readyNode(raw,id,nowMs,{verified=true,lifecycle='ready'}={}){
  raw.prepare("INSERT INTO nodes(id,provider,region,lifecycle,user_limit,byte_limit) "+
    "VALUES(?,'Webdade','test',?,20,10737418240)").run(id,lifecycle);
  raw.prepare("UPDATE nodes SET acked_revision=desired_revision WHERE id=?").run(id);
  raw.prepare(
    "INSERT INTO node_bootstrap_jobs(id,node_id,ip,owner_id,mode,state,created_ms,updated_ms) "+
    "VALUES(?,?,'198.51.100.2','100','fresh','installed',1,1)"
  ).run('job-'+id,id);
  raw.prepare("INSERT INTO routes(id,node_id,transport,state,verified_ms) "+
    "VALUES(?,?,'reality',?,?)").run(id+'_reality',id,verified?'ready':'draft',
      verified?nowMs-1000:null);
  for(const [operator,port] of [['mci',443],['irancell',8443]])
    raw.prepare(
      "INSERT INTO route_carrier_variants(route_id,operator,host,port,server_name,reality_public_key,reality_short_id,published,verified_ms) "+
      "VALUES(?,?,?,?,?,?,?,?,?)"
    ).run(id+'_reality',operator,'198.51.100.2',port,'www.cloudflare.com',
      'a'.repeat(43),'aabb',verified?1:0,verified?nowMs-1000:null);
  const encrypted=await wrapClientUuid(UUID,KEY);
  raw.prepare("INSERT INTO node_trial_credentials(node_id,ciphertext_b64,nonce_b64,key_version,created_ms) "+
    "VALUES(?,?,?,1,1)").run(id,encrypted.ciphertext_b64,encrypted.nonce_b64);
}
const urlFrom=reply=>reply.text.match(/https:\/\/v2\.example\.test\/t\/[A-Za-z0-9_-]{43}/)?.[0]??null;

test('customer panel exposes one clearly labeled free-trial action',()=>{
  const buttons=botMenu().inline_keyboard.flat();
  assert.ok(buttons.some(x=>x.callback_data==='v2:customer:trial'&&x.text==='🧪 دریافت تست رایگان'));
});

test('one Telegram account receives one one-hour link with both verified carriers, even after expiry',async()=>{
  const {raw,env,event}=fixture(),now=1_000_000;
  await readyNode(raw,'test-customer-trial',now);
  const first=await resolveBotAction(env,event(200,'customer:trial',501),now);
  const url=urlFrom(first);
  assert.ok(url);
  assert.match(first.text,/تست یک‌ساعته شما فعال شد/);
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM customer_trial_claims WHERE telegram_id=?').get('200').n,1);
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM node_trial_links WHERE owner_id=?').get('200').n,1);
  // A link alone is not a working config: server must first install this
  // customer's own UUID on both REALITY listeners.
  assert.equal((await getTrialFeed(new Request(url),env,now)).status,503);
  const sub=raw.prepare("SELECT s.max_bytes,s.expires_at,c.ciphertext_b64,c.nonce_b64,c.key_version "+
    "FROM subscriptions s JOIN subscription_credentials c ON c.subscription_id=s.id "+
    "WHERE s.id='trial-200'").get();
  assert.equal(sub.max_bytes,1073741824);
  assert.equal(sub.expires_at,now+3600000);
  const ownUuid=await unwrapClientUuid(sub,KEY);
  assert.notEqual(ownUuid,UUID);
  raw.prepare("INSERT INTO node_client_acks(node_id,subscription_id,revision,credential_sha256,observed_ms) "+
    "VALUES(?,'trial-200',1,?,?)").run('test-customer-trial','a'.repeat(64),now);
  const feed=await getTrialFeed(new Request(url),env,now);
  assert.equal(feed.status,200);
  const lines=atob(await feed.text()).trim().split('\n');
  assert.equal(lines.length,2);
  assert.ok(lines.some(x=>x.includes(':443?')&&decodeURIComponent(x).includes('همراه اول')));
  assert.ok(lines.some(x=>x.includes(':8443?')&&decodeURIComponent(x).includes('ایرانسل')));
  assert.ok(lines.every(x=>x.startsWith('vless://'+ownUuid+'@')));

  const repeat=await resolveBotAction(env,event(200,'customer:trial',502),now+1000);
  assert.match(repeat.text,/قبلاً برای حساب شما صادر شده است/);
  assert.equal(urlFrom(repeat),url); // Same capability, not a second trial.
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM customer_trial_claims WHERE telegram_id=?').get('200').n,1);
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM node_trial_links WHERE owner_id=?').get('200').n,1);

  const expired=await resolveBotAction(env,event(200,'customer:trial',503),now+3600001);
  assert.match(expired.text,/سهمیه تست استفاده شده/);
  assert.equal(urlFrom(expired),null);
  assert.equal((await getTrialFeed(new Request(url),env,now+3600001)).status,403);
  const again=await resolveBotAction(env,event(200,'customer:trial',504),now+3600002);
  assert.match(again.text,/امکان صدور تست مجدد وجود ندارد/);
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM customer_trial_claims WHERE telegram_id=?').get('200').n,1);
  raw.close();
});

test('each Telegram ID gets its own independent lifetime claim',async()=>{
  const {raw,env,event}=fixture(),now=2_000_000;
  await readyNode(raw,'test-second-account',now);
  const first=await resolveBotAction(env,event(200,'customer:trial',601),now);
  const second=await resolveBotAction(env,event(300,'customer:trial',602),now+1);
  assert.ok(urlFrom(first));
  assert.ok(urlFrom(second));
  assert.notEqual(urlFrom(first),urlFrom(second));
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM customer_trial_claims').get().n,2);
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM node_trial_links').get().n,2);
  raw.close();
});

test('no eligible server or stale carrier verification does not consume the one-time claim',async()=>{
  const {raw,env,event}=fixture(),now=3_000_000;
  const none=await resolveBotAction(env,event(200,'customer:trial',701),now);
  assert.match(none.text,/سرور آماده با دو مسیر تأییدشده پیدا نشد/);
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM customer_trial_claims').get().n,0);

  await readyNode(raw,'test-not-yet-verified',now,{verified:false,lifecycle:'provisioning'});
  const pending=await resolveBotAction(env,event(200,'customer:trial',702),now+1);
  assert.match(pending.text,/سهمیه یک‌باره شما مصرف نشده است/);
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM customer_trial_claims').get().n,0);

  raw.prepare("UPDATE nodes SET lifecycle='ready' WHERE id='test-not-yet-verified'").run();
  raw.prepare("UPDATE routes SET state='ready',verified_ms=? WHERE node_id='test-not-yet-verified'")
    .run(now+2);
  raw.prepare("UPDATE route_carrier_variants SET published=1,verified_ms=? WHERE route_id='test-not-yet-verified_reality'")
    .run(now+2);
  const ready=await resolveBotAction(env,event(200,'customer:trial',703),now+3);
  assert.ok(urlFrom(ready));
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM customer_trial_claims').get().n,1);
  raw.close();
});

test('customer trial feed is revoked when account is suspended or the server leaves ready state',async()=>{
  const {raw,env,event}=fixture(),now=4_000_000;
  await readyNode(raw,'test-revocation',now);
  const issued=await resolveBotAction(env,event(200,'customer:trial',801),now);
  const url=urlFrom(issued);
  assert.ok(url);
  raw.prepare("UPDATE customers SET state='suspended' WHERE telegram_id='200'").run();
  assert.equal((await getTrialFeed(new Request(url),env,now+1)).status,403);
  raw.prepare("UPDATE customers SET state='active' WHERE telegram_id='200'").run();
  raw.prepare("UPDATE nodes SET lifecycle='quarantined' WHERE id='test-revocation'").run();
  assert.equal((await getTrialFeed(new Request(url),env,now+2)).status,403);
  raw.close();
});

test('suspended customers cannot claim a trial',async()=>{
  const {raw,env,event}=fixture(),now=5_000_000;
  await readyNode(raw,'test-suspended',now);
  raw.prepare("UPDATE customers SET state='suspended' WHERE telegram_id='200'").run();
  const reply=await resolveBotAction(env,event(200,'customer:trial',901),now);
  assert.match(reply.text,/حساب شما تعلیق شده است/);
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM customer_trial_claims').get().n,0);
  raw.close();
});
