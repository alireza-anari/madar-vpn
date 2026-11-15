/** V2 Telegram panels: read-only dashboards, owner-scoped ticket conversations,
 * and short-lived admin input wizards. Never enables sales or changes a VPS.
 */
import {botMenu} from './bot-ux.mjs';

const NAT=/^[0-9]{1,20}$/;
const TICKET=/^tg-[0-9]{1,20}$/;
const PLAN=/^[a-zA-Z0-9][a-zA-Z0-9_-]{1,30}$/;
const lang=(fa,en,l)=>l==='en'?en:fa;
const panel=(s,locale='fa',buttons=[])=>({
  text:String(s).slice(0,3800),
  replyMarkup:{inline_keyboard:[...buttons,...botMenu(locale).inline_keyboard]},
});
const idAdmin=(env,id)=>typeof env.ADMIN_TELEGRAM_IDS==='string'&&NAT.test(id??'')&&
  env.ADMIN_TELEGRAM_IDS.split(',').map(x=>x.trim()).includes(id);
const gb=b=>(Math.round(Number(b||0)/1073741824*100)/100).toLocaleString('en-US');
const button=(text,key)=>[{text,callback_data:'v2:'+key}];

async function count(db,sql,...args) {
  const x=await db.prepare(sql).bind(...args).first();
  return Number(x?.n??0);
}

export async function adminDashboard(env,e) {
  if(!idAdmin(env,e.actorId))return panel('Access denied',e.locale);
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
  const note=ready>0?'\n⚠️ ظرفیت نهایی باید با تأیید مسیر و سهمیه بررسی شود.':
    '\n⛔ فروش عمومی و صدور اشتراک پولی تا تأیید مسیر و سهمیه بسته می‌ماند.';
  return panel(
    lang('🛠 داشبورد مدیریت مدار V2','🛠 Madar V2 admin dashboard',e.locale)+
    '\n\n👥 '+lang('مشتریان','Customers',e.locale)+': '+customers+
    '\n🧾 '+lang('سفارش‌های باز','Open orders',e.locale)+': '+orders+
    ' ('+receipts+' '+lang('رسید','receipts',e.locale)+')'+
    '\n💬 '+lang('تیکت‌های باز','Open tickets',e.locale)+': '+tickets+
    '\n🖥 '+lang('سرورها','Nodes',e.locale)+': '+nodes+
    ' ('+installed+' '+lang('نصب‌شده','installed',e.locale)+', '+ready+' '+lang('آماده فروش','sale-ready',e.locale)+')'+
    '\n🔗 '+lang('اشتراک‌های فعال','Active subscriptions',e.locale)+': '+subs+
    (e.locale==='en'?'\nPublic sales remain safety-gated.':note),e.locale,[
      button('➕ '+lang('افزودن خودکار سرور','Add server',e.locale),'admin:node:new'),
      button('🧪 '+lang('لینک آزمایشی دو اپراتور','Trial link',e.locale),'admin:node:trials'),
      button('🖥 '+lang('سرورها','Nodes',e.locale),'admin:nodes'),
      button('🛍 '+lang('مدیریت پلن‌ها','Manage plans',e.locale),'admin:plans'),
      button('🧾 '+lang('بررسی رسیدها','Review receipts',e.locale),'admin:queue'),
      button('💬 '+lang('صندوق پشتیبانی','Support inbox',e.locale),'admin:tickets'),
      button('👥 '+lang('مشتریان','Customers',e.locale),'admin:customers'),
      button('🧑‍💼 '+lang('کارکنان و فروشندگان','Staff and sellers',e.locale),'admin:staff'),
  ]);
}

export async function customerTickets(env,e) {
  const rows=(await env.DB.prepare(
    'SELECT id,subject,state,created_at FROM support_tickets WHERE customer_telegram_id=? ORDER BY created_at DESC,id DESC LIMIT 12'
  ).bind(e.actorId).all()).results??[];
  if(!rows.length)return panel(lang('💬 هنوز تیکتی ندارید. برای درخواست جدید «پشتیبانی» را انتخاب کنید.',
    '💬 No tickets yet. Choose Support to create one.',e.locale),e.locale,
    [button('➕ '+lang('تیکت جدید','New ticket',e.locale),'support')]);
  return panel(lang('💬 درخواست‌های پشتیبانی من','💬 My support tickets',e.locale)+'\n\n'+
    rows.map(x=>x.id+' · '+x.state+' · '+x.subject.slice(0,80)).join('\n'),e.locale,[
      ...rows.map(x=>button('📨 '+x.id+' · '+x.state,'customer:ticket:'+x.id)),
      button('➕ '+lang('تیکت جدید','New ticket',e.locale),'support'),
  ]);
}

