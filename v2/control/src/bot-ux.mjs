/** رابط کاربری یکپارچه ربات تلگرام مدار؛ تمام متن‌های قابل مشاهده فارسی هستند. */

const faDigits=new Intl.NumberFormat('fa-IR');
export function faNumber(value,options={}) {
  const n=Number(value);
  return Number.isFinite(n)?faDigits.format(n):'۰';
}
export function faMoney(amount,currency='IRT') {
  const unit=({IRT:'تومان',IRR:'ریال',USD:'دلار آمریکا'})[currency]??currency;
  return faNumber(amount)+' '+unit;
}
export function faGB(value) {
  const n=Number(value);
  return (Number.isFinite(n)?new Intl.NumberFormat('fa-IR',{maximumFractionDigits:2}).format(n):'۰')+' گیگابایت';
}
export function faDate(value) {
  const date=new Date(value);
  if(!Number.isFinite(date.getTime()))return 'ثبت نشده';
  try {
    return new Intl.DateTimeFormat('fa-IR-u-ca-persian',{
      year:'numeric',month:'long',day:'numeric',timeZone:'Asia/Tehran'
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat('fa-IR',{
      year:'numeric',month:'2-digit',day:'2-digit',timeZone:'Asia/Tehran'
    }).format(date);
  }
}
const states={
  pending:'در انتظار بررسی',receipt_submitted:'رسید ارسال شده',
  approved:'تأیید شده',rejected:'رد شده',provisioning:'در حال آماده‌سازی',
  active:'فعال',suspended:'تعلیق‌شده',expired:'منقضی‌شده',
  open:'باز',waiting:'در انتظار پاسخ',closed:'بسته‌شده',
  installed:'نصب‌شده',enrolling:'در حال ثبت',ready:'آماده',
  degraded:'نیازمند بررسی',draft:'پیش‌نویس',checking:'در حال بررسی',
  dispatching:'در حال ارسال دستور',dispatched:'دستور ارسال شد',
  failed:'ناموفق',disabled:'غیرفعال',revoked:'لغوشده',
  reserved:'رزروشده',accepted:'پذیرفته‌شده',
  fulfilled:'تحویل داده شده',cancelled:'لغو شده',refunded:'وجه بازگردانده شد',
  quarantined:'قرنطینه‌شده',retired:'خارج از سرویس',released:'آزاد شده',
};
export function faStatus(value) {
  const key=String(value??'').toLowerCase();
  return states[key]??(key||'نامشخص');
}
export function faRole(value) {
  return ({seller:'فروشنده',support:'پشتیبان',admin:'مدیر'})[value]??String(value??'');
}
export function panelHeading(icon,title,subtitle='') {
  return [icon+'  '+title,subtitle].filter(Boolean).join('\n');
}
export function panelRow(icon,label,value) { return icon+' '+label+': '+value; }
export function frameMessage(content) {
  // Telegram wraps long decorative lines unpredictably in Persian RTL chats.
  const body=String(content??'').replace(/^[━─═]{6,}\s*$/gm,'').replace(/\n{3,}/g,'\n\n').trim();
  if(body.startsWith('🌐  مــدار\n'))return body;
  return '🌐  مــدار\n'+body;
}

/** Locally hosted non-sensitive brand artwork; all live counts stay in the caption. */
export const BRAND_BANNER_URL='https://madar-v2-staging.alirezaanari117.workers.dev/brand/banner.jpg';


/** Telegram Bot API 9.4+ supports a restricted semantic button palette.
 * Older clients may render the usual neutral button instead. */
export function styleInlineKeyboard(markup){
  if(!markup||!Array.isArray(markup.inline_keyboard))return markup;
  const primary=new Set(['v2:plans','v2:my','v2:admin:home','v2:customer:home',
    'v2:admin:nodes','v2:admin:tickets','v2:status','v2:seller:home']);
  const success=new Set(['v2:admin:node:new','v2:seller:invite','v2:customer:trial']);
  const danger=new Set(['v2:seller:revoke']);
  return {...markup,inline_keyboard:markup.inline_keyboard.map(row=>
    row.map(button=>{
      const cb=String(button.callback_data??'');
      if(button.style||!cb)return {...button};
      const style=primary.has(cb)?'primary':success.has(cb)?'success':
        danger.has(cb)?'danger':null;
      return style?{...button,style}:{...button};
    })
  )};
}

const customerMenu={inline_keyboard:[
  [
    {text:'🛍 خرید اشتراک',callback_data:'v2:plans'},
    {text:'📦 اشتراک‌های من',callback_data:'v2:my'},
  ],
  [
    {text:'🧪 دریافت تست رایگان',callback_data:'v2:customer:trial'},
    {text:'📶 وضعیت سرویس',callback_data:'v2:status'},
  ],
  [
    {text:'🧾 سفارش‌های من',callback_data:'v2:orders'},
    {text:'💬 پشتیبانی',callback_data:'v2:customer:tickets'},
  ],
  [
    {text:'📘 راهنمای اتصال',callback_data:'v2:help'},
    {text:'🔐 حریم خصوصی',callback_data:'v2:privacy'},
  ],
]};
const managerMenu={inline_keyboard:[
  [
    {text:'🖥 مدیریت سرورها',callback_data:'v2:admin:nodes'},
    {text:'🛍 مدیریت پلن‌ها',callback_data:'v2:admin:plans'},
  ],
  [
    {text:'🧾 بررسی رسیدها',callback_data:'v2:admin:queue'},
    {text:'👥 مشتریان',callback_data:'v2:admin:customers'},
  ],
  [
    {text:'💬 صندوق پشتیبانی',callback_data:'v2:admin:tickets'},
    {text:'🔗 صدور کانفیگ',callback_data:'v2:admin:configs'},
  ],
  [{text:'🧑‍💼 کارکنان و فروشندگان',callback_data:'v2:admin:staff'}],
]};
const sellerMenuMarkup={inline_keyboard:[
  [
    {text:'🧾 سفارش‌های من',callback_data:'v2:seller:orders'},
    {text:'🔗 ساخت لینک معرفی',callback_data:'v2:seller:invite'},
  ],
  [
    {text:'🔒 لغو لینک‌های قبلی',callback_data:'v2:seller:revoke'},
    {text:'🏠 خانه',callback_data:'v2:customer:home'},
  ],
]};
const supportMenuMarkup={inline_keyboard:[
  [{text:'💬 صندوق پشتیبانی',callback_data:'v2:admin:tickets'}],
  [{text:'🏠 خانه مشتری',callback_data:'v2:customer:home'}],
]};
export function botMenu() { return structuredClone(customerMenu); }
export function adminMenu() { return structuredClone(managerMenu); }
export function sellerMenu() { return structuredClone(sellerMenuMarkup); }
export function supportMenu() { return structuredClone(supportMenuMarkup); }

/** A single back button outside home screens, never a global menu. */
export function sectionNavigation(role='customer'){
  const destination={
    customer:'customer:home',admin:'admin:home',
    seller:'seller:home',support:'admin:tickets',
  }[role]??'customer:home';
  return [[{text:'↩️ بازگشت',callback_data:'v2:'+destination}]];
}

/** Resolve a real parent page instead of returning every screen to the dashboard.
 * Pure, bounded callback routing; permissions are still enforced by shop.mjs. */
export function parentPage(key,isAdmin=false){
  key=String(key??'');
  if(key==='customer:trial')return 'customer:home';
  if(key==='admin:node:new')return 'admin:node:cancel';
  if(key==='admin:node:cancel')return 'admin:home'; // Cancellation lands on server overview.
  if(key==='admin:node:trials')return 'admin:nodes';
  if(key==='admin:configs'||key==='admin:configs:home')return 'admin:home';
  if(key==='admin:configs:e2e:list')return 'admin:configs';
  if(/^admin:configs:e2e:(view|start|status|link|end|revoke):[a-f0-9]{24}$/.test(key))
    return 'admin:configs:e2e:list';
  if(/^admin:configs:(trials|subscriptions):[0-9]{1,4}$/.test(key))
    return 'admin:configs';
  if(/^admin:configs:trial:[a-f0-9]{24}$/.test(key))
    return 'admin:configs:trials:0';
  if(/^admin:configs:subscription:[a-f0-9]{24}$/.test(key))
    return 'admin:configs:subscriptions:0';
  if(/^admin:configs:issue:[a-f0-9]{24}$/.test(key))
    return 'admin:configs:subscription:'+key.slice(-24);
  if(/^admin:tickets:(open|waiting|closed|all):[0-9]{1,4}$/.test(key))
    return 'admin:tickets';
  if(/^ticket:page:tg-[0-9]{1,20}:[0-9]{1,4}$/.test(key))
    return 'ticket:view:'+key.split(':')[2];
  if(/^customer:ticket:page:tg-[0-9]{1,20}:[0-9]{1,4}$/.test(key))
    return 'customer:ticket:'+key.split(':')[3];
  if(/^admin:nodes:(all|ready|setup|testing|attention|quarantine|archive):[0-9]{1,4}$/.test(key))
    return 'admin:nodes';
  if(/^admin:node:(confirm|apply):(quarantine|restore|retire):[a-f0-9]{24}$/.test(key))
    return 'admin:node:view:'+key.slice(-24);
  if(/^admin:node:(field|fieldapply):(mci|irancell):[a-f0-9]{24}$/.test(key))
    return 'admin:node:view:'+key.slice(-24);
  if(/^admin:node:trialref:[a-f0-9]{24}$/.test(key))
    return 'admin:node:view:'+key.slice(-24);
  if(/^admin:node:view:[a-f0-9]{24}$/.test(key))return 'admin:nodes';
  if(key.startsWith('admin:node:trial:'))return 'admin:node:trials';
  if(key==='admin:nodes'||key==='/nodes'||key==='/node_add'||key==='/node_route')return 'admin:home';
  if(key.startsWith('admin:plan:')||key.startsWith('plan:'))return 'admin:plans';
  if(key==='admin:plans')return 'admin:home';
  if(key.startsWith('admin:receipt:'))return 'admin:queue';
  if(key.startsWith('admin:review:')){
    const id=key.split(':').at(-1);
    return /^[a-zA-Z0-9][a-zA-Z0-9_-]{1,48}$/.test(id)?'admin:receipt:'+id:'admin:queue';
  }
  if(key==='admin:queue')return 'admin:home';
  if(key.startsWith('admin:customer:')){
    const id=key.split(':').at(-1);
    const isAction=/^admin:customer:(?:suspend|activate|confirm):/.test(key);
    return isAction&&/^[0-9]{1,20}$/.test(id)
      ?'admin:customer:'+id:'admin:customers';
  }
  if(key.startsWith('admin:customers'))return 'admin:home';
  if(key.startsWith('admin:staff:'))return 'admin:staff';
  if(key==='admin:staff')return 'admin:home';
  if(key==='admin:tickets')return isAdmin?'admin:home':'home'; // Staff goes to their dedicated support home.
  if(key.startsWith('ticket:view:'))return 'admin:tickets';
  if(key.startsWith('ticket:')){
    const id=key.split(':').at(-1);
    return /^tg-[0-9]{1,20}$/.test(id)?'ticket:view:'+id:'admin:tickets';
  }
  if(key.startsWith('seller:'))return 'seller:home';
  if(key==='support'||key==='/support')return 'customer:tickets';
  if(key.startsWith('customer:ticket:reply:'))
    return 'customer:ticket:'+key.slice('customer:ticket:reply:'.length);
  if(key.startsWith('customer:ticket:'))return 'customer:tickets';
  if(key.startsWith('customer:tickets'))return 'customer:home';
  if(key.startsWith('orders:view:'))return 'orders';
  if(key.startsWith('my:link:'))return 'my';
  if(key.startsWith('buy:'))return 'plans';
  if(key==='plans'||key==='my'||key==='orders'||key==='status'||
     key==='help'||key==='privacy'||key==='/plans'||key==='/my'||key==='/orders')
    return 'customer:home';
  return isAdmin?'admin:home':'customer:home';
}

/** Called at outbox time so every route, including legacy wizards and
 * secondary screens, gets the same scoped action + one back convention. */
export function contextualKeyboard(key,markup,{isAdmin=false}={}){
  if(!markup||!Array.isArray(markup.inline_keyboard))return markup;
  key=String(key??'');
  const adminHome=isAdmin&&['/start','/admin','admin:home','home'].includes(key);
  const userHome=['customer:home'].includes(key)||!isAdmin&&['/start','home'].includes(key);
  const sellerHome=key==='seller:home'||key==='/seller';
  if(adminHome)return structuredClone(markup);
  if(userHome||sellerHome){
    return {...markup,inline_keyboard:markup.inline_keyboard.map(row=>row.filter(
      b=>!String(b.text??'').includes('نمای مشتری'))).filter(row=>row.length>0)};
  }
  const source=markup.inline_keyboard;
  // This conversational wizard has its own previous-step and cancel controls;
  // an extra global back would clutter the screen and interrupt the draft.
  if(source.flat().some(b=>b.callback_data==='v2:admin:plan:cancel'))
    return {...markup,inline_keyboard:source.map(row=>row.filter(b=>
      !String(b.text??'').startsWith('↩️')&&!String(b.text??'').startsWith('🏠')
    )).filter(row=>row.length>0)};
  // Text replies from a wizard have no callback key; honor the secure
  // wizard's explicit return destination instead of guessing a global home.
  const explicitBack=(key==='text'||/^ticket:media:[0-9]{1,20}$/.test(key)||
    /^customer:ticket:media:[0-9]{1,20}$/.test(key));
  const typedBack=explicitBack?source.flat().find(b=>
    String(b.text??'').startsWith('↩️')&&
    /^v2:[a-zA-Z0-9:_-]{1,64}$/.test(String(b.callback_data??''))):null;
  const target=typedBack?typedBack.callback_data.slice(3):parentPage(key,isAdmin);
  const backData='v2:'+target;
  const rootAdmin=new Set(adminMenu().inline_keyboard.flat().map(b=>b.callback_data));
  const rootCustomer=new Set(botMenu().inline_keyboard.flat().map(b=>b.callback_data));
  const rootSeller=new Set(sellerMenu().inline_keyboard.flat().map(b=>b.callback_data));
  const isFullAdminMenu=source.flat().filter(b=>rootAdmin.has(b.callback_data)).length>=4;
  const isFullCustomerMenu=source.flat().filter(b=>rootCustomer.has(b.callback_data)).length>=4;
  const isFullSellerMenu=source.flat().filter(b=>rootSeller.has(b.callback_data)).length>=3;
  const rows=source.map(row=>row.filter(button=>{
    const txt=String(button.text??''),cb=String(button.callback_data??'');
    if(txt.includes('نمای مشتری'))return false;
    if(cb===backData)return false;
    if(txt.startsWith('↩️')||txt.startsWith('🏠'))return false;
    if(isFullAdminMenu&&rootAdmin.has(cb))return false;
    if(isFullCustomerMenu&&rootCustomer.has(cb))return false;
    if(isFullSellerMenu&&rootSeller.has(cb))return false;
    return true;
  })).filter(row=>row.length>0);
  rows.push([{text:'↩️ بازگشت',callback_data:backData}]);
  return {...markup,inline_keyboard:rows};
}
export function usageMeter(usedBytes,maxBytes){
  const max=Number(maxBytes),used=Number(usedBytes);
  if(!Number.isFinite(max)||max<=0)return 'حجم اشتراک نامشخص است';
  const safeUsed=Number.isFinite(used)?Math.max(0,used):0;
  const ratio=Math.min(1,safeUsed/max),filled=Math.round(ratio*10);
  const percent=new Intl.NumberFormat('fa-IR',{maximumFractionDigits:0})
    .format(Math.min(100,Math.max(0,safeUsed/max*100)));
  return '▰'.repeat(filled)+'▱'.repeat(10-filled)+'  '+percent+'٪';
}
export function shortCode(value,max=10){
  const str=String(value??'');
  return str.length<=max?str:str.slice(0,max)+'…';
}
export function statusSymbol(state){
  return ({active:'🟢',ready:'🟢',approved:'✅',installed:'🟢',
    pending:'🟡',receipt_submitted:'🟡',waiting:'🟡',
    provisioning:'🟠',enrolling:'🟠',open:'🔵',
    rejected:'🔴',failed:'🔴',suspended:'🔴',degraded:'🟠',
    expired:'⚪',closed:'⚪',disabled:'⚪',fulfilled:'✅',cancelled:'⚪',refunded:'⚪',quarantined:'🔴',retired:'⚪'})[state]??'🔹';
}

const pages={
  home:'🌐 به مدار خوش آمدید\n\nاز اینجا می‌توانید اشتراک بخرید، وضعیت سرویس و سفارش‌ها را ببینید و با پشتیبانی در ارتباط باشید.\n\n⛔ فروش عمومی تا تأیید آزمون اتصال و کنترل مصرف غیرفعال است. لطفاً فعلاً پرداختی انجام ندهید.',
  plans:'🛍  انتخاب اشتراک\n\nفروش عمومی غیرفعال است. بسته‌ها پس از تأیید ظرفیت و کنترل مصرف در این بخش منتشر می‌شوند.\n\nاشتراک‌های نسخه قبلی شما مستقل و محفوظ هستند.',
  my:'📦  اشتراک‌های من\n\nوضعیت، حجم مصرفی، تاریخ پایان و لینک اتصال اشتراک‌های شما در این بخش نمایش داده می‌شود.',
  status:'📶  وضعیت سرویس\n\nمدار در مرحله آزمون نهایی قرار دارد. مسیرهای تأییدنشده هنوز آماده استفاده نیستند؛ فقط مسیرهایی که آزمون واقعی اتصال را گذرانده باشند فعال می‌شوند.',
  support:'💬  پشتیبانی\n\nبرای ثبت درخواست، دکمه «شروع درخواست پشتیبانی» را بزنید و مشکل را در یک پیام توضیح دهید.\n\n🔐 رمز عبور، اطلاعات بانکی یا کلید خصوصی ارسال نکنید.',
  help:'📘  راهنمای استفاده\n\n۱. از «خرید اشتراک» بسته موردنظر را انتخاب کنید.\n۲. پس از ثبت سفارش، رسید پرداخت را در همین ربات بفرستید.\n۳. نتیجه بررسی را در «سفارش‌های من» دنبال کنید.\n۴. لینک اتصال و حجم مصرفی در «اشتراک‌های من» قرار می‌گیرد.\n۵. برای پیگیری مشکل از «پشتیبانی» استفاده کنید.',
  privacy:'🔐  حریم خصوصی\n\nمدار فقط اطلاعات ضروری برای مدیریت حساب، سفارش و پشتیبانی را نگهداری می‌کند.\n\nرمز عبور، اطلاعات کارت بانکی، کلید خصوصی و اطلاعات ورود سرور را در گفت‌وگو ارسال نکنید.',
  orders:'🧾  سفارش‌های من\n\nآخرین سفارش‌ها، مبلغ و وضعیت بررسی رسید در این بخش نمایش داده می‌شود.',
  tickets:'💬  درخواست‌های پشتیبانی من\n\nدرخواست‌های ثبت‌شده و پاسخ‌های پشتیبانی را از این بخش دنبال کنید.',
  lang:'🌐  زبان ربات\n\nزبان ربات مدار فارسی است.',
  unknown:'این گزینه شناخته نشد. برای نمایش منوی اصلی، «خانه» را انتخاب کنید.',
};
export function botPage(page) {
  const resolved=page==='customer:tickets'?'tickets':
    (page==='customer:home'||page==='admin:home')?'home':page;
  const body=Object.hasOwn(pages,resolved)?pages[resolved]:pages.unknown;
  return {text:frameMessage(body),replyMarkup:botMenu()};
}
