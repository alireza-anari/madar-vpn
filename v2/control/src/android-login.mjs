import {activeRoutes,issueActiveToken,tokenDigest} from './subscription.mjs';

const ID=/^[A-Za-z0-9_-]{24}$/;
const BOT=/^[A-Za-z][A-Za-z0-9_]{4,31}$/;
const OTP=/^\d{6}$/;
const encoder=new TextEncoder();
const random=(size)=>btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(size))))
  .replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const base64url=bytes=>btoa(String.fromCharCode(...bytes))
  .replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const fromBase64url=value=>{
  const clean=value.replace(/-/g,'+').replace(/_/g,'/');
  return Uint8Array.from(atob(clean+'='.repeat((4-clean.length%4)%4)),x=>x.charCodeAt(0));
};
const hex=bytes=>Array.from(bytes).map(x=>x.toString(16).padStart(2,'0')).join('');
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{
  'content-type':'application/json; charset=utf-8',
  'cache-control':'private, no-store','pragma':'no-cache',
  'x-content-type-options':'nosniff','referrer-policy':'no-referrer',
}});
const subscriptionApiEnabled=env=>env.SUBSCRIPTION_API_ENABLED==='true' ||
  env.SUBSCRIPTION_API_ENABLED_SECRET==='true';
const botUsername=env=>env.BOT_USERNAME??env.BOT_USERNAME_SECRET??'';
const enabled=env=>(env.ANDROID_LOGIN_ENABLED==='true' ||
  env.ANDROID_LOGIN_ENABLED_SECRET==='true') && subscriptionApiEnabled(env) && !!env.DB &&
  typeof env.TELEGRAM_WEBHOOK_SECRET==='string' && env.TELEGRAM_WEBHOOK_SECRET.length>=32 &&
  typeof env.SUBSCRIPTION_CREDENTIAL_KEY==='string' &&
  /^[A-Za-z0-9_-]{43}$/.test(env.SUBSCRIPTION_CREDENTIAL_KEY) &&
  BOT.test(botUsername(env));
async function clientDigest(request,env){
  const ip=(request.headers.get('cf-connecting-ip')??'unknown').trim().slice(0,64)||'unknown';
  const key=await crypto.subtle.importKey('raw',
    encoder.encode(env.TELEGRAM_WEBHOOK_SECRET),
    {name:'HMAC',hash:'SHA-256'},false,['sign']);
  const mac=new Uint8Array(await crypto.subtle.sign('HMAC',key,encoder.encode(ip)));
  return hex(mac);
}
async function allowChallengeStart(request,env,now){
  const digest=await clientDigest(request,env);
  const windowStart=Math.floor(now/300000)*300000;
  const result=await env.DB.prepare(
    'INSERT INTO android_login_rate_limits(ip_hash,window_start_ms,request_count) VALUES(?,?,1) '+
    'ON CONFLICT(ip_hash,window_start_ms) DO UPDATE SET request_count=request_count+1 '+
    'WHERE request_count<30'
  ).bind(digest,windowStart).run();
  return result.meta?.changes===1;
}
const expired=(time,now)=>!Number.isSafeInteger(time)||time<=now;

