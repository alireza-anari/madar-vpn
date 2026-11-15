import {issueTrialLink,enqueueAutoNode} from './node-auto.mjs';
import {issueCarrierLink} from './carrier-subscription.mjs';
import {adminDashboard,adminPanelAction,customerTicketAction,consumePanelInput,notifySupport,staffTicketDetails} from './bot-panels.mjs';
import {beginNodeWizard,cancelNodeWizard,consumeNodeWizard} from './node-wizard.mjs';
import { nodeAdminAction,nodeOverview,nodeDetails,nodeManagement,nodeFromRef } from './node-admin.mjs';
import { handleSeller, linkSellerOnStart, grantStaffRole } from './referrals.mjs';
/**
 * Madar V2 business UI. Every mutable action is idempotent by the Telegram
 * update ID or by a state-qualified SQL transition. No unattended payment or
 * config issuance takes place from this module.
 */
import { botMenu,botPage,adminMenu,sellerMenu,supportMenu,frameMessage,faNumber,faMoney,faGB,faDate,faStatus,faRole,sectionNavigation,usageMeter,statusSymbol,shortCode,panelHeading,BRAND_BANNER_URL } from './bot-ux.mjs';

const ORDER_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{1,48}$/;
const PLAN_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{1,30}$/;
const t = (fa) => fa;
const line = (...parts) => parts.filter(Boolean).join('\n');
// ناوبری درون بخش‌ها فقط اقدامات مرتبط را نشان می‌دهد.
const response = (text, locale = 'fa', extra = [], audience = 'customer') => ({
  text: frameMessage(String(text).slice(0, 3300)),
  replyMarkup: {inline_keyboard:[...extra,...sectionNavigation(audience)]},
});
const adminResponse = (text,locale='fa',extra=[]) => response(text,locale,extra,'admin');
const supportResponse = (text,locale='fa',extra=[]) => response(text,locale,extra,'support');
const staffResponse = (text,e,env,extra=[]) =>
  adminAllowed(env.ADMIN_TELEGRAM_IDS,e.actorId)
    ?adminResponse(text,e.locale,extra):supportResponse(text,e.locale,extra);

function money(amount, currency) {
  return faMoney(amount,currency);
}

export function adminAllowed(ids, userId) {
  if (typeof ids !== 'string' || !/^[0-9]+$/.test(userId ?? '')) return false;
  return ids.split(',').map(s => s.trim()).some(id => id.length > 0 && id === userId);
}

export function salesConfigured(env) {
  return env.SHOP_ENABLED === 'true' && env.PROVISIONING_ENABLED === 'true' &&
    typeof env.PAYMENT_INSTRUCTIONS === 'string' &&
    env.PAYMENT_INSTRUCTIONS.trim().length >= 12 &&
    env.PAYMENT_INSTRUCTIONS.length <= 700;
}

async function isCustomerActive(db, id) {
  const s = await db.prepare('SELECT state FROM customers WHERE telegram_id=?').bind(id).first();
  return s?.state === 'active';
}

async function upsertCustomer(db, e) {
  await db.prepare(
    "INSERT INTO customers(telegram_id,locale) VALUES (?,'fa') " +
    "ON CONFLICT(telegram_id) DO UPDATE SET locale='fa'"
  ).bind(e.actorId).run();
}

async function healthyNodeAvailable(db, quota, nowMs) {
  const r = await db.prepare(
    "SELECT n.id FROM nodes n WHERE n.lifecycle='ready' " +
    "AND n.user_limit > (SELECT COUNT(*) FROM node_allocations a " +
    "WHERE a.node_id=n.id AND a.state IN ('reserved','active')) " +
    "AND n.byte_limit - (SELECT COALESCE(SUM(a.quota_bytes),0) " +
    "FROM node_allocations a WHERE a.node_id=n.id AND a.state IN ('reserved','active')) >= ? " +
    "AND EXISTS(SELECT 1 FROM routes r WHERE r.node_id=n.id AND r.state='ready' " +
    "AND r.verified_ms BETWEEN ? AND ?) ORDER BY n.id LIMIT 1"
  ).bind(quota, nowMs - 600000, nowMs).first();
  return r?.id ?? null;
}

export async function availableForSale(db, plan, nowMs) {
  if (!plan || !Number.isSafeInteger(plan.quota_bytes) || plan.quota_bytes <= 0) return false;
  return (await healthyNodeAvailable(db, plan.quota_bytes, nowMs)) !== null;
}

async function listPlans(db, env, locale, nowMs) {
  const plans = (await db.prepare(
    'SELECT id,title_fa,price_amount,price_currency,quota_bytes,duration_days FROM plans WHERE active=1 ORDER BY price_amount,id LIMIT 12'
  ).all()).results ?? [];
  if (!plans.length) return response(
    panelHeading('🛍','فروشگاه اشتراک','بسته مناسب خود را در این بخش انتخاب کنید')+
    '\n\nدر حال حاضر بسته فعالی برای خرید منتشر نشده است.\n\nاشتراک‌های نسخه قبلی شما مستقل و محفوظ هستند.',
    locale);
  const items = [];
  const buttons = [];
  for (const p of plans) {
    const label = p.title_fa;
    items.push('┌ '+label+'\n│ ⏱ مدت: '+faNumber(p.duration_days)+' روز\n│ 📦 حجم: '+faGB(p.quota_bytes / 1073741824)+
      '\n└ 💳 قیمت: '+money(p.price_amount,p.price_currency));
    if (salesConfigured(env) && await availableForSale(db, p, nowMs)) {
      buttons.push([{text:'🛒 خرید · '+label.slice(0,18),callback_data:'v2:buy:'+p.id}]);
    }
  }
  const warning = buttons.length
    ? 'پس از پرداخت، تصویر رسید را ارسال کنید. فعال‌سازی فقط بعد از تأیید مدیر و آماده‌سازی سرور انجام می‌شود.'
    : '⛔ فروش فعلاً غیرفعال است یا ظرفیت تأییدشده کافی نیست؛ لطفاً پرداخت نکنید.';
  return response(panelHeading('🛍','انتخاب اشتراک','بسته‌ها را از نظر حجم، مدت و قیمت مقایسه کنید')+
    '\n\n'+items.join('\n\n──────────────\n\n')+'\n\n'+warning,locale,buttons);
}

async function pendingOrder(db,id) {
  return db.prepare(
    "SELECT id,state,quoted_amount,quoted_currency FROM orders " +
    "WHERE customer_telegram_id=? AND state IN ('pending','receipt_submitted','approved','provisioning') " +
    "ORDER BY created_at DESC LIMIT 1"
  ).bind(id).first();
}

