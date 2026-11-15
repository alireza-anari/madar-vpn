import test from 'node:test';
import assert from 'node:assert/strict';
import {androidLoginRoute,approveAndroidLogin} from '../src/android-login.mjs';

class FakeDB {
  constructor(){this.challenges=new Map();this.queries=[];}
  prepare(sql){
    this.queries.push(sql);
    return {bind:(...args)=>({
      run:async()=>{
        if(sql.startsWith('INSERT INTO android_login_challenges')){
          this.challenges.set(args[0],{id:args[0],verifier_hash:args[1],
            created_ms:args[2],expires_ms:args[3],state:'pending',telegram_id:null});
          return {meta:{changes:1}};
        }
        if(sql.includes("SET state='approved'")){
          const row=this.challenges.get(args[1]);
          if(row && row.state==='pending' && row.expires_ms>args[2]){
            row.state='approved';row.telegram_id=args[0];return {meta:{changes:1}};
          }
          return {meta:{changes:0}};
        }
        return {meta:{changes:0}};
      },
      first:async()=>{
        if(sql.includes('FROM android_login_challenges')){
          const row=this.challenges.get(args[0]);
          return row?.verifier_hash===args[1]?row:null;
        }
        if(sql.includes('FROM subscriptions'))return {id:'sub-for-active-customer'};
        return null;
      },
    })};
  }
}
const url='https://madar-v2.test/api/v2/android/login/';
const post=(name,value)=>new Request(url+name,{method:'POST',
  headers:{'content-type':'application/json'},body:JSON.stringify(value)});
const enabled=(db)=>({DB:db,ANDROID_LOGIN_ENABLED:'true',
  SUBSCRIPTION_API_ENABLED:'true',BOT_USERNAME:'MadarTestBot'});

test('mobile authorization is fail-closed without explicit configuration',async()=>{
  const r=await androidLoginRoute(post('start',{}),{},1000);
  assert.equal(r.status,503);
  assert.equal((await r.json()).error,'not_ready');
});
test('public Telegram URL never contains the secret verifier',async()=>{
  const db=new FakeDB(),now=1_900_000_000_000;
  const env=enabled(db);
  const response=await androidLoginRoute(post('start',{}),env,now);
  assert.equal(response.status,200);
  const challenge=await response.json();
  assert.match(challenge.id,/^[A-Za-z0-9_-]{24}$/);
  assert.match(challenge.verifier,/^[A-Za-z0-9_-]{43}$/);
  assert.equal(challenge.login_url,
    'https://t.me/MadarTestBot?start=app_'+challenge.id);
  assert.equal(challenge.login_url.includes(challenge.verifier),false);
  assert.equal(db.challenges.get(challenge.id).verifier_hash.length,64);
  assert.equal(JSON.stringify([...db.challenges.values()]).includes(challenge.verifier),false);

  const pending=await androidLoginRoute(post('complete',{
    id:challenge.id,verifier:challenge.verifier}),env,now+1000);
  assert.equal(pending.status,202);
  const forged=await androidLoginRoute(post('complete',{
    id:challenge.id,verifier:'A'.repeat(43)}),env,now+1000);
  assert.equal(forged.status,403);

  assert.equal(await approveAndroidLogin(env,{
    key:'/unknown',inputText:'/start app_'+challenge.id,actorId:'1234567'},now+2000),null);
  const approved=await approveAndroidLogin(env,{
    key:'/start',inputText:'/start app_'+challenge.id,actorId:'1234567'},now+2000);
  assert.match(approved.text,/ورود تأیید شد/);
  assert.equal(db.challenges.get(challenge.id).telegram_id,'1234567');
  const second=await approveAndroidLogin(env,{
    key:'/start',inputText:'/start app_'+challenge.id,actorId:'9999999'},now+2001);
  assert.match(second.text,/قبلاً استفاده شده/);
  assert.equal(db.challenges.get(challenge.id).telegram_id,'1234567');
});
test('an expired challenge cannot be approved or completed',async()=>{
  const now=1_900_000_000_000,db=new FakeDB(),env=enabled(db);
  const r=await androidLoginRoute(post('start',{}),env,now);
  const challenge=await r.json();
  const after=now+300001;
  const approval=await approveAndroidLogin(env,{
    key:'/start',inputText:'/start app_'+challenge.id,actorId:'1234567'},after);
  assert.match(approval.text,/منقضی شده/);
  const result=await androidLoginRoute(post('complete',{
    id:challenge.id,verifier:challenge.verifier}),env,after);
  assert.equal(result.status,410);
});