async function thread(env,e,id,ownerOnly) {
  if(!TICKET.test(id))return panel('Invalid ticket',e.locale);
  const db=env.DB;
  const ticket=await db.prepare(
    'SELECT id,customer_telegram_id,state,subject FROM support_tickets WHERE id=?'+
    (ownerOnly?' AND customer_telegram_id=?':'')
  ).bind(...(ownerOnly?[id,e.actorId]:[id])).first();
  if(!ticket)return panel(lang('تیکت پیدا نشد.','Ticket not found.',e.locale),e.locale);
  const rows=(await db.prepare(
    'SELECT role,body,created_at FROM support_messages WHERE ticket_id=? ORDER BY created_at DESC,id DESC LIMIT 8'
  ).bind(id).all()).results??[];
  const messages=rows.reverse().map(x=>
    (x.role==='customer'?lang('👤 شما','👤 Customer',e.locale):lang('🧑‍💼 پشتیبانی','🧑‍💼 Support',e.locale))+
    ': '+x.body.slice(0,600));
  const controls=ticket.state==='closed'?[button('💬 '+lang('تیکت جدید','New ticket',e.locale),'support')]:
    [button('✉️ '+lang('پاسخ به تیکت','Reply',e.locale),'customer:ticket:reply:'+id)];
  controls.push(button('📋 '+lang('تیکت‌های من','My tickets',e.locale),'customer:tickets'));
  return panel('💬 '+ticket.id+' · '+ticket.state+'\n'+ticket.subject+
    (messages.length?'\n\n'+messages.join('\n\n'):''),e.locale,controls);
}

export async function staffTicketDetails(env,e,id) {
  if(!TICKET.test(id))return panel('Invalid ticket',e.locale);
  const db=env.DB;
  const authorized=idAdmin(env,e.actorId)||!!(await db.prepare(
    "SELECT 1 AS ok FROM staff_roles sr JOIN customers c ON c.telegram_id=sr.telegram_id WHERE sr.telegram_id=? AND sr.role='support' AND c.state='active'"
  ).bind(e.actorId).first());
  if(!authorized)return panel('Access denied',e.locale);
  const ticket=await db.prepare(
    'SELECT id,customer_telegram_id,state,subject FROM support_tickets WHERE id=?'
  ).bind(id).first();
  if(!ticket)return panel('Ticket not found',e.locale);
  const messages=(await db.prepare(
    'SELECT role,body,created_at FROM support_messages WHERE ticket_id=? ORDER BY created_at DESC,id DESC LIMIT 12'
  ).bind(id).all()).results??[];
  const conversation=messages.reverse().map(x=>
    (x.role==='customer'?'👤 ':'🧑‍💼 ')+x.body.slice(0,600)).join('\n\n');
  return panel('💬 '+ticket.id+' · '+ticket.state+
    '\n'+lang('مشتری: ','Customer: ',e.locale)+ticket.customer_telegram_id+
    '\n'+ticket.subject+(conversation?'\n\n'+conversation:''),e.locale,[
      ...(ticket.state==='closed'?[]:[
        button('✉️ '+lang('پاسخ','Reply',e.locale),'ticket:reply:'+id),
        button('✅ '+lang('بستن','Close',e.locale),'ticket:close:'+id)
      ]),
      button('📋 '+lang('صندوق پشتیبانی','Support inbox',e.locale),'admin:tickets'),
  ]);
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
    if(!TICKET.test(id))return panel('Invalid ticket',e.locale);
    const row=await env.DB.prepare(
      "SELECT id FROM support_tickets WHERE id=? AND customer_telegram_id=? AND state IN ('open','waiting')"
    ).bind(id,e.actorId).first();
    if(!row)return panel(lang('این تیکت برای پاسخ باز نیست.','This ticket is not open for reply.',e.locale),e.locale);
    await startSession(env.DB,e,'ticket_reply',id,nowMs);
    return panel(lang('✉️ پاسخ خود را در یک پیام ارسال کن. مهلت: ۱۰ دقیقه. برای لغو /cancel را بفرست.',
      '✉️ Send one reply within 10 minutes. Use /cancel to cancel.',e.locale),e.locale);
  }
  if(key.startsWith('customer:ticket:'))return thread(env,e,key.slice('customer:ticket:'.length),true);
  return null;
}

