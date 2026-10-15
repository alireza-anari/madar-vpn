# فعال‌سازی امن

کد و Worker می‌توانند بدون توکن آماده شوند؛ تا تنظیم توکن و Runner و نود واقعی، فروش آماده نیست.

## تلگرام

1. در BotFather ربات بساز و توکن را خصوصی نگه دار؛ آن را در این چت نفرست.
2. در Cloudflare → Workers & Pages → madar-sales-bot → Settings → Variables and Secrets، `BOT_TOKEN` را از نوع Secret وارد کن.
3. شناسه عددی تلگرام ادمین را در `ADMIN_TELEGRAM_IDS` قرار بده. نام کاربری و ایمیل جایگزین این شناسه نیستند.
4. مقدار `PUBLIC_BASE_URL` باید آدرس HTTPS همین Worker مستقل باشد.
5. secret تصادفی webhook، Runner و policy و کلید عمومی Runner باید توسط ابزار setup امن تنظیم شوند. ابزار setup توکن را با getpass می‌گیرد، خروجی Telegram را چاپ نمی‌کند، getMe را بررسی و سپس setWebhook را اجرا می‌کند. اتصال Cloudflare CLI با حساب مالک لازم است؛ secrets داخل argv قرار نمی‌گیرند.
6. پس از ورود موفق، /start باید منوی ادمین بدهد؛ یک حساب دیگر باید فقط مشتری باشد.

## Runner و VPS

میزبان Runner هنوز انتخاب نشده است. با تأیید محل اجرا، کد Python و کلید خصوصی رمزگشایی روی آن نصب می‌شوند. config و private key باید 0600، مسیر خارج مخزن و فقط قابل خواندن برای کاربر Runner باشند. اجرای دائمی Runner نباید به لپ‌تاپ وابسته باشد.

کلید/رمز AWS یا VPS فقط از Mini App ادمین فرستاده می‌شود. ابتدا اثر انگشت SSH بررسی و تأیید می‌شود؛ سپس اطلاعات رمز می‌شوند و نصب شروع می‌شود. Ubuntu تازه لازم است؛ سرویس‌های موجود و پورت اشغال نصب را متوقف می‌کنند. VPSهای قبلی بدون تأیید جدا تغییر نمی‌کنند.

## پیش از فروش

در منوی ادمین اطلاعات پرداخت و پلن را با نام، قیمت تومان و تعداد روز تنظیم کن. ابتدا تست و یک خرید آزمایشی با حساب مشتری انجام بده؛ دریافت کانفیگ، IP خروجی، تمدید، لغو و انقضا را با کلاینت واقعی تأیید کن. عبارت «نامحدود» فقط به نبود سقف حجم برنامه اشاره دارد؛ محدودیت پهنای باند و هزینه ارائه‌دهنده همچنان برقرار است.

## ابزار فعال‌سازی

پس از تأیید کد و CI، روی میزبان امنی که قرار است Runner روی آن اجرا شود:

```bash
python3 -m venv .venv
.venv/bin/pip install paramiko==5.0.0 cryptography==50.0.2
pnpm exec wrangler login
.venv/bin/python sales-runner/setup.py --base-url https://YOUR-WORKER.workers.dev --admin-id YOUR_NUMERIC_ID --config-dir /PRIVATE/runner-config --worker-dir apps/sales-bot
```

توکن فقط در prompt مخفی درخواست می‌شود. پوشه config خصوصی باید خارج مخزن و پایدار باشد. فایل کلید خصوصی و config تولید می‌شوند؛ توکن ربات در فایل دائمی Runner ذخیره نمی‌شود. ابزار چند Secret را ثبت، متغیرهای غیرمحرمانه را تنظیم و webhook را فعال می‌کند. موفقیت ابزار فقط فعال‌شدن تنظیمات است، نه PASS آزمون فروش یا نود.

اجرای Runner با مسیر config، بدون secret در argv:

```bash
.venv/bin/python sales-runner/runner.py --config /PRIVATE/runner-config/runner.json
```

برای اجرای دائمی، مدیر میزبان service با کاربر اختصاصی و restart-on-failure تنظیم می‌کند؛ محل آن باید ابتدا مشخص شود. لپ‌تاپ برای اجرای دائمی مناسب نیست. اگر secrets ثبت شوند ولی deploy یا webhook شکست بخورد، ابزار را با همان پوشه خصوصی دوباره اجرا کن؛ کلید و service secret حفظ می‌شوند.
