/** V2 administrative direct issuance (legacy UX, new fail-closed runtime).
 * Name -> ready node -> GiB -> days -> explicit confirmation.
 * Real Xray client ACK, never admin input, activates pending account.
 * No payment, seller permission, arbitrary unverified node or store changes.
 */
import {nodeUiRef,nodeFromRef} from './node-admin.mjs';
import {reserveApprovedOrder} from './provisioning.mjs';
import {issueCarrierLink} from './carrier-subscription.mjs';
import {frameMessage,faNumber,panelHeading} from './bot-ux.mjs';

const MODE='direct_config_draft';
const TTL=15*60*1000;
const ID=/^di-[a-f0-9]{24}$/;
const REF=/^[a-f0-9]{24}$/;
const AMOUNTS=[10,30,50,100,200];
const DAYS=[7,15,30,60,90];
const MAX_GB=1000;
const validAdmin=(env,actor)=>
  env.ADMIN_DIRECT_ISSUE_ENABLED==='true'&&/^[0-9]{5,20}$/.test(actor??'')&&
  typeof env.ADMIN_TELEGRAM_IDS==='string'&&
  env.ADMIN_TELEGRAM_IDS.split(',').map(s=>s.trim()).includes(actor);
const button=(text,action)=>[{text,callback_data:'v2:admin:configs:direct:'+action}];
const panel=(text,buttons=[])=>({
  text:frameMessage(text),
  replyMarkup:{inline_keyboard:[...buttons,
    [{text:'↩️ صدور کانفیگ',callback_data:'v2:admin:configs:home'}]]},
});
const hex=n=>Array.from(crypto.getRandomValues(new Uint8Array(n)),
  x=>x.toString(16).padStart(2,'0')).join('');
