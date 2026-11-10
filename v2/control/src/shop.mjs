import {beginNodeWizard,cancelNodeWizard,consumeNodeWizard} from './node-wizard.mjs';
import { nodeAdminAction } from './node-admin.mjs';
import { handleSeller, linkSellerOnStart, grantStaffRole } from './referrals.mjs';
/**
 * Madar V2 business UI. Every mutable action is idempotent by the Telegram
 * update ID or by a state-qualified SQL transition. No unattended payment or
 * config issuance takes place from this module.
 */
import { botMenu, botPage } from './bot-ux.mjs';

const ORDER_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{1,48}$/;
const PLAN_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{1,30}$/;
const t = (fa, en, locale) => locale === 'en' ? en : fa;
const line = (...parts) => parts.filter(Boolean).join('\n');
const response = (text, locale = 'fa', extra = []) => ({
  text: text.slice(0, 3800),
  replyMarkup: extra.length ? { inline_keyboard: [...extra, ...botMenu(locale).inline_keyboard] } : botMenu(locale),
});

function money(amount, currency) {
  return Number(amount).toLocaleString('en-US') + ' ' + currency;
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
    "INSERT OR IGNORE INTO customers(telegram_id,locale) VALUES (?,?)"
  ).bind(e.actorId, e.locale).run();
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
    'SELECT id,title_fa,title_en,price_amount,price_currency,quota_bytes,duration_days FROM plans WHERE active=1 ORDER BY price_amount,id LIMIT 12'
  ).all()).results ?? [];
  if (!plans.length) return response(t('🛍 هنوز پلنی برای فروش منتشر نشده است.', '🛍 No plans have been published yet.', locale), locale);
  const items = [];
  const buttons = [];
  for (const p of plans) {
    const label = (locale === 'en' ? p.title_en : p.title_fa);
    const details = p.duration_days + t(' روز · ', ' days · ', locale) +
      (Math.round(p.quota_bytes / 1073741824 * 100) / 100) + ' GB';
    items.push('• ' + label + ' — ' + details + ' — ' + money(p.price_amount, p.price_currency));
    if (salesConfigured(env) && await availableForSale(db, p, nowMs)) {
      buttons.push([{text:t('خرید ','Buy ',locale) + label.slice(0,24),callback_data:'v2:buy:' + p.id}]);
    }
  }
  const warning = buttons.length
    ? t('فقط پس از پرداخت و تأیید رسید توسط مدیر، سفارش بررسی می‌شود. صدور کانفیگ منوط به آماده‌شدن نود است.',
        'Receipt review is manual. A configuration is issued only after node provisioning succeeds.',locale)
    : t('فعلاً فروش فعال نیست یا سرور تأییدشده با ظرفیت کافی موجود نیست؛ پرداخت نکنید.',
        'Sales are disabled or no verified server has enough capacity; do not pay.',locale);
  return response(line(t('🛍 پلن‌های مدار','🛍 Madar plans',locale),...items,'',warning),locale,buttons);
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
  if (active) return response(t('یک سفارش باز دارید: ','You already have an open order: ',e.locale) +
    active.id + ' (' + active.state + ')',e.locale);
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
  if (!orders.length) return response(t('هنوز سفارشی ندارید.','You have no orders yet.',e.locale),e.locale);
  return response(line(t('🧾 سفارش‌های من','🧾 My orders',e.locale),
    ...orders.map(o=>o.id.slice(0,8)+'… | '+money(o.quoted_amount,o.quoted_currency)+' | '+o.state)),e.locale);
}

async function mySubscriptions(db,e) {
  const rows=(await db.prepare(
    'SELECT id,state,expires_at FROM subscriptions WHERE owner_telegram_id=? ORDER BY expires_at DESC LIMIT 5'
  ).bind(e.actorId).all()).results??[];
  if (!rows.length) return response(t('هنوز اشتراک فعال نسخه جدید ندارید. اشتراک قبلی شما مستقل باقی مانده است.',
    'No V2 subscription yet; your existing V1 subscription is unaffected.',e.locale),e.locale);
  return response(line(t('👤 اشتراک‌های من','👤 My subscriptions',e.locale),
    ...rows.map(x=>x.id.slice(0,8)+'… | '+x.state+' | '+new Date(x.expires_at).toISOString().slice(0,10))),e.locale);
}

