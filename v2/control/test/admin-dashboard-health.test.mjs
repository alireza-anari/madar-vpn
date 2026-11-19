import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {adminDashboard} from '../src/bot-panels.mjs';

const NOW=1800000000000;
const EVENT={actorId:'100001',chatId:'100001',locale:'fa',key:'admin:home'};
function fixture() {
  const raw=new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys=ON');
  for(const file of readdirSync(new URL('../migrations/',import.meta.url)).sort())
    raw.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
  raw.exec("INSERT INTO customers(telegram_id,locale) VALUES('100001','fa')");
  raw.exec("INSERT INTO nodes(id,provider,region,lifecycle,user_limit,byte_limit,desired_revision,acked_revision) "+
    "VALUES('node-aa','aws','eu','ready',2,5000000000,2,2)");
  raw.prepare("INSERT INTO node_bootstrap_jobs(id,node_id,ip,owner_id,mode,state,created_ms,updated_ms) "+
    "VALUES('job-aa','node-aa','198.51.100.1','100001','fresh','installed',?,?)")
    .run(NOW-10000,NOW-10000);
  const prepare=(sql,args=[])=>({
    bind(...values){return prepare(sql,values);},
    async first(){return raw.prepare(sql).get(...args)??null;}
  });
  return {raw,env:{DB:{prepare},ADMIN_TELEGRAM_IDS:'100001',SHOP_ENABLED:'false',PROVISIONING_ENABLED:'false'}};
}

test('dashboard distinguishes historical field approval from fresh signed operational health',async()=>{
  const {raw,env}=fixture();
  let page=await adminDashboard(env,EVENT,NOW);
  assert.match(page.text,/آماده برای صدور: ۰/);
  assert.match(page.text,/تأیید اولیه: ۱/);
  assert.match(page.text,/گزارش سلامت تازه/);
  raw.prepare("INSERT INTO node_health(node_id,revision,observed_ms,xray_healthy,stats_healthy) VALUES('node-aa',2,?,1,1)")
    .run(NOW-1000);
  page=await adminDashboard(env,EVENT,NOW);
  assert.match(page.text,/آماده برای صدور: ۱/);
  assert.match(page.text,/تأیید اولیه: ۱/);
  raw.prepare("UPDATE node_health SET observed_ms=? WHERE node_id='node-aa'").run(NOW-600001);
  page=await adminDashboard(env,EVENT,NOW);
  assert.match(page.text,/آماده برای صدور: ۰/);
  assert.match(page.text,/تأیید اولیه: ۱/);
  raw.close();
});

test('dashboard refuses stale revision, invalid health, missing install and full capacity',async()=>{
  const {raw,env}=fixture();
  raw.prepare("INSERT INTO node_health(node_id,revision,observed_ms,xray_healthy,stats_healthy) VALUES('node-aa',2,?,1,1)")
    .run(NOW);
  const count=async()=> (await adminDashboard(env,EVENT,NOW)).text;
  raw.exec("UPDATE node_health SET revision=1");
  assert.match(await count(),/آماده برای صدور: ۰/);
  raw.exec("UPDATE node_health SET revision=2,xray_healthy=0");
  assert.match(await count(),/آماده برای صدور: ۰/);
  raw.exec("UPDATE node_health SET xray_healthy=1");
  raw.exec("UPDATE node_bootstrap_jobs SET state='failed'");
  assert.match(await count(),/آماده برای صدور: ۰/);
  raw.exec("UPDATE node_bootstrap_jobs SET state='installed'");
  assert.match(await count(),/آماده برای صدور: ۱/);
  raw.exec("INSERT INTO subscriptions(id,owner_telegram_id,state,expires_at,max_bytes,used_bytes) "+
    "VALUES('sub-one','100001','pending',0,1000,0),('sub-two','100001','pending',0,1000,0)");
  raw.exec("INSERT INTO node_allocations(id,node_id,subscription_id,quota_bytes,state) VALUES "+
    "('alloc-one','node-aa','sub-one',1000,'reserved'),"+
    "('alloc-two','node-aa','sub-two',1000,'active')");
  assert.match(await count(),/آماده برای صدور: ۰/);
  assert.match(await count(),/تأیید اولیه: ۱/);
  raw.close();
});