async function purchase(db,env,e,planId,nowMs) {
  if (!salesConfigured(env)) return response(t('ثبت سفارش در این محیط غیرفعال است؛ لطفاً پرداخت نکنید.',
    'Checkout is disabled in this environment; do not pay.',e.locale),e.locale);
  if (!PLAN_ID.test(planId)) return response(t('پلن نامعتبر است.','Invalid plan.',e.locale),e.locale);
  const active=await pendingOrder(db,e.actorId);
  if (active) return response('ℹ️ یک سفارش باز دارید.\nشناسه: '+active.id+
    '\nوضعیت: '+faStatus(active.state),e.locale);
  const p=await db.prepare('SELECT * FROM plans WHERE id=? AND active=1').bind(planId).first();
  if (!p) return response(t('پلن پیدا نشد.','Plan not found.',e.locale),e.locale);
  if (!await availableForSale(db,p,nowMs)) return response(t('فعلاً سرور آماده با ظرفیت کافی نداریم؛ هیچ پرداختی انجام ندهید.',
    'No verified server has capacity. Please do not pay.',e.locale),e.locale);
  const id=crypto.randomUUID();
  const idempotency='telegram-update:' + e.updateId;
  try {
    await db.prepare(
      "INSERT INTO orders(id,customer_telegram_id,seller_telegram_id,plan_id,idempotency_key,quoted_amount,quoted_currency) " +
      "SELECT ?,?,(SELECT seller_telegram_id FROM customers WHERE telegram_id=?),?,?,?,? " +
      "WHERE EXISTS(SELECT 1 FROM plans WHERE id=? AND active=1)"
    ).bind(id,e.actorId,e.actorId,planId,idempotency,p.price_amount,p.price_currency,planId).run();
  } catch {
    const current=await pendingOrder(db,e.actorId);
    if (current) return response(t('سفارش باز شما: ','Your open order: ',e.locale) + current.id,e.locale);
    throw new Error('purchase_rejected'); // never log sensitive information
  }
  return response(line(
    t('✅ سفارش ثبت شد؛ هنوز هیچ کانفیگی صادر نشده است.','✅ Order recorded; no VPN configuration has been issued.',e.locale),
    t('شناسه: ','Order: ',e.locale)+id,
    t('مبلغ: ','Amount: ',e.locale)+money(p.price_amount,p.price_currency),
    '',
    env.PAYMENT_INSTRUCTIONS.trim(),
    '',
    t('پس از پرداخت، تصویر رسید را همین‌جا بفرستید. بررسی دستی است و پرداخت به‌تنهایی سرویس را فعال نمی‌کند.',
      'Send a receipt photo here after paying. Payment alone does not activate a service.',e.locale)
  ),e.locale);
}

export function validAdminIds(ids,customerId='') {
  if(typeof ids!=='string') return [];
  return [...new Set(ids.split(',').map(s=>s.trim()).filter(x=>
    /^[0-9]{1,20}$/.test(x) && x!==customerId))].slice(0,20);
}

async function storeReceipt(db,e,env) {
  const order=await db.prepare(
    "SELECT id,state FROM orders WHERE customer_telegram_id=? " +
    "AND state IN ('pending','receipt_submitted') ORDER BY created_at DESC LIMIT 1"
  ).bind(e.actorId).first();
  if(!order) return response(t('سفارش در انتظار رسید ندارید. از بخش پلن‌ها شروع کنید.',
    'No order is awaiting a receipt.',e.locale),e.locale);
  if(typeof e.photoId!=='string' || e.photoId.length>512 || e.photoId.length<5)
    return response(t('رسید معتبر نیست؛ لطفاً تصویر رسید را ارسال کنید.','Please send a valid receipt image.',e.locale),e.locale);
  if(order.state==='pending') {
    await db.batch([
      db.prepare(
        "INSERT OR IGNORE INTO receipts(id,order_id,telegram_file_id,upload_by_telegram_id) VALUES(?,?,?,?)"
      ).bind(crypto.randomUUID(),order.id,e.photoId,e.actorId),
      db.prepare(
        "UPDATE orders SET state='receipt_submitted',updated_at=CURRENT_TIMESTAMP WHERE id=? AND state='pending'"
      ).bind(order.id),
    ]);
  }
  // An administrative notice uses a deterministic key, so a retried event
  // cannot spam admins even when acknowledgement is lost.
  for(const adminId of validAdminIds(env.ADMIN_TELEGRAM_IDS,e.actorId)) {
    await db.prepare(
      "INSERT OR IGNORE INTO telegram_notifications(id,chat_id,body,state,due_ms) " +
      "VALUES(?,?,?,'pending',?)"
    ).bind('receipt-review:'+order.id+':'+adminId,adminId,
      '🧾 رسید تازه برای بررسی\nسفارش: '+order.id+
      '\nمشتری: '+e.actorId+'\n/admin را باز کنید.',Date.now()).run();
  }
  return response(t('✅ رسید ثبت شد و منتظر بررسی مدیر است. تا تأیید سرویس، کانفیگی صادر نمی‌شود.',
    '✅ Receipt received for manual review. No VPN configuration has been issued.',e.locale),e.locale);
}

async function myOrders(db,e) {
  const orders=(await db.prepare(
    'SELECT id,state,quoted_amount,quoted_currency FROM orders WHERE customer_telegram_id=? ORDER BY created_at DESC LIMIT 5'
  ).bind(e.actorId).all()).results ?? [];
  if (!orders.length)return response(
    panelHeading('🧾','سفارش‌های من','پیگیری خریدها و وضعیت پرداخت')+
    '\n\nهنوز سفارشی ثبت نکرده‌اید.\nبرای شروع، بسته‌های فعال را بررسی کنید.',
    e.locale,[[{text:'🛍 مشاهده بسته‌ها',callback_data:'v2:plans'}]]);
  return response(panelHeading('🧾','پیگیری سفارش‌ها','آخرین سفارش‌های ثبت‌شده در حساب شما')+
    '\n\n'+orders.map((o,i)=>(
      faNumber(i+1)+'. '+statusSymbol(o.state)+' '+faStatus(o.state)+
      '\n💳 مبلغ: '+money(o.quoted_amount,o.quoted_currency)+
      '\n🔎 کد پیگیری: '+shortCode(o.id,18)
    )).join('\n\n──────────────\n\n'),
    e.locale,orders.map(o=>[{text:'👁 مشاهده · '+shortCode(o.id,10),
      callback_data:'v2:orders:view:'+o.id}]));
}

async function orderDetails(db,e,id){
  if(!ORDER_ID.test(id))return response('⚠️ شناسه سفارش معتبر نیست.',e.locale);
  const order=await db.prepare(
    'SELECT id,state,quoted_amount,quoted_currency,created_at FROM orders WHERE id=? AND customer_telegram_id=?'
  ).bind(id,e.actorId).first();
  if(!order)return response('این سفارش در حساب شما پیدا نشد.',e.locale);
  const step={
    pending:'📷 تصویر رسید پرداخت را همین‌جا در ربات بفرستید. پیش از پرداخت، اطلاعات سفارش را بررسی کنید.',
    receipt_submitted:'⏳ رسید دریافت شده و در صف بررسی مدیر است. نیازی به ارسال دوباره نیست.',
    approved:'✅ رسید تأیید شده است. آماده‌سازی اشتراک به تأیید سرور بستگی دارد.',
    provisioning:'⚙️ در حال آماده‌سازی سرویس هستیم. وضعیت را از همین صفحه پیگیری کنید.',
    fulfilled:'✅ سفارش تحویل داده شده است. جزئیات اتصال را در «اشتراک‌های من» ببینید.',
    cancelled:'سفارش لغو شده است. برای سفارش جدید به بخش بسته‌ها برگردید.',
    refunded:'وجه این سفارش بازگردانده شده است. برای پیگیری از پشتیبانی کمک بگیرید.',
    rejected:'❌ رسید تأیید نشده است. برای پیگیری درخواست پشتیبانی ثبت کنید.'
  }[order.state]??'برای پیگیری وضعیت از بخش پشتیبانی استفاده کنید.';
  const stage=({pending:1,receipt_submitted:2,approved:3,provisioning:4,fulfilled:5})[order.state]??0;
  const stages=['ثبت سفارش','ارسال رسید','بررسی پرداخت','آماده‌سازی سرویس','تحویل اشتراک'];
  const timeline=stages.map((label,i)=>(stage>i?'🟢 ':'⚪ ')+label).join('\n');
  return response(panelHeading('🧾','جزئیات سفارش','پیگیری مرحله‌به‌مرحله')+
    '\n\n🔎 کد پیگیری: '+order.id+
    '\nوضعیت: '+statusSymbol(order.state)+' '+faStatus(order.state)+
    '\n💳 مبلغ: '+money(order.quoted_amount,order.quoted_currency)+
    '\n📅 تاریخ ثبت: '+faDate(order.created_at)+
    '\n\nروند سفارش\n'+timeline+
    '\n\nمرحله بعد\n'+step,e.locale,[
    [{text:'🔄 تازه‌سازی وضعیت',callback_data:'v2:orders:view:'+id}]
  ]);
}