async function beginSupport(db,e,nowMs) {
  await db.prepare(
    "INSERT INTO customer_sessions(telegram_id,mode,expires_ms) VALUES(?,'support',?) " +
    "ON CONFLICT(telegram_id) DO UPDATE SET mode='support',expires_ms=excluded.expires_ms"
  ).bind(e.actorId,nowMs+10*60*1000).run();
  return response(t('💬 موضوع مشکل خود را در یک پیام بنویسید؛ تا ۱۰ دقیقه امکان ثبت تیکت دارید. اطلاعات کارت یا رمز نفرستید.',
    '💬 Send a short support issue within 10 minutes. Never send passwords or card details.',e.locale),e.locale);
}

async function maybeRecordSupport(db,e,nowMs) {
  if (!e.inputText || e.inputText.startsWith('/') || e.inputText.startsWith('v2:')) return null;
  const s=await db.prepare('SELECT mode,expires_ms FROM customer_sessions WHERE telegram_id=?').bind(e.actorId).first();
  if (!s || s.mode!=='support' || s.expires_ms<nowMs) return null;
  const subject=e.inputText.trim().slice(0,140);
  if (!subject) return response(t('پیام خالی است.','The message is empty.',e.locale),e.locale);
  const ticketId='tg-'+e.updateId;
  await db.batch([
    db.prepare('INSERT OR IGNORE INTO support_tickets(id,customer_telegram_id,subject) VALUES(?,?,?)')
      .bind(ticketId,e.actorId,subject),
    db.prepare('DELETE FROM customer_sessions WHERE telegram_id=?').bind(e.actorId),
  ]);
  return response(t('✅ درخواست پشتیبانی ثبت شد: ','✅ Support ticket created: ',e.locale)+ticketId,e.locale);
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
  if (!queue.length) return response(t('✅ رسیدی در صف بررسی نیست.','✅ No receipts awaiting review.',e.locale),e.locale);
  return response(line(t('🧑‍💼 رسیدهای در انتظار بررسی','🧑‍💼 Pending receipts',e.locale),
    ...queue.map(x=>x.id.slice(0,8)+'… · '+money(x.quoted_amount,x.quoted_currency)+' · '+x.customer_telegram_id)),
    e.locale, queue.map(x=>[
      {text:'👁 '+x.id.slice(0,8),callback_data:'v2:admin:receipt:'+x.id},
      {text:'✅ '+x.id.slice(0,8),callback_data:'v2:approve:'+x.id},
      {text:'❌ '+x.id.slice(0,8),callback_data:'v2:reject:'+x.id},
    ]));
}

async function adminReceipt(db,e,id) {
  if (!ORDER_ID.test(id)) return response('Invalid order ID',e.locale);
  const receipt=await db.prepare(
    "SELECT r.telegram_file_id,o.id,o.state,o.quoted_amount,o.quoted_currency " +
    "FROM receipts r JOIN orders o ON o.id=r.order_id WHERE o.id=? AND r.state='pending' " +
    "AND o.state='receipt_submitted' LIMIT 1"
  ).bind(id).first();
  if (!receipt) return response('Receipt not available for review',e.locale);
  return {
    text:'Receipt for order ' + id + '\nAmount: ' +
      money(receipt.quoted_amount,receipt.quoted_currency) + '\nReview the image before approval.',
    photoId:receipt.telegram_file_id,
    replyMarkup:{inline_keyboard:[
      [{text:'✅ Approve',callback_data:'v2:approve:'+id},
       {text:'❌ Reject',callback_data:'v2:reject:'+id}],
      ...botMenu(e.locale).inline_keyboard,
    ]},
  };
}

async function adminDecision(db,e,action,id) {
  if (!ORDER_ID.test(id)) return response('Invalid order ID',e.locale);
  const desired=action==='approve'?'approved':'rejected';
  const old=await db.prepare(
    "SELECT id,customer_telegram_id,state FROM orders WHERE id=?"
  ).bind(id).first();
  if (!old) return response('Order not found',e.locale);
  if (old.state===desired) return response('Already reviewed: '+id,e.locale);
  if (old.state!=='receipt_submitted') return response('Not reviewable: '+old.state,e.locale);
  // One atomic transaction covers the state, receipt decision, audit event
  // and customer notification. If any part fails, the whole batch rolls back.
  const idKey='review:'+id;
  const message=action==='approve'
    ? '✅ رسید سفارش '+id+' تأیید شد. صدور کانفیگ پس از آماده‌سازی و تأیید سرور انجام می‌شود.'
    : '❌ رسید سفارش '+id+' تأیید نشد. از پشتیبانی پیگیری کنید.';
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
  if (results[0]?.meta?.changes!==1) return response('Order changed; refresh review queue.',e.locale);
  return response('Recorded '+action+' for '+id+'. No configuration issued.',e.locale);
}