async function otpHash(env,id,code){
  const key=await crypto.subtle.importKey('raw',encoder.encode(env.TELEGRAM_WEBHOOK_SECRET),
    {name:'HMAC',hash:'SHA-256'},false,['sign']);
  return hex(new Uint8Array(await crypto.subtle.sign('HMAC',key,encoder.encode(id+':'+code))));
}
async function otpEncryptionKey(env){
  const raw=await crypto.subtle.digest('SHA-256',
    encoder.encode('madar:android-login:otp-encryption:'+env.TELEGRAM_WEBHOOK_SECRET));
  return crypto.subtle.importKey('raw',raw,{name:'AES-GCM'},false,['encrypt','decrypt']);
}
async function encryptOtp(env,id,code){
  const nonce=crypto.getRandomValues(new Uint8Array(12));
  const key=await otpEncryptionKey(env);
  const ciphertext=new Uint8Array(await crypto.subtle.encrypt({
    name:'AES-GCM',iv:nonce,additionalData:encoder.encode(id),
  },key,encoder.encode(code)));
  return {nonce:base64url(nonce),ciphertext:base64url(ciphertext)};
}
async function decryptOtp(env,id,row){
  try{
    if(typeof row.otp_nonce!=='string'||typeof row.otp_ciphertext!=='string')return null;
    const key=await otpEncryptionKey(env);
    const clear=await crypto.subtle.decrypt({
      name:'AES-GCM',iv:fromBase64url(row.otp_nonce),additionalData:encoder.encode(id),
    },key,fromBase64url(row.otp_ciphertext));
    const code=new TextDecoder('utf-8',{fatal:true}).decode(clear);
    return OTP.test(code)?code:null;
  }catch{return null;}
}
function sameText(a,b){
  if(typeof a!=='string'||typeof b!=='string'||a.length!==b.length)return false;
  let mismatch=0;
  for(let i=0;i<a.length;i++)mismatch|=a.charCodeAt(i)^b.charCodeAt(i);
  return mismatch===0;
}
function newOtp(){
  return String(crypto.getRandomValues(new Uint32Array(1))[0]%1000000).padStart(6,'0');
}
const expiredOrUsed=()=> '⏱ این درخواست منقضی شده یا قبلاً استفاده شده است. دوباره از داخل اپ تلاش کنید.';
const otpMessage=code=>'🔐 کد تأیید ورود به اپ مدار\n\n' +
  'کد ورود شما:\n\n' +
  code+'\n\n' +
  '⏳ این کد تا ۳ دقیقه معتبر است و فقط یک‌بار استفاده می‌شود.\n' +
  'کد را فقط در اپ مدار وارد کنید و آن را برای هیچ‌کس نفرستید.';

async function readChallenge(env,id){
  return env.DB.prepare(
    'SELECT state,telegram_id,expires_ms,otp_hash,otp_nonce,otp_ciphertext,otp_expires_ms,otp_attempts '+
    'FROM android_login_challenges WHERE id=?'
  ).bind(id).first();
}

/** The app receives a private verifier; Telegram sees only the public challenge id.
 * The OTP is HMACed for verification and encrypted only to make webhook retries safe. */
