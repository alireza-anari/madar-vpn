/** Telegram Bot v2 UX: localized, predictable, no false sales/connection claims. */
const messages = {
  fa: {
    home: '🌐 مدار ۲.۰\n\nخوش آمدید! همه‌چیز در یک منوی ساده در دسترس است. این محیط آزمایشی V2 در حال آماده‌سازی است. فروش غیرفعال است. مدیر می‌تواند از دکمه مدیریت، سرورها و لینک‌های تست را بررسی کند.',
    plans: '🛍 پلن‌های مدار\n\nتا تأیید امنیت پرداخت، ظرفیت سرورها و اتصال واقعی، فروش در این نسخه غیرفعال است. اشتراک‌های فعلی در ربات قبلی محفوظ می‌مانند.',
    my: '👤 اشتراک من\n\nوضعیت، حجم مصرفی و تاریخ انقضای اشتراک V2 در این بخش نمایش داده می‌شود. اشتراک قبلی شما مستقل باقی می‌ماند.',
    status: '📶 وضعیت سرویس\n\nمدار ۲.۰ در حال آزمایش است. اتصال و فعال بودن نودهای جدید هنوز تأیید نشده است.',
    support: '💬 پشتیبانی\n\nمی‌توانید یک تیکت جدید ثبت کنید و پاسخ پشتیبانی را در همان ربات دریافت کنید. رمز و کلید خصوصی ارسال نکنید.',
    help: '❓ راهنمای مدار\n\nاز «پلن‌ها» ظرفیت و پیشنهادهای فعال را ببینید؛ از «اشتراک من» وضعیت و لینک دو اپراتور را بگیرید؛ در «سفارش‌ها» وضعیت رسید را دنبال کنید و از «تیکت‌های من» با پشتیبانی گفتگو کنید. برای زبان /lang و بازگشت /start را بزنید. تا فعال‌شدن فروش عمومی هیچ پرداختی انجام ندهید.',
    privacy: '🔐 حریم خصوصی\n\nمدار ۲.۰ به حداقل داده‌های لازم برای اشتراک و پشتیبانی محدود می‌شود. از واردکردن رمز، اطلاعات کارت یا کلید خصوصی در چت خودداری کنید.',
    orders: '🧾 سفارش‌های من\n\nاز این بخش می‌توانید آخرین سفارش‌ها و وضعیت رسید را ببینید.',
    tickets: '💬 تیکت‌های من\n\nدرخواست‌ها و پاسخ‌های پشتیبانی در این بخش قابل مشاهده‌اند.',
    lang: '🌐 زبان\n\nزبان ربات را انتخاب کنید.',
    unknown: 'این دستور را نشناختم. برای نمایش منو /start را بفرستید.',
    homeBtn: '🏠 خانه', plansBtn: '🛍 پلن‌ها', myBtn: '👤 اشتراک من',
    statusBtn: '📶 وضعیت', supportBtn: '💬 پشتیبانی', ordersBtn:'🧾 سفارش‌های من', ticketsBtn:'💬 تیکت‌های من', langBtn:'🌐 زبان',
    helpBtn: '❓ راهنما', privacyBtn: '🔐 حریم خصوصی',
  },
  en: {
    home: '🌐 Madar 2.0\n\nWelcome! This is the isolated V2 test environment. Payments and public config issuance are not enabled; admins can manage test server enrollment and trial links.',
    plans: '🛍 Plans\n\nSales remain disabled until payments, node capacity and live connectivity have passed their acceptance tests.',
    my: '👤 My subscription\n\nView your V2 subscription, quota, expiration and eligible two-carrier link. Your V1 subscription stays independent.',
    status: '📶 Service status\n\nMadar 2.0 is under testing. New VPN nodes have not passed live field acceptance.',
    support: '💬 Support\n\nCreate a ticket and read replies here. Never send passwords or private VPN keys.',
    help: '❓ Help\n\nChoose Plans to see available offers, My plan for your quota and link, My orders for receipts, and My tickets to contact support. Use /lang to switch language and /start to return home. Do not pay while public checkout is disabled.',
    privacy: '🔐 Privacy\n\nPlease do not send passwords, card details or private VPN keys to this bot.',
    orders: '🧾 My orders\n\nView orders and receipt review status.',
    tickets: '💬 My tickets\n\nOpen support tickets and their replies.',
    lang: '🌐 Language\n\nChoose your bot language.',
    unknown: 'Unknown command. Use /start to open the menu.',
    homeBtn: '🏠 Home', plansBtn: '🛍 Plans', myBtn: '👤 My plan',
    statusBtn: '📶 Status', supportBtn: '💬 Support', ordersBtn:'🧾 My orders', ticketsBtn:'💬 My tickets', langBtn:'🌐 Language',
    helpBtn: '❓ Help', privacyBtn: '🔐 Privacy',
  },
};

export function botMenu(locale = 'fa') {
  const t = messages[locale] ?? messages.fa;
  return { inline_keyboard: [
    [{text:t.plansBtn,callback_data:'v2:plans'},{text:t.myBtn,callback_data:'v2:my'}],
    [{text:t.statusBtn,callback_data:'v2:status'},{text:t.supportBtn,callback_data:'v2:support'}],
    [{text:t.ordersBtn,callback_data:'v2:orders'},{text:t.ticketsBtn,callback_data:'v2:customer:tickets'}],
    [{text:t.helpBtn,callback_data:'v2:help'},{text:t.privacyBtn,callback_data:'v2:privacy'}],
    [{text:t.langBtn,callback_data:'v2:lang'}],
    [{text:t.homeBtn,callback_data:'v2:home'}],
  ]};
}

export function botPage(page, locale='fa') {
  const t=messages[locale]??messages.fa;
  const resolved=page==='customer:tickets'?'tickets':page;
  const safePage=Object.hasOwn(t,resolved)&&typeof t[resolved]==='string'&&!resolved.endsWith('Btn')?resolved:'unknown';
  return {text:t[safePage],replyMarkup:botMenu(locale)};
}
