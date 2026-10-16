# نصب نود و محدوده تغییر

نصب‌کننده فقط Ubuntu 22.04/24.04 و معماری x86_64/aarch64 را می‌پذیرد. Xray نسخه 26.3.27 با checksum برگرفته از asset digest رسمی GitHub نصب می‌شود؛ checksum هنگام دانلود مجدداً بررسی می‌شود. REALITY کلید مجزا برای هر نود دارد.

فایل‌ها: `/opt/madar-sales-node`، `/etc/madar-sales-node`، `/run/madar-sales-node` و چهار unit با نام `madar-sales-*`. Firewall میزبان، SSH، سیستم‌عامل، سرویس‌های قدیمی و VPS حذف یا تغییر نمی‌شوند. بازبودن پورت 443 در تنظیمات ارائه‌دهنده باید مستقل بررسی شود؛ فعال‌شدن سرویس در داخل سرور عبور ترافیک از Security Group را تضمین نمی‌کند.

وجود سرویس قبلی باعث توقف می‌شود. پس از قطع Runner، job با lease جدید و manifest مالک همان job ادامه می‌یابد. نصب ناقص برای reconciliation نگه داشته می‌شود؛ `rollback(transport, job_id)` فقط برای لغو صریح نصب و manifest همان job است و مسیرهای همین نصب را پاک می‌کند. این کار روی نود دارای مشتری بدون برنامه انتقال انجام نشود.

راه‌اندازی مجدد نود ابتدا Xray را خاموش می‌کند. config و authorization در `/run` هستند؛ watchdog یک‌ثانیه‌ای و guard شروع سرویس جلوی استفاده از سیاست منقضی را می‌گیرند. در نودهای fresh پروتکل v2، frontend عمومی REALITY روی TCP 443 توسط `madar-sales-xray.service` مدیریت می‌شود و bridge هر حساب فقط روی loopback است. HandlerService نیز فقط loopback است. capability `shared-443` فقط وقتی اعلام می‌شود که frontend واقعاً زنده باشد؛ افت frontend باعث fail-closed شدن runtime و توقف/مسدودشدن workerهای فعال می‌شود.

آزمون محلی واقعی SSH با کلید و رمز و بررسی نحوی config توسط باینری pinned انجام می‌شود. نصب Ubuntu/systemd واقعی و آزمون عبور اینترنت، gate جدا هستند؛ شبیه‌سازی آن‌ها PASS میدانی نیست.

اگر نصب شکست خورد یا اطلاعات اتصال منقضی شد، فرم افزودن نود را دوباره باز کن و ابتدا بررسی اثر انگشت تازه بگیر. با همان IP، پورت، نام کاربری و اثر انگشت تأییدشده، اطلاعات ورود تازه را وارد کن؛ تلاش مجدد شناسهٔ نصب و نود قبلی را نگه می‌دارد. تغییر اثر انگشت یا مشخصات نصب قبلی نیازمند بررسی مالک است و خودکار جایگزین نمی‌شود.

## AWS automatic ingress

Runner روی EC2 از credential موقت instance role از طریق IMDSv2 استفاده می‌کند؛ هیچ AWS key در فرم، تلگرام، log یا disk ذخیره نمی‌شود. Runner در `eu-north-1` دقیقاً instance درحال‌اجرایی را که public IPv4 آن با IP هدف برابر است پیدا می‌کند. برای target منطبق، فقط این ingressها به اولین Security Group متصل اضافه می‌شوند:

- TCP پورت SSH همان job از public IPv4 خود Runner با ماسک `/32`.
- TCP 443 از `0.0.0.0/0` برای frontend عمومی REALITY.

پورت‌های bridge حساب‌ها (`20000–20999`) و stats (`21000–21999`) داخلی هستند و نباید به‌عنوان ingress عمومی AWS باز شوند. Ruleهای موجود حفظ می‌شوند. اگر Security Group مشترک باشد، ruleهای جدید روی instanceهای دیگری که همان group را دارند نیز اثر می‌گذارند. Runner instance، role، route، outbound rule و attachmentهای Security Group را تغییر نمی‌دهد. اگر target در AWS منطبق نباشد، مسیر معمول VPS/SSH ادامه پیدا می‌کند. نبودن یا ناکافی‌بودن IAM با safe code صریح fail می‌شود؛ regionهای غیر از `eu-north-1` در این مسیر خودکار پشتیبانی نمی‌شوند.

وصل‌کردن role به‌تنهایی Runner را به‌روز نمی‌کند. قبل از field acceptance، Runner را با `bootstrap.sh <EXACT_GREEN_REF> --update` روی همان commit دقیقی که CI آن سبز شده به‌روز کن، سپس یک probe تازه بگیر و برای EC2 منطبق انتظار `AWS_NETWORK_READY` داشته باش. بعد نصب تازه، listenerهای loopback و اتصال واقعی کلاینت روی public TCP 443 را بررسی کن. installer همچنان firewall داخل سیستم‌عامل را تغییر نمی‌دهد.
