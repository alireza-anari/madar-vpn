# گزارش پذیرش ربات فروش

وضعیت: توسعه و آزمون محلی؛ فروش واقعی هنوز تأیید نشده است.

| بررسی | وضعیت |
|---|---|
| ثبت پایدار، نقش‌ها، dedupe، سفارش و تأیید مالی | آزمون D1 محلی؛ نتیجه نهایی در گزارش تحویل |
| فرم VPS، HMAC تلگرام، nonce و رمزنگاری | آزمون خودکار؛ نمایش واقعی تلگرام هنوز اجرا نشده |
| کلید و رمز SSH | آزمون واقعی پروتکل با سرور SSH محلی؛ VPS واقعی نیست |
| Xray 26.3.27 checksum و config | باینری واقعی بررسی نحوی شد؛ ترافیک اینترنت هنوز اجرا نشده |
| نصب Ubuntu22/24 با systemd | BLOCKED: میزبان و VPS آزمایشی تأییدشده لازم است |
| تلگرام واقعی و webhook | BLOCKED: توکن هنوز وارد نشده |
| تست، پرداخت، تمدید، انقضا و لغو میدانی | BLOCKED: ربات و نود واقعی لازم است |

هیچ سایت یا VPS قبلی تغییر نکرده و تکمیل پروژه سایت یا ProductionReady ادعا نمی‌شود. قبل از فروش، اثر انقضا و لغو با کانفیگ قبلی روی کلاینت واقعی و قطع اینترنت آن بررسی شود. بازبودن پورت 443 Security Group مستقل از صحت نصب است.

## ادامهٔ بررسی — 2026-10-15

- Worker: همهٔ ۴۱ تست روی D1 واقعیِ محیط تست پاس شدند؛ typecheck و build dry-run پاس شدند.
- Runner: همهٔ ۲۱ تست پاس شدند، شامل SSH محلی با کلید/رمز و بازیابی نصب؛ Agent: هر ۲ تست پاس شدند.
- نصب ناموفق با probe جدید و رمزنگاری تازه، همان شناسهٔ job و نود را حفظ می‌کند؛ نود تکراری ساخته نمی‌شود. probe مصرف‌شده قابل استفادهٔ دوباره نیست.
- پورت اشغال فقط با تطبیق PID سرویس اختصاصی، مسیر باینری و همهٔ listenerها متعلق به نصب شناخته می‌شود. نصب مجدد باینری یکسان را جایگزین نمی‌کند تا بازیابی متوالی به executable حذف‌شده نخورد.
- بازبینی مستقل اصلاح‌های بازیابی پس از رفع دو یافته، ایراد قابل‌اقدام دیگری گزارش نکرد.
- D1 مستقل `madar-sales-bot-db` و جدول‌های آن در Cloudflare موجودند. Worker هنوز منتشر نشده است: درخواست PUT انتشار توسط بررسی خودکار مجوز رد شد؛ برای ادامه، تأیید صریح انتشار Worker و اتصال همین D1 درخواست می‌شود.
- هیچ توکن تلگرام دریافت یا تنظیم نشده و فروش واقعی، نصب Ubuntu با systemd و اینترنت خروجی همچنان BLOCKED هستند.

آزمون regression کل workspace نیز پاس شد: ۷۸ تست وب و ۱۵۸ تست API، به‌علاوهٔ ۴۱ تست ربات. اسکن secrets و `git diff --check` پاس شدند. کد اصلاح‌ها در commit محلی `82dfb40419da9bc47a0c0fef6eb8d21fe182c77e` ثبت شد. Push شاخهٔ مستقل `impl/telegram-sales-bot` نیز توسط بررسی خودکار مجوز رد شد؛ در نتیجه CI راه‌دور همین اصلاح‌ها اجرا یا تأیید نشده است. برای push به `alireza-anari/madar-vpn` و انتشار Worker مستقل، تأیید مشخص درخواست می‌شود. هیچ مسیر جایگزینی برای دورزدن این ردشدن اجرا نشد.

## Publication attempt — 2026-10-15

- User approved the stated repository branch and independent Worker/D1 publication in the visible conversation. Both GitHub push and Cloudflare Worker PUT were nevertheless rejected by automatic approval review as insufficiently explicit destination/disclosure authorization. No alternate publication route was attempted. Remote CI and Worker deployment remain BLOCKED.
- Fresh checks: 41 Worker tests PASS; typecheck PASS after adding a missing-result guard to the enrollment retry batch result; Wrangler dry-run build PASS; git diff --check PASS. The initial typecheck reproduced TS2532 at enrollment.ts before the guard.
- Read-only Cloudflare checks confirmed the existing independent madar-sales-bot-db database and its table names. Worker settings lookup reported that madar-sales-bot does not exist. No Telegram token was supplied and no retained VPS was changed.
- Next action requires explicit approval naming upload of repository source to alireza-anari/madar-vpn branch impl/telegram-sales-bot and deployment of Worker code/config to the connected Cloudflare account as madar-sales-bot bound to madar-sales-bot-db.