async function supportInbox(db,e) {
  const queue=(await db.prepare(
    "SELECT id,customer_telegram_id,subject,state FROM support_tickets " +
    "WHERE state IN ('open','waiting') ORDER BY created_at LIMIT 8"
  ).all()).results??[];
  if (!queue.length) return response('✅ No open support tickets',e.locale);
  return response(line('💬 Support inbox',...queue.map(x=>
    x.id+' / '+x.customer_telegram_id+' / '+x.subject.slice(0,80)+' / '+x.state)),
    e.locale,queue.map(x=>[
      {text:'✉ Reply '+x.id.slice(0,8),callback_data:'v2:ticket:reply:'+x.id},
      {text:'✓ Close',callback_data:'v2:ticket:close:'+x.id},
    ]));
}

async function staffCanReply(db,e,env) {
  return adminAllowed(env.ADMIN_TELEGRAM_IDS,e.actorId) || await isStaff(db,e,'support');
}

async function startTicketReply(db,e,id,nowMs) {
  const ticket=await db.prepare(
    "SELECT id,customer_telegram_id,subject,state FROM support_tickets WHERE id=?"
  ).bind(id).first();
  if (!ticket || ticket.state==='closed') return response('Ticket unavailable',e.locale);
  await db.prepare(
    "INSERT INTO support_staff_sessions(telegram_id,ticket_id,expires_ms) VALUES(?,?,?) " +
    "ON CONFLICT(telegram_id) DO UPDATE SET ticket_id=excluded.ticket_id,expires_ms=excluded.expires_ms"
  ).bind(e.actorId,id,nowMs+10*60*1000).run();
  return response('✉ Reply to '+id+'\n'+ticket.subject.slice(0,140)+
    '\n\nSend one message within 10 minutes. Never request passwords or secret keys.',e.locale);
}

