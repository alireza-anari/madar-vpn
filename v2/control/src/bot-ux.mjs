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

/** The image is a public, non-sensitive visual asset; all live counts stay in the caption. */
export const BRAND_BANNER_URL='https://raw.githubusercontent.com/alireza-anari/madar-vpn/rewrite/madar-v2-20261110/apps/sales-bot/public/madar-logo.png';


const customerMenu={inline_keyboard:[
  [
    {text:'🛍 خرید اشتراک',callback_data:'v2:plans'},
    {text:'📦 اشتراک‌های من',callback_data:'v2:my'},
  ],
  [
    {text:'🧾 سفارش‌های من',callback_data:'v2:orders'},
    {text:'💬 پشتیبانی',callback_data:'v2:customer:tickets'},
  ],
  [
    {text:'📶 وضعیت سرویس',callback_data:'v2:status'},
    {text:'📘 راهنمای اتصال',callback_data:'v2:help'},
  ],
  [
    {text:'🔐 حریم خصوصی',callback_data:'v2:privacy'},
    {text:'🏠 خانه',callback_data:'v2:customer:home'},
  ],
]};
const managerMenu={inline_keyboard:[
  [
    {text:'📊 پیشخوان مدیریت',callback_data:'v2:admin:home'},
    {text:'🖥 مدیریت سرورها',callback_data:'v2:admin:nodes'},
  ],
  [
    {text:'➕ افزودن سرور',callback_data:'v2:admin:node:new'},
    {text:'🧪 آزمون سرورها',callback_data:'v2:admin:node:trials'},
  ],
  [
    {text:'🛍 مدیریت پلن‌ها',callback_data:'v2:admin:plans'},
    {text:'🧾 بررسی رسیدها',callback_data:'v2:admin:queue'},
  ],
  [
    {text:'👥 مشتریان',callback_data:'v2:admin:customers'},
    {text:'💬 صندوق پشتیبانی',callback_data:'v2:admin:tickets'},
  ],
  [
    {text:'🧑‍💼 کارکنان و فروشندگان',callback_data:'v2:admin:staff'},
  ],
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

/** دکمه‌های کم‌تعداد و وابسته به موقعیت؛ فقط صفحه نخست منوی کامل دارد. */
export function sectionNavigation(role='customer'){
  const nav={
    customer:[
      [{text:'🛍 خرید اشتراک',callback_data:'v2:plans'},
       {text:'🏠 خانه',callback_data:'v2:customer:home'}],
    ],
    admin:[
      [{text:'↩️ پیشخوان مدیریت',callback_data:'v2:admin:home'},
       {text:'👤 نمای مشتری',callback_data:'v2:customer:home'}],
    ],
    seller:[
      [{text:'↩️ پنل فروشنده',callback_data:'v2:seller:home'},
       {text:'🏠 خانه',callback_data:'v2:customer:home'}],
    ],
    support:[
      [{text:'↩️ صندوق پشتیبانی',callback_data:'v2:admin:tickets'},
       {text:'🏠 خانه',callback_data:'v2:customer:home'}],
    ]
  };
  return structuredClone(nav[role]??nav.customer);
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