export async function adminPanelAction(env,e,nowMs=Date.now()) {
  const key=e.key??'';
  if(!key.startsWith('admin:customers')&&!key.startsWith('admin:customer:')&&
     !key.startsWith('admin:staff')&&!key.startsWith('admin:plan:new'))return null;
  if(!idAdmin(env,e.actorId))return panel('Access denied',e.locale);
  const db=env.DB;
  if(key==='admin:plan:new'){
    await startSession(db,e,'plan_draft',null,nowMs);
    return panel('🛍 '+lang('پلن جدید را در یک پیام بفرست:','Send a new plan in one message:',e.locale)+
      '\n\nid|عنوان فارسی|English title|price|IRT|quotaGB|days\n'+
      'مثال: monthly|یک‌ماهه|Monthly|300000|IRT|30|30\n\n'+
      lang('پلن جدید غیرفعال ثبت می‌شود. /cancel برای لغو.','New plans remain disabled. /cancel to cancel.',e.locale),e.locale);
  }
  if(key==='admin:customers'){
    const rows=(await db.prepare(
      'SELECT telegram_id,state,locale,created_at FROM customers ORDER BY created_at DESC,telegram_id DESC LIMIT 12'
    ).all()).results??[];
    const suspended=await count(db,"SELECT COUNT(*) AS n FROM customers WHERE state='suspended'");
    return panel('👥 '+lang('مشتریان','Customers',e.locale)+'\n'+
      lang('تعلیق‌شده: ','Suspended: ',e.locale)+suspended+'\n\n'+
      (rows.map(x=>x.telegram_id+' · '+x.state+' · '+x.locale).join('\n')||'—'),e.locale,
      rows.map(x=>button('👤 '+x.telegram_id,'admin:customer:'+x.telegram_id)));
  }
  if(key.startsWith('admin:customer:')){
    const tail=key.slice('admin:customer:'.length);
    const action=tail.startsWith('suspend:')?'suspend':tail.startsWith('activate:')?'activate':null;
    const id=action?tail.slice(action.length+1):tail;
    if(!NAT.test(id))return panel('Invalid customer',e.locale);
    const row=await db.prepare('SELECT telegram_id,state,locale,seller_telegram_id FROM customers WHERE telegram_id=?')
      .bind(id).first();
    if(!row)return panel('Customer not found',e.locale);
    if(action) {
      if(idAdmin(env,id))return panel('Administrator cannot be suspended from this panel.',e.locale);
      const state=action==='suspend'?'suspended':'active';
      await db.batch([
        db.prepare('UPDATE customers SET state=? WHERE telegram_id=? AND state<>?').bind(state,id,state),
        db.prepare('INSERT OR IGNORE INTO audit_events(event_id,actor_id,object_type,object_id,verb) VALUES(?,?,?,?,?)')
          .bind('customer:state:'+e.updateId,e.actorId,'customer',id,'state:'+state),
      ]);
      return panel('✅ '+id+' · '+state,e.locale,[button('👤 '+lang('نمایش مشتری','Customer',e.locale),'admin:customer:'+id)]);
    }
    const [orders,subs,tickets]=await Promise.all([
      count(db,'SELECT COUNT(*) AS n FROM orders WHERE customer_telegram_id=?',id),
      count(db,'SELECT COUNT(*) AS n FROM subscriptions WHERE owner_telegram_id=?',id),
      count(db,'SELECT COUNT(*) AS n FROM support_tickets WHERE customer_telegram_id=?',id),
    ]);
    const buttons=[];
    if(idAdmin(env,id))buttons.push(button('🔒 '+lang('حساب مدیر','Admin account',e.locale),'admin:customers'));
    else if(row.state==='active')buttons.push(button('⛔ '+lang('تعلیق مشتری','Suspend customer',e.locale),'admin:customer:suspend:'+id));
    else buttons.push(button('✅ '+lang('فعال‌سازی مشتری','Activate customer',e.locale),'admin:customer:activate:'+id));
    buttons.push(button('👥 '+lang('بازگشت','Back',e.locale),'admin:customers'));
    return panel('👤 '+id+'\n'+row.state+' · '+row.locale+'\n'+
      lang('سفارش: ','Orders: ',e.locale)+orders+' · '+
      lang('اشتراک: ','Subscriptions: ',e.locale)+subs+' · '+
      lang('تیکت: ','Tickets: ',e.locale)+tickets+
      (row.seller_telegram_id?'\nSeller: '+row.seller_telegram_id:''),e.locale,buttons);
  }
  if(key==='admin:staff'){
    const rows=(await db.prepare(
      "SELECT sr.telegram_id,sr.role FROM staff_roles sr JOIN customers c ON c.telegram_id=sr.telegram_id WHERE sr.role IN ('seller','support') ORDER BY sr.role,sr.telegram_id LIMIT 25"
    ).all()).results??[];
    return panel('🧑‍💼 '+lang('مدیریت کارکنان و فروشندگان','Staff and sellers',e.locale)+'\n\n'+
      (rows.map(x=>x.role+' · '+x.telegram_id).join('\n')||lang('هنوز کسی ثبت نشده است.','No staff yet.',e.locale)),e.locale,[
        button('➕ '+lang('افزودن فروشنده','Add seller',e.locale),'admin:staff:grant:seller'),
        button('➕ '+lang('افزودن پشتیبان','Add support agent',e.locale),'admin:staff:grant:support'),
        button('🚫 '+lang('حذف دسترسی فروشنده','Remove seller role',e.locale),'admin:staff:revoke:seller'),
        button('🚫 '+lang('حذف دسترسی پشتیبان','Remove support role',e.locale),'admin:staff:revoke:support'),
    ]);
  }
  const m=key.match(/^admin:staff:(grant|revoke):(seller|support)$/);
  if(m){
    await startSession(db,e,m[1]+'_'+m[2],null,nowMs);
    return panel(lang('🧑‍💼 شناسه عددی تلگرام را ارسال کن. مهلت ۱۰ دقیقه؛ لغو با /cancel.',
      '🧑‍💼 Send the numeric Telegram user ID within 10 minutes; /cancel to abort.',e.locale),e.locale);
  }
  return panel('Unknown staff action',e.locale);
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
      '💬 پیام تازه در تیکت '+ticketId+'\n/admin یا پنل پشتیبانی را باز کنید.',nowMs).run();
}

