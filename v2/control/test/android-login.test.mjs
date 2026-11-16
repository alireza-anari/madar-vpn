import test from 'node:test';
import assert from 'node:assert/strict';
import {androidLoginRoute,approveAndroidLogin} from '../src/android-login.mjs';

class FakeDB {
  constructor(){this.challenges=new Map();this.queries=[];this.rates=new Map();this.revoked=new Set();this.tokenHashes=new Set();}
  prepare(sql){
    this.queries.push(sql);
    return {bind:(...args)=>({
      run:async()=>{
        if(sql.startsWith('INSERT INTO android_login_rate_limits')){
          const key=args[0]+':'+args[1],count=this.rates.get(key)??0;
          if(count>=30)return {meta:{changes:0}};
          this.rates.set(key,count+1);return {meta:{changes:1}};
        }
        if(sql.startsWith('UPDATE subscription_tokens')){
          this.revoked.add(args[0]);return {meta:{changes:1}};
        }
        if(sql.startsWith('INSERT INTO subscription_tokens')){
          this.tokenHashes.add(args[0]);return {meta:{changes:1}};
        }
        if(sql.includes("SET state='redeeming'")){
          const row=this.challenges.get(args[0]);
          if(row && row.state==='approved' && row.expires_ms>args[2]){
            row.state='redeeming';return {meta:{changes:1}};
          }
          return {meta:{changes:0}};
        }
        if(sql.includes("UPDATE android_login_challenges SET state=?")){
          const row=this.challenges.get(args[1]);
          if(row && row.state==='redeeming'){row.state=args[0];return {meta:{changes:1}};}
          return {meta:{changes:0}};
        }
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
        if(sql.includes('JOIN subscription_credentials c ON c.subscription_id=s.id'))
          return {id:'sub-for-active-customer',expires_at:1_900_003_600_000};
        if(sql.includes('FROM subscriptions'))return {id:'sub-for-active-customer'};
        return null;
      },
      all:async()=>{
        if(sql.includes('FROM node_allocations a JOIN nodes n')){
          return {results:[{route_id:'route:mci',transport:'reality',
            operator_hint:'mci',host:'vpn.example.com',port:443,
            server_name:'www.cloudflare.com',ws_path:null,
            reality_public_key:'A'.repeat(43),reality_short_id:'abcd'}]};
        }
        return {results:[]};
      },
    })};
  }
}
const url='https://madar-v2.test/api/v2/android/login/';
const post=(name,value,extraHeaders={})=>new Request(
  name==='logout'?'https://madar-v2.test/api/v2/android/logout':url+name,
  {method:'POST',
    headers:{'content-type':'application/json','cf-connecting-ip':'203.0.113.10',...extraHeaders},
    body:JSON.stringify(value)});
const enabled=(db)=>({DB:db,ANDROID_LOGIN_ENABLED:'true',
  SUBSCRIPTION_API_ENABLED:'true',BOT_USERNAME:'MadarTestBot',
  TELEGRAM_WEBHOOK_SECRET:'T'.repeat(48),
  SUBSCRIPTION_CREDENTIAL_KEY:'A'.repeat(43)});

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

test('challenge creation is throttled per HMACed client IP window',async()=>{
  const db=new FakeDB(),env=enabled(db),now=1_900_000_000_000;
  for(let i=0;i<30;i++){
    const response=await androidLoginRoute(post('start',{}),env,now+i);
    assert.equal(response.status,200);
  }
  const limited=await androidLoginRoute(post('start',{}),env,now+31);
  assert.equal(limited.status,429);
  const otherIp=await androidLoginRoute(post('start',{},{
    'cf-connecting-ip':'203.0.113.11'}),env,now+32);
  assert.equal(otherIp.status,200);
});
test('logout revokes the server token without revealing whether it existed',async()=>{
  const db=new FakeDB(),env=enabled(db),token='A'.repeat(43);
  const response=await androidLoginRoute(post('logout',{},{
    authorization:'Bearer '+token}),env,1_900_000_000_000);
  assert.equal(response.status,200);
  assert.equal((await response.json()).status,'signed_out');
  assert.equal(db.revoked.size,1);
  const missing=await androidLoginRoute(post('logout',{}),env,1_900_000_000_000);
  assert.equal(missing.status,401);
});

test('approved Telegram challenge redeems one active subscription token exactly once',async()=>{
  const now=1_900_000_000_000,db=new FakeDB(),env=enabled(db);
  const started=await androidLoginRoute(post('start',{}),env,now);
  const challenge=await started.json();
  await approveAndroidLogin(env,{
    key:'/start',inputText:'/start app_'+challenge.id,actorId:'1234567'},now+1000);
  const response=await androidLoginRoute(post('complete',{
    id:challenge.id,verifier:challenge.verifier}),env,now+2000);
  assert.equal(response.status,200);
  const result=await response.json();
  assert.equal(result.status,'authorized');
  assert.match(result.access_token,/^[A-Za-z0-9_-]{43}$/);
  assert.equal(result.telegram_id,'1234567');
  assert.equal(db.challenges.get(challenge.id).state,'used');
  assert.equal(db.tokenHashes.size,1);
  assert.equal([...db.tokenHashes][0].length,64);
  assert.equal(JSON.stringify([...db.challenges.values()]).includes(result.access_token),false);

  const replay=await androidLoginRoute(post('complete',{
    id:challenge.id,verifier:challenge.verifier}),env,now+3000);
  assert.equal(replay.status,410);
  assert.equal(db.tokenHashes.size,1);
});
