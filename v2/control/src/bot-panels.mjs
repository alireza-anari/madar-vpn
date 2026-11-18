/** پنل‌های فارسی مدیریت و مشتری در ربات مدار V2. */
import {adminMenu,frameMessage,faNumber,faStatus,faRole,statusSymbol,sectionNavigation,shortCode,panelHeading,BRAND_BANNER_URL} from './bot-ux.mjs';
import {planWizardAction,planWizardInput} from './plan-wizard.mjs';
import {directInput} from './admin-direct.mjs';

const NAT=/^[0-9]{1,20}$/;
const TICKET=/^tg-[0-9]{1,20}$/;
const PLAN=/^[a-zA-Z0-9][a-zA-Z0-9_-]{1,30}$/;
const panel=(s,locale='fa',buttons=[],audience='customer')=>({
  text:frameMessage(String(s).slice(0,3300)),
  replyMarkup:{inline_keyboard:[...buttons,...sectionNavigation(audience)]},
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
  const salesReady=env.SHOP_ENABLED==='true'&&env.PROVISIONING_ENABLED==='true'&&
    typeof env.PAYMENT_INSTRUCTIONS==='string'&&env.PAYMENT_INSTRUCTIONS.trim().length>=12&&
    env.PAYMENT_INSTRUCTIONS.length<=700;
  // Keep this overview short. Telegram photo captions use the user's native
  // small text size; dense reports become unreadable on narrow mobile screens.
  const actionNeeded=receipts>0
    ?'🧾 '+faNumber(receipts)+' رسید در صف بررسی'
    :tickets>0
      ?'💬 '+faNumber(tickets)+' درخواست پشتیبانی باز'
      :ready===0
        ?'⚠️ سرور آماده وجود ندارد'
        :'✅ مورد فوری در صف نیست';
  const body=[
    panelHeading('📊','پیشخوان مدیریت','خلاصه وضعیت مدار'),
    '',
    '👥 مشتریان: '+faNumber(customers),
    '🔗 اشتراک فعال: '+faNumber(subs),
    '🧾 سفارش باز: '+faNumber(orders),
    '📩 رسید در انتظار: '+faNumber(receipts),
    '💬 پشتیبانی باز: '+faNumber(tickets),
    '',
    '🖥 کل سرورها: '+faNumber(nodes),
    '🛠 نصب‌شده: '+faNumber(installed),
    '✅ وضعیت آماده: '+faNumber(ready),
    '',
    '🛒 فروش عمومی: '+(salesReady?'در حال پیکربندی':'غیرفعال'),
    actionNeeded
  ].join('\n');
  return {text:frameMessage(body),photoId:BRAND_BANNER_URL,replyMarkup:{inline_keyboard:[
    [{text:'👤 مشاهده نمای مشتری',callback_data:'v2:customer:home'}],
    ...adminMenu().inline_keyboard
  ]}};
}

export async function customerTickets(env,e,page=0) {
  // Leaving the support composer with Back must not send the next free text as a ticket.
  if(Number.isSafeInteger(e.messageId)&&e.messageId>0)
    await env.DB.prepare("DELETE FROM customer_sessions WHERE telegram_id=? AND mode='support'")
      .bind(e.actorId).run();
  const pageIndex=Number.isInteger(page)&&page>=0&&page<=1000?page:0;
  const rows=(await env.DB.prepare(
    'SELECT id,subject,state,created_at FROM support_tickets WHERE customer_telegram_id=? '+
    'ORDER BY created_at DESC,id DESC LIMIT 7 OFFSET ?'
  ).bind(e.actorId,pageIndex*6).all()).results??[];
  const visible=rows.slice(0,6),next=rows.length>6;
  if(!visible.length)return panel(
    panelHeading('💬','پشتیبانی مدار','همراه شما برای حل مشکل'),
    e.locale,[button('➕ ثبت درخواست جدید','support')]);
  const controls=visible.map(x=>button(
    statusSymbol(x.state)+' '+shortCode(x.id,12)+' · '+faStatus(x.state),
    'customer:ticket:'+x.id));
  const pages=[];
  if(pageIndex>0)pages.push({text:'◀️ قبلی',callback_data:'v2:customer:tickets:'+(pageIndex-1)});
  if(next)pages.push({text:'بعدی ▶️',callback_data:'v2:customer:tickets:'+(pageIndex+1)});
  if(pages.length)controls.push(pages);
  controls.push(button('➕ درخواست جدید','support'));
  return panel(
    panelHeading('💬','درخواست‌های پشتیبانی','گفت‌وگوهای شما با تیم مدار')+
    '\nصفحه '+faNumber(pageIndex+1)+'\n\n'+
    visible.map((x,i)=>
      faNumber(pageIndex*6+i+1)+'. '+statusSymbol(x.state)+' '+faStatus(x.state)+
      '\n'+x.subject.slice(0,85)+'\nکد پیگیری: '+x.id
    ).join('\n\n──────────────\n\n'),
    e.locale,controls);
}

async function thread(env,e,id,ownerOnly,page=0) {
  if(!TICKET.test(id))return panel('⚠️ شناسه درخواست معتبر نیست.',e.locale);
  const db=env.DB;
  const ticket=await db.prepare(
    'SELECT id,customer_telegram_id,state,subject FROM support_tickets WHERE id=?'+
    (ownerOnly?' AND customer_telegram_id=?':'')
  ).bind(...(ownerOnly?[id,e.actorId]:[id])).first();
  if(!ticket)return panel('درخواست موردنظر پیدا نشد.',e.locale);
  if(ownerOnly&&Number.isSafeInteger(e.messageId)&&e.messageId>0)
    await db.prepare("DELETE FROM v2_bot_input_sessions WHERE telegram_id=? AND mode='ticket_reply'")
      .bind(e.actorId).run();
  page=Number.isSafeInteger(page)&&page>=0&&page<=1000?page:0;
  const total=(await db.prepare('SELECT COUNT(*) n FROM support_messages WHERE ticket_id=?')
    .bind(id).first())?.n??0;
  const maxPage=Math.max(0,Math.ceil(Number(total)/5)-1);
  page=Math.min(page,maxPage);
  const rows=(await db.prepare(
    'SELECT id,role,body,telegram_file_id FROM support_messages WHERE ticket_id=? ORDER BY created_at DESC,id DESC LIMIT 5 OFFSET ?'
  ).bind(id,page*5).all()).results??[];
  const messages=rows.reverse().map(x=>
    (x.role==='customer'?'👤 شما':'🧑‍💼 پشتیبانی')+'\n'+x.body.slice(0,350));
  const controls=ticket.state==='closed'
    ?[button('➕ ثبت درخواست جدید','support')]
    :[button('✉️ پاسخ به درخواست','customer:ticket:reply:'+id)];
  controls.push(...rows.filter(x=>x.telegram_file_id&&/^support-media:[0-9]{1,20}$/.test(x.id))
    .map(x=>button('🖼 مشاهده تصویر پیوست','customer:ticket:media:'+x.id.slice(14))));
  const nav=[];
  if(page<maxPage)nav.push({text:'◀️ قدیمی‌تر',callback_data:'v2:customer:ticket:page:'+id+':'+(page+1)});
  if(page>0)nav.push({text:'جدیدتر ▶️',callback_data:'v2:customer:ticket:page:'+id+':'+(page-1)});
  if(nav.length)controls.push(nav);
  controls.push(button('📋 بازگشت به درخواست‌ها','customer:tickets'));
  return panel(
    panelHeading('💬','گفت‌وگوی پشتیبانی',ticket.subject.slice(0,90))+
    '\nکد پیگیری: '+ticket.id+'\nوضعیت: '+statusSymbol(ticket.state)+' '+faStatus(ticket.state)+
    '\n📜 پیام‌ها · صفحه '+faNumber(page+1)+' از '+faNumber(maxPage+1)+
    (messages.length?'\n\n'+messages.join('\n\n──────────\n\n'):'\n\nهنوز پیامی ثبت نشده است.'),
    e.locale,controls);
}

export async function staffTicketDetails(env,e,id,page=0) {
  if(!TICKET.test(id))return panel('⚠️ شناسه درخواست معتبر نیست.',e.locale);
  const db=env.DB;
  const isAdministrator=idAdmin(env,e.actorId);
  const authorized=isAdministrator||!!(await db.prepare(
    "SELECT 1 AS ok FROM staff_roles sr JOIN customers c ON c.telegram_id=sr.telegram_id WHERE sr.telegram_id=? AND sr.role='support' AND c.state='active'"
  ).bind(e.actorId).first());
  if(!authorized)return panel('⛔ دسترسی به این بخش مجاز نیست.',e.locale);
  if(Number.isSafeInteger(e.messageId)&&e.messageId>0)
    await db.prepare("DELETE FROM support_staff_sessions WHERE telegram_id=?")
      .bind(e.actorId).run();
  const staffPanel=isAdministrator?adminPanel:supportPanel;
  const ticket=await db.prepare(
    'SELECT id,customer_telegram_id,state,subject FROM support_tickets WHERE id=?'
  ).bind(id).first();
  if(!ticket)return staffPanel('درخواست موردنظر پیدا نشد.',[],e.locale);
  page=Number.isSafeInteger(page)&&page>=0&&page<=1000?page:0;
  const total=(await db.prepare('SELECT COUNT(*) n FROM support_messages WHERE ticket_id=?')
    .bind(id).first())?.n??0;
  const maxPage=Math.max(0,Math.ceil(Number(total)/5)-1);
  page=Math.min(page,maxPage);
  const messages=(await db.prepare(
    'SELECT id,role,body,telegram_file_id FROM support_messages WHERE ticket_id=? ORDER BY created_at DESC,id DESC LIMIT 5 OFFSET ?'
  ).bind(id,page*5).all()).results??[];
  const conversation=messages.reverse().map(x=>
    (x.role==='customer'?'👤 مشتری':'🧑‍💼 پشتیبان')+'\n'+x.body.slice(0,350)).join('\n\n──────────\n\n');
  const navigation=[];
  if(page<maxPage)navigation.push({text:'◀️ قدیمی‌تر',callback_data:'v2:ticket:page:'+id+':'+(page+1)});
  if(page>0)navigation.push({text:'جدیدتر ▶️',callback_data:'v2:ticket:page:'+id+':'+(page-1)});
  return staffPanel(
    panelHeading('💬','جزئیات درخواست',ticket.subject.slice(0,90))+
    '\nکد پیگیری: '+ticket.id+'\nشناسه مشتری: '+ticket.customer_telegram_id+
    '\nوضعیت: '+statusSymbol(ticket.state)+' '+faStatus(ticket.state)+
    '\n📜 پیام‌ها · صفحه '+faNumber(page+1)+' از '+faNumber(maxPage+1)+
    (conversation?'\n\n'+conversation:'\n\nهنوز پیامی ثبت نشده است.'),
    [
      ...(ticket.state==='closed'
        ?[]
        :[
          button('✉️ پاسخ به مشتری','ticket:reply:'+id),
          button('🔒 بستن درخواست','ticket:confirm-close:'+id),
        ]),
      ...messages.filter(x=>x.telegram_file_id&&/^support-media:[0-9]{1,20}$/.test(x.id))
        .map(x=>button('🖼 مشاهده تصویر پیوست','ticket:media:'+x.id.slice(14))),
      ...(navigation.length?[navigation]:[]),
      button('📋 بازگشت به صندوق','admin:tickets'),
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
  const threadPage=key.match(/^customer:ticket:page:(tg-[0-9]{1,20}):([0-9]{1,4})$/);
  if(threadPage)return thread(env,e,threadPage[1],true,Number(threadPage[2]));
  if(/^customer:tickets:[0-9]{1,4}$/.test(key))
    return customerTickets(env,e,Number(key.slice('customer:tickets:'.length)));
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
     !key.startsWith('admin:staff')&&
     !['admin:plan:new','admin:plan:back','admin:plan:cancel','admin:plan:save'].includes(key))
    return null;
  if(!idAdmin(env,e.actorId))return adminPanel('⛔ دسترسی به این بخش مجاز نیست.',[],e.locale);
  const db=env.DB;
  if(['admin:plan:new','admin:plan:back','admin:plan:cancel','admin:plan:save'].includes(key))
    return planWizardAction(db,e,nowMs);
  if(key==='admin:customers'||/^admin:customers:[0-9]{1,4}$/.test(key)){
    const page=key==='admin:customers'?0:Math.min(1000,Number(key.slice('admin:customers:'.length)));
    const rows=(await db.prepare(
      'SELECT telegram_id,state,locale,created_at FROM customers ORDER BY created_at DESC,telegram_id DESC LIMIT 7 OFFSET ?'
    ).bind(page*6).all()).results??[];
    const shown=rows.slice(0,6);
    const suspended=await count(db,"SELECT COUNT(*) AS n FROM customers WHERE state='suspended'");
    const controls=shown.map(x=>button('👤 '+x.telegram_id+' · '+faStatus(x.state),'admin:customer:'+x.telegram_id));
    const pages=[];
    if(page>0)pages.push({text:'◀️ قبلی',callback_data:'v2:admin:customers:'+(page-1)});
    if(rows.length>6)pages.push({text:'بعدی ▶️',callback_data:'v2:admin:customers:'+(page+1)});
    if(pages.length)controls.push(pages);
    return adminPanel(
      '👥  مدیریت مشتریان\n━━━━━━━━━━━━━━━━━━\n'+
      'صفحه '+faNumber(page+1)+'  |  حساب‌های تعلیق‌شده: '+faNumber(suspended)+'\n'+
      'برای مشاهده جزئیات، یک مشتری را انتخاب کنید.\n\n'+
      (shown.map(x=>statusSymbol(x.state)+' '+x.telegram_id+'  ·  '+faStatus(x.state)).join('\n')||
        'در این صفحه مشتری‌ای وجود ندارد.'),
      controls,e.locale);
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
    if(Number.isSafeInteger(e.messageId)&&e.messageId>0)
      await db.prepare("DELETE FROM v2_bot_input_sessions WHERE telegram_id=? AND mode IN ('grant_seller','grant_support','revoke_seller','revoke_support')")
        .bind(e.actorId).run();
    const rows=(await db.prepare(
      "SELECT sr.telegram_id,sr.role FROM staff_roles sr JOIN customers c ON c.telegram_id=sr.telegram_id WHERE sr.role IN ('seller','support') ORDER BY sr.role,sr.telegram_id LIMIT 25"
    ).all()).results??[];
    return adminPanel(
      '🧑‍💼  دسترسی همکاران\n━━━━━━━━━━━━━━━━━━\n'+
      'نقش هر همکار را از فهرست زیر بررسی و مدیریت کنید.\n\n'+
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
  return planWizardAction(db,e,nowMs);
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
    const [removed,direct]=await db.batch([
      db.prepare('DELETE FROM v2_bot_input_sessions WHERE telegram_id=?').bind(e.actorId),
      db.prepare('DELETE FROM admin_direct_drafts WHERE telegram_id=?').bind(e.actorId),
    ]);
    return (removed.meta?.changes||direct.meta?.changes)?
      panel('✅ عملیات لغو شد.',e.locale):null;
  }
  const raw=e.inputText;
  if(typeof raw!=='string'||!raw.trim()||raw.startsWith('/')||raw.startsWith('v2:'))return null;
  const session=await db.prepare(
    'SELECT mode,context_id,expires_ms FROM v2_bot_input_sessions WHERE telegram_id=?'
  ).bind(e.actorId).first();
  if(!session){
    if(!idAdmin(env,e.actorId))return null;
    const draft=await db.prepare(
      'SELECT context_id,expires_ms FROM admin_direct_drafts WHERE telegram_id=?'
    ).bind(e.actorId).first();
    if(!draft)return null;
    if(draft.expires_ms<=nowMs){
      await db.prepare('DELETE FROM admin_direct_drafts WHERE telegram_id=?')
        .bind(e.actorId).run();
      return panel('⌛ مهلت صدور کانفیگ پایان یافت؛ از ابتدا شروع کنید.',e.locale);
    }
    return directInput(env,e,draft,nowMs);
  }
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
  if(session.mode==='plan_draft')return planWizardInput(db,e,session,nowMs);
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
