/** پنل‌های فارسی مدیریت و مشتری در ربات مدار V2. */
import {botMenu,adminMenu,supportMenu,frameMessage,faNumber,faStatus,faRole} from './bot-ux.mjs';

const NAT=/^[0-9]{1,20}$/;
const TICKET=/^tg-[0-9]{1,20}$/;
const PLAN=/^[a-zA-Z0-9][a-zA-Z0-9_-]{1,30}$/;
const panel=(s,locale='fa',buttons=[],audience='customer')=>({
  text:frameMessage(String(s).slice(0,3300)),
  replyMarkup:{inline_keyboard:[...buttons,...(audience==='admin'?adminMenu():audience==='support'?supportMenu():botMenu()).inline_keyboard]},
});
const adminPanel=(s,buttons=[],locale='fa')=>panel(s,locale,buttons,'admin');
const supportPanel=(s,buttons=[],locale='fa')=>panel(s,locale,buttons,'support');
const idAdmin=(env,id)=>typeof env.ADMIN_TELEGRAM_IDS==='string'&&NAT.test(id??'')&&
  env.ADMIN_TELEGRAM_IDS.split(',').map(x=>x.trim()).includes(id);
const button=(text,key)=>[{text,callback_data:'v2:'+key}];

async function count(db,sql,...args) {
  const x=await db.prepare(sql).bind(...args).first();
  return Number(x?.n??0);
}

export async function adminDashboard(env,e) {
  if(!idAdmin(env,e.actorId))return adminPanel('⛔ دسترسی به این بخش مجاز نیست.',[],e.locale);
  const db=env.DB;
  const [customers,orders,receipts,tickets,nodes,installed,ready,subs]=await Promise.all([
    count(db,'SELECT COUNT(*) AS n FROM customers'),
    count(db,"SELECT COUNT(*) AS n FROM orders WHERE state IN ('pending','receipt_submitted','approved','provisioning')"),
    count(db,"SELECT COUNT(*) AS n FROM orders WHERE state='receipt_submitted'"),
    count(db,"SELECT COUNT(*) AS n FROM support_tickets WHERE state IN ('open','waiting')"),
    count(db,'SELECT COUNT(*) AS n FROM nodes'),
    count(db,"SELECT COUNT(*) AS n FROM node_bootstrap_jobs WHERE state='installed'"),
    count(db,"SELECT COUNT(*) AS n FROM nodes WHERE lifecycle='ready'"),
    count(db,"SELECT COUNT(*) AS n FROM subscriptions WHERE state='active'")
  ]);
  const body=[
    '🛠  پیشخوان مدیریت مدار',
    '━━━━━━━━━━━━━━━━━━',
    '👥 مشتریان: '+faNumber(customers),
    '🧾 سفارش‌های باز: '+faNumber(orders)+'  |  رسیدهای منتظر: '+faNumber(receipts),
    '💬 درخواست‌های باز پشتیبانی: '+faNumber(tickets),
    '🖥 سرورها: '+faNumber(nodes),
    '   ├ نصب‌شده: '+faNumber(installed),
    '   └ آماده: '+faNumber(ready),
    '🔗 اشتراک‌های فعال: '+faNumber(subs),
    '',
    ready>0
      ?'⚠️ وجود سرور آماده به‌تنهایی مجوز فروش نیست؛ آزمون مسیر و کنترل سهمیه نیز باید تأیید شود.'
      :'⛔ فروش عمومی و صدور اشتراک پولی تا تأیید مسیر و سهمیه غیرفعال است.',
    '',
    'از گزینه‌های زیر برای مدیریت بخش‌های مدار استفاده کنید.'
  ].join('\n');
  return adminPanel(body,[
    button('➕ افزودن خودکار سرور','admin:node:new'),
    button('🧪 لینک آزمایشی دو اپراتور','admin:node:trials'),
    button('🖥 مدیریت سرورها','admin:nodes'),
    button('🛍 مدیریت پلن‌ها','admin:plans'),
    button('🧾 بررسی رسیدها','admin:queue'),
    button('💬 صندوق پشتیبانی','admin:tickets'),
    button('👥 مدیریت مشتریان','admin:customers'),
    button('🧑‍💼 کارکنان و فروشندگان','admin:staff'),
  ],e.locale);
}

