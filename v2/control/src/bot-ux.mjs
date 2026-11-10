/** Telegram Bot v2 UX: localized, predictable, no false sales/connection claims. */
const messages = {
  fa: {
    home: '🌐 مدار ۲.۰\n\nخوش آمدید! همه‌چیز در یک منوی ساده در دسترس است. این نسخه فعلاً آزمایشی است؛ فروش و صدور کانفیگ هنوز فعال نشده‌اند.',
    plans: '🛍 پلن‌های مدار\n\nتا تأیید امنیت پرداخت، ظرفیت سرورها و اتصال واقعی، فروش در این نسخه غیرفعال است. اشتراک‌های فعلی در ربات قبلی محفوظ می‌مانند.',
    my: '👤 اشتراک من\n\nنمایش اشتراک‌های نسخه ۲ پس از تکمیل مهاجرت فعال می‌شود. فعلاً اشتراک قبلی خود را از ربات فعلی مدیریت کنید.',
    status: '📶 وضعیت سرویس\n\nمدار ۲.۰ در حال آزمایش است. اتصال و فعال بودن نودهای جدید هنوز تأیید نشده است.',
    support: '💬 پشتیبانی\n\nصندوق پشتیبانی نسخه جدید هنوز منتشر نشده است؛ از مسیر پشتیبانی قبلی استفاده کنید.',
    help: '❓ راهنما\n\nاز دکمه‌های همین منو استفاده کنید. برای بازگشت /start را بفرستید. هیچ پرداختی در نسخه آزمایشی دریافت نمی‌شود.',
    privacy: '🔐 حریم خصوصی\n\nمدار ۲.۰ به حداقل داده‌های لازم برای اشتراک و پشتیبانی محدود می‌شود. از واردکردن رمز، اطلاعات کارت یا کلید خصوصی در چت خودداری کنید.',
    unknown: 'این دستور را نشناختم. برای نمایش منو /start را بفرستید.',
    homeBtn: '🏠 خانه', plansBtn: '🛍 پلن‌ها', myBtn: '👤 اشتراک من',
    statusBtn: '📶 وضعیت', supportBtn: '💬 پشتیبانی',
    helpBtn: '❓ راهنما', privacyBtn: '🔐 حریم خصوصی',
  },
  en: {
    home: '🌐 Madar 2.0\n\nWelcome! This is an isolated preview. Payments and VPN configuration issuance are not enabled.',
    plans: '🛍 Plans\n\nSales remain disabled until payments, node capacity and live connectivity have passed their acceptance tests.',
    my: '👤 My subscription\n\nV2 subscriptions are not enabled. Continue managing any existing plan through the current bot.',
    status: '📶 Service status\n\nMadar 2.0 is under testing. New VPN nodes have not passed live field acceptance.',
    support: '💬 Support\n\nV2 support inbox is not available yet. Please use the existing support channel.',
    help: '❓ Help\n\nUse the buttons below, or /start to return home. This preview never requests payment.',
    privacy: '🔐 Privacy\n\nPlease do not send passwords, card details or private VPN keys to this bot.',
    unknown: 'Unknown command. Use /start to open the menu.',
    homeBtn: '🏠 Home', plansBtn: '🛍 Plans', myBtn: '👤 My plan',
    statusBtn: '📶 Status', supportBtn: '💬 Support',
    helpBtn: '❓ Help', privacyBtn: '🔐 Privacy',
  },
};

export function botMenu(locale = 'fa') {
  const t = messages[locale] ?? messages.fa;
  return { inline_keyboard: [
    [{text:t.plansBtn,callback_data:'v2:plans'},{text:t.myBtn,callback_data:'v2:my'}],
    [{text:t.statusBtn,callback_data:'v2:status'},{text:t.supportBtn,callback_data:'v2:support'}],
    [{text:t.helpBtn,callback_data:'v2:help'},{text:t.privacyBtn,callback_data:'v2:privacy'}],
    [{text:t.homeBtn,callback_data:'v2:home'}],
  ]};
}

export function botPage(page, locale='fa') {
  const t=messages[locale]??messages.fa;
  const safePage=Object.hasOwn(t,page)&&typeof t[page]==='string'&&!page.endsWith('Btn')?page:'unknown';
  return {text:t[safePage],replyMarkup:botMenu(locale)};
}
