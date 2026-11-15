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
};
export function faStatus(value) {
  const key=String(value??'').toLowerCase();
  return states[key]??(key||'نامشخص');
}
export function faRole(value) {
  return ({seller:'فروشنده',support:'پشتیبان',admin:'مدیر'})[value]??String(value??'');
}
export function frameMessage(content) {
  const body=String(content??'').trim();
  if(body.startsWith('🌐  مــدار\n━━━━━━━━━━━━━━━━━━'))return body;
  return '🌐  مــدار\n━━━━━━━━━━━━━━━━━━\n'+body+'\n━━━━━━━━━━━━━━━━━━';
}

const customerMenu={inline_keyboard:[
  [
    {text:'🛍 خرید اشتراک',callback_data:'v2:plans'},
    {text:'👤 اشتراک من',callback_data:'v2:my'},
  ],
  [
    {text:'🧾 سفارش‌های من',callback_data:'v2:orders'},
    {text:'💬 پشتیبانی',callback_data:'v2:support'},
  ],
  [
    {text:'📶 وضعیت سرویس',callback_data:'v2:status'},
    {text:'❓ راهنما',callback_data:'v2:help'},
  ],
  [
    {text:'🔐 حریم خصوصی',callback_data:'v2:privacy'},
    {text:'🏠 خانه',callback_data:'v2:home'},
  ],
]};
const managerMenu={inline_keyboard:[
  [
    {text:'🖥 مدیریت سرورها',callback_data:'v2:admin:nodes'},
    {text:'🧪 لینک‌های آزمایشی',callback_data:'v2:admin:node:trials'},
  ],
  [
    {text:'🛍 مدیریت پلن‌ها',callback_data:'v2:admin:plans'},
    {text:'🧾 بررسی رسیدها',callback_data:'v2:admin:queue'},
  ],
  [
    {text:'💬 صندوق پشتیبانی',callback_data:'v2:admin:tickets'},
    {text:'👥 مدیریت مشتریان',callback_data:'v2:admin:customers'},
  ],
  [
    {text:'🧑‍💼 کارکنان و فروشندگان',callback_data:'v2:admin:staff'},
    {text:'🏠 خانه',callback_data:'v2:home'},
  ],
]};
const sellerMenu={inline_keyboard:[
  [
    {text:'🧾 سفارش‌های من',callback_data:'v2:seller:orders'},
    {text:'🔗 ساخت لینک معرفی',callback_data:'v2:seller:invite'},
  ],
  [
    {text:'🔒 لغو لینک‌های قبلی',callback_data:'v2:seller:revoke'},
    {text:'🏠 خانه',callback_data:'v2:home'},
  ],
]};
const supportMenu={inline_keyboard:[
  [{text:'💬 صندوق پشتیبانی',callback_data:'v2:admin:tickets'}],
  [{text:'🏠 خانه',callback_data:'v2:home'}],
]};
export function botMenu() { return structuredClone(customerMenu); }
export function adminMenu() { return structuredClone(managerMenu); }
export function sellerMenu() { return structuredClone(sellerMenu); }
export function supportMenu() { return structuredClone(supportMenu); }

const pages={
  home:'🌐 به مدار خوش آمدید\n\nاز منوی پایین می‌توانید اشتراک، سفارش‌ها و درخواست‌های پشتیبانی خود را مدیریت کنید.\n\n⛔ فروش عمومی تا تکمیل آزمون‌های اتصال و کنترل مصرف غیرفعال است. لطفاً پرداختی انجام ندهید.',
  plans:'🛍  خرید اشتراک\n\nفروش عمومی غیرفعال است. پس از تأیید پرداخت، ظرفیت سرورها و کنترل سهمیه، پلن‌ها در همین بخش منتشر می‌شوند.\n\nاشتراک‌های نسخه قبلی شما مستقل و محفوظ هستند.',
  my:'👤  اشتراک من\n\nوضعیت اشتراک، میزان مصرف، تاریخ انقضا و لینک اتصال در این بخش نمایش داده می‌شود.',
  status:'📶  وضعیت سرویس\n\nمدار در مرحله آزمون نهایی قرار دارد. مسیرهای تأییدنشده هنوز آماده استفاده نیستند؛ فقط مسیرهایی که آزمون واقعی اتصال را گذرانده باشند فعال می‌شوند.',
  support:'💬  پشتیبانی\n\nبرای ثبت درخواست، دکمه «شروع درخواست پشتیبانی» را بزنید و مشکل را در یک پیام توضیح دهید.\n\n🔐 رمز عبور، اطلاعات بانکی یا کلید خصوصی ارسال نکنید.',
  help:'❓  راهنمای استفاده\n\n۱. از «خرید اشتراک» پلن‌های فعال را ببینید.\n۲. از «اشتراک من» وضعیت و حجم مصرفی را بررسی کنید.\n۳. در «سفارش‌های من» نتیجه بررسی رسید را ببینید.\n۴. برای پیگیری مشکل از «پشتیبانی» استفاده کنید.\n\nبرای بازگشت به منوی اصلی، «خانه» را بزنید.',
  privacy:'🔐  حریم خصوصی\n\nمدار فقط اطلاعات ضروری برای مدیریت حساب، سفارش و پشتیبانی را نگهداری می‌کند.\n\nرمز عبور، اطلاعات کارت بانکی، کلید خصوصی و اطلاعات ورود سرور را در گفت‌وگو ارسال نکنید.',
  orders:'🧾  سفارش‌های من\n\nآخرین سفارش‌ها، مبلغ و وضعیت بررسی رسید در این بخش نمایش داده می‌شود.',
  tickets:'💬  درخواست‌های پشتیبانی من\n\nدرخواست‌های ثبت‌شده و پاسخ‌های پشتیبانی را از این بخش دنبال کنید.',
  lang:'🌐  زبان ربات\n\nزبان ربات مدار فارسی است.',
  unknown:'این گزینه شناخته نشد. برای نمایش منوی اصلی، «خانه» را انتخاب کنید.',
};
export function botPage(page) {
  const resolved=page==='customer:tickets'?'tickets':page;
  const body=Object.hasOwn(pages,resolved)?pages[resolved]:pages.unknown;
  return {text:frameMessage(body),replyMarkup:botMenu()};
}