export async function customerTickets(env,e) {
  const rows=(await env.DB.prepare(
    'SELECT id,subject,state,created_at FROM support_tickets WHERE customer_telegram_id=? ORDER BY created_at DESC,id DESC LIMIT 12'
  ).bind(e.actorId).all()).results??[];
  if(!rows.length)return panel(
    '💬 هنوز درخواستی ثبت نکرده‌اید. برای شروع، گزینه «پشتیبانی» را انتخاب کنید.',
    e.locale,[button('➕ ثبت درخواست جدید','support')]);
  return panel(
    '💬  درخواست‌های پشتیبانی من\n━━━━━━━━━━━━━━━━━━\n'+
    rows.map(x=>'• '+x.id+'  |  '+faStatus(x.state)+'\n  '+x.subject.slice(0,80)).join('\n\n'),
    e.locale,[
      ...rows.map(x=>button('📨 '+x.id+' · '+faStatus(x.state),'customer:ticket:'+x.id)),
      button('➕ ثبت درخواست جدید','support'),
    ]);
}

async function thread(env,e,id,ownerOnly) {
  if(!TICKET.test(id))return panel('⚠️ شناسه درخواست معتبر نیست.',e.locale);
  const db=env.DB;
  const ticket=await db.prepare(
    'SELECT id,customer_telegram_id,state,subject FROM support_tickets WHERE id=?'+
    (ownerOnly?' AND customer_telegram_id=?':'')
  ).bind(...(ownerOnly?[id,e.actorId]:[id])).first();
  if(!ticket)return panel('درخواست موردنظر پیدا نشد.',e.locale);
  const rows=(await db.prepare(
    'SELECT role,body,created_at FROM support_messages WHERE ticket_id=? ORDER BY created_at DESC,id DESC LIMIT 8'
  ).bind(id).all()).results??[];
  const messages=rows.reverse().map(x=>
    (x.role==='customer'?'👤 شما':'🧑‍💼 پشتیبانی')+'\n'+x.body.slice(0,600));
  const controls=ticket.state==='closed'
    ?[button('💬 ثبت درخواست جدید','support')]
    :[button('✉️ پاسخ به این درخواست','customer:ticket:reply:'+id)];
  controls.push(button('📋 بازگشت به درخواست‌های من','customer:tickets'));
  return panel(
    '💬  گفت‌وگوی پشتیبانی\n━━━━━━━━━━━━━━━━━━\n'+
    'شناسه: '+ticket.id+'\nوضعیت: '+faStatus(ticket.state)+'\nموضوع: '+ticket.subject+
    (messages.length?'\n\n'+messages.join('\n\n──────────────\n\n'):''),
    e.locale,controls);
}

export async function staffTicketDetails(env,e,id) {
  if(!TICKET.test(id))return staffPanel('⚠️ شناسه درخواست معتبر نیست.',[],e.locale);
  const db=env.DB;
  const isAdministrator=idAdmin(env,e.actorId);
  const authorized=isAdministrator||!!(await db.prepare(
    "SELECT 1 AS ok FROM staff_roles sr JOIN customers c ON c.telegram_id=sr.telegram_id WHERE sr.telegram_id=? AND sr.role='support' AND c.state='active'"
  ).bind(e.actorId).first());
  if(!authorized)return panel('⛔ دسترسی به این بخش مجاز نیست.',e.locale);
  const staffPanel=isAdministrator?adminPanel:supportPanel;
  const ticket=await db.prepare(
    'SELECT id,customer_telegram_id,state,subject FROM support_tickets WHERE id=?'
  ).bind(id).first();
  if(!ticket)return staffPanel('درخواست موردنظر پیدا نشد.',[],e.locale);
  const messages=(await db.prepare(
    'SELECT role,body,created_at FROM support_messages WHERE ticket_id=? ORDER BY created_at DESC,id DESC LIMIT 12'
  ).bind(id).all()).results??[];
  const conversation=messages.reverse().map(x=>
    (x.role==='customer'?'👤 مشتری':'🧑‍💼 پشتیبان')+'\n'+x.body.slice(0,600)).join('\n\n──────────────\n\n');
  return staffPanel(
    '💬  جزئیات درخواست پشتیبانی\n━━━━━━━━━━━━━━━━━━\n'+
    'شناسه: '+ticket.id+'\nمشتری: '+ticket.customer_telegram_id+
    '\nوضعیت: '+faStatus(ticket.state)+'\nموضوع: '+ticket.subject+
    (conversation?'\n\n'+conversation:''),
    [
      ...(ticket.state==='closed'?[]:[
        button('✉️ پاسخ به مشتری','ticket:reply:'+id),
        button('✅ بستن درخواست','ticket:close:'+id)
      ]),
      button('📋 بازگشت به صندوق پشتیبانی','admin:tickets'),
    ],e.locale);
}

