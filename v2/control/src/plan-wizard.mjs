/** Native Persian four-step plan creation, isolated to the V2 admin input session.
 * No plan is created until an explicit final Telegram button confirmation.
 */
import {frameMessage,faNumber} from './bot-ux.mjs';

const STEPS=['title','gb','days','price','review'];
const CODE=/^[A-Za-z0-9][A-Za-z0-9_-]{1,30}$/;
const SESSION_MS=10*60*1000;
const action=(text,key)=>[{text,callback_data:'v2:admin:plan:'+key}];
const plansButton=[{text:'🛍 مدیریت پلن‌ها',callback_data:'v2:admin:plans'}];
const panel=(message,buttons=[])=>({
  text:frameMessage(message),
  replyMarkup:{inline_keyboard:buttons},
});
function localizedDigits(input){
  return String(input).replace(/[۰-۹]/g,c=>String(c.charCodeAt(0)-1776))
    .replace(/[٠-٩]/g,c=>String(c.charCodeAt(0)-1632));
}
function numberField(input,min,max){
  if(typeof input!=='string'||input.length>40)return null;
  const n=localizedDigits(input.trim()).replace(/[\s,\u066c]/g,'');
  if(!/^(0|[1-9][0-9]*)$/.test(n))return null;
  const value=Number(n);
  return Number.isSafeInteger(value)&&value>=min&&value<=max?value:null;
}
function titleField(input){
  if(typeof input!=='string')return null;
  const name=input.trim();
  return name.length>=2&&name.length<=64&&
    /[\u0621-\u064a\u067e\u0686\u0698\u06a9\u06af\u06cc\u06be]/u.test(name)&&
    !/[\r\n|<>]/.test(name)?name:null;
}
function fromSession(session){
  if(!session||session.mode!=='plan_draft'||typeof session.context_id!=='string'||
     session.context_id.length>512)return null;
  try {
    const d=JSON.parse(session.context_id);
    return d.version===1&&STEPS.includes(d.step)&&CODE.test(d.id)?d:null;
  }catch{return null;}
}
function question(d,warning=''){
  const current=d.step==='title'?d.title:d[d.step];
  const repeat=current===undefined?'':'\nمقدار قبلی: '+(d.step==='title'?current:faNumber(current));
  const queries={
    title:'نام فارسی این پلن چیست؟\nمثال: اشتراک یک‌ماهه',
    gb:'حجم پلن چند گیگابایت باشد؟\nعدد بین ۱ تا ۲۰۰۰ وارد کنید.',
    days:'اعتبار پلن چند روز باشد؟\nعدد بین ۱ تا ۳۶۶ وارد کنید.',
    price:'قیمت پلن به تومان چقدر باشد؟\nمثال: ۳۰۰٬۰۰۰',
  };
  const summary=d.step==='review'
    ?'📋 اطلاعات پلن را بررسی کن:\n\n'+
      '🛍 نام: '+d.title+
      '\n📦 حجم: '+faNumber(d.gb)+' گیگابایت'+
      '\n📅 مدت: '+faNumber(d.days)+' روز'+
      '\n💳 قیمت: '+faNumber(d.price)+' تومان'+
      '\n🔎 شناسه خودکار: '+d.id+
      '\n\n🔒 پلن فقط به‌صورت غیرفعال ثبت می‌شود.':
    queries[d.step]+repeat;
  const controls=[];
  if(d.step==='review')controls.push(action('✅ تأیید و ثبت پلن','save'));
  if(d.step!=='title')controls.push(action('⬅️ مرحله قبل','back'));
  controls.push(action('❌ لغو ساخت پلن','cancel'));
  return panel('🛍 ساخت پلن جدید\n'+(d.step==='review'?'پیش‌نمایش نهایی':
    'مرحله '+faNumber(STEPS.indexOf(d.step)+1)+' از ۴')+
    (warning?'\n\n⚠️ '+warning:'')+'\n\n'+summary+
    '\n\n⏳ مهلت پاسخ‌گویی: ۱۰ دقیقه',controls);
}
async function store(db,e,d,nowMs){
  await db.prepare(
    "INSERT INTO v2_bot_input_sessions(telegram_id,mode,context_id,expires_ms) VALUES(?,'plan_draft',?,?) "+
    "ON CONFLICT(telegram_id) DO UPDATE SET mode='plan_draft',context_id=excluded.context_id,expires_ms=excluded.expires_ms"
  ).bind(e.actorId,JSON.stringify(d),nowMs+SESSION_MS).run();
}
async function clear(db,e){
  await db.prepare("DELETE FROM v2_bot_input_sessions WHERE telegram_id=? AND mode='plan_draft'")
    .bind(e.actorId).run();
}
async function load(db,e,nowMs){
  const s=await db.prepare("SELECT mode,context_id,expires_ms FROM v2_bot_input_sessions WHERE telegram_id=? AND mode='plan_draft'")
    .bind(e.actorId).first();
  if(!s)return null;
  if(s.expires_ms<=nowMs){await clear(db,e);return null;}
  const d=fromSession(s);
  if(!d)await clear(db,e);
  return d;
}
const expired=()=>panel('⌛ فرم پلن فعال نیست یا زمان آن پایان یافته است.\nاز مدیریت پلن‌ها دوباره شروع کنید.',[plansButton]);
export async function planWizardAction(db,e,nowMs=Date.now()){
  const key=e.key??'';
  if(key==='admin:plan:new'){
    if(!Number.isSafeInteger(e.updateId)||e.updateId<0)return panel('⚠️ شناسه درخواست معتبر نیست.');
    const d={version:1,step:'title',id:'p'+e.updateId};
    if(!CODE.test(d.id))return panel('⚠️ ساخت شناسه پلن ممکن نیست.');
    await store(db,e,d,nowMs);
    return question(d);
  }
  if(key==='admin:plan:cancel'){
    await clear(db,e);
    return panel('✅ ساخت پلن لغو شد. هیچ پلنی ثبت نشده است.',[plansButton]);
  }
  const d=await load(db,e,nowMs);
  if(!d)return expired();
  if(key==='admin:plan:back'){
    const index=STEPS.indexOf(d.step);
    if(index>0)d.step=STEPS[index-1];
    await store(db,e,d,nowMs);
    return question(d);
  }
  if(key!=='admin:plan:save')return null;
  if(d.step!=='review'||titleField(d.title)===null||
    numberField(String(d.gb),1,2000)===null||
    numberField(String(d.days),1,366)===null||
    numberField(String(d.price),0,100000000000)===null)
    return question(d,'ابتدا تمام مراحل را تکمیل کنید.');
  const results=await db.batch([
    db.prepare("INSERT OR IGNORE INTO plans("+
      "id,title_fa,title_en,price_amount,price_currency,quota_bytes,duration_days,active) "+
      "VALUES(?,?,?,?,?,?,?,0)").bind(d.id,d.title,d.title,d.price,'IRT',d.gb*1073741824,d.days),
    db.prepare("INSERT OR IGNORE INTO audit_events(event_id,actor_id,object_type,object_id,verb) VALUES(?,?,?,?,?)")
      .bind('plan:wizard:'+d.id,e.actorId,'plan',d.id,'create:disabled'),
    db.prepare("DELETE FROM v2_bot_input_sessions WHERE telegram_id=? AND mode='plan_draft'")
      .bind(e.actorId),
  ]);
  return panel(results[0]?.meta?.changes===1
    ?'✅ پلن غیرفعال ثبت شد: '+d.title+
      '\nفعال‌سازی فروش به تأیید ظرفیت و تنظیمات پرداخت وابسته است.'
    :'ℹ️ شناسه این پلن قبلاً ثبت شده است؛ پلن تکراری ساخته نشد.',
    [plansButton]);
}
export async function planWizardInput(db,e,session,nowMs=Date.now()){
  const d=fromSession(session);
  if(!d){await clear(db,e);return expired();}
  if(d.step==='review')return question(d,'برای ثبت پلن، دکمه «تأیید و ثبت پلن» را بزنید.');
  const raw=e.inputText;
  let value=null,warning='';
  if(d.step==='title'){
    value=titleField(raw);
    if(value===null)warning='نام باید فارسی، یک‌خطی و بین ۲ تا ۶۴ نویسه باشد.';
  }else if(d.step==='gb'){
    value=numberField(raw,1,2000);
    if(value===null)warning='حجم باید عددی بین ۱ تا ۲۰۰۰ باشد.';
  }else if(d.step==='days'){
    value=numberField(raw,1,366);
    if(value===null)warning='مدت باید عددی بین ۱ تا ۳۶۶ روز باشد.';
  }else if(d.step==='price'){
    value=numberField(raw,0,100000000000);
    if(value===null)warning='قیمت باید عدد معتبر به تومان باشد.';
  }
  if(warning)return question(d,warning);
  d[d.step]=value;
  d.step=STEPS[STEPS.indexOf(d.step)+1];
  await store(db,e,d,nowMs);
  return question(d);
}