export async function androidLoginRoute(request,env,now=Date.now()){
  const route=new URL(request.url).pathname;
  if(request.method!=='POST')return json({error:'method_not_allowed'},405);
  if(route==='/api/v2/android/logout'){
    if(!env.DB || !subscriptionApiEnabled(env))
      return json({error:'not_ready'},503);
    const payload=await body(request);
    if(!payload || Object.keys(payload).length)return json({error:'bad_request'},400);
    const header=request.headers.get('authorization')??'';
    if(!header.startsWith('Bearer '))return json({error:'unauthorized'},401);
    const digest=await tokenDigest(header.slice(7));
    if(!digest)return json({error:'unauthorized'},401);
    await env.DB.prepare(
      'UPDATE subscription_tokens SET revoked=1 WHERE token_hash=?'
    ).bind(digest).run();
    return json({status:'signed_out'});
  }
  if(!enabled(env))return json({error:'not_ready'},503);
  const payload=await body(request);
  if(!payload)return json({error:'bad_request'},400);
  if(route==='/api/v2/android/login/start'){
    if(Object.keys(payload).length)return json({error:'bad_request'},400);
    if(!await allowChallengeStart(request,env,now))
      return json({error:'rate_limited'},429);
    const id=random(18),verifier=random(32);
    const hash=await tokenDigest(verifier);
    await env.DB.prepare(
      "INSERT INTO android_login_challenges(id,verifier_hash,created_ms,expires_ms) VALUES(?,?,?,?)"
    ).bind(id,hash,now,now+300000).run();
    return json({id,verifier,expires_at:now+300000,
      login_url:'https://t.me/'+botUsername(env)+'?start=app_'+id});
  }
  if(route==='/api/v2/android/login/verify' || route==='/api/v2/android/login/complete'){
    const id=payload.id,verifier=payload.verifier,code=payload.code;
    if(Object.keys(payload).some(key=>!['id','verifier','code'].includes(key)) ||
       !ID.test(id??'') || !(await tokenDigest(verifier)) || !OTP.test(code??''))
      return json({error:'bad_request'},400);
    const verifierHash=await tokenDigest(verifier);
    const row=await env.DB.prepare(
      'SELECT state,telegram_id,expires_ms,otp_hash,otp_expires_ms,otp_attempts '+
      'FROM android_login_challenges WHERE id=? AND verifier_hash=?'
    ).bind(id,verifierHash).first();
    if(!row)return json({error:'invalid_challenge'},403);
    if(expired(row.expires_ms,now))return json({error:'expired'},410);
    if(row.state==='pending')return json({status:'pending'},202);
    if(row.state==='rejected')return json({error:'subscription_inactive'},403);
    if(row.state==='failed')return json({error:'subscription_not_ready'},403);
    if(row.state!=='code_sent')return json({error:'already_used'},410);
    if(expired(row.otp_expires_ms,now))return json({error:'expired'},410);
    if(!row.otp_hash)return json({error:'invalid_challenge'},403);
    if(row.otp_attempts>=5)return json({error:'too_many_attempts'},429);

    const counted=await env.DB.prepare(
      "UPDATE android_login_challenges SET otp_attempts=otp_attempts+1 " +
      "WHERE id=? AND verifier_hash=? AND state='code_sent' AND expires_ms>? " +
      "AND otp_expires_ms>? AND otp_attempts<5"
    ).bind(id,verifierHash,now,now).run();
    if(counted.meta?.changes!==1){
      const latest=await readChallenge(env,id);
      if(latest?.otp_attempts>=5)return json({error:'too_many_attempts'},429);
      return json({error:'expired'},410);
    }
    const suppliedHash=await otpHash(env,id,code);
    if(!sameText(suppliedHash,row.otp_hash)){
      const latest=await readChallenge(env,id);
      return latest?.otp_attempts>=5
        ?json({error:'too_many_attempts'},429)
        :json({error:'invalid_code'},401);
    }
    const claimed=await env.DB.prepare(
      "UPDATE android_login_challenges SET state='redeeming' " +
      "WHERE id=? AND verifier_hash=? AND state='code_sent' AND otp_hash=? " +
      "AND expires_ms>? AND otp_expires_ms>?"
    ).bind(id,verifierHash,row.otp_hash,now,now).run();
    if(claimed.meta?.changes!==1)return json({error:'already_used'},410);
    const subscription=await env.DB.prepare(
      "SELECT s.id FROM subscriptions s JOIN customers c ON c.telegram_id=s.owner_telegram_id " +
      "WHERE s.owner_telegram_id=? AND s.state='active' AND c.state='active' " +
      "AND s.expires_at>? AND s.max_bytes>s.used_bytes ORDER BY s.expires_at DESC LIMIT 1"
    ).bind(row.telegram_id,now).first();
    const issued=subscription?await issueActiveToken(env,subscription.id,now):null;
    await env.DB.prepare(
      "UPDATE android_login_challenges SET state=? WHERE id=? AND state='redeeming'"
    ).bind(issued?'used':'failed',id).run();
    if(!issued)return json({error:'subscription_not_ready'},403);
    return json({status:'authorized',
      access_token:issued.token,expires_at:issued.expires_at});
  }
  return json({error:'not_found'},404);
}

async function body(request){
  if(!/^application\/json(?:;|$)/i.test(request.headers.get('content-type')??''))
    return null;
  const length=Number(request.headers.get('content-length')??0);
  if(length>512)return null;
  try{
    const raw=await request.text();
    if(raw.length>512)return null;
    const value=JSON.parse(raw);
    return value && typeof value==='object' && !Array.isArray(value)?value:null;
  }catch{return null;}
}