async function startSession(db,e,mode,context,nowMs) {
  await db.prepare(
    'INSERT INTO v2_bot_input_sessions(telegram_id,mode,context_id,expires_ms) VALUES(?,?,?,?) '+
    'ON CONFLICT(telegram_id) DO UPDATE SET mode=excluded.mode,context_id=excluded.context_id,expires_ms=excluded.expires_ms'
  ).bind(e.actorId,mode,context,nowMs+10*60*1000).run();
}

export async function customerTicketAction(env,e,nowMs=Date.now()) {
  const key=e.key??'';
  if(key==='customer:tickets'||key==='/tickets')return customerTickets(env,e);
  if(key.startsWith('customer:ticket:reply:')){
    const id=key.slice('customer:ticket:reply:'.length);
    if(!TICKET.test(id))return panel('⚠️ شناسه درخواست معتبر نیست.',e.locale);
    const row=await env.DB.prepare(
      "SELECT id FROM support_tickets WHERE id=? AND customer_telegram_id=? AND state IN ('open','waiting')"
    ).bind(id,e.actorId).first();
    if(!row)return panel('این درخواست برای پاسخ‌دادن باز نیست.',e.locale);
    await startSession(env.DB,e,'ticket_reply',id,nowMs);
    return panel('✉️ پاسخ خود را در یک پیام بفرستید.\nمهلت پاسخ‌گویی: ۱۰ دقیقه.\nبرای لغو، /cancel را بفرستید.',e.locale);
  }
  if(key.startsWith('customer:ticket:'))return thread(env,e,key.slice('customer:ticket:'.length),true);
  return null;
}