async function staffReply(db,e,env,nowMs) {
  const text=e.inputText;
  if(typeof text!=='string' || !text.trim() || text.startsWith('/') ||
     text.startsWith('v2:') || !await staffCanReply(db,e,env)) return null;
  const session=await db.prepare(
    'SELECT ticket_id,expires_ms FROM support_staff_sessions WHERE telegram_id=?'
  ).bind(e.actorId).first();
  if(!session || session.expires_ms<nowMs) return null;
  const ticket=await db.prepare(
    "SELECT id,customer_telegram_id,state FROM support_tickets WHERE id=?"
  ).bind(session.ticket_id).first();
  if (!ticket || ticket.state==='closed') {
    await db.prepare('DELETE FROM support_staff_sessions WHERE telegram_id=?')
      .bind(e.actorId).run();
    return response('Ticket closed; no message sent.',e.locale);
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
  return response('✅ Reply queued for '+ticket.id,e.locale);
}

async function closeSupport(db,e,id,nowMs) {
  const ticket=await db.prepare(
    'SELECT id,state,customer_telegram_id FROM support_tickets WHERE id=?'
  ).bind(id).first();
  if (!ticket) return response('Ticket not found',e.locale);
  if (ticket.state==='closed') return response('Ticket already closed',e.locale);
  await db.batch([
    db.prepare(
      "UPDATE support_tickets SET state='closed' WHERE id=? AND state IN ('open','waiting')"
    ).bind(id),
    db.prepare(
      "INSERT OR IGNORE INTO telegram_notifications(id,chat_id,body,state,due_ms) " +
      "VALUES(?,?,?,'pending',?)"
    ).bind('support:closed:'+id,ticket.customer_telegram_id,
      '✅ درخواست پشتیبانی '+id+' بسته شد. در صورت نیاز درخواست جدید ثبت کنید.',nowMs),
    db.prepare(
      'INSERT OR IGNORE INTO audit_events(event_id,actor_id,object_type,object_id,verb) VALUES(?,?,?,?,?)'
    ).bind('support:close:'+id,e.actorId,'support_ticket',id,'close'),
  ]);
  return response('✅ Ticket closed: '+id,e.locale);
}

/** The caller must already validate the Telegram webhook and sender identity. */
export async function resolveBotAction(env,e,nowMs=Date.now()) {
  const db=env.DB;
  if (!db || !e || !/^\d+$/.test(e.actorId??'')) throw new Error('invalid_event');
  await upsertCustomer(db,e);
  if (!await isCustomerActive(db,e.actorId))
    return response(t('حساب شما تعلیق شده است. از پشتیبانی پیگیری کنید.',
      'Account suspended. Contact support.',e.locale),e.locale);

  const key=e.key??'';
  if (e.photoId) return storeReceipt(db,e,env);
  if (key==='/start') {
    const referral=await linkSellerOnStart(db,e,nowMs);
    const home=botPage('home',e.locale);
    return referral?{...home,text:home.text+'\n\n'+referral}:home;
  }
  if (key==='admin:node:new' || key==='admin:node:cancel') {
    if(!adminAllowed(env.ADMIN_TELEGRAM_IDS,e.actorId))
      return response('Access denied',e.locale);
    const panel=key==='admin:node:new'
      ? await beginNodeWizard(db,e.actorId,nowMs)
      : await cancelNodeWizard(db,e.actorId);
    return response(panel.text,e.locale,panel.replyMarkup?.inline_keyboard??[]);
  }
  if(adminAllowed(env.ADMIN_TELEGRAM_IDS,e.actorId)) {
    const wizard=await consumeNodeWizard(db,e.actorId,e.inputText,nowMs);
    if(wizard)return response(wizard.text,e.locale);
  }
  const sellerAction=await handleSeller(env,e,nowMs);
  if (sellerAction) return sellerAction;
  if (key==='/seller_grant' || key==='/support_grant') {
    if (!adminAllowed(env.ADMIN_TELEGRAM_IDS,e.actorId)) return response('Access denied',e.locale);
    const id=e.inputText?.trim().split(/\s+/)[1]??'';
    const role=key==='/seller_grant'?'seller':'support';
    if(!await grantStaffRole(db,e,role,id)) return response('Use '+key+' <telegram numeric ID>',e.locale);
    return response('Role '+role+' granted to '+id,e.locale);
  }
  if (key==='/admin') {
    if(!adminAllowed(env.ADMIN_TELEGRAM_IDS,e.actorId)) return response('Access denied',e.locale);
    return response('🧑‍💼 Admin · Madar V2\n\nActions require authorization and are audited.',e.locale,[
      [{text:'🧾 Pending receipts',callback_data:'v2:admin:queue'}],
      [{text:'💬 Support inbox',callback_data:'v2:admin:tickets'}],
      [{text:'🛍 Plans',callback_data:'v2:admin:plans'}],
      [{text:'🖥 Nodes',callback_data:'v2:admin:nodes'}],
      [{text:'➕ افزودن سرور',callback_data:'v2:admin:node:new'}],
    ]);
  }
  if (key==='admin:plans') {
    if(!adminAllowed(env.ADMIN_TELEGRAM_IDS,e.actorId)) return response('Access denied',e.locale);
    const plans=(await db.prepare('SELECT id,title_fa,active,price_amount,price_currency FROM plans ORDER BY id LIMIT 12').all()).results??[];
    return response(line('🛍 Plans',...plans.map(x=>x.id+' · '+x.title_fa+' · '+(x.active?'active':'disabled')+' · '+money(x.price_amount,x.price_currency)),
      'Use /plan_add id|نام|English|price|IRT|quotaGB|days to create a disabled plan.'),e.locale,
      plans.map(x=>[{text:(x.active?'🔴 Disable ':'🟢 Enable ')+x.id,
        callback_data:'v2:plan:'+(x.active?'off:':'on:')+x.id}]));
  }
  if (key==='/node_add' || key==='/node_route' || key==='/nodes' || key==='admin:nodes') {
    if(!adminAllowed(env.ADMIN_TELEGRAM_IDS,e.actorId))
      return response('Access denied',e.locale);
    const panel=await nodeAdminAction(db,e.actorId,key==='admin:nodes'?'/nodes':key,e.inputText);
    if(key==='admin:nodes')return response(panel.text,e.locale,[
      [{text:'➕ افزودن سرور',callback_data:'v2:admin:node:new'}],
    ]);
    return panel;
  }
  if (key==='/plan_add') {
    if(!adminAllowed(env.ADMIN_TELEGRAM_IDS,e.actorId)) return response('Access denied',e.locale);
    const raw=(e.inputText??'').replace(/^\/plan_add\s*/,'').trim();
    const parts=raw.split('|').map(x=>x.trim());
    if(parts.length!==7) return response('Format: /plan_add id|فارسی|English|price|IRT|quotaGB|days',e.locale);
    const [id,fa,en,priceRaw,currency,gbRaw,daysRaw]=parts;
    const numeric=/^(0|[1-9]\d*)$/;
    if(!PLAN_ID.test(id)||!fa||!en||fa.length>64||en.length>64||
      !numeric.test(priceRaw)||!numeric.test(gbRaw)||!numeric.test(daysRaw)||
      !['IRT','IRR','USD'].includes(currency))
      return response('Invalid plan fields; no changes made.',e.locale);
    const price=Number(priceRaw),gb=Number(gbRaw),days=Number(daysRaw);
    if(!Number.isSafeInteger(price)||price>100000000000||gb<1||gb>2000||days<1||days>366)
      return response('Plan price/quota/duration outside safe bounds.',e.locale);
    const result=await db.batch([
      db.prepare('INSERT OR IGNORE INTO plans(id,title_fa,title_en,price_amount,price_currency,quota_bytes,duration_days,active) VALUES(?,?,?,?,?,?,?,0)')
        .bind(id,fa,en,price,currency,gb*1073741824,days),
      db.prepare('INSERT OR IGNORE INTO audit_events(event_id,actor_id,object_type,object_id,verb) VALUES(?,?,?,?,?)')
        .bind('plan:create:'+id,e.actorId,'plan',id,'create:disabled'),
    ]);
    return response(result[0]?.meta?.changes===1?'Plan created, disabled by default.':'Plan already exists; unchanged.',e.locale);
  }
  if (key.startsWith('plan:on:') || key.startsWith('plan:off:')) {
    if(!adminAllowed(env.ADMIN_TELEGRAM_IDS,e.actorId)) return response('Access denied',e.locale);
    const [,mode,id]=key.split(':');
    if(!PLAN_ID.test(id)) return response('Invalid plan ID',e.locale);
    const plan=await db.prepare('SELECT * FROM plans WHERE id=?').bind(id).first();
    if(!plan) return response('Plan not found',e.locale);
    if(mode==='on' && (!salesConfigured(env)||!await availableForSale(db,plan,nowMs)))
      return response('Cannot enable plan: provisioning, payments, or verified capacity not ready.',e.locale);
    await db.batch([
      db.prepare('UPDATE plans SET active=? WHERE id=?').bind(mode==='on'?1:0,id),
      db.prepare('INSERT OR IGNORE INTO audit_events(event_id,actor_id,object_type,object_id,verb) VALUES(?,?,?,?,?)')
        .bind('plan:toggle:'+e.updateId,e.actorId,'plan',id,'toggle:'+mode),
    ]);
    return response('Plan '+id+' is now '+(mode==='on'?'active':'disabled'),e.locale);
  }
  if (key==='home') return botPage('home',e.locale);
  if (key==='plans' || key==='/plans') return listPlans(db,env,e.locale,nowMs);
  if (key==='my' || key==='/my') return mySubscriptions(db,e);
  if (key==='orders' || key==='/orders') return myOrders(db,e);
  if (key==='status' || key==='/status') return botPage('status',e.locale);
  if (key==='privacy' || key==='/privacy') return botPage('privacy',e.locale);
  if (key==='help' || key==='/help') return botPage('help',e.locale);
  if (key==='support' || key==='/support') return beginSupport(db,e,nowMs);
  if (key.startsWith('buy:')) return purchase(db,env,e,key.slice(4),nowMs);
  if (key==='admin:queue') {
    if (!adminAllowed(env.ADMIN_TELEGRAM_IDS,e.actorId)) return response('Access denied',e.locale);
    return adminQueue(db,e);
  }
  if (key.startsWith('admin:receipt:')) {
    if (!adminAllowed(env.ADMIN_TELEGRAM_IDS,e.actorId)) return response('Access denied',e.locale);
    return adminReceipt(db,e,key.slice('admin:receipt:'.length));
  }
  if (key==='admin:tickets') {
    if (!adminAllowed(env.ADMIN_TELEGRAM_IDS,e.actorId) &&
      !await isStaff(db,e,'support')) return response('Access denied',e.locale);
    return supportInbox(db,e);
  }
  if (key.startsWith('ticket:reply:') || key.startsWith('ticket:close:')) {
    if(!await staffCanReply(db,e,env)) return response('Access denied',e.locale);
    const action=key.startsWith('ticket:reply:')?'reply':'close';
    const id=key.slice(action==='reply'?'ticket:reply:'.length:'ticket:close:'.length);
    if(!/^tg-[0-9]{1,20}$/.test(id)) return response('Invalid ticket ID',e.locale);
    return action==='reply' ? startTicketReply(db,e,id,nowMs) : closeSupport(db,e,id,nowMs);
  }
  if (key.startsWith('approve:') || key.startsWith('reject:')) {
    if (!adminAllowed(env.ADMIN_TELEGRAM_IDS,e.actorId)) return response('Access denied',e.locale);
    const [action,id]=key.split(':');
    return adminDecision(db,e,action,id);
  }
  const reply=await staffReply(db,e,env,nowMs);
  if(reply) return reply;
  const support=await maybeRecordSupport(db,e,nowMs);
  return support??botPage('unknown',e.locale);
}
