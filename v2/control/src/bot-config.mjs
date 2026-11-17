/** Private admin-only Telegram controls for issuing real, verified subscriptions
 * and isolated one-hour carrier-pair trial links. Never bypasses sales or route gates. */
import {nodeUiRef,nodeFromRef} from './node-admin.mjs';
import {issueTrialLink} from './node-auto.mjs';
import {issueCarrierLink} from './carrier-subscription.mjs';
import {frameMessage,faNumber,faStatus,shortCode,panelHeading} from './bot-ux.mjs';

const HEX=/^[a-f0-9]{24}$/;
const PAGE=6;
const btn=(label,key)=>[{text:label,callback_data:'v2:admin:configs:'+key}];
const view=(text,buttons=[])=>({
  text:frameMessage(text),replyMarkup:{inline_keyboard:[
    ...buttons,[{text:'↩️ پیشخوان مدیریت',callback_data:'v2:admin:home'}],
  ]},
});
async function refFor(value){
  const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)));
  return Array.from(bytes.slice(0,12),b=>b.toString(16).padStart(2,'0')).join('');
}
async function subscriptionByRef(db,ref){
  if(!HEX.test(ref??''))return null;
  const rows=(await db.prepare(
    "SELECT id FROM subscriptions ORDER BY id LIMIT 5001"
  ).all()).results??[];
  if(rows.length>5000)return null;
  let id=null;
  for(const row of rows)
    if(await refFor(row.id)===ref){
      if(id!==null)return null;
      id=row.id;
    }
  return id;
}
function pages(type,page,count){
  const controls=[];
  if(page>0)controls.push({text:'◀️ قبلی',callback_data:'v2:admin:configs:'+type+':'+(page-1)});
  if((page+1)*PAGE<count)controls.push({text:'بعدی ▶️',callback_data:'v2:admin:configs:'+type+':'+(page+1)});
  return controls.length?[controls]:[];
}
const instructions='🔐 لینک اتصال خصوصی است و نباید در گروه عمومی منتشر شود. دو مسیر همراه اول و ایرانسل از یک سهمیه استفاده می‌کنند.';
async function configHome(env,nowMs){
  const db=env.DB;
  const [installed,sub]=await Promise.all([
    db.prepare("SELECT COUNT(*) n FROM node_bootstrap_jobs j JOIN nodes n ON n.id=j.node_id "+
      "WHERE j.state='installed' AND n.lifecycle NOT IN ('retired','quarantined')").first(),
    db.prepare("SELECT COUNT(*) n FROM subscriptions s JOIN customers c ON c.telegram_id=s.owner_telegram_id "+
      "WHERE s.state='active' AND c.state='active' AND s.expires_at>? AND s.max_bytes>s.used_bytes")
      .bind(nowMs).first()
  ]);
  const real=env.SUBSCRIPTION_API_ENABLED==='true'&&env.SUBSCRIPTION_LINKS_ENABLED==='true';
  return view(panelHeading('🔗','صدور کانفیگ مدار','یک لینک اشتراک با دو مسیر اپراتور')+
    '\n\n🧪 سرور نصب‌شده برای بررسی: '+faNumber(installed?.n??0)+
    '\n👤 اشتراک دارای اعتبار: '+faNumber(sub?.n??0)+
    '\n🔒 صدور کانفیگ واقعی: '+(real?'در صورت تأیید مسیرها':'غیرفعال تا تأیید سرویس')+
    '\n\nبرای کانفیگ آزمایشی سرور، مسیر اول را انتخاب کنید. لینک مشتری فقط برای اشتراک فعال با مسیرهای مستقل تأییدشده صادر می‌شود.',[
    btn('🧪 صدور لینک تست سرور','trials:0'),
    btn('🔗 صدور لینک اشتراک فعال','subscriptions:0'),
  ]);
}
async function trialList(env,e,page){
  page=Number.isSafeInteger(page)&&page>=0&&page<=1000?page:0;
  const owner=e.actorId,db=env.DB;
  const total=Number((await db.prepare(
    "SELECT COUNT(*) n FROM node_bootstrap_jobs j JOIN nodes n ON n.id=j.node_id "+
    "WHERE j.owner_id=? AND j.state='installed' AND n.lifecycle NOT IN ('retired','quarantined')"
  ).bind(owner).first())?.n??0);
  const max=Math.max(0,Math.ceil(total/PAGE)-1);
  page=Math.min(page,max);
  const nodes=(await db.prepare(
    "SELECT j.node_id,n.provider,n.region,n.lifecycle FROM node_bootstrap_jobs j "+
    "JOIN nodes n ON n.id=j.node_id WHERE j.owner_id=? AND j.state='installed' "+
    "AND n.lifecycle NOT IN ('retired','quarantined') "+
    "ORDER BY j.created_ms DESC LIMIT 6 OFFSET ?"
  ).bind(owner,page*PAGE).all()).results??[];
  const buttons=[];
  for(const n of nodes)buttons.push(btn('🧪 '+shortCode(n.node_id,26)+' · '+faStatus(n.lifecycle),
    'trial:'+await nodeUiRef(n.node_id)));
  return view(panelHeading('🧪','کانفیگ آزمایشی','فقط سرورهای نصب‌شده خود مدیر')+
    '\n\nصفحه '+faNumber(page+1)+' از '+faNumber(max+1)+
    '\n'+(nodes.length?'یک سرور را انتخاب کنید.':'سرور نصب‌شده‌ای برای صدور تست وجود ندارد.')+
    '\n\nلینک آزمایشی یک‌ساعته است و مجوز فروش محسوب نمی‌شود.',[
    ...buttons,...pages('trials',page,total),
    btn('↩️ بازگشت به صدور کانفیگ','home'),
  ]);
}
async function subscriptionList(env,nowMs,page){
  page=Number.isSafeInteger(page)&&page>=0&&page<=1000?page:0;
  const db=env.DB;
  const where="s.state='active' AND c.state='active' AND s.expires_at>? AND s.max_bytes>s.used_bytes";
  const count=Number((await db.prepare(
    "SELECT COUNT(*) n FROM subscriptions s JOIN customers c ON c.telegram_id=s.owner_telegram_id WHERE "+where
  ).bind(nowMs).first())?.n??0);
  const max=Math.max(0,Math.ceil(count/PAGE)-1);page=Math.min(page,max);
  const rows=(await db.prepare(
    "SELECT s.id,s.owner_telegram_id FROM subscriptions s JOIN customers c ON c.telegram_id=s.owner_telegram_id "+
    "WHERE "+where+" ORDER BY s.expires_at DESC,s.id LIMIT 6 OFFSET ?"
  ).bind(nowMs,page*PAGE).all()).results??[];
  const controls=[];
  for(const row of rows)controls.push(btn('👤 '+shortCode(row.owner_telegram_id,14)+' · '+shortCode(row.id,19),
    'subscription:'+await refFor(row.id)));
  return view(panelHeading('🔗','اشتراک‌های فعال','برای صدور یک لینک خصوصی، اشتراک را انتخاب کنید')+
    '\n\nصفحه '+faNumber(page+1)+' از '+faNumber(max+1)+
    '\n'+(rows.length?'لینک فقط پس از تأیید دو مسیر و سهمیه صادر می‌شود.':
      'اشتراک فعال و معتبر برای صدور وجود ندارد.'),[
    ...controls,...pages('subscriptions',page,count),btn('↩️ بازگشت به صدور کانفیگ','home'),
  ]);
}
async function trialIssue(env,e,ref,nowMs){
  if(!HEX.test(ref??''))return view('⚠️ شناسه سرور معتبر نیست.');
  const node=await nodeFromRef(env.DB,ref);
  if(!node)return view('⚠️ سرور موردنظر پیدا نشد.');
  const [job,credential,variants]=await Promise.all([
    env.DB.prepare('SELECT state,owner_id FROM node_bootstrap_jobs WHERE node_id=?').bind(node.id).first(),
    env.DB.prepare('SELECT node_id FROM node_trial_credentials WHERE node_id=?').bind(node.id).first(),
    env.DB.prepare("SELECT operator,host,port FROM route_carrier_variants WHERE route_id=?")
      .bind(node.id+'_reality').all(),
  ]);
  const rs=variants.results??[];
  const two=rs.length===2&&new Set(rs.map(x=>x.operator)).size===2&&
    rs.some(x=>x.operator==='mci')&&rs.some(x=>x.operator==='irancell')&&
    rs.every(x=>Number.isInteger(x.port)&&x.port>=1&&x.port<=65535)&&
    rs[0].host===rs[1].host&&rs[0].port!==rs[1].port;
  if(!job||job.state!=='installed'||job.owner_id!==e.actorId||
      !credential||!two||['quarantined','retired'].includes(node.lifecycle))
    return view('⛔ امکان صدور تست وجود ندارد.\nنصب کامل، مالکیت مدیر و دو مسیر مجزای همراه اول و ایرانسل باید موجود باشند.',[
      btn('🧪 بازگشت به سرورها','trials:0'),
    ]);
  const url=await issueTrialLink(env,e.actorId,node.id,nowMs);
  return view(url?'✅ لینک تست یک‌ساعته سرور '+node.id+'\n\n'+url+
    '\n\nیک لینک شامل مسیر همراه اول و ایرانسل است.\n'+instructions:
    '⏸ لینک تست صادر نشد. تنظیمات رمزنگاری و نشانی اشتراک را بررسی کنید.',[
    btn('🧪 سرورهای آزمایشی','trials:0'),
  ]);
}
async function subscriptionAction(env,ref,nowMs,issue){
  const db=env.DB,id=await subscriptionByRef(db,ref);
  if(!id)return view('⚠️ اشتراک پیدا نشد یا لینک انتخاب آن منقضی شده است.');
  const row=await db.prepare(
    "SELECT s.id,s.owner_telegram_id,s.state,s.expires_at,s.max_bytes,s.used_bytes,c.state owner_state "+
    "FROM subscriptions s JOIN customers c ON c.telegram_id=s.owner_telegram_id WHERE s.id=?"
  ).bind(id).first();
  if(!row||row.state!=='active'||row.owner_state!=='active'||
     row.expires_at<=nowMs||row.max_bytes<=0||row.used_bytes>=row.max_bytes)
    return view('⛔ اشتراک فعال و دارای سهمیه نیست؛ لینکی صادر نشد.');
  if(!issue)return view(panelHeading('🔗','تأیید صدور کانفیگ',id)+
    '\n\n👤 مشتری: '+row.owner_telegram_id+
    '\n📦 اعتبار حجمی باقی‌مانده: '+faNumber(Math.floor((row.max_bytes-row.used_bytes)/1073741824))+' گیگابایت'+
    '\n\nاین دکمه فقط برای اشتراک تأییدشده با دو مسیر مستقل و فعال کار می‌کند.',[
      btn('✅ تأیید صدور لینک','issue:'+ref),
      btn('↩️ اشتراک‌های فعال','subscriptions:0'),
    ]);
  const link=await issueCarrierLink(env,id,nowMs);
  return view(link?'✅ لینک خصوصی اشتراک '+id+'\n\n'+link.url+
    '\n\n'+instructions:
    '⛔ کانفیگ صادر نشد. سرویس اشتراک فعال نیست یا هنوز هر دو مسیر تأییدشده، ظرفیت و اعتبار لازم را ندارند.',[
      btn('↩️ اشتراک‌های فعال','subscriptions:0'),
    ]);
}
/** All actions are guarded by shop.mjs's adminAllowed before reaching here. */
export async function adminConfigAction(env,e,nowMs=Date.now()){
  const key=e.key??'';
  if(key==='admin:configs'||key==='admin:configs:home')return configHome(env,nowMs);
  const list=key.match(/^admin:configs:(trials|subscriptions):([0-9]{1,4})$/);
  if(list)return list[1]==='trials'?trialList(env,e,Number(list[2])):
    subscriptionList(env,nowMs,Number(list[2]));
  const trial=key.match(/^admin:configs:trial:([a-f0-9]{24})$/);
  if(trial)return trialIssue(env,e,trial[1],nowMs);
  const sub=key.match(/^admin:configs:(subscription|issue):([a-f0-9]{24})$/);
  if(sub)return subscriptionAction(env,sub[2],nowMs,sub[1]==='issue');
  return view('⚠️ درخواست صدور کانفیگ معتبر نیست.');
}