/** Only invoke on updates verified with the Telegram webhook secret.
 * The bot sends an OTP only to the private Telegram account that owns the active subscription. */
export async function approveAndroidLogin(env,event,now=Date.now()){
  if(!event || event.key!=='/start')return null;
  const match=/^\/start(?:@[A-Za-z0-9_]+)?\s+app_([A-Za-z0-9_-]{24})\s*$/
    .exec(event.inputText??'');
  if(!match)return null;
  const reply=(message)=>({text:'🌐  مــدار\n\n'+message,replyMarkup:null});
  if(!enabled(env))return reply('ورود به اپ در این محیط هنوز فعال نیست.');
  if(!/^\d{5,20}$/.test(event.actorId??'') ||
     (event.chatId!==undefined && event.chatId!==event.actorId))
    return reply('درخواست ورود نامعتبر است.');

  const id=match[1];
  const challenge=await readChallenge(env,id);
  if(!challenge || expired(challenge.expires_ms,now))return reply(expiredOrUsed());

  // Telegram can redeliver the same update after an interrupted outbox write.
  // Re-send the same code only to the same Telegram account, never mint a new one.
  if(challenge.state==='code_sent' && challenge.telegram_id===event.actorId &&
     !expired(challenge.otp_expires_ms,now)){
    const code=await decryptOtp(env,id,challenge);
    return reply(code?otpMessage(code):expiredOrUsed());
  }
  if(challenge.state!=='pending')return reply(expiredOrUsed());

  const sub=await env.DB.prepare(
    "SELECT s.id FROM subscriptions s JOIN customers c ON c.telegram_id=s.owner_telegram_id " +
    "WHERE s.owner_telegram_id=? AND c.state='active' AND s.state='active' " +
    "AND s.expires_at>? AND s.max_bytes>s.used_bytes LIMIT 1"
  ).bind(event.actorId,now).first();
  if(!sub){
    const rejected=await env.DB.prepare(
      "UPDATE android_login_challenges SET state='rejected' " +
      "WHERE id=? AND state='pending' AND expires_ms>?"
    ).bind(id,now).run();
    return reply(rejected.meta?.changes===1
      ?'برای ورود به اپ، اشتراک فعال با حجم باقی‌مانده لازم است.'
      :expiredOrUsed());
  }

  // Identity verification is independent of route readiness. Token redemption
  // below still requires a usable credential and a freshly verified route.

  const code=newOtp();
  const codeHash=await otpHash(env,id,code);
  const encrypted=await encryptOtp(env,id,code);
  const codeExpires=Math.min(now+180000,challenge.expires_ms);
  const updated=await env.DB.prepare(
    "UPDATE android_login_challenges SET state='code_sent',telegram_id=?,otp_hash=?,"+
    "otp_nonce=?,otp_ciphertext=?,otp_expires_ms=?,otp_attempts=0 " +
    "WHERE id=? AND state='pending' AND expires_ms>?"
  ).bind(event.actorId,codeHash,encrypted.nonce,encrypted.ciphertext,codeExpires,id,now).run();
  if(updated.meta?.changes===1)return reply(otpMessage(code));

  const current=await readChallenge(env,id);
  if(current?.state==='code_sent' && current.telegram_id===event.actorId &&
     !expired(current.otp_expires_ms,now)){
    const previous=await decryptOtp(env,id,current);
    if(previous)return reply(otpMessage(previous));
  }
  return reply(expiredOrUsed());
}

export async function purgeAndroidLogins(db,now=Date.now()){
  await db.prepare('DELETE FROM android_login_challenges WHERE expires_ms<?')
    .bind(now-86400000).run();
  await db.prepare('DELETE FROM android_login_rate_limits WHERE window_start_ms<?')
    .bind(now-86400000).run();
}
