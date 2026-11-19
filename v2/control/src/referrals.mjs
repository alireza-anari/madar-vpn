import {botMenu,sellerMenu,frameMessage,faMoney,faStatus,faNumber} from './bot-ux.mjs';

const response=(text,locale='fa',buttons=[],audience='customer')=>({
  text:frameMessage(text),
  replyMarkup:{inline_keyboard:[
    ...buttons,
    ...(audience==='seller'?sellerMenu():botMenu()).inline_keyboard
  ]},
});
const sellerResponse=(text,locale='fa',buttons=[])=>response(text,locale,buttons,'seller');
const lang=(fa)=>fa;
const ID=/^\d{1,20}$/;
const START_TOKEN=/^[a-f0-9]{32}$/;

function hex(bytes) {
  return Array.from(bytes).map(b=>b.toString(16).padStart(2,'0')).join('');
}
export async function hashInvite(token) {
  if(!START_TOKEN.test(token))return null;
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))));
}

export async function linkSellerOnStart(db,e,nowMs=Date.now()) {
  const match=e.inputText?.match(/^\/start(?:@\w+)?\s+([a-f0-9]{32})$/i);
  if(!match)return null;
  const token=match[1].toLowerCase(),hash=await hashInvite(token);
  const row=await db.prepare(
    "SELECT si.seller_telegram_id FROM seller_invites si "+
    "JOIN staff_roles sr ON sr.telegram_id=si.seller_telegram_id AND sr.role='seller' "+
    "JOIN customers c ON c.telegram_id=sr.telegram_id AND c.state='active' "+
    "WHERE si.token_hash=? AND si.disabled=0 AND si.expires_ms>? LIMIT 1"
  ).bind(hash,nowMs).first();
  if(!row||row.seller_telegram_id===e.actorId)
    return lang('کد معرفی معتبر نیست یا مهلت آن به پایان رسیده است.','Referral code is invalid or expired.',e.locale);
  const result=await db.prepare(
    "UPDATE customers SET seller_telegram_id=? WHERE telegram_id=? AND seller_telegram_id IS NULL"
  ).bind(row.seller_telegram_id,e.actorId).run();
  return result.meta?.changes===1
    ?lang('✅ کد معرف ثبت شد. فروشنده فقط سفارش‌های مرتبط با شما را برای پشتیبانی مشاهده می‌کند.',
      'Referral saved. Your seller can see your associated orders for support.',e.locale)
    :lang('حساب شما قبلاً به یک فروشنده مرتبط شده است.','Your account is already assigned to a seller.',e.locale);
}

export async function isSeller(db,userId) {
  const r=await db.prepare(
    "SELECT 1 AS ok FROM staff_roles WHERE telegram_id=? AND role='seller'"
  ).bind(userId).first();
  return r?.ok===1;
}

async function newInvite(db,e,env,nowMs) {
  const bytes=crypto.getRandomValues(new Uint8Array(16));
  const token=hex(bytes);
  const hash=await hashInvite(token);
  await db.prepare(
    'INSERT INTO seller_invites(token_hash,seller_telegram_id,expires_ms) VALUES(?,?,?)'
  ).bind(hash,e.actorId,nowMs+30*24*60*60*1000).run();
  const bot=typeof env.BOT_USERNAME==='string'&&/^[a-zA-Z0-9_]{5,32}$/.test(env.BOT_USERNAME)
    ?'https://t.me/'+env.BOT_USERNAME+'?start='+token
    :'/start '+token;
  return sellerResponse('🔗  لینک معرفی شما\n━━━━━━━━━━━━━━━━━━\n'+bot+
    '\n\n⏳ اعتبار این لینک: ۳۰ روز\nاین لینک فقط یک‌بار نمایش داده می‌شود؛ آن را در محل امن نگهداری کنید.',e.locale);
}

async function sellerOrders(db,e) {
  const rows=(await db.prepare(
    "SELECT id,state,quoted_amount,quoted_currency FROM orders "+
    "WHERE seller_telegram_id=? ORDER BY created_at DESC LIMIT 15"
  ).bind(e.actorId).all()).results??[];
  if(!rows.length)return sellerResponse('🧾 هنوز سفارشی به حساب فروشندگی شما نسبت داده نشده است.',e.locale);
  return sellerResponse('🧾  سفارش‌های مرتبط با شما\n━━━━━━━━━━━━━━━━━━\n'+
    rows.map(o=>'شناسه: '+o.id.slice(0,8)+'…'+
      '\nوضعیت: '+faStatus(o.state)+
      '\nمبلغ: '+faMoney(o.quoted_amount,o.quoted_currency)).join('\n\n'),e.locale);
}

export async function handleSeller(env,e,nowMs=Date.now()) {
  const db=env.DB,key=e.key??'';
  if(key==='/seller'||key==='seller:home'||key==='seller:orders'||
     key==='seller:invite'||key==='seller:revoke') {
    if(!await isSeller(db,e.actorId))
      return response('⛔ دسترسی فروشندگی برای حساب شما فعال نیست.',e.locale);
    if(key==='seller:invite')return newInvite(db,e,env,nowMs);
    if(key==='seller:revoke') {
      await db.prepare('UPDATE seller_invites SET disabled=1 WHERE seller_telegram_id=? AND disabled=0')
        .bind(e.actorId).run();
      return sellerResponse('🔒 تمام لینک‌های معرفی قبلی غیرفعال شدند.',e.locale);
    }
    if(key==='seller:orders')return sellerOrders(db,e);
    return sellerResponse('🧑‍💼  پیشخوان فروشنده\n━━━━━━━━━━━━━━━━━━\n'+
      'از گزینه‌های زیر برای مدیریت سفارش‌ها و لینک‌های معرفی استفاده کنید.',e.locale);
  }
  return null;
}

export async function grantStaffRole(db,e,role,subjectId) {
  if(!['seller','support'].includes(role)||!ID.test(subjectId))return false;
  await db.batch([
    db.prepare('INSERT OR IGNORE INTO customers(telegram_id) VALUES(?)').bind(subjectId),
    db.prepare('INSERT OR IGNORE INTO staff_roles(telegram_id,role,granted_by) VALUES(?,?,?)')
      .bind(subjectId,role,e.actorId),
    db.prepare(
      'INSERT OR IGNORE INTO audit_events(event_id,actor_id,object_type,object_id,verb) VALUES(?,?,?,?,?)'
    ).bind('staff:'+role+':'+subjectId,e.actorId,'staff',subjectId,'grant:'+role),
  ]);
  return true;
}