async function mySubscriptions(db,e,env) {
  const rows=(await db.prepare(
    'SELECT id,state,expires_at,max_bytes,used_bytes FROM subscriptions WHERE owner_telegram_id=? ORDER BY expires_at DESC LIMIT 5'
  ).bind(e.actorId).all()).results??[];
  if (!rows.length)return response(
    panelHeading('📦','اشتراک‌های من','وضعیت و اطلاعات اتصال سرویس شما')+
    '\n\nهنوز اشتراک فعالی در مدار V2 ندارید.\nاشتراک نسخه قبلی شما مستقل و محفوظ است.',
    e.locale,[[{text:'🛍 مشاهده بسته‌ها',callback_data:'v2:plans'}]]);
  const buttons=env.SUBSCRIPTION_LINKS_ENABLED==='true'?
    rows.filter(x=>x.state==='active').map(x=>[{
      text:'🔗 دریافت لینک اتصال · '+shortCode(x.id,8),
      callback_data:'v2:my:link:'+x.id,
    }]):[];
  return response(panelHeading('📦','اشتراک‌های من','مصرف، اعتبار و لینک اتصال')+
    '\n\n'+rows.map((x,i)=>(
      faNumber(i+1)+'. '+statusSymbol(x.state)+' '+faStatus(x.state)+
      '\nشناسه: '+shortCode(x.id,18)+
      '\n📊 مصرف: '+faGB(x.used_bytes/1073741824)+' از '+faGB(x.max_bytes/1073741824)+
      '\n'+usageMeter(x.used_bytes,x.max_bytes)+
      '\n📅 پایان اعتبار: '+faDate(x.expires_at)
    )).join('\n\n──────────────\n\n')+
    '\n\n🔐 لینک اتصال خصوصی است؛ حجم دو مسیر همراه اول و ایرانسل مشترک محاسبه می‌شود.',
    e.locale,buttons);
}

async function beginSupport(db,e,nowMs) {
  await db.prepare(
    "INSERT INTO customer_sessions(telegram_id,mode,expires_ms) VALUES(?,'support',?) " +
    "ON CONFLICT(telegram_id) DO UPDATE SET mode='support',expires_ms=excluded.expires_ms"
  ).bind(e.actorId,nowMs+10*60*1000).run();
  return response(panelHeading('💬','ثبت درخواست پشتیبانی','تیم مدار در کنار شماست')+
    '\n\nموضوع و شرح مشکل را در یک پیام بنویسید.\nمهلت ارسال: ۱۰ دقیقه.\n\n🔐 رمز عبور، اطلاعات بانکی یا کلید خصوصی ارسال نکنید.',e.locale);
}

async function maybeRecordSupport(db,e,env,nowMs) {
  if (!e.inputText || e.inputText.startsWith('/') || e.inputText.startsWith('v2:')) return null;
  const s=await db.prepare('SELECT mode,expires_ms FROM customer_sessions WHERE telegram_id=?').bind(e.actorId).first();
  if (!s || s.mode!=='support' || s.expires_ms<nowMs) return null;
  const subject=e.inputText.trim().slice(0,140);
  if (!subject) return response('پیام نمی‌تواند خالی باشد.',e.locale);
  const ticketId='tg-'+e.updateId;
  await db.batch([
    db.prepare('INSERT OR IGNORE INTO support_tickets(id,customer_telegram_id,subject) VALUES(?,?,?)')
      .bind(ticketId,e.actorId,subject),
    db.prepare("INSERT OR IGNORE INTO support_messages(id,ticket_id,sender_telegram_id,body,role) VALUES(?,?,?,?,'customer')")
      .bind('customer-initial:'+e.updateId,ticketId,e.actorId,e.inputText.trim().slice(0,1000)),
    db.prepare('DELETE FROM customer_sessions WHERE telegram_id=?').bind(e.actorId),
  ]);
  await notifySupport(env,e,ticketId,nowMs);
  return response('✅ درخواست پشتیبانی شما ثبت شد.\nشناسه پیگیری: '+ticketId,e.locale,[[
    {text:'💬 مشاهده درخواست',callback_data:'v2:customer:ticket:'+ticketId}
  ]]);
}

async function isStaff(db,e,role) {
  const r=await db.prepare(
    'SELECT 1 AS ok FROM staff_roles WHERE telegram_id=? AND role=?'
  ).bind(e.actorId,role).first();
  return r?.ok===1;
}

async function adminQueue(db,e) {
  const queue=(await db.prepare(
    "SELECT o.id,o.customer_telegram_id,o.quoted_amount,o.quoted_currency " +
    "FROM orders o WHERE o.state='receipt_submitted' " +
    "AND EXISTS(SELECT 1 FROM receipts r WHERE r.order_id=o.id AND r.state='pending') " +
    "ORDER BY o.created_at LIMIT 8"
  ).all()).results??[];
  if(!queue.length)return adminResponse(
    panelHeading('🧾','بررسی پرداخت‌ها','صندوق رسیدهای ارسالی')+
    '\n\n✅ رسیدی برای بررسی باقی نمانده است.',e.locale);
  return adminResponse(panelHeading('🧾','صندوق بررسی پرداخت','رسیدهای منتظر تصمیم مدیر')+
    '\n\n'+queue.map((x,i)=>faNumber(i+1)+'. سفارش '+shortCode(x.id,16)+
      '\n👤 مشتری: '+x.customer_telegram_id+
      '\n💳 مبلغ: '+money(x.quoted_amount,x.quoted_currency)).join('\n\n──────────────\n\n'),
    e.locale,queue.map(x=>[
      {text:'👁 بررسی رسید · '+shortCode(x.id,8),callback_data:'v2:admin:receipt:'+x.id}
    ]));
}

async function adminReceipt(db,e,id) {
  if(!ORDER_ID.test(id))return adminResponse('⚠️ شناسه سفارش معتبر نیست.',e.locale);
  const receipt=await db.prepare(
    "SELECT r.telegram_file_id,o.id,o.state,o.quoted_amount,o.quoted_currency " +
    "FROM receipts r JOIN orders o ON o.id=r.order_id WHERE o.id=? AND r.state='pending' " +
    "AND o.state='receipt_submitted' LIMIT 1"
  ).bind(id).first();
  if(!receipt)return adminResponse('رسید برای بررسی در دسترس نیست.',e.locale);
  return {
    text:frameMessage(panelHeading('🧾','بررسی رسید پرداخت','تصویر و مبلغ سفارش را با دقت تطبیق دهید')+
      '\n\n🔎 شناسه سفارش: '+id+
      '\n💳 مبلغ: '+money(receipt.quoted_amount,receipt.quoted_currency)+
      '\n\nپس از بررسی تصویر، تصمیم خود را ثبت کنید.'),
    photoId:receipt.telegram_file_id,
    replyMarkup:{inline_keyboard:[
      [{text:'✅ تأیید رسید',callback_data:'v2:admin:review:approve:'+id},
       {text:'❌ رد رسید',callback_data:'v2:admin:review:reject:'+id}],
      [{text:'↩️ صف بررسی رسیدها',callback_data:'v2:admin:queue'}],
      ...sectionNavigation('admin'),
    ]},
  };
}

