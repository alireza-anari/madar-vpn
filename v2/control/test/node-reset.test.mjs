import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readdirSync,readFileSync} from 'node:fs';
import {resetEligibility,retireCleanedNode} from '../src/node-reset.mjs';
import {enrollmentPage} from '../src/enrollment-page.mjs';

const NOW=1800000000000,OWNER='100001',NODE='test-reset01';
function fixture(){
  const raw=new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys=ON');
  for(const file of readdirSync(new URL('../migrations/',import.meta.url)).sort())
    raw.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
  raw.exec("INSERT INTO customers(telegram_id,locale) VALUES('100001','fa')");
  raw.exec("INSERT INTO nodes(id,provider,region,lifecycle,user_limit,byte_limit) "+
    "VALUES('test-reset01','aws','eu', 'ready',20,5000000)");
  raw.prepare("INSERT INTO node_bootstrap_jobs(id,node_id,ip,owner_id,mode,state,created_ms,updated_ms) "+
    "VALUES('install-reset','test-reset01','8.8.8.8',?,'fresh','installed',?,?)")
    .run(OWNER,NOW-1000,NOW-1000);
  raw.exec("INSERT INTO subscriptions(id,owner_telegram_id,state,expires_at,max_bytes,used_bytes) "+
    "VALUES('sub-pending','100001','pending',0,1000,0)");
  raw.exec("INSERT INTO node_allocations(id,node_id,subscription_id,quota_bytes,state) "+
    "VALUES('alloc-reset','test-reset01','sub-pending',1000,'reserved')");
  const adapt=(sql,args=[])=>({
    bind(...next){return adapt(sql,next);},
    async first(){return raw.prepare(sql).get(...args)??null;},
    async all(){return {results:raw.prepare(sql).all(...args)};},
    async run(){return {meta:raw.prepare(sql).run(...args)};},
  });
  return {raw,db:{prepare:sql=>adapt(sql),
    async batch(statements){raw.exec('BEGIN');try{
      const out=[];
      for(const s of statements)out.push(await s.run());
      raw.exec('COMMIT');return out;
    }catch(e){raw.exec('ROLLBACK');throw e;}}}};
}
test('safe reset allows only pending zero-usage reservations, and requires verified owner',async()=>{
  const {raw,db}=fixture();
  const allowed=await resetEligibility(db,OWNER,NODE,NOW);
  assert.equal(allowed.ok,true);
  assert.equal(allowed.willCancelPending,1);
  assert.equal((await resetEligibility(db,'other',NODE,NOW)).ok,false);
  assert.equal((await resetEligibility(db,OWNER,'../bad',NOW)).ok,false);
  raw.exec("UPDATE subscriptions SET used_bytes=10 WHERE id='sub-pending'");
  assert.equal((await resetEligibility(db,OWNER,NODE,NOW)).code,'NODE_HAS_ACTIVE_OR_USED_ACCOUNTS');
  raw.exec("UPDATE subscriptions SET used_bytes=0,state='active' WHERE id='sub-pending'");
  assert.equal((await resetEligibility(db,OWNER,NODE,NOW)).ok,false);
  raw.close();
});
test('positive client installation ACK or still-active trial blocks VPS removal',async()=>{
  const {raw,db}=fixture();
  raw.prepare("INSERT INTO node_trial_links(token_hash,node_id,owner_id,expires_ms) "+
    "VALUES(?,?,?,?)").run('a'.repeat(64),NODE,OWNER,NOW+60000);
  assert.equal((await resetEligibility(db,OWNER,NODE,NOW)).code,'NODE_HAS_LIVE_TRIAL');
  raw.exec("DELETE FROM node_trial_links");
  raw.prepare("INSERT INTO node_client_acks(node_id,subscription_id,revision,credential_sha256,observed_ms) "+
    "VALUES(?, 'sub-pending',1,?,?)").run(NODE,'b'.repeat(64),NOW);
  assert.equal((await resetEligibility(db,OWNER,NODE,NOW)).code,'NODE_HAS_ACTIVE_OR_USED_ACCOUNTS');
  raw.close();
});
test('signed remote cleanup completion preserves history and retires node atomically',async()=>{
  const {raw,db}=fixture();
  raw.exec("UPDATE nodes SET lifecycle='quarantined' WHERE id='test-reset01'");
  raw.prepare("INSERT INTO v2_runner_jobs(id,owner_id,kind,spec_json,state,lease_id,lease_until_ms,created_ms,expires_ms) "+
    "VALUES('job-reset','100001','v2-install','{}','leased','lease',?,?,?)")
    .run(NOW+10000,NOW,NOW+900000);
  const completion=db.prepare("UPDATE v2_runner_jobs SET state='ready',safe_code='RESET_COMPLETED' "+
    "WHERE id='job-reset' AND state='leased'");
  assert.equal(await retireCleanedNode(db,OWNER,NODE,'job-reset',NOW,completion),true);
  assert.equal(raw.prepare("SELECT lifecycle FROM nodes WHERE id=?").get(NODE).lifecycle,'retired');
  assert.equal(raw.prepare("SELECT state FROM subscriptions WHERE id='sub-pending'").get().state,'revoked');
  assert.equal(raw.prepare("SELECT state FROM node_allocations WHERE id='alloc-reset'").get().state,'released');
  assert.equal(raw.prepare("SELECT state FROM v2_runner_jobs WHERE id='job-reset'").get().state,'ready');
  assert.equal(raw.prepare("SELECT COUNT(*) n FROM audit_events WHERE verb='v2-owner-remote-reset-complete'").get().n,1);
  // Second callback cannot pretend to reset a retired node.
  assert.equal(await retireCleanedNode(db,OWNER,NODE,'job-reset',NOW,completion),false);
  raw.close();
});
test('reset control is visible after secure SSH probe but not a blind delete',()=>{
  assert.match(enrollmentPage,/id="resetInstalled"/);
  assert.match(enrollmentPage,/reset-check\?nodeId=/);
  assert.match(enrollmentPage,/confirmNodeId:nodeId/);
  assert.match(enrollmentPage,/RESET_V2_ONLY/);
  assert.match(enrollmentPage,/پاک‌سازی V2 روی سرور/);
});
