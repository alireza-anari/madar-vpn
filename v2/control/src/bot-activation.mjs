const API='https://api.telegram.org/bot';

function channelConfig(env){
  const id=String(env.MADAR_CHANNEL_ID??'').trim();
  const url=String(env.MADAR_CHANNEL_URL??'').trim();
  const validId=/^(?:-100\d{5,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/.test(id);
  let validUrl=false;
  try{
    const parsed=new URL(url);
    validUrl=parsed.protocol==='https:'&&parsed.hostname==='t.me'&&
      !parsed.username&&!parsed.password&&!parsed.search&&!parsed.hash&&
      /^\/(?:[A-Za-z][A-Za-z0-9_]{4,31}|\+[A-Za-z0-9_-]{8,}|joinchat\/[A-Za-z0-9_-]{8,})\/?$/.test(parsed.pathname);
  }catch{}
  return validId&&validUrl?{id,url}:null;
}

export function channelActivationConfigured(env){
  return !!channelConfig(env)&&typeof env.BOT_TOKEN==='string'&&env.BOT_TOKEN.length>20;
}

export async function isBotActivated(db,telegramId){
  if(!db||!/^\d{5,20}$/.test(String(telegramId??'')))return false;
  const row=await db.prepare(
    'SELECT 1 AS active FROM telegram_bot_activations WHERE telegram_id=?'
  ).bind(String(telegramId)).first();
  return !!row;
}

/** Check channel membership through Telegram and persist activation only on a
 * confirmed member status. The bot must be an administrator of the channel. */
export async function checkAndActivateBot(env,telegramId,now=Date.now(),send=fetch){
  if(!env.DB||!/^\d{5,20}$/.test(String(telegramId??''))||
     typeof env.BOT_TOKEN!=='string'||env.BOT_TOKEN.length<20)
    return {state:'unavailable'};
  const config=channelConfig(env);
  if(!config)return {state:'unconfigured'};
  let data;
  try{
    const response=await send(API+env.BOT_TOKEN+'/getChatMember',{
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify({chat_id:config.id,user_id:Number(telegramId)}),
      signal:AbortSignal.timeout(8000),
    });
    data=await response.json().catch(()=>null);
    if(!response.ok||data?.ok!==true||!data?.result)return {state:'unavailable'};
  }catch{return {state:'unavailable'};}
  const member=data.result;
  const joined=['creator','administrator','member'].includes(member.status)||
    (member.status==='restricted'&&member.is_member===true);
  if(!joined){
    await env.DB.prepare(
      'DELETE FROM telegram_bot_activations WHERE telegram_id=?'
    ).bind(String(telegramId)).run();
    return {state:'not_member',channelUrl:config.url};
  }
  await env.DB.prepare(
    "INSERT INTO customers(telegram_id,locale) VALUES(?,'fa') " +
    "ON CONFLICT(telegram_id) DO UPDATE SET locale='fa'"
  ).bind(String(telegramId)).run();
  await env.DB.prepare(
    'INSERT INTO telegram_bot_activations(telegram_id,channel_id,activated_ms,last_verified_ms) '+
    'VALUES(?,?,?,?) ON CONFLICT(telegram_id) DO UPDATE SET '+
    'channel_id=excluded.channel_id,last_verified_ms=excluded.last_verified_ms'
  ).bind(String(telegramId),config.id,now,now).run();
  return {state:'activated',channelUrl:config.url};
}

export function activationKeyboard(env,callbackData){
  const config=channelConfig(env);
  if(!config)return null;
  return {inline_keyboard:[
    [{text:'📢 عضویت در کانال اطلاع‌رسانی مدار',url:config.url}],
    [{text:'✅ بررسی عضویت و ادامه',callback_data:callbackData}],
  ]};
}

export function activationPrompt(env,callbackData,context='bot'){
  const app=context==='app';
  const markup=activationKeyboard(env,callbackData);
  if(!channelConfig(env))return {
    text:'⚠️ فعال‌سازی مدار هنوز پیکربندی نشده است. لطفاً کمی بعد دوباره تلاش کنید یا با پشتیبانی مدار تماس بگیرید.',
    replyMarkup:null,
  };
  return {
    text:app
      ?'🔐 برای ورود به اپ مدار، ابتدا ربات را فعال کنید.\n\n۱. از دکمه زیر عضو کانال اطلاع‌رسانی مدار شوید.\n۲. به همین گفت‌وگو برگردید و «بررسی عضویت و ادامه» را بزنید.\n۳. پس از تأیید، کد یک‌بارمصرف ورود برایتان ارسال می‌شود.'
      :'🌐 برای فعال‌سازی ربات مدار، عضویت در کانال اطلاع‌رسانی مدار الزامی است.\n\n۱. عضو کانال شوید.\n۲. سپس «بررسی عضویت» را بزنید تا حساب شما فعال شود.',
    replyMarkup:markup,
  };
}

export function activationUnavailableReply(env,callbackData){
  return {
    text:'⚠️ در حال حاضر امکان بررسی عضویت در کانال وجود ندارد. چند لحظه دیگر دوباره «بررسی عضویت» را بزنید.',
    replyMarkup:activationKeyboard(env,callbackData),
  };
}