export async function adminPanelAction(env,e,nowMs=Date.now()) {
  const key=e.key??'';
  if(!key.startsWith('admin:customers')&&!key.startsWith('admin:customer:')&&
     !key.startsWith('admin:staff')&&!key.startsWith('admin:plan:new'))return null;
  if(!idAdmin(env,e.actorId))return adminPanel('⛔ دسترسی به این بخش مجاز نیست.',[],e.locale);
  const db=env.DB;
  if(key==='admin:plan:new'){
    await startSession(db,e,'plan_draft',null,nowMs);
    return adminPanel(
      '🛍  ساخت پلن جدید\n━━━━━━━━━━━━━━━━━━\n'+
      'اطلاعات را در یک پیام و به ترتیب زیر بفرستید:\n\n'+
      'شناسه فنی | نام پلن | قیمت به تومان | حجم به گیگابایت | مدت به روز\n\n'+
      'نمونه:\nmahane-30 | اشتراک یک‌ماهه | ۳۰۰۰۰۰ | ۳۰ | ۳۰\n\n'+
      'شناسه فنی باید کوتاه و با حروف انگلیسی باشد؛ نام پلن فارسی است.\n'+
      'پلن ابتدا غیرفعال ثبت می‌شود. برای لغو، /cancel را بفرستید.',
      [],e.locale);
  }
  if(key==='admin:customers'){
    const rows=(await db.prepare(
      'SELECT telegram_id,state,locale,created_at FROM customers ORDER BY created_at DESC,telegram_id DESC LIMIT 12'
    ).all()).results??[];
    const suspended=await count(db,"SELECT COUNT(*) AS n FROM customers WHERE state='suspended'");
    return adminPanel(
      '👥  مدیریت مشتریان\n━━━━━━━━━━━━━━━━━━\n'+
      'تعداد حساب‌های تعلیق‌شده: '+faNumber(suspended)+'\n\n'+
      (rows.map(x=>'• '+x.telegram_id+'  |  '+faStatus(x.state)).join('\n')||'هنوز مشتری‌ای ثبت نشده است.'),
      rows.map(x=>button('👤 مشاهده '+x.telegram_id,'admin:customer:'+x.telegram_id)),e.locale);
  }
  if(key.startsWith('admin:customer:')){
    const tail=key.slice('admin:customer:'.length);
    const confirmed=tail.startsWith('confirm:');
    const target=confirmed?tail.slice('confirm:'.length):tail;
    const action=target.startsWith('suspend:')?'suspend':target.startsWith('activate:')?'activate':null;
    const id=action?target.slice(action.length+1):target;
    if(!NAT.test(id))return adminPanel('⚠️ شناسه مشتری معتبر نیست.',[],e.locale);
    const row=await db.prepare('SELECT telegram_id,state,locale,seller_telegram_id FROM customers WHERE telegram_id=?')
      .bind(id).first();
    if(!row)return adminPanel('مشتری موردنظر پیدا نشد.',[],e.locale);
    if(action) {
      if(idAdmin(env,id))return adminPanel('⛔ وضعیت حساب مدیر از این بخش قابل تغییر نیست.',[],e.locale);
      if(!confirmed)return adminPanel(
        '⚠️  تأیید تغییر وضعیت مشتری\n━━━━━━━━━━━━━━━━━━\n'+
        'آیا از '+(action==='suspend'?'تعلیق':'فعال‌سازی')+' حساب '+id+' مطمئن هستید؟',
        [
          button('✅ بله، تأیید می‌کنم','admin:customer:confirm:'+action+':'+id),
          button('↩️ انصراف','admin:customer:'+id),
        ],e.locale);
      const state=action==='suspend'?'suspended':'active';
      await db.batch([
        db.prepare('UPDATE customers SET state=? WHERE telegram_id=? AND state<>?').bind(state,id,state),
        db.prepare('INSERT OR IGNORE INTO audit_events(event_id,actor_id,object_type,object_id,verb) VALUES(?,?,?,?,?)')
          .bind('customer:state:'+e.updateId,e.actorId,'customer',id,'state:'+state),
      ]);
      return adminPanel(
        '✅ وضعیت مشتری به‌روزرسانی شد.\nشناسه: '+id+'\nوضعیت جدید: '+faStatus(state),
        [button('👤 مشاهده مشتری','admin:customer:'+id)],e.locale);
    }
    const [orders,subs,tickets]=await Promise.all([
      count(db,'SELECT COUNT(*) AS n FROM orders WHERE customer_telegram_id=?',id),
      count(db,'SELECT COUNT(*) AS n FROM subscriptions WHERE owner_telegram_id=?',id),
      count(db,'SELECT COUNT(*) AS n FROM support_tickets WHERE customer_telegram_id=?',id),
    ]);
    const buttons=[];
    if(idAdmin(env,id))buttons.push(button('🔒 حساب مدیر','admin:customers'));
    else if(row.state==='active')buttons.push(button('⛔ تعلیق مشتری','admin:customer:suspend:'+id));
    else buttons.push(button('✅ فعال‌سازی مشتری','admin:customer:activate:'+id));
    buttons.push(button('👥 بازگشت به فهرست مشتریان','admin:customers'));
    return adminPanel(
      '👤  پرونده مشتری\n━━━━━━━━━━━━━━━━━━\n'+
      'شناسه تلگرام: '+id+'\nوضعیت حساب: '+faStatus(row.state)+'\n'+
      'سفارش‌ها: '+faNumber(orders)+'  |  اشتراک‌ها: '+faNumber(subs)+
      '  |  درخواست‌ها: '+faNumber(tickets)+
      (row.seller_telegram_id?'\nشناسه فروشنده: '+row.seller_telegram_id:''),
      buttons,e.locale);
  }
  if(key==='admin:staff'){
    const rows=(await db.prepare(
      "SELECT sr.telegram_id,sr.role FROM staff_roles sr JOIN customers c ON c.telegram_id=sr.telegram_id WHERE sr.role IN ('seller','support') ORDER BY sr.role,sr.telegram_id LIMIT 25"
    ).all()).results??[];
    return adminPanel(
      '🧑‍💼  مدیریت کارکنان\n━━━━━━━━━━━━━━━━━━\n'+
      (rows.map(x=>'• '+faRole(x.role)+'  |  '+x.telegram_id).join('\n')||'هنوز همکار یا فروشنده‌ای ثبت نشده است.'),
      [
        button('➕ افزودن فروشنده','admin:staff:grant:seller'),
        button('➕ افزودن پشتیبان','admin:staff:grant:support'),
        button('🚫 حذف دسترسی فروشنده','admin:staff:revoke:seller'),
        button('🚫 حذف دسترسی پشتیبان','admin:staff:revoke:support'),
      ],e.locale);
  }
  const m=key.match(/^admin:staff:(grant|revoke):(seller|support)$/);
  if(m){
    await startSession(db,e,m[1]+'_'+m[2],null,nowMs);
    return adminPanel(
      '🧑‍💼  '+(m[1]==='grant'?'افزودن همکار':'حذف دسترسی همکار')+'\n'+
      'شناسه عددی تلگرام فرد را ارسال کنید.\nمهلت انجام: ۱۰ دقیقه.\nبرای لغو، /cancel را بفرستید.',
      [],e.locale);
  }
  return adminPanel('این گزینه در دسترس نیست.',[],e.locale);
}

