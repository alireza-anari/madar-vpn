import test from 'node:test';
import assert from 'node:assert/strict';
import {androidLoginRoute,approveAndroidLogin} from '../src/android-login.mjs';

class FakeDB {
  constructor(){
    this.challenges=new Map();this.queries=[];this.rates=new Map();
    this.revoked=new Set();this.tokenHashes=new Set();
    this.hasSubscription=true;this.hasCredential=true;this.hasRoutes=true;
  }
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
        if(sql.startsWith('INSERT INTO android_login_challenges')){
          this.challenges.set(args[0],{
            id:args[0],verifier_hash:args[1],created_ms:args[2],expires_ms:args[3],
            state:'pending',telegram_id:null,otp_hash:null,otp_nonce:null,
            otp_ciphertext:null,otp_expires_ms:null,otp_attempts:0,
          });
          return {meta:{changes:1}};
        }
        if(sql.includes("SET state='code_sent'")){
          const row=this.challenges.get(args[5]);
          if(row&&row.state==='pending'&&row.expires_ms>args[6]){
            Object.assign(row,{state:'code_sent',telegram_id:args[0],otp_hash:args[1],
              otp_nonce:args[2],otp_ciphertext:args[3],otp_expires_ms:args[4],otp_attempts:0});
            return {meta:{changes:1}};
          }
          return {meta:{changes:0}};
        }
        if(sql.includes("SET state='rejected'")){
          const row=this.challenges.get(args[0]);
          if(row&&row.state==='pending'&&row.expires_ms>args[1]){
            row.state='rejected';return {meta:{changes:1}};
          }
          return {meta:{changes:0}};
        }
        if(sql.includes("SET state='failed'")){
          const row=this.challenges.get(args[0]);
          if(row&&row.state==='pending'&&row.expires_ms>args[1]){
            row.state='failed';return {meta:{changes:1}};
          }
          return {meta:{changes:0}};
        }
        if(sql.includes('SET otp_attempts=otp_attempts+1')){
          const row=this.challenges.get(args[0]);
          if(row&&row.verifier_hash===args[1]&&row.state==='code_sent'&&
             row.expires_ms>args[2]&&row.otp_expires_ms>args[3]&&row.otp_attempts<5){
            row.otp_attempts++;return {meta:{changes:1}};
          }
          return {meta:{changes:0}};
        }
        if(sql.includes("SET state='redeeming'")){
          const row=this.challenges.get(args[0]);
          if(row&&row.verifier_hash===args[1]&&row.state==='code_sent'&&
             row.otp_hash===args[2]&&row.expires_ms>args[3]&&row.otp_expires_ms>args[4]){
            row.state='redeeming';return {meta:{changes:1}};
          }
          return {meta:{changes:0}};
        }
        if(sql.includes('UPDATE android_login_challenges SET state=?')){
          const row=this.challenges.get(args[1]);
          if(row&&row.state==='redeeming'){
            row.state=args[0];return {meta:{changes:1}};
          }
          return {meta:{changes:0}};
        }
        return {meta:{changes:0}};
      },
      first:async()=>{
        if(sql.includes('FROM subscription_credentials WHERE subscription_id=?'))
          return this.hasCredential?{key_version:1}:null;
        if(sql.includes('FROM android_login_challenges')){
          const row=this.challenges.get(args[0]);
          if(!row)return null;
          return args.length>1&&sql.includes('verifier_hash')
            ?(row.verifier_hash===args[1]?row:null):row;
        }
        if(sql.includes('JOIN subscription_credentials c ON c.subscription_id=s.id'))
          return this.hasCredential?{id:'sub-for-active-customer',expires_at:1_900_003_600_000}:null;
        if(sql.includes('FROM subscriptions'))
          return this.hasSubscription?{id:'sub-for-active-customer'}:null;
        return null;
      },
      all:async()=>{
        if(sql.includes('FROM node_allocations a JOIN nodes n')){
          return {results:this.hasRoutes?[{route_id:'route:mci',transport:'reality',
            operator_hint:'mci',host:'vpn.example.com',port:443,
            server_name:'www.cloudflare.com',ws_path:null,
            reality_public_key:'A'.repeat(43),reality_short_id:'abcd'}]:[]};
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
const now=1_900_000_000_000;
async function begin(env,at=now){
  const response=await androidLoginRoute(post('start',{}),env,at);
  assert.equal(response.status,200);
  return response.json();
}
async function requestCode(env,challenge,actorId='1234567',at=now+1000){
  return approveAndroidLogin(env,{
    key:'/start',inputText:'/start app_'+challenge.id,actorId,chatId:actorId,
  },at);
}
function codeFrom(reply){
  const match=/\b(\d{6})\b/.exec(reply.text);
  assert.ok(match,'Telegram reply must contain a six-digit code');
  return match[1];
}
const verify=(challenge,code)=>({
  id:challenge.id,verifier:challenge.verifier,code,
});

test('mobile authorization is fail-closed without explicit configuration',async()=>{
  const response=await androidLoginRoute(post('start',{}),{},now);
  assert.equal(response.status,503);
  assert.equal((await response.json()).error,'not_ready');
});

test('isolated protected flags enable challenge creation without overwriting Worker vars',async()=>{
  const db=new FakeDB(),env=enabled(db);
  delete env.ANDROID_LOGIN_ENABLED;
  delete env.SUBSCRIPTION_API_ENABLED;
  delete env.BOT_USERNAME;
  env.ANDROID_LOGIN_ENABLED_SECRET='true';
  env.SUBSCRIPTION_API_ENABLED_SECRET='true';
  env.BOT_USERNAME_SECRET='MadarTestBot';
  const challenge=await begin(env);
  assert.equal(challenge.login_url,
    'https://t.me/MadarTestBot?start=app_'+challenge.id);
});

test('Telegram sends a one-time code only to the subscribed private account',async()=>{
  const db=new FakeDB(),env=enabled(db);
  const challenge=await begin(env);
  const pending=await androidLoginRoute(post('verify',verify(challenge,'123456')),env,now+500);
  assert.equal(pending.status,202);
  assert.equal((await pending.json()).status,'pending');

  const reply=await requestCode(env,challenge);
  assert.match(reply.text,/کد تأیید ورود/);
  const code=codeFrom(reply);
  assert.equal(db.challenges.get(challenge.id).state,'code_sent');
  assert.equal(db.challenges.get(challenge.id).telegram_id,'1234567');
  assert.equal(db.challenges.get(challenge.id).otp_hash.length,64);
  assert.notEqual(db.challenges.get(challenge.id).otp_hash,code);
  assert.notEqual(db.challenges.get(challenge.id).otp_ciphertext,code);
  assert.equal(Object.hasOwn(db.challenges.get(challenge.id),'otp_code'),false);

  const replay=await requestCode(env,challenge,'1234567',now+1100);
  assert.equal(codeFrom(replay),code);
  const otherUser=await requestCode(env,challenge,'9999999',now+1200);
  assert.match(otherUser.text,/منقضی شده یا قبلاً استفاده شده/);
  assert.equal(db.challenges.get(challenge.id).telegram_id,'1234567');
});

test('wrong OTP attempts are counted and locked after five tries',async()=>{
  const db=new FakeDB(),env=enabled(db),challenge=await begin(env);
  const issued=await requestCode(env,challenge);
  const actualCode=codeFrom(issued);
  const wrongCode=actualCode==='000000'?'000001':'000000';
  for(let i=0;i<4;i++){
    const response=await androidLoginRoute(post('verify',verify(challenge,wrongCode)),env,now+2000+i);
    assert.equal(response.status,401);
    assert.equal((await response.json()).error,'invalid_code');
  }
  const fifth=await androidLoginRoute(post('verify',verify(challenge,wrongCode)),env,now+2100);
  assert.equal(fifth.status,429);
  assert.equal((await fifth.json()).error,'too_many_attempts');
  assert.equal(db.challenges.get(challenge.id).otp_attempts,5);
});

test('an expired challenge cannot issue or redeem a code',async()=>{
  const db=new FakeDB(),env=enabled(db),challenge=await begin(env);
  const after=now+300001;
  const reply=await requestCode(env,challenge,'1234567',after);
  assert.match(reply.text,/منقضی شده/);
  const response=await androidLoginRoute(post('verify',verify(challenge,'123456')),env,after);
  assert.equal(response.status,410);
  assert.equal((await response.json()).error,'expired');
});

test('missing active subscription rejects the challenge',async()=>{
  const db=new FakeDB(),env=enabled(db),challenge=await begin(env);
  db.hasSubscription=false;
  const reply=await requestCode(env,challenge);
  assert.match(reply.text,/اشتراک فعال/);
  assert.equal(db.challenges.get(challenge.id).state,'rejected');
  const response=await androidLoginRoute(post('verify',verify(challenge,'123456')),env,now+2000);
  assert.equal(response.status,403);
  assert.equal((await response.json()).error,'subscription_inactive');
});

test('an active subscriber can sign in during a route outage, without receiving unverified routes',async()=>{
  const db=new FakeDB(),env=enabled(db),challenge=await begin(env);
  db.hasRoutes=false;
  const reply=await requestCode(env,challenge);
  const code=codeFrom(reply);
  assert.equal(db.challenges.get(challenge.id).state,'code_sent');
  const response=await androidLoginRoute(post('verify',verify(challenge,code)),env,now+2000);
  assert.equal(response.status,200);
  assert.equal((await response.json()).status,'authorized');
  assert.equal(db.challenges.get(challenge.id).state,'used');
  assert.equal(db.tokenHashes.size,1);
});

test('OTP can be delivered to an active subscriber, but missing credentials prevent token redemption',async()=>{
  const db=new FakeDB(),env=enabled(db),challenge=await begin(env);
  db.hasCredential=false;
  const reply=await requestCode(env,challenge);
  const code=codeFrom(reply);
  assert.equal(db.challenges.get(challenge.id).state,'code_sent');
  const response=await androidLoginRoute(post('verify',verify(challenge,code)),env,now+2000);
  assert.equal(response.status,403);
  assert.equal((await response.json()).error,'subscription_not_ready');
  assert.equal(db.challenges.get(challenge.id).state,'failed');
});

test('a valid code redeems exactly one active subscription token',async()=>{
  const db=new FakeDB(),env=enabled(db),challenge=await begin(env);
  const reply=await requestCode(env,challenge);
  const code=codeFrom(reply);
  const response=await androidLoginRoute(post('verify',verify(challenge,code)),env,now+2000);
  assert.equal(response.status,200);
  const result=await response.json();
  assert.equal(result.status,'authorized');
  assert.match(result.access_token,/^[A-Za-z0-9_-]{43}$/);
  assert.equal(db.challenges.get(challenge.id).state,'used');
  assert.equal(db.tokenHashes.size,1);
  assert.equal([...db.tokenHashes][0].length,64);
  assert.equal(JSON.stringify([...db.challenges.values()]).includes(result.access_token),false);

  const replay=await androidLoginRoute(post('verify',verify(challenge,code)),env,now+3000);
  assert.equal(replay.status,410);
  assert.equal((await replay.json()).error,'already_used');
  assert.equal(db.tokenHashes.size,1);
});

test('challenge creation is throttled per HMACed client IP window',async()=>{
  const db=new FakeDB(),env=enabled(db);
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
    authorization:'Bearer '+token}),env,now);
  assert.equal(response.status,200);
  assert.equal((await response.json()).status,'signed_out');
  assert.equal(db.revoked.size,1);
  const missing=await androidLoginRoute(post('logout',{}),env,now);
  assert.equal(missing.status,401);
});

test('legacy completion without the one-time code cannot authorize a device',async()=>{
  const db=new FakeDB(),env=enabled(db),challenge=await begin(env);
  await requestCode(env,challenge);
  const response=await androidLoginRoute(post('complete',{
    id:challenge.id,verifier:challenge.verifier,
  }),env,now+2000);
  assert.equal(response.status,400);
  assert.equal(db.tokenHashes.size,0);
});