export async function consumePanelInput(env,e,nowMs=Date.now()) {
  const db=env.DB;
  if((e.key??'')==='/cancel') {
    const removed=await db.prepare('DELETE FROM v2_bot_input_sessions WHERE telegram_id=?')
      .bind(e.actorId).run();
    return removed.meta?.changes?panel(lang('✅ عملیات لغو شد.','✅ Cancelled.',e.locale),e.locale):null;
  }
  const raw=e.inputText;
  if(typeof raw!=='string'||!raw.trim()||raw.startsWith('/')||raw.startsWith('v2:'))return null;
  const session=await db.prepare(
    'SELECT mode,context_id,expires_ms FROM v2_bot_input_sessions WHERE telegram_id=?'
  ).bind(e.actorId).first();
  if(!session)return null;
  if(session.expires_ms<=nowMs){
    await db.prepare('DELETE FROM v2_bot_input_sessions WHERE telegram_id=?').bind(e.actorId).run();
    return panel(lang('⌛ مهلت عملیات پایان یافت. دوباره از منو شروع کن.',
      '⌛ Session expired. Start again from the menu.',e.locale),e.locale);
  }
  if(session.mode==='ticket_reply') {
    if(!TICKET.test(session.context_id??''))return panel('Invalid ticket session',e.locale);
    const ticket=await db.prepare(
      "SELECT id FROM support_tickets WHERE id=? AND customer_telegram_id=? AND state IN ('open','waiting')"
    ).bind(session.context_id,e.actorId).first();
    if(!ticket)return panel(lang('این تیکت دیگر برای پاسخ باز نیست.','Ticket is no longer open.',e.locale),e.locale);
    const message=raw.trim().slice(0,1000);
    if(!message)return panel(lang('پیام خالی است.','Message cannot be empty.',e.locale),e.locale);
    await db.batch([
      db.prepare("INSERT OR IGNORE INTO support_messages(id,ticket_id,sender_telegram_id,body,role) VALUES(?,?,?,?,'customer')")
        .bind('customer-reply:'+e.updateId,ticket.id,e.actorId,message),
      db.prepare("UPDATE support_tickets SET state='open' WHERE id=? AND state='waiting'").bind(ticket.id),
      db.prepare('DELETE FROM v2_bot_input_sessions WHERE telegram_id=?').bind(e.actorId),
    ]);
    await notifySupport(env,e,ticket.id,nowMs);
    return panel(lang('✅ پاسخ شما در تیکت ثبت شد.','✅ Your reply was saved.',e.locale),e.locale,
      [button('💬 '+ticket.id,'customer:ticket:'+ticket.id)]);
  }
  if(!idAdmin(env,e.actorId))return panel('Access denied',e.locale);
  if(session.mode==='plan_draft'){
    const parts=raw.trim().split('|').map(x=>x.trim());
    const [id,fa,en,priceText,currency,gbText,daysText]=parts;
    const numeric=/^(0|[1-9][0-9]*)$/;
    if(parts.length!==7||!PLAN.test(id??'')||!fa||!en||
       fa.length>64||en.length>64||!['IRT','IRR','USD'].includes(currency)||
       !numeric.test(priceText??'')||!numeric.test(gbText??'')||!numeric.test(daysText??'')){
      return panel('⚠️ '+lang('فرمت معتبر نیست. دوباره id|فارسی|English|price|IRT|quotaGB|days را بفرست.',
        'Invalid format. Use id|Persian|English|price|IRT|quotaGB|days.',e.locale),e.locale);
    }
    const price=Number(priceText),gbCount=Number(gbText),days=Number(daysText);
    if(!Number.isSafeInteger(price)||price>100000000000||
       !Number.isSafeInteger(gbCount)||gbCount<1||gbCount>2000||
       !Number.isSafeInteger(days)||days<1||days>366)
      return panel(lang('محدوده قیمت، حجم یا مدت معتبر نیست.','Invalid price, quota or duration.',e.locale),e.locale);
    const r=await db.prepare(
      'INSERT OR IGNORE INTO plans(id,title_fa,title_en,price_amount,price_currency,quota_bytes,duration_days,active) VALUES(?,?,?,?,?,?,?,0)'
    ).bind(id,fa,en,price,currency,gbCount*1073741824,days).run();
    await db.batch([
      db.prepare('DELETE FROM v2_bot_input_sessions WHERE telegram_id=?').bind(e.actorId),
      db.prepare('INSERT OR IGNORE INTO audit_events(event_id,actor_id,object_type,object_id,verb) VALUES(?,?,?,?,?)')
        .bind('plan:bot:'+e.updateId,e.actorId,'plan',id,'create:disabled'),
    ]);
    return panel(r.meta?.changes===1?'✅ '+lang('پلن غیرفعال ثبت شد: ','Disabled plan created: ',e.locale)+id:
      lang('این شناسه پلن قبلاً ثبت شده است؛ تغییری ایجاد نشد.','Plan already exists; no change.',e.locale),
      e.locale,[button('🛍 '+lang('بازگشت به پلن‌ها','Back to plans',e.locale),'admin:plans')]);
  }
  const match=session.mode.match(/^(grant|revoke)_(seller|support)$/);
  if(match){
    const id=raw.trim(),mode=match[1],role=match[2];
    if(!NAT.test(id))return panel(lang('فقط شناسه عددی معتبر تلگرام را وارد کن.',
      'Enter a valid numeric Telegram ID.',e.locale),e.locale);
    if(idAdmin(env,id))return panel(lang('دسترسی مدیر از این مسیر تغییر نمی‌کند.',
      'Admin access cannot be changed here.',e.locale),e.locale);
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
    return panel('✅ '+role+' · '+id+' · '+mode,e.locale,
      [button('🧑‍💼 '+lang('بازگشت','Back',e.locale),'admin:staff')]);
  }
  return null;
}