export async function adminPlanNewButton(db,e,nowMs) {
  await startSession(db,e,'plan_draft',null,nowMs);
}

export async function notifySupport(env,e,ticketId,nowMs=Date.now()) {
  const db=env.DB;
  const recipients=new Set((env.ADMIN_TELEGRAM_IDS??'').split(',').map(x=>x.trim()).filter(x=>NAT.test(x)&&x!==e.actorId));
  const staff=(await db.prepare(
    "SELECT sr.telegram_id FROM staff_roles sr JOIN customers c ON c.telegram_id=sr.telegram_id WHERE sr.role='support' AND c.state='active' LIMIT 20"
  ).all()).results??[];
  for(const s of staff){if(NAT.test(s.telegram_id)&&s.telegram_id!==e.actorId)recipients.add(s.telegram_id);}
  for(const id of recipients)await db.prepare(
    "INSERT OR IGNORE INTO telegram_notifications(id,chat_id,body,state,due_ms) VALUES(?,?,?,'pending',?)"
  ).bind('ticket:'+ticketId+':'+e.updateId+':'+id,id,
      '💬 درخواست تازه پشتیبانی\nشناسه: '+ticketId+'\nبرای مشاهده و پاسخ، صندوق پشتیبانی را در ربات باز کنید.',nowMs).run();
}