async function adminDecision(db,e,action,id) {
  if(!ORDER_ID.test(id))return adminResponse('⚠️ شناسه سفارش معتبر نیست.',e.locale);
  const desired=action==='approve'?'approved':'rejected';
  const old=await db.prepare(
    "SELECT id,customer_telegram_id,state FROM orders WHERE id=?"
  ).bind(id).first();
  if(!old)return adminResponse('سفارش موردنظر پیدا نشد.',e.locale);
  if(old.state===desired)return adminResponse('این سفارش قبلاً بررسی شده است: '+id,e.locale);
  if(old.state!=='receipt_submitted')
    return adminResponse('این سفارش در وضعیت فعلی قابل بررسی نیست: '+faStatus(old.state),e.locale);
  const idKey='review:'+id;
  const message=action==='approve'
    ?'✅ رسید سفارش '+id+' تأیید شد. صدور کانفیگ پس از آماده‌سازی و تأیید سرور انجام می‌شود.'
    :'❌ رسید سفارش '+id+' تأیید نشد. لطفاً از بخش پشتیبانی پیگیری کنید.';
  const results=await db.batch([
    db.prepare(
      "UPDATE orders SET state=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND state='receipt_submitted' " +
      "AND EXISTS(SELECT 1 FROM receipts WHERE order_id=? AND state='pending')"
    ).bind(desired,id,id),
    db.prepare(
      "UPDATE receipts SET state=? WHERE order_id=? AND state='pending' " +
      "AND EXISTS(SELECT 1 FROM orders WHERE id=? AND state=?)"
    ).bind(action==='approve'?'accepted':'rejected',id,id,desired),
    db.prepare(
      "INSERT OR IGNORE INTO audit_events(event_id,actor_id,object_type,object_id,verb) " +
      "SELECT ?,?,'order',?,? WHERE EXISTS(SELECT 1 FROM orders WHERE id=? AND state=?)"
    ).bind(idKey,e.actorId,id,action,id,desired),
    db.prepare(
      "INSERT OR IGNORE INTO telegram_notifications(id,chat_id,body,state,due_ms) " +
      "SELECT ?,?,?,'pending',? WHERE EXISTS(SELECT 1 FROM orders WHERE id=? AND state=?)"
    ).bind(idKey,old.customer_telegram_id,message,Date.now(),id,desired),
  ]);
  if(results[0]?.meta?.changes!==1)return adminResponse('وضعیت سفارش تغییر کرده است؛ فهرست رسیدها را دوباره باز کنید.',e.locale);
  return adminResponse('✅ نتیجه بررسی سفارش ثبت شد.\nشناسه: '+id+
    '\nوضعیت: '+(action==='approve'?'تأیید شد':'رد شد')+
    '\nهنوز هیچ کانفیگی صادر نشده است.',e.locale);
}

async function supportInbox(env,e) {
  const db=env.DB;
  const queue=(await db.prepare(
    "SELECT id,customer_telegram_id,subject,state FROM support_tickets " +
    "WHERE state IN ('open','waiting') ORDER BY created_at LIMIT 8"
  ).all()).results??[];
  if(!queue.length)return staffResponse(
    panelHeading('💬','صندوق پشتیبانی','مدیریت گفت‌وگوهای مشتریان')+
    '\n\n✅ درخواست بازِ پشتیبانی در صف نیست.',e,env);
  return staffResponse(panelHeading('💬','صندوق پشتیبانی','درخواست‌های نیازمند پاسخ')+
    '\n\n'+queue.map((x,i)=>faNumber(i+1)+'. '+statusSymbol(x.state)+' '+faStatus(x.state)+
      '\nکد: '+x.id+'  ·  مشتری: '+x.customer_telegram_id+
      '\nموضوع: '+x.subject.slice(0,80)).join('\n\n──────────────\n\n'),
    e,env,queue.map(x=>[
      {text:'💬 مشاهده · '+shortCode(x.id,10),callback_data:'v2:ticket:view:'+x.id},
    ]));
}

async function staffCanReply(db,e,env) {
  return adminAllowed(env.ADMIN_TELEGRAM_IDS,e.actorId) || await isStaff(db,e,'support');
}

async function startTicketReply(db,e,id,nowMs,env) {
  const ticket=await db.prepare(
    "SELECT id,customer_telegram_id,subject,state FROM support_tickets WHERE id=?"
  ).bind(id).first();
  if(!ticket||ticket.state==='closed')return staffResponse('این درخواست بسته شده یا در دسترس نیست.',e,env);
  await db.prepare(
    "INSERT INTO support_staff_sessions(telegram_id,ticket_id,expires_ms) VALUES(?,?,?) " +
    "ON CONFLICT(telegram_id) DO UPDATE SET ticket_id=excluded.ticket_id,expires_ms=excluded.expires_ms"
  ).bind(e.actorId,id,nowMs+10*60*1000).run();
  return staffResponse('✉️  پاسخ به درخواست '+id+'\nموضوع: '+ticket.subject.slice(0,140)+
    '\n\nپاسخ خود را در یک پیام بفرستید. مهلت: ۱۰ دقیقه.\n🔐 هرگز رمز عبور یا کلید خصوصی درخواست نکنید.',e,env);
}

async function staffReply(db,e,env,nowMs) {
  const text=e.inputText;
  if(typeof text!=='string'||!text.trim()||text.startsWith('/')||
     text.startsWith('v2:')||!await staffCanReply(db,e,env))return null;
  const session=await db.prepare(
    'SELECT ticket_id,expires_ms FROM support_staff_sessions WHERE telegram_id=?'
  ).bind(e.actorId).first();
  if(!session||session.expires_ms<nowMs)return null;
  const ticket=await db.prepare(
    "SELECT id,customer_telegram_id,state FROM support_tickets WHERE id=?"
  ).bind(session.ticket_id).first();
  if(!ticket||ticket.state==='closed'){
    await db.prepare('DELETE FROM support_staff_sessions WHERE telegram_id=?')
      .bind(e.actorId).run();
    return staffResponse('این درخواست بسته شده است؛ پیامی ارسال نشد.',e,env);
  }
  const body=text.trim().slice(0,1000);
  await db.batch([
    db.prepare(
      "INSERT OR IGNORE INTO support_messages(id,ticket_id,sender_telegram_id,body,role) " +
      "VALUES(?,?,?,?,'support')"
    ).bind('message:'+e.updateId,ticket.id,e.actorId,body),
    db.prepare(
      "INSERT OR IGNORE INTO telegram_notifications(id,chat_id,body,state,due_ms) " +
      "VALUES(?,?,?,'pending',?)"
    ).bind('support:'+e.updateId,ticket.customer_telegram_id,
      '💬 پاسخ پشتیبانی مدار به درخواست '+ticket.id+':\n\n'+body,nowMs),
    db.prepare(
      "UPDATE support_tickets SET state='waiting' WHERE id=? AND state='open'"
    ).bind(ticket.id),
    db.prepare('DELETE FROM support_staff_sessions WHERE telegram_id=?')
      .bind(e.actorId),
    db.prepare(
      'INSERT OR IGNORE INTO audit_events(event_id,actor_id,object_type,object_id,verb) VALUES(?,?,?,?,?)'
    ).bind('support:reply:'+e.updateId,e.actorId,'support_ticket',ticket.id,'reply'),
  ]);
  return staffResponse('✅ پاسخ برای مشتری ارسال شد.\nشناسه درخواست: '+ticket.id,e,env);
}