function label(input){
  if(typeof input!=='string')return null;
  const trimmed=input.trim();
  if(trimmed.length<2||trimmed.length>60||
     /[\x00-\x1f\x7f<>|\u202a-\u202e\u2066-\u2069]/u.test(trimmed))
    return null;
  return trimmed;
}
function number(input,min,max){
  if(typeof input!=='string'||input.length>32)return null;
  const ascii=input.trim().replace(/[۰-۹]/g,x=>String(x.charCodeAt(0)-1776))
    .replace(/[٠-٩]/g,x=>String(x.charCodeAt(0)-1632))
    .replace(/[,\u066c\u2009\s]/g,'');
  if(!/^[1-9]\d{0,4}$/.test(ascii))return null;
  const n=Number(ascii);
  return Number.isSafeInteger(n)&&n>=min&&n<=max?n:null;
}
const orderId=id=>'do-'+id.slice(3);
const planId=(gb,days)=>'dp-'+gb+'-'+days;
function decode(row){
  if(row?.mode!==MODE||typeof row.context_id!=='string'||
     row.context_id.length>700)return null;
  try{
    const v=JSON.parse(row.context_id);
    return v.version===1&&ID.test(v.id??'')&&
      ['name','node','gb','days','review','issued'].includes(v.step)?v:null;
  }catch{return null;}
}
async function save(db,actor,v,now){
  await db.prepare(
    "INSERT INTO v2_bot_input_sessions(telegram_id,mode,context_id,expires_ms) "+
    "VALUES(?,?,?,?) ON CONFLICT(telegram_id) DO UPDATE SET "+
    "mode=excluded.mode,context_id=excluded.context_id,expires_ms=excluded.expires_ms"
  ).bind(actor,MODE,JSON.stringify(v),now+TTL).run();
}
async function load(db,actor,now){
  const row=await db.prepare(
    "SELECT mode,context_id,expires_ms FROM v2_bot_input_sessions WHERE telegram_id=?"
  ).bind(actor).first();
  if(!row||row.mode!==MODE)return null;
  if(row.expires_ms<=now){
    await clear(db,actor);
    return null;
  }
  return decode(row);
}
async function clear(db,actor){
  await db.prepare(
    "DELETE FROM v2_bot_input_sessions WHERE telegram_id=? AND mode=?"
  ).bind(actor,MODE).run();
}
async function ownReadyNode(env,actor,ref,nowMs) {
  if(!REF.test(ref??''))return null;
  const n=await nodeFromRef(env.DB,ref);
  if(!n||n.lifecycle!=='ready'||n.desired_revision!==n.acked_revision)return null;
  const row=await env.DB.prepare(
    "SELECT 1 ok FROM node_bootstrap_jobs j "+
    "JOIN node_health h ON h.node_id=j.node_id "+
    "WHERE j.node_id=? AND j.state='installed' AND j.owner_id=? "+
    "AND h.revision=? AND h.xray_healthy=1 AND h.stats_healthy=1 "+
    "AND h.observed_ms BETWEEN ? AND ?"
  ).bind(n.id,actor,n.desired_revision,nowMs-600000,nowMs).first();
  return row?n:null;
}
async function nodeButtons(env,actor,nowMs){
  const rows=(await env.DB.prepare(
    "SELECT n.id,n.user_limit,n.byte_limit FROM nodes n "+
    "JOIN node_bootstrap_jobs j ON j.node_id=n.id AND j.state='installed' "+
    "JOIN node_health h ON h.node_id=n.id AND h.revision=n.desired_revision "+
    "WHERE j.owner_id=? AND n.lifecycle='ready' AND "+
    "n.desired_revision=n.acked_revision AND h.xray_healthy=1 AND "+
    "h.stats_healthy=1 AND h.observed_ms BETWEEN ? AND ? "+
    "AND n.user_limit>(SELECT COUNT(*) FROM node_allocations a "+
    "WHERE a.node_id=n.id AND a.state IN ('reserved','active')) "+
    "ORDER BY n.id LIMIT 12"
  ).bind(actor,nowMs-600000,nowMs).all()).results??[];
  const buttons=[];
  for(const n of rows)buttons.push(button('🟢 '+n.id,'node:'+await nodeUiRef(n.id)));
  return buttons;
}
async function question(env,actor,v,nowMs,warning=''){
  const step=v.step;
  const title=step==='review'?'بررسی نهایی':step==='issued'?'صدور ثبت شد':
    'مرحله '+faNumber(['name','node','gb','days'].indexOf(step)+1)+' از ۴';
  let text='';
  const controls=[];
  if(step==='name')
    text='👤 نام یا برچسب مشتری را بنویس (۲ تا ۶۰ نویسه).\nمثال: علی رضایی';
  else if(step==='node'){
    text='🌐 سرور آمادهٔ موردنظر را انتخاب کن.\nسرور فقط یک بار هنگام نصب تأیید شده است.';
    controls.push(...await nodeButtons(env,actor,nowMs));
    if(!controls.length)text+='\n⏸ سرور آماده با سلامت تازه در دسترس نیست.';
  } else if(step==='gb'){
    text='📦 حجم اشتراک چند گیگابایت باشد؟\nاز دکمه‌ها انتخاب کن یا عدد ۱ تا ۱۰۰۰ بفرست.';
    for(const n of AMOUNTS)controls.push(button(faNumber(n)+' گیگابایت','gb:'+n));
  } else if(step==='days'){
    text='📅 مدت اعتبار چند روز باشد؟\nاز دکمه‌ها انتخاب کن یا عدد ۱ تا ۳۶۵ بفرست.';
    for(const n of DAYS)controls.push(button(faNumber(n)+' روز','days:'+n));
  } else if(step==='review'){
    text='👤 مشتری: '+v.label+'\n🌐 سرور: '+v.node_id+
      '\n📦 حجم: '+faNumber(v.gb)+' گیگابایت'+
      '\n📅 مدت: '+faNumber(v.days)+' روز'+
      '\n💳 مبلغ دریافتی در مدار: صفر (صدور دستی مدیر)'+
      '\n\nبا تأیید، UUID اختصاصی به‌صورت امن ایجاد و برای نصب خودکار به عامل سرور ارسال می‌شود.'+
      '\n🔒 لینک فقط پس از تأیید واقعی نصب توسط Xray تحویل داده خواهد شد.';
    controls.push(button('✅ تأیید و صدور کانفیگ','save'));
  }else if(step==='issued')return directStatus(env,actor,v.id,nowMs);
  if(step!=='name')controls.push(button('⬅️ مرحله قبل','back'));
  controls.push(button('❌ انصراف','cancel'));
  return panel(panelHeading('🔗','صدور کانفیگ جدید',title)+
    (warning?'\n\n⚠️ '+warning:'')+'\n\n'+text,controls);
}
async function issueRow(db,actor,id){
  if(!ID.test(id??''))return null;
  return db.prepare(
    "SELECT i.id,i.node_id,i.label,i.quota_bytes,i.duration_days,i.order_id,"+
    "o.state order_state,s.id subscription_id,s.state subscription_state,"+
    "s.expires_at,s.used_bytes,a.state allocation_state,ac.observed_ms client_ack "+
    "FROM admin_direct_issues i JOIN orders o ON o.id=i.order_id "+
    "LEFT JOIN subscriptions s ON s.order_id=o.id "+
    "LEFT JOIN node_allocations a ON a.subscription_id=s.id AND a.node_id=i.node_id "+
    "LEFT JOIN node_client_acks ac ON ac.subscription_id=s.id AND ac.node_id=i.node_id "+
    "WHERE i.id=? AND i.actor_id=? AND o.customer_telegram_id=? LIMIT 1"
  ).bind(id,actor,actor).first();
}
async function ensureReservation(env,actor,v,nowMs){
  const db=env.DB;
  const existing=await issueRow(db,actor,v.id);
  if(existing){
    if(existing.subscription_id||existing.order_state!=='approved')return {status:'already_created'};
    return reserveApprovedOrder(env,existing.order_id,nowMs,existing.node_id);
  }
  const n=await ownReadyNode(env,actor,v.node_ref,nowMs);
  if(!n||n.id!==v.node_id)return {status:'node_unavailable'};
  if(label(v.label)===null||number(String(v.gb),1,MAX_GB)===null||
     number(String(v.days),1,365)===null)return {status:'invalid_fields'};
  const quota=v.gb*1073741824,plan=planId(v.gb,v.days),order=orderId(v.id);
  try{
    const writes=await db.batch([
      db.prepare(
        "INSERT OR IGNORE INTO plans(id,title_fa,title_en,price_amount,price_currency,"+
        "quota_bytes,duration_days,active) VALUES(?,'صدور دستی مدیر','Admin direct issue',0,'IRT',?,?,0)"
      ).bind(plan,quota,v.days),
      db.prepare(
        "INSERT OR IGNORE INTO orders(id,customer_telegram_id,plan_id,idempotency_key,"+
        "quoted_amount,quoted_currency,state) "+
        "SELECT ?,?,?,?,0,'IRT','approved' FROM customers c JOIN plans p ON p.id=? "+
        "WHERE c.telegram_id=? AND c.state='active' AND p.price_amount=0 AND p.active=0 "+
        "AND p.quota_bytes=? AND p.duration_days=?"
      ).bind(order,actor,plan,'direct:'+v.id,plan,actor,quota,v.days),
      db.prepare(
        "INSERT OR IGNORE INTO admin_direct_issues("+
        "id,actor_id,order_id,node_id,label,quota_bytes,duration_days,created_ms) "+
        "VALUES(?,?,?,?,?,?,?,?)"
      ).bind(v.id,actor,order,n.id,v.label,quota,v.days,nowMs),
    ]);
    if(Number(writes[2]?.meta?.changes)!==1 && !await issueRow(db,actor,v.id))
      return {status:'create_rejected'};
  }catch{return {status:'create_rejected'};}
  return reserveApprovedOrder(env,order,nowMs,n.id);
}
export async function directStatus(env,actor,id,nowMs=Date.now()){
  if(!validAdmin(env,actor))return panel('⛔ دسترسی به صدور مستقیم مجاز نیست.');
  const row=await issueRow(env.DB,actor,id);
  if(!row)return panel('⚠️ این کانفیگ در حساب مدیر وجود ندارد.',[
    button('📋 کانفیگ‌های صادرشده','list')]);
  const ack=Number(row.client_ack??0)>=nowMs-600000;
  const ready=row.order_state==='fulfilled'&&row.subscription_state==='active'&&
    row.allocation_state==='active'&&ack;
  const text=panelHeading('🔗','کانفیگ مشتری',row.label)+
    '\n🌐 سرور: '+row.node_id+
    '\n📦 حجم: '+faNumber(row.quota_bytes/1073741824)+' گیگابایت'+
    '\n📅 مدت: '+faNumber(row.duration_days)+' روز'+
    '\n📋 سفارش: '+row.order_state+
    '\n🔐 نصب UUID: '+(ack?'✅ تأیید واقعی دریافت شد':'⏳ در انتظار تأیید عامل')+
    '\n\n'+(ready?'✅ کانفیگ نصب شده و برای دریافت آماده است.':
      row.subscription_state==='revoked'?'⛔ اشتراک لغو شده است.':
      '⏳ مدار در حال نصب خودکار UUID جدید است. نیازی به تست مجدد سرور نیست.');
  return panel(text,[
    ...(ready?[button('🔗 دریافت لینک دو اپراتور','link:'+id)]:[]),
    ...(row.subscription_state!=='revoked'&&row.order_state!=='cancelled'?
      [button('🛑 لغو این کانفیگ','end:'+id)]:[]),
    button('🔄 تازه‌سازی','status:'+id),
    button('📋 کانفیگ‌های من','list'),
  ]);
}
export async function directList(env,actor,nowMs=Date.now()){
  if(!validAdmin(env,actor))return panel('⛔ دسترسی به این بخش مجاز نیست.');
  const rows=(await env.DB.prepare(
    "SELECT id,label,node_id FROM admin_direct_issues WHERE actor_id=? "+
    "ORDER BY created_ms DESC LIMIT 12"
  ).bind(actor).all()).results??[];
  return panel(panelHeading('📋','کانفیگ‌های صادرشده','کانفیگ‌های همین مدیر')+
    '\n\n'+(rows.length?'یک کانفیگ را انتخاب کن.':'هنوز کانفیگی ثبت نشده است.'),[
      ...rows.map(r=>button('👤 '+r.label.slice(0,32)+' · '+r.node_id.slice(0,15),
        'status:'+r.id)),
      button('➕ صدور کانفیگ جدید','new'),
    ]);
}
export async function directAction(env,e,nowMs=Date.now()) {
  if(!validAdmin(env,e.actorId))return panel('⛔ دسترسی به صدور مستقیم مجاز نیست.');
  const key=e.key??'', db=env.DB,actor=e.actorId;
  if(key==='admin:configs:direct:new'){
    const v={version:1,id:'di-'+hex(12),step:'name'};
    await save(db,actor,v,nowMs);
    return question(env,actor,v,nowMs);
  }
  if(key==='admin:configs:direct:list')return directList(env,actor,nowMs);
  if(key==='admin:configs:direct:cancel'){
    await clear(db,actor);
    return panel('✅ صدور جدید لغو شد؛ هیچ سفارش جدیدی ساخته نشد.',[
      button('➕ صدور کانفیگ','new')]);
  }
  const operation=key.match(/^admin:configs:direct:(status|link|end|revoke):((?:di-)[a-f0-9]{24})$/);
  if(operation){
    const [,action,id]=operation, row=await issueRow(db,actor,id);
    if(!row)return panel('⛔ این کانفیگ متعلق به مدیر نیست.');
    if(action==='status')return directStatus(env,actor,id,nowMs);
    if(action==='end')return panel('آیا کانفیگ '+row.label+' لغو شود؟ لینک آن بی‌اعتبار می‌شود و عامل سرور حذف UUID را انجام می‌دهد.',[
      button('✅ تأیید لغو','revoke:'+id),
      button('↩️ انصراف','status:'+id)]);
    if(action==='revoke'){
      await db.batch([
        db.prepare("UPDATE subscriptions SET state='revoked' WHERE id=? AND owner_telegram_id=? "+
          "AND state IN ('active','pending')").bind(row.subscription_id,actor),
        db.prepare("UPDATE subscription_tokens SET revoked=1 WHERE subscription_id=?")
          .bind(row.subscription_id),
        db.prepare("UPDATE orders SET state='cancelled' WHERE id=? AND state IN ('approved','provisioning')")
          .bind(row.order_id),
      ]);
      return directStatus(env,actor,id,nowMs);
    }
    if(row.order_state!=='fulfilled'||row.subscription_state!=='active'||
       row.allocation_state!=='active'||Number(row.client_ack??0)<nowMs-600000)
      return directStatus(env,actor,id,nowMs);
    const link=await issueCarrierLink(env,row.subscription_id,nowMs);
    return panel(link?'🔗 کانفیگ '+row.label+'\n\n'+link.url+
      '\n\nاین لینک خصوصی شامل هر دو مسیر همراه اول و ایرانسل با حجم مشترک است.':
      '⏳ لینک هنوز قابل انتشار نیست؛ نصب UUID و سلامت هر دو مسیر باید معتبر باشند.',[
      button('🔄 وضعیت','status:'+id)]);
  }
  let v=await load(db,actor,nowMs);
  if(!v)return panel('⌛ فرم صدور منقضی شده است. دوباره شروع کن.',[
    button('➕ صدور جدید','new')]);
  if(key==='admin:configs:direct:back'){
    const steps=['name','node','gb','days','review'];
    const index=steps.indexOf(v.step);
    if(index>0)v.step=steps[index-1];
    await save(db,actor,v,nowMs);
    return question(env,actor,v,nowMs);
  }
  const n=key.match(/^admin:configs:direct:node:([a-f0-9]{24})$/);
  if(n&&v.step==='node'){
    const node=await ownReadyNode(env,actor,n[1],nowMs);
    if(!node)return question(env,actor,v,nowMs,'این سرور آماده نیست؛ سرور دیگری انتخاب کن.');
    v.node_id=node.id;v.node_ref=n[1];v.step='gb';
    await save(db,actor,v,nowMs);return question(env,actor,v,nowMs);
  }
  const gb=key.match(/^admin:configs:direct:gb:(\d{1,4})$/);
  if(gb&&v.step==='gb'){
    const amount=number(gb[1],1,MAX_GB);
    if(amount===null)return question(env,actor,v,nowMs,'حجم نامعتبر است.');
    v.gb=amount;v.step='days';
    await save(db,actor,v,nowMs);return question(env,actor,v,nowMs);
  }
  const days=key.match(/^admin:configs:direct:days:(\d{1,3})$/);
  if(days&&v.step==='days'){
    const amount=number(days[1],1,365);
    if(amount===null)return question(env,actor,v,nowMs,'مدت نامعتبر است.');
    v.days=amount;v.step='review';
    await save(db,actor,v,nowMs);return question(env,actor,v,nowMs);
  }
  if(key==='admin:configs:direct:save'){
    if(v.step!=='review'||!v.node_id||!v.node_ref||
       label(v.label)===null||number(String(v.gb),1,MAX_GB)===null||
       number(String(v.days),1,365)===null)
      return question(env,actor,v,nowMs,'اطلاعات صدور کامل نیست.');
    const result=await ensureReservation(env,actor,v,nowMs);
    if(!['reserved','already_created','concurrent_change'].includes(result.status)){
      const row=await issueRow(db,actor,v.id);
      if(!row)return question(env,actor,v,nowMs,'ثبت درخواست انجام نشد: '+result.status);
    }
    v.step='issued';await save(db,actor,v,nowMs);
    return directStatus(env,actor,v.id,nowMs);
  }
  return question(env,actor,v,nowMs,'این دکمه مربوط به مرحلهٔ فعلی نیست.');
}
export async function directInput(env,e,session,nowMs=Date.now()){
  if(!validAdmin(env,e.actorId))return null;
  const v=decode(session);
  if(!v)return null;
  const raw=e.inputText;
  if(typeof raw!=='string'||raw.startsWith('/')||raw.length>150)return null;
  if(v.step==='name'){
    const value=label(raw);
    if(value===null)return question(env,e.actorId,v,nowMs,
      'نام مشتری باید یک خط و بین ۲ تا ۶۰ نویسه باشد.');
    v.label=value;v.step='node';
  }else if(v.step==='gb'){
    const value=number(raw,1,MAX_GB);
    if(value===null)return question(env,e.actorId,v,nowMs,
      'حجم باید عدد صحیح بین ۱ تا ۱۰۰۰ گیگابایت باشد.');
    v.gb=value;v.step='days';
  }else if(v.step==='days'){
    const value=number(raw,1,365);
    if(value===null)return question(env,e.actorId,v,nowMs,
      'مدت باید عدد صحیح بین ۱ تا ۳۶۵ روز باشد.');
    v.days=value;v.step='review';
  }else return question(env,e.actorId,v,nowMs,'از دکمه‌های همین مرحله استفاده کن.');
  await save(env.DB,e.actorId,v,nowMs);
  return question(env,e.actorId,v,nowMs);
}
