import {issueActiveToken,tokenDigest} from './subscription.mjs';

const ID=/^[A-Za-z0-9_-]{24}$/;
const BOT=/^[A-Za-z][A-Za-z0-9_]{4,31}$/;
const random=(size)=>btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(size))))
  .replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{
  'content-type':'application/json; charset=utf-8',
  'cache-control':'private, no-store','pragma':'no-cache',
  'x-content-type-options':'nosniff','referrer-policy':'no-referrer',
}});
const enabled=env=>env.ANDROID_LOGIN_ENABLED==='true' &&
  env.SUBSCRIPTION_API_ENABLED==='true' && !!env.DB &&
  typeof env.TELEGRAM_WEBHOOK_SECRET==='string' && env.TELEGRAM_WEBHOOK_SECRET.length>=32 &&
  BOT.test(env.BOT_USERNAME??'');
async function clientDigest(request,env){
  const ip=(request.headers.get('cf-connecting-ip')??'unknown').trim().slice(0,64)||'unknown';
  const key=await crypto.subtle.importKey('raw',
    new TextEncoder().encode(env.TELEGRAM_WEBHOOK_SECRET),
    {name:'HMAC',hash:'SHA-256'},false,['sign']);
  const mac=new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(ip)));
  return Array.from(mac).map(x=>x.toString(16).padStart(2,'0')).join('');
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

/** The Android app receives a private verifier, while Telegram sees ONLY the
 * public challenge id. Telegram webhook authentication is performed upstream. */
export async function androidLoginRoute(request,env,now=Date.now()){
  const route=new URL(request.url).pathname;
  if(request.method!=='POST')return json({error:'method_not_allowed'},405);
  if(route==='/api/v2/android/logout'){
    if(!env.DB || env.SUBSCRIPTION_API_ENABLED!=='true')
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
    if(!await allowChallengeStart(request,env,now))
      return json({error:'rate_limited'},429);
    if(Object.keys(payload).length)return json({error:'bad_request'},400);
    const id=random(18),verifier=random(32);
    const hash=await tokenDigest(verifier);
    await env.DB.prepare(
      "INSERT INTO android_login_challenges(id,verifier_hash,created_ms,expires_ms) VALUES(?,?,?,?)"
    ).bind(id,hash,now,now+300000).run();
    return json({id,verifier,expires_at:now+300000,
      login_url:'https://t.me/'+env.BOT_USERNAME+'?start=app_'+id});
  }
  if(route==='/api/v2/android/login/complete'){
    const id=payload.id,verifier=payload.verifier;
    if(!ID.test(id??'')||!(await tokenDigest(verifier)))return json({error:'invalid_challenge'},400);
    const digest=await tokenDigest(verifier);
    const row=await env.DB.prepare(
      'SELECT state,telegram_id,expires_ms FROM android_login_challenges WHERE id=? AND verifier_hash=?'
    ).bind(id,digest).first();
    if(!row)return json({error:'invalid_challenge'},403);
    if(expired(row.expires_ms,now))return json({error:'expired'},410);
    if(row.state==='pending')return json({status:'pending'},202);
    if(row.state==='rejected'||row.state==='failed')
      return json({error:'subscription_not_ready'},403);
    if(row.state!=='approved')return json({error:'already_used'},410);
    const claimed=await env.DB.prepare(
      "UPDATE android_login_challenges SET state='redeeming' " +
      "WHERE id=? AND verifier_hash=? AND state='approved' AND expires_ms>?"
    ).bind(id,digest,now).run();
    if(claimed.meta?.changes!==1)return json({error:'already_used'},410);
    const subscription=await env.DB.prepare(
      "SELECT s.id FROM subscriptions s JOIN customers c ON c.telegram_id=s.owner_telegram_id " +
      "WHERE s.owner_telegram_id=? AND s.state='active' AND c.state='active' " +
      "AND s.expires_at>? AND s.max_bytes>s.used_bytes ORDER BY s.expires_at DESC LIMIT 1"
    ).bind(row.telegram_id,now).first();
    const issued=subscription?await issueActiveToken(env,subscription.id,now):null;
    await env.DB.prepare(
      'UPDATE android_login_challenges SET state=? WHERE id=? AND state=\'redeeming\''
    ).bind(issued?'used':'failed',id).run();
    if(!issued)return json({error:'subscription_not_ready'},403);
    return json({status:'authorized',
      access_token:issued.token,expires_at:issued.expires_at});
  }
  return json({error:'not_found'},404);
}

/** Only invoke on updates verified with the Telegram webhook secret.
 * This does not accept forwarded messages, callback data or arbitrary user IDs. */
export async function approveAndroidLogin(env,event,now=Date.now()){
  if(!event || event.key!=='/start')return null;
  const match=/^\/start(?:@[A-Za-z0-9_]+)?\s+app_([A-Za-z0-9_-]{24})\s*$/
    .exec(event.inputText??'');
  if(!match)return null;
  const reply=(message)=>({text:'🌐  مــدار\n\n'+message,replyMarkup:null});
  if(!enabled(env))return reply('ورود به اپ در این محیط هنوز فعال نیست.');
  if(!/^\d{5,20}$/.test(event.actorId??''))return reply('درخواست ورود نامعتبر است.');
  const sub=await env.DB.prepare(
    "SELECT s.id FROM subscriptions s JOIN customers c ON c.telegram_id=s.owner_telegram_id " +
    "WHERE s.owner_telegram_id=? AND c.state='active' AND s.state='active' " +
    "AND s.expires_at>? AND s.max_bytes>s.used_bytes LIMIT 1"
  ).bind(event.actorId,now).first();
  if(!sub){
    const rejected=await env.DB.prepare(
      "UPDATE android_login_challenges SET state='rejected' " +
      "WHERE id=? AND state='pending' AND expires_ms>?"
    ).bind(match[1],now).run();
    return reply(rejected.meta?.changes===1
      ?'برای ورود به اپ باید اشتراک فعال داشته باشید.'
      :'⏱ این درخواست منقضی شده یا قبلاً استفاده شده است. دوباره از داخل اپ تلاش کنید.');
  }
  const updated=await env.DB.prepare(
    "UPDATE android_login_challenges SET state='approved',telegram_id=? " +
    "WHERE id=? AND state='pending' AND expires_ms>?"
  ).bind(event.actorId,match[1],now).run();
  return reply(updated.meta?.changes===1
    ?'✅ ورود تأیید شد. به اپ مدار برگردید تا اشتراک شما به‌صورت خودکار فعال شود.'
    :'⏱ این درخواست منقضی شده یا قبلاً استفاده شده است. دوباره از داخل اپ تلاش کنید.');
}

export async function purgeAndroidLogins(db,now=Date.now()){
  await db.prepare('DELETE FROM android_login_challenges WHERE expires_ms<?')
    .bind(now-86400000).run();
  await db.prepare('DELETE FROM android_login_rate_limits WHERE window_start_ms<?')
    .bind(now-86400000).run();
}