async function closeSupport(db,e,id,nowMs,env) {
  const ticket=await db.prepare(
    'SELECT id,state,customer_telegram_id FROM support_tickets WHERE id=?'
  ).bind(id).first();
  if(!ticket)return staffResponse('درخواست موردنظر پیدا نشد.',e,env);
  if(ticket.state==='closed')return staffResponse('این درخواست قبلاً بسته شده است.',e,env);
  await db.batch([
    db.prepare(
      "UPDATE support_tickets SET state='closed' WHERE id=? AND state IN ('open','waiting')"
    ).bind(id),
    db.prepare(
      "INSERT OR IGNORE INTO telegram_notifications(id,chat_id,body,state,due_ms) " +
      "VALUES(?,?,?,'pending',?)"
    ).bind('support:closed:'+id,ticket.customer_telegram_id,
      '✅ درخواست پشتیبانی '+id+' بسته شد. در صورت نیاز، درخواست تازه‌ای ثبت کنید.',nowMs),
    db.prepare(
      'INSERT OR IGNORE INTO audit_events(event_id,actor_id,object_type,object_id,verb) VALUES(?,?,?,?,?)'
    ).bind('support:close:'+id,e.actorId,'support_ticket',id,'close'),
  ]);
  return staffResponse('✅ درخواست پشتیبانی بسته شد.\nشناسه: '+id,e,env);
}

async function personalizedHome(env,e,customerView=false) {
  const isAdmin=adminAllowed(env.ADMIN_TELEGRAM_IDS,e.actorId);
  if(isAdmin&&!customerView)return adminDashboard(env,e);
  const seller=await isStaff(env.DB,e,'seller');
  const supportAgent=await isStaff(env.DB,e,'support');
  const [active,customer,latestOrder]=await Promise.all([
    env.DB.prepare(
      "SELECT COUNT(*) AS n FROM subscriptions WHERE owner_telegram_id=? AND state='active' AND expires_at>?"
    ).bind(e.actorId,Date.now()).first(),
    env.DB.prepare('SELECT state FROM customers WHERE telegram_id=?').bind(e.actorId).first(),
    env.DB.prepare(
      'SELECT id,state FROM orders WHERE customer_telegram_id=? ORDER BY created_at DESC LIMIT 1'
    ).bind(e.actorId).first(),
  ]);
  const activeCount=Number(active?.n??0);
  const greeting=isAdmin&&!customerView?'🛠 خوش آمدید، مدیر مدار':'🌐 به مدار خوش آمدید';
  const state=activeCount>0
    ?'🟢 اشتراک‌های فعال شما: '+faNumber(activeCount)
    :'📦 در حال حاضر اشتراک فعالی در این نسخه ندارید.';
  const orderHint=latestOrder
    ?'🧾 آخرین سفارش: '+faStatus(latestOrder.state)+' · '+shortCode(latestOrder.id,14)
    :'🧾 هنوز سفارشی ثبت نکرده‌اید.';
  const safety=!salesConfigured(env)
    ?'⛔ فروش عمومی هنوز فعال نشده است؛ تا تأیید اتصال، ظرفیت و کنترل مصرف، هیچ پرداختی انجام ندهید.'
    :'برای مشاهده بسته‌ها، بخش خرید اشتراک را انتخاب کنید.';
  const restriction=customer?.state==='suspended'
    ?'\n⛔ حساب شما تعلیق شده است؛ دسترسی به پشتیبانی همچنان برقرار است.':'';
  const menu=customerView?botMenu():isAdmin?adminMenu():supportAgent?supportMenu():seller?sellerMenu():botMenu();
  const quick=[
    ...(isAdmin?[[{text:'📊 پیشخوان مدیریت',callback_data:'v2:admin:home'}]]:[]),
    ...(isAdmin&&!customerView?[[{text:'👤 مشاهده نمای مشتری',callback_data:'v2:customer:home'}]]:[]),
    ...(seller?[[{text:'🧑‍💼 ورود به پنل فروشنده',callback_data:'v2:seller:home'}]]:[]),
  ];
  const homeLines=[
    panelHeading('👋','پنل کاربری مدار','اشتراک و سفارش‌های شما، یکجا'),
    '',
    greeting,
    state,
    orderHint,
    '',
    safety+restriction
  ];
  return {text:frameMessage(homeLines.join('\n')),photoId:BRAND_BANNER_URL,
    replyMarkup:{inline_keyboard:[...quick,...menu.inline_keyboard]}};
}

async function liveServiceStatus(env,e,nowMs) {
  const ready=(await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM nodes n WHERE n.lifecycle='ready' AND EXISTS("+
    "SELECT 1 FROM routes r WHERE r.node_id=n.id AND r.state='ready' AND r.verified_ms BETWEEN ? AND ?)"
  ).bind(nowMs-600000,nowMs).first())?.n??0;
  return response(panelHeading('📶','وضعیت سرویس مدار','پایش مسیرهای تأییدشده')+
    '\n\n'+(ready>0?'🟢 مسیرهای دارای تأیید تازه در ۱۰ دقیقه اخیر: '+faNumber(ready):
      '🟠 در حال حاضر مسیر تأییدشده تازه‌ای برای فروش عمومی وجود ندارد.')+
    '\n\nنصب آزمایشی یا دریافت لینک تست به‌تنهایی به معنی آماده‌بودن سرویس پولی نیست.',e.locale);
}

