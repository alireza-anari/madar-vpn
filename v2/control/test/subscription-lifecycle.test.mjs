import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readdirSync,readFileSync} from 'node:fs';
import {expireEntitlements} from '../src/subscription-lifecycle.mjs';
test('expiry and exhausted quota invalidate links but wait for node removal ACK',async()=>{
  const raw=new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys=ON');
  for(const file of readdirSync(new URL('../migrations/',import.meta.url)).sort())
    raw.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
  raw.exec("INSERT INTO customers(telegram_id) VALUES('100')");
  raw.exec("INSERT INTO nodes(id,provider,region,lifecycle,user_limit,byte_limit) "+
    "VALUES('test-node01','vendor','eu','ready',10,10000)");
  for(const [id,expiration,used] of [['old',100,0],['empty',2000,1000],['valid',2000,0]]){
    raw.prepare("INSERT INTO subscriptions(id,owner_telegram_id,state,expires_at,max_bytes,used_bytes) "+
      "VALUES(?,'100','active',?,1000,?)").run(id,expiration,used);
    raw.prepare("INSERT INTO node_allocations(id,node_id,subscription_id,quota_bytes,state) "+
      "VALUES(?,'test-node01',?,1000,'active')").run('alloc-'+id,id);
    raw.prepare("INSERT INTO subscription_tokens(token_hash,subscription_id,expires_at) "+
      "VALUES(?,?,2000)").run(id.padEnd(64,'a'),id);
  }
  const stmt=(sql,args=[])=>({
    bind(...params){return stmt(sql,params);},
    async run(){const info=raw.prepare(sql).run(...args);return {meta:{changes:Number(info.changes)}};},
  });
  const updated=await expireEntitlements({DB:{prepare:stmt}},1000);
  assert.equal(updated.expired,2);
  assert.deepEqual(raw.prepare('SELECT id FROM subscriptions WHERE state="active"').all()
    .map(x=>x.id),['valid']);
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM subscription_tokens').get().n,1);
  assert.equal(raw.prepare("SELECT COUNT(*) n FROM node_allocations WHERE state='active'").get().n,3);
  raw.close();
});