export async function consumePanelInput(env,e,nowMs=Date.now()) {
  const db=env.DB;
  if((e.key??'')==='/cancel') {
    const removed=await db.prepare('DELETE FROM v2_bot_input_sessions WHERE telegram_id=?')
      .bind(e.actorId).run();
    return removed.meta?.changes?panel('✅ عملیات لغو شد.',e.locale):null;
  }
  const raw=e.inputText;
  if(typeof raw!=='string'||!raw.trim()||raw.startsWith('/')||raw.startsWith('v2:'))return null;
  const session=await db.prepare(
    'SELECT mode,context_id,expires_ms FROM v2_bot_input_sessions WHERE telegram_id=?'
  ).bind(e.actorId).first();
  if(!session)return null;
  if(session.expires_ms<=nowMs){
    await db.prepare('DELETE FROM v2_bot_input_sessions WHERE telegram_id=?').bind(e.actorId).run();
    return panel('⌛ مهلت عملیات پایان یافت. دوباره از منوی مربوط شروع کنید.',e.locale);
  }
  if(session.mode==='ticket_reply') {
    if(!TICKET.test(session.context_id??''))return panel('⚠️ نشست پاسخ‌گویی معتبر نیست.',e.locale);
    const ticket=await db.prepare(
      "SELECT id FROM support_tickets WHERE id=? AND customer_telegram_id=? AND state IN ('open','waiting')"
    ).bind(session.context_id,e.actorId).first();
    if(!ticket)return panel('این درخواست دیگر برای پاسخ‌دادن باز نیست.',e.locale);
    const message=raw.trim().slice(0,1000);
    if(!message)return panel('پیام نمی‌تواند خالی باشد.',e.locale);
    await db.batch([
      db.prepare("INSERT OR IGNORE INTO support_messages(id,ticket_id,sender_telegram_id,body,role) VALUES(?,?,?,?,'customer')")
        .bind('customer-reply:'+e.updateId,ticket.id,e.actorId,message),
      db.prepare("UPDATE support_tickets SET state='open' WHERE id=? AND state='waiting'").bind(ticket.id),
      db.prepare('DELETE FROM v2_bot_input_sessions WHERE telegram_id=?').bind(e.actorId),
    ]);
    await notifySupport(env,e,ticket.id,nowMs);
    return panel('✅ پاسخ شما در درخواست پشتیبانی ثبت شد.',e.locale,
      [button('💬 مشاهده گفت‌وگو','customer:ticket:'+ticket.id)]);
  }
  if(!idAdmin(env,e.actorId))return adminPanel('⛔ دسترسی به این بخش مجاز نیست.',[],e.locale);
  if(session.mode==='plan_draft'){
    const parts=raw.trim().split('|').map(x=>x.trim());
    const [id,title,priceText,gbText,daysText]=parts;
    const numeric=/^(0|[1-9][0-9]*)$/;
    if(parts.length!==5||!PLAN.test(id??'')||!title||title.length>64||
       !numeric.test(priceText??'')||!numeric.test(gbText??'')||!numeric.test(daysText??'')){
      return adminPanel(
        '⚠️ اطلاعات پلن معتبر نیست. قالب درست را دوباره بفرستید:\n'+
        'شناسه فنی | نام پلن | قیمت تومان | حجم گیگابایت | مدت روز',
        [],e.locale);
    }
    const price=Number(priceText),gbCount=Number(gbText),days=Number(daysText);
    if(!Number.isSafeInteger(price)||price>100000000000||
       !Number.isSafeInteger(gbCount)||gbCount<1||gbCount>2000||
       !Number.isSafeInteger(days)||days<1||days>366)
      return adminPanel('⚠️ قیمت، حجم یا مدت خارج از محدوده مجاز است.',[],e.locale);
    const r=await db.prepare(
      'INSERT OR IGNORE INTO plans(id,title_fa,title_en,price_amount,price_currency,quota_bytes,duration_days,active) VALUES(?,?,?,?,?,?,?,0)'
    ).bind(id,title,title,price,'IRT',gbCount*1073741824,days).run();
    await db.batch([
      db.prepare('DELETE FROM v2_bot_input_sessions WHERE telegram_id=?').bind(e.actorId),
      db.prepare('INSERT OR IGNORE INTO audit_events(event_id,actor_id,object_type,object_id,verb) VALUES(?,?,?,?,?)')
        .bind('plan:bot:'+e.updateId,e.actorId,'plan',id,'create:disabled'),
    ]);
    return adminPanel(
      r.meta?.changes===1?'✅ پلن غیرفعال ثبت شد: '+title:
        'ℹ️ این شناسه پلن قبلاً ثبت شده است؛ تغییری ایجاد نشد.',
      [button('🛍 بازگشت به مدیریت پلن‌ها','admin:plans')],e.locale);
  }
  const match=session.mode.match(/^(grant|revoke)_(seller|support)$/);
  if(match){
    const id=raw.trim(),mode=match[1],role=match[2];
    if(!NAT.test(id))return adminPanel('⚠️ فقط شناسه عددی معتبر تلگرام را وارد کنید.',[],e.locale);
    if(idAdmin(env,id))return adminPanel('⛔ دسترسی مدیر از این مسیر تغییر نمی‌کند.',[],e.locale);
    if(mode==='grant'){
      await db.batch([
        db.prepare('INSERT OR IGNORE INTO customers(telegram_id) VALUES(?)').bind(id),
        db.prepare('INSERT OR IGNORE INTO staff_roles(telegram_id,role,granted_by) VALUES(?,?,?)')
          .bind(id,role,e.actorId),
        db.prepare('INSERT OR IGNORE INTO audit_events(event_id,actor_id,object_type,object_id,verb) VALUES(?,?,?,?,?)')
          .bind('staff:bot:'+e.updateId,e.actorId,'staff',id,'grant:'+role),
        db.prepare('DELETE FROM v2_bot_input_sessions WHERE telegram_id=?').bind(e.actorId),
      ]);
    } else {
      await db.batch([
        db.prepare('DELETE FROM staff_roles WHERE telegram_id=? AND role=?').bind(id,role),
        db.prepare('INSERT OR IGNORE INTO audit_events(event_id,actor_id,object_type,object_id,verb) VALUES(?,?,?,?,?)')
          .bind('staff:bot:'+e.updateId,e.actorId,'staff',id,'revoke:'+role),
        db.prepare('DELETE FROM v2_bot_input_sessions WHERE telegram_id=?').bind(e.actorId),
      ]);
    }
    return adminPanel(
      '✅ دسترسی '+faRole(role)+' برای شناسه '+id+' '+
      (mode==='grant'?'فعال شد.':'برداشته شد.'),
      [button('🧑‍💼 بازگشت به مدیریت کارکنان','admin:staff')],e.locale);
  }
  return null;
}