/** The caller must already validate the Telegram webhook and sender identity. */
export async function resolveBotAction(env,e,nowMs=Date.now()) {
  const db=env.DB;
  if (!db || !e || !/^\d+$/.test(e.actorId??'')) throw new Error('invalid_event');
  await upsertCustomer(db,e);
  e={...e,locale:'fa'};
  const key=e.key??'';
  if (!await isCustomerActive(db,e.actorId) &&
      !['/start','home','support','/support','customer:tickets','/tickets','lang','/lang'].includes(key) &&
      !key.startsWith('lang:') && !key.startsWith('customer:ticket:') &&
      !key.startsWith('customer:ticket:reply:') &&
      !(typeof e.inputText==='string' && (
        !!(await db.prepare(
          "SELECT 1 AS ok FROM customer_sessions WHERE telegram_id=? AND mode='support' AND expires_ms>?"
        ).bind(e.actorId,nowMs).first()) ||
        !!(await db.prepare(
          "SELECT 1 AS ok FROM v2_bot_input_sessions WHERE telegram_id=? AND mode='ticket_reply' AND expires_ms>?"
        ).bind(e.actorId,nowMs).first())
      )))
    return response('⛔ حساب شما تعلیق شده است. برای پیگیری همچنان می‌توانید از بخش پشتیبانی استفاده کنید.',e.locale);

  if(key==='lang'||key==='/lang'||key==='lang:fa'||key==='lang:en')
    return response('🌐 زبان ربات مدار فارسی است و همه پیام‌ها به زبان فارسی نمایش داده می‌شوند.',e.locale);
  if(key==='/start'){
    const referral=await linkSellerOnStart(db,e,nowMs);
    const home=await personalizedHome(env,e);
    return referral?{...home,text:home.text+'\n\n'+referral}:home;
  }
  if(e.photoId)return storeReceipt(db,e,env);
  const customer=await customerTicketAction(env,e,nowMs);
  if(customer)return customer;
  const adminPanel=await adminPanelAction(env,e,nowMs);
  if(adminPanel)return adminPanel;
  const panelInput=await consumePanelInput(env,e,nowMs);
  if(panelInput)return panelInput;
  if(key==='/cancel') {
    await db.batch([
      db.prepare('DELETE FROM customer_sessions WHERE telegram_id=?').bind(e.actorId),
      db.prepare('DELETE FROM admin_node_sessions WHERE telegram_id=?').bind(e.actorId),
    ]);
    return response(t('✅ عملیات لغو شد.','✅ Cancelled.',e.locale),e.locale);
  }
  if (key==='admin:node:new' || key==='admin:node:cancel') {
    if(!adminAllowed(env.ADMIN_TELEGRAM_IDS,e.actorId))
      return adminResponse('⛔ دسترسی به این بخش مجاز نیست.',e.locale);
    if(key==='admin:node:cancel'){
      await cancelNodeWizard(db,e.actorId);
      const overview=await nodeOverview(db);
      return adminResponse(overview.text,e.locale,overview.replyMarkup.inline_keyboard);
    }
    const panel=await beginNodeWizard(db,e.actorId,nowMs,env);
    return adminResponse(panel.text,e.locale,panel.replyMarkup?.inline_keyboard??[]);
  }
  if(adminAllowed(env.ADMIN_TELEGRAM_IDS,e.actorId)) {
    const wizard=await consumeNodeWizard(db,e.actorId,e.inputText,nowMs,env);
    if(wizard)return adminResponse(wizard.text,e.locale);
  }
  const sellerAction=await handleSeller(env,e,nowMs);
  if(sellerAction)return sellerAction;
  if(key==='/seller_grant'||key==='/support_grant') {
    if(!adminAllowed(env.ADMIN_TELEGRAM_IDS,e.actorId))
      return adminResponse('⛔ دسترسی به این بخش مجاز نیست.',e.locale);
    const id=e.inputText?.trim().split(/\s+/)[1]??'';
    const role=key==='/seller_grant'?'seller':'support';
    if(!await grantStaffRole(db,e,role,id))
      return adminResponse('⚠️ شناسه تلگرام معتبر نیست. دستور را همراه شناسه عددی بفرستید.',e.locale);
    return adminResponse('✅ دسترسی '+faRole(role)+' برای شناسه '+id+' فعال شد.',e.locale);
  }
  if(/^admin:nodes:(all|ready|setup|attention|quarantine|archive):[0-9]{1,4}$/.test(key)){
    if(!adminAllowed(env.ADMIN_TELEGRAM_IDS,e.actorId))
      return adminResponse('⛔ دسترسی به این بخش مجاز نیست.',e.locale);
    const [, ,filter,page]=key.split(':');
    const list=await nodeOverview(db,{filter,page:Number(page)});
    return adminResponse(list.text,e.locale,list.replyMarkup.inline_keyboard);
  }
  if(key.startsWith('admin:node:view:') ||
     /^admin:node:(confirm|apply|trialref):/.test(key)){
    if(!adminAllowed(env.ADMIN_TELEGRAM_IDS,e.actorId))
      return adminResponse('⛔ دسترسی به این بخش مجاز نیست.',e.locale);
    let panel;
    const view=key.match(/^admin:node:view:([a-f0-9]{24})$/);
    const manage=key.match(/^admin:node:(confirm|apply):(quarantine|restore|retire):([a-f0-9]{24})$/);
    const trial=key.match(/^admin:node:trialref:([a-f0-9]{24})$/);
    if(view)panel=await nodeDetails(db,view[1],e.actorId);
    else if(manage)
      panel=await nodeManagement(db,e.actorId,manage[3],manage[2],
        manage[1]==='apply',e.updateId);
    else if(trial){
      const node=await nodeFromRef(db,trial[1]);
      const job=node?await db.prepare(
        'SELECT state,owner_id FROM node_bootstrap_jobs WHERE node_id=?'
      ).bind(node.id).first():null;
      if(!node||!job||job.state!=='installed'||job.owner_id!==e.actorId||
         ['quarantined','retired'].includes(node.lifecycle))
        panel={text:'⛔ صدور لینک تست این سرور مجاز نیست.',replyMarkup:{inline_keyboard:[]}};
      else {
        const url=await issueTrialLink(env,e.actorId,node.id,nowMs);
        panel={text:url?'🔗 لینک تست سرور '+node.id+'\n'+url+
          '\n\nاین لینک آزمایشی است و تأیید آمادگی فروش محسوب نمی‌شود.':
          '⏸ لینک تست آماده نیست. نصب سرور و مسیرهای اپراتورها را بررسی کنید.',
          replyMarkup:{inline_keyboard:[]}};
      }
    }else panel={text:'⚠️ درخواست مدیریت سرور معتبر نیست.',replyMarkup:{inline_keyboard:[]}};
    return adminResponse(panel.text,e.locale,panel.replyMarkup?.inline_keyboard??[]);
  }
  if(key.startsWith('admin:node:trial:')) {
    if(!adminAllowed(env.ADMIN_TELEGRAM_IDS,e.actorId))
      return adminResponse('⛔ دسترسی به این بخش مجاز نیست.',e.locale);
    const id=key.slice('admin:node:trial:'.length);
    const url=await issueTrialLink(env,e.actorId,id,nowMs);
    return url?adminResponse('🔗 لینک آزمایشی یک‌ساعته مدار\n'+url+
      '\n\nاین لینک دو مسیر همراه اول و ایرانسل را فقط برای آزمون نشان می‌دهد؛ سرور هنوز برای فروش تأیید نشده است.',e.locale)
      :adminResponse('⏸ نصب کامل نشده یا لینک آزمایشی آماده نیست. وضعیت سرور و اجراکننده امن را بررسی کنید.',e.locale);
  }
  if(key==='/admin'||key==='admin:home')return adminDashboard(env,e);
  if(key==='admin:node:trials') {
    if(!adminAllowed(env.ADMIN_TELEGRAM_IDS,e.actorId))
      return adminResponse('⛔ دسترسی به این بخش مجاز نیست.',e.locale);
    const rows=(await db.prepare(
      "SELECT node_id,state FROM node_bootstrap_jobs ORDER BY created_ms DESC LIMIT 12"
    ).all()).results??[];
    if(!rows.length)return adminResponse('🧪 هنوز سرور آزمایشی اضافه نشده است.',e.locale);
    return adminResponse('🧪  لینک‌های آزمایشی سرورها\n━━━━━━━━━━━━━━━━━━\n'+rows.map(x=>
      x.node_id+'  |  '+faStatus(x.state)).join('\n'),e.locale,
      rows.filter(x=>x.state==='installed').map(x=>[{
        text:'🔗 دریافت لینک '+x.node_id,callback_data:'v2:admin:node:trial:'+x.node_id
      }]));
  }
  if(key==='admin:plans') {
    if(!adminAllowed(env.ADMIN_TELEGRAM_IDS,e.actorId))
      return adminResponse('⛔ دسترسی به این بخش مجاز نیست.',e.locale);
    // A back button from the plan wizard abandons the unsaved draft.
    if(Number.isSafeInteger(e.messageId)&&e.messageId>0)
      await db.prepare("DELETE FROM v2_bot_input_sessions WHERE telegram_id=? AND mode='plan_draft'")
        .bind(e.actorId).run();
    const plans=(await db.prepare(
      'SELECT id,title_fa,active,price_amount,price_currency FROM plans ORDER BY id LIMIT 12'
    ).all()).results??[];
    return adminResponse(panelHeading('🛍','مدیریت پلن‌ها','قیمت‌گذاری و انتشار بسته‌ها')+
      '\n\n'+(plans.map(x=>statusSymbol(x.active?'active':'disabled')+' '+x.title_fa+
        '\nشناسه: '+x.id+'  ·  '+(x.active?'فعال':'غیرفعال')+
        '\n💳 '+money(x.price_amount,x.price_currency)).join('\n\n──────────────\n\n')||
        'هنوز پلنی ثبت نشده است.')+
      '\n\nپلن تازه ابتدا غیرفعال ساخته می‌شود؛ انتشار فقط پس از تأیید ظرفیت و صدور مجاز است.',e.locale,[
        [{text:'➕ ساخت پلن جدید',callback_data:'v2:admin:plan:new'}],
        ...plans.map(x=>[{text:(x.active?'🔴 غیرفعال‌سازی ':'🟢 فعال‌سازی ')+x.title_fa.slice(0,16),
          callback_data:'v2:admin:plan:confirm:'+(x.active?'off:':'on:')+x.id}]),
      ]);
  }
  if(key==='/node_add_auto') {
    if(!adminAllowed(env.ADMIN_TELEGRAM_IDS,e.actorId))
      return adminResponse('⛔ دسترسی به این بخش مجاز نیست.',e.locale);
    const data=(e.inputText??'').replace(/^\/node_add_auto(?:@\w+)?\s*/,'').trim();
    const result=await enqueueAutoNode(env,e.actorId,data,nowMs);
    const errors={bad_input:'اطلاعات سرور با قالب خواسته‌شده مطابقت ندارد.',
      not_ready:'پایگاه داده آماده نیست.',automation_not_configured:'اتصال اجراکننده امن کامل نیست.',
      already_exists:'این شناسه سرور قبلاً ثبت شده است.'};
    if(result.error)return adminResponse('⚠️ ثبت انجام نشد.\n'+
      (errors[result.error]??'خطای پیش‌بینی‌نشده؛ تنظیمات را بررسی کنید.'),e.locale);
    return adminResponse(result.dispatched
      ?'🚀 درخواست نصب خودکار سرور '+result.id+' به اجراکننده امن ارسال شد.'
      :'⏸ سرور '+result.id+' ثبت شد، اما اجرای خودکار هنوز آغاز نشده است.',e.locale);
  }
  if(key==='/node_add'||key==='/node_route'||key==='/nodes'||key==='admin:nodes') {
    if(!adminAllowed(env.ADMIN_TELEGRAM_IDS,e.actorId))
      return adminResponse('⛔ دسترسی به این بخش مجاز نیست.',e.locale);
    const result=await nodeAdminAction(db,e.actorId,key==='admin:nodes'?'/nodes':key,e.inputText);
    if(key==='admin:nodes'||key==='/nodes')
      return adminResponse(result.text,e.locale,result.replyMarkup?.inline_keyboard??[]);
    return adminResponse(result.text,e.locale);
  }
  if(key==='/plan_add') {
    if(!adminAllowed(env.ADMIN_TELEGRAM_IDS,e.actorId))
      return adminResponse('⛔ دسترسی به این بخش مجاز نیست.',e.locale);
    const raw=(e.inputText??'').replace(/^\/plan_add\s*/,'').trim();
    const parts=raw.split('|').map(x=>x.trim());
    if(parts.length!==5)return adminResponse(
      'قالب درست: /plan_add شناسه فنی|نام فارسی|قیمت تومان|حجم گیگابایت|مدت روز',e.locale);
    const [id,title,priceRaw,gbRaw,daysRaw]=parts;
    const numeric=/^(0|[1-9]\d*)$/;
    if(!PLAN_ID.test(id)||!title||title.length>64||
      !numeric.test(priceRaw)||!numeric.test(gbRaw)||!numeric.test(daysRaw))
      return adminResponse('⚠️ اطلاعات پلن معتبر نیست؛ هیچ تغییری انجام نشد.',e.locale);
    const price=Number(priceRaw),gb=Number(gbRaw),days=Number(daysRaw);
    if(!Number.isSafeInteger(price)||price>100000000000||gb<1||gb>2000||days<1||days>366)
      return adminResponse('⚠️ قیمت، حجم یا مدت خارج از محدوده مجاز است.',e.locale);
    const result=await db.batch([
      db.prepare('INSERT OR IGNORE INTO plans(id,title_fa,title_en,price_amount,price_currency,quota_bytes,duration_days,active) VALUES(?,?,?,?,?,?,?,0)')
        .bind(id,title,title,price,'IRT',gb*1073741824,days),
      db.prepare('INSERT OR IGNORE INTO audit_events(event_id,actor_id,object_type,object_id,verb) VALUES(?,?,?,?,?)')
        .bind('plan:create:'+id,e.actorId,'plan',id,'create:disabled'),
    ]);
    return adminResponse(result[0]?.meta?.changes===1
      ?'✅ پلن با موفقیت و در وضعیت غیرفعال ثبت شد.'
      :'ℹ️ این شناسه پلن قبلاً ثبت شده است؛ تغییری ایجاد نشد.',e.locale);
  }
  if(key.startsWith('admin:plan:confirm:')){
    if(!adminAllowed(env.ADMIN_TELEGRAM_IDS,e.actorId))
      return adminResponse('⛔ دسترسی به این بخش مجاز نیست.',e.locale);
    const m=key.match(/^admin:plan:confirm:(on|off):([a-zA-Z0-9_-]{2,30})$/);
    if(!m)return adminResponse('⚠️ شناسه پلن معتبر نیست.',e.locale);
    const [,mode,id]=m;
    const plan=await db.prepare(
      'SELECT id,title_fa,active,price_amount,price_currency FROM plans WHERE id=?'
    ).bind(id).first();
    if(!plan)return adminResponse('پلن موردنظر پیدا نشد.',e.locale);
    if(Boolean(plan.active)===(mode==='on'))
      return adminResponse('این پلن از قبل در وضعیت انتخاب‌شده قرار دارد.',e.locale,
        [[{text:'🛍 فهرست پلن‌ها',callback_data:'v2:admin:plans'}]]);
    return adminResponse(
      '⚠️  تأیید تغییر پلن\n━━━━━━━━━━━━━━━━━━\n'+
      'پلن: '+plan.title_fa+'\nقیمت: '+money(plan.price_amount,plan.price_currency)+
      '\nوضعیت کنونی: '+(plan.active?'فعال':'غیرفعال')+
      '\nوضعیت درخواستی: '+(mode==='on'?'فعال':'غیرفعال')+
      '\n\nبرای جلوگیری از تغییر ناخواسته، تصمیم خود را تأیید کنید.',e.locale,[
      [{text:'✅ تأیید تغییر وضعیت',callback_data:'v2:plan:'+mode+':'+id}],
      [{text:'↩️ انصراف',callback_data:'v2:admin:plans'}],
    ]);
  }
  if(key.startsWith('plan:on:')||key.startsWith('plan:off:')) {
    if(!adminAllowed(env.ADMIN_TELEGRAM_IDS,e.actorId))
      return adminResponse('⛔ دسترسی به این بخش مجاز نیست.',e.locale);
    const [,mode,id]=key.split(':');
    if(!PLAN_ID.test(id))return adminResponse('⚠️ شناسه پلن معتبر نیست.',e.locale);
    const plan=await db.prepare('SELECT * FROM plans WHERE id=?').bind(id).first();
    if(!plan)return adminResponse('پلن موردنظر پیدا نشد.',e.locale);
    if(mode==='on'&&(!salesConfigured(env)||!await availableForSale(db,plan,nowMs)))
      return adminResponse('⛔ امکان فعال‌سازی پلن وجود ندارد؛ پرداخت، نصب و ظرفیت سرور هنوز به‌طور کامل تأیید نشده‌اند.',e.locale);
    await db.batch([
      db.prepare('UPDATE plans SET active=? WHERE id=?').bind(mode==='on'?1:0,id),
      db.prepare('INSERT OR IGNORE INTO audit_events(event_id,actor_id,object_type,object_id,verb) VALUES(?,?,?,?,?)')
        .bind('plan:toggle:'+e.updateId,e.actorId,'plan',id,'toggle:'+mode),
    ]);
    return adminResponse('✅ وضعیت پلن '+id+' به '+(mode==='on'?'فعال':'غیرفعال')+' تغییر کرد.',e.locale);
  }
  if (key==='home') return personalizedHome(env,e);
  if (key==='customer:home') return personalizedHome(env,e,true);
  if (key==='plans' || key==='/plans') return listPlans(db,env,e.locale,nowMs);
  if (key==='my' || key==='/my') return mySubscriptions(db,e,env);
  if (key.startsWith('my:link:')) {
    const subId=key.slice('my:link:'.length);
    if(!/^[A-Za-z0-9][A-Za-z0-9_-]{1,79}$/.test(subId))
      return response(t('اشتراک نامعتبر است.','Invalid subscription.',e.locale),e.locale);
    // Sender identity was verified as a private Telegram conversation.
    // Never issue someone else's URL, even if a callback is forged.
    const owned=await db.prepare(
      "SELECT id FROM subscriptions WHERE id=? AND owner_telegram_id=? AND state='active'"
    ).bind(subId,e.actorId).first();
    if(!owned)return response(t('اشتراک فعال شما پیدا نشد.','Active subscription not found.',e.locale),e.locale);
    const link=await issueCarrierLink(env,subId,nowMs);
    if(!link)return response(t(
      'هر دو مسیر تأییدشده هنوز آماده نیستند؛ لینکی صادر نشد.',
      'Both verified carrier routes are not yet ready; no link was issued.',e.locale),e.locale);
    return response(line(
      '🔗  لینک اشتراک مدار',
      '━━━━━━━━━━━━━━━━━━',
      'این لینک شامل دو مسیر جداگانه برای همراه اول و ایرانسل است:',
      link.url,'',
      'در برنامه v2rayNG وارد بخش «تنظیمات اشتراک» شوید، لینک را اضافه کنید و سپس «به‌روزرسانی اشتراک» را بزنید.',
      '🔐 این لینک خصوصی است؛ آن را برای دیگران ارسال نکنید.',
      'یک اشتراک، یک حجم مصرف و یک تاریخ انقضا برای هر دو مسیر.'
    ),e.locale);
  }
  if (key==='orders' || key==='/orders') return myOrders(db,e);
  if (key.startsWith('orders:view:')) return orderDetails(db,e,key.slice('orders:view:'.length));
  if (key==='status' || key==='/status') return liveServiceStatus(env,e,nowMs);
  if (key==='privacy' || key==='/privacy') return botPage('privacy',e.locale);
  if (key==='help' || key==='/help') return botPage('help',e.locale);
  if (key==='support' || key==='/support') return beginSupport(db,e,nowMs);
  if (key.startsWith('buy:')) return purchase(db,env,e,key.slice(4),nowMs);
  if (key==='admin:queue') {
    if (!adminAllowed(env.ADMIN_TELEGRAM_IDS,e.actorId)) return adminResponse('⛔ دسترسی به این بخش مجاز نیست.',e.locale);
    return adminQueue(db,e);
  }
  if (key.startsWith('admin:receipt:')) {
    if (!adminAllowed(env.ADMIN_TELEGRAM_IDS,e.actorId)) return adminResponse('⛔ دسترسی به این بخش مجاز نیست.',e.locale);
    return adminReceipt(db,e,key.slice('admin:receipt:'.length));
  }
  if (key==='admin:tickets') {
    if (!adminAllowed(env.ADMIN_TELEGRAM_IDS,e.actorId) &&
      !await isStaff(db,e,'support')) return adminResponse('⛔ دسترسی به این بخش مجاز نیست.',e.locale);
    return supportInbox(env,e);
  }
  if(key.startsWith('ticket:view:')) {
    if(!await staffCanReply(db,e,env))return adminResponse('⛔ دسترسی به این بخش مجاز نیست.',e.locale);
    return staffTicketDetails(env,e,key.slice('ticket:view:'.length));
  }
  if(key.startsWith('ticket:confirm-close:')){
    if(!await staffCanReply(db,e,env))
      return staffResponse('⛔ دسترسی به این بخش مجاز نیست.',e,env);
    const id=key.slice('ticket:confirm-close:'.length);
    if(!/^tg-[0-9]{1,20}$/.test(id))
      return staffResponse('⚠️ شناسه درخواست معتبر نیست.',e,env);
    const ticket=await db.prepare(
      'SELECT id,state,subject FROM support_tickets WHERE id=?'
    ).bind(id).first();
    if(!ticket||ticket.state==='closed')
      return staffResponse('درخواست بسته شده یا در دسترس نیست.',e,env);
    return staffResponse(
      '⚠️  بستن گفت‌وگوی پشتیبانی\n━━━━━━━━━━━━━━━━━━\n'+
      'شناسه: '+id+'\nموضوع: '+ticket.subject+
      '\n\nبا بستن درخواست، امکان پاسخ در این گفت‌وگو متوقف می‌شود.',e,env,[
      [{text:'✅ تأیید بستن درخواست',callback_data:'v2:ticket:close:'+id}],
      [{text:'↩️ بازگشت به گفت‌وگو',callback_data:'v2:ticket:view:'+id}],
    ]);
  }
  if (key.startsWith('ticket:reply:') || key.startsWith('ticket:close:')) {
    if(!await staffCanReply(db,e,env)) return adminResponse('⛔ دسترسی به این بخش مجاز نیست.',e.locale);
    const action=key.startsWith('ticket:reply:')?'reply':'close';
    const id=key.slice(action==='reply'?'ticket:reply:'.length:'ticket:close:'.length);
    if(!/^tg-[0-9]{1,20}$/.test(id)) return adminResponse('⚠️ شناسه درخواست معتبر نیست.',e.locale);
    return action==='reply' ? startTicketReply(db,e,id,nowMs,env) : closeSupport(db,e,id,nowMs,env);
  }
  if(key.startsWith('admin:review:')){
    if(!adminAllowed(env.ADMIN_TELEGRAM_IDS,e.actorId))
      return adminResponse('⛔ دسترسی به این بخش مجاز نیست.',e.locale);
    const m=key.match(/^admin:review:(approve|reject):([a-zA-Z0-9_-]{2,48})$/);
    if(!m)return adminResponse('⚠️ شناسه رسید معتبر نیست.',e.locale);
    const [,decision,id]=m;
    const record=await db.prepare(
      "SELECT id,state,quoted_amount,quoted_currency FROM orders WHERE id=?"
    ).bind(id).first();
    if(!record||record.state!=='receipt_submitted')
      return adminResponse('این سفارش دیگر برای بررسی در دسترس نیست.',e.locale);
    return adminResponse('⚠️  تأیید تصمیم درباره رسید\n━━━━━━━━━━━━━━━━━━\n'+
      'کد سفارش: '+record.id+
      '\nمبلغ: '+money(record.quoted_amount,record.quoted_currency)+
      '\n\nتصمیم: '+(decision==='approve'?'✅ تأیید رسید پرداخت':'❌ رد رسید پرداخت')+
      '\n\nاین اقدام در پرونده سفارش ثبت و به مشتری اطلاع داده می‌شود.',e.locale,[
        [{text:'✅ بله، ثبت تصمیم',callback_data:'v2:'+decision+':'+id}],
        [{text:'↩️ بازگشت بدون تغییر',callback_data:'v2:admin:receipt:'+id}],
      ]);
  }
  if (key.startsWith('approve:') || key.startsWith('reject:')) {
    if (!adminAllowed(env.ADMIN_TELEGRAM_IDS,e.actorId)) return adminResponse('⛔ دسترسی به این بخش مجاز نیست.',e.locale);
    const [action,id]=key.split(':');
    return adminDecision(db,e,action,id);
  }
  const reply=await staffReply(db,e,env,nowMs);
  if(reply) return reply;
  const support=await maybeRecordSupport(db,e,env,nowMs);
  return support??botPage('unknown',e.locale);
}
