# مرحلهٔ بعد در AWS

این runbook مربوط به معماری fresh `shared-443` است. دستورهای قدیمی که public ingress بازهٔ `20000–20999` می‌ساختند منسوخ‌اند و نباید اجرا شوند. rollout فقط از روی **exact green commit** انجام شود؛ یعنی همان SHA چهل‌کاراکتری که هر دو workflow `CI` و `Telegram sales bot` برای آن موفق شده‌اند. از `main`، `latest` یا یک SHA قدیمی استفاده نکن.

اجرای این مراحل به دسترسی داخل Runner و VPS هدف نیاز دارد. محیط گفت‌وگو به SSH سرورها دسترسی مستقیم ندارد، بنابراین تغییرات live باید در ترمینال همان سرورها اجرا و خروجی غیرمحرمانه بررسی شود. هیچ private key، token، password، credential، UUID مشتری یا config کامل را در چت قرار نده.

## ۱. قبل از نصب مجدد VPS هدف

روی VPS هدف فقط مالکیت و conflictهای قبلی را بررسی کن. installer عمداً روی سرویس یا مسیر ناشناخته overwrite نمی‌کند. اگر `EXISTING_SERVICE` دیدی، ابتدا مشخص کن دقیقاً کدام unit/path مربوط به نصب قدیمی Madar است؛ سرویس ناشناخته یا VPN دیگر را حذف نکن.

برای بررسی read-only:

```bash
printf '\n=== MADAR/XRAY UNITS ===\n'
systemctl list-unit-files --no-legend --no-pager \
  | grep -E '^(madar-|xray|v2ray|sing-box)' || true

printf '\n=== OLD PATHS ===\n'
for p in \
  /etc/madar-node-agent \
  /opt/madar-node-agent \
  /opt/madar-speed-enforcer \
  /etc/xray \
  /usr/local/etc/xray \
  /usr/local/bin/xray \
  /opt/madar-sales-node
do
  [ -e "$p" ] && echo "EXISTS $p"
done

printf '\n=== PORT 443 ===\n'
sudo ss -ltnp | grep ':443 ' || echo 'PORT_443_FREE'
```

## ۲. Runner را روی exact green commit به‌روز کن

روی EC2ای که `madar-sales-runner` اجرا می‌شود، `sales-runner/bootstrap.sh` را از exact green commit بگیر و ابتدا SHA256 همان فایل دانلودشده را با مقدار مستقلی که از همان commit محاسبه و ثبت شده تطبیق بده. سپس فقط این bootstrap را با همان REF و گزینهٔ update اجرا کن:

```text
sudo bash <verified-bootstrap-file> <EXACT_GREEN_REF> --update
```

`--update` pairing و کلیدهای Runner موجود را نگه می‌دارد. role attachment بدون این update کافی نیست. پس از update، probe قدیمی را reuse نکن؛ از ربات/Mini App یک probe تازه بگیر. برای EC2 منطبق در `eu-north-1` نتیجهٔ شبکه باید `AWS_NETWORK_READY` باشد. `AWS_ROLE_UNAVAILABLE` یا `AWS_NETWORK_PERMISSION_DENIED` باید به‌عنوان خطای IAM بررسی شود، نه با بازکردن دستی پورت‌های حساب.

## ۳. قواعد شبکهٔ fresh shared-443

برای enrollment جدید AWS فقط SSH از public IPv4 Runner با `/32` و TCP 443 عمومی لازم است. پورت‌های `20000–20999` bridge داخلی حساب و `21000–21999` stats داخلی‌اند و نباید public ingress داشته باشند. Rule قدیمی `20000–20999` را تا قبل از موفقیت field test روی 443 حذف نکن؛ بعد از اثبات اتصال واقعی روی 443 می‌توان آن rule قدیمی را از Security Group پاک کرد.

## ۴. نصب تازه از خود ربات

بعد از رفع conflictهای مالکیت، اطلاعات VPS را فقط از flow رسمی افزودن VPS وارد کن. نصب موفق باید به `INSTALLED` برسد و سپس نود فقط وقتی آمادهٔ فروش است که health تازه، exact policy ACK و capability `shared-443` ثبت شوند. هیچ state دیتابیس را دستی به ready تغییر نده.

روی VPS تازه با یک حساب فعال، این listenerها را بررسی کن:

```bash
sudo ss -ltnp | grep -E ':(443|19999|20000|21000) ' || true
```

انتظار: public `*:443`، HandlerService روی `127.0.0.1:19999`، bridge حساب روی `127.0.0.1:20000` و stats روی `127.0.0.1:21000`. وجود public `*:20000` خطاست.

## ۵. field acceptance قبل از فروش

یک تست تازه از ربات صادر کن. URI تحویلی برای نود `shared-443` باید public port `443` و SNI تعیین‌شدهٔ نود را داشته باشد و هرگز port داخلی account را نشان ندهد. سپس روی کلاینت واقعی اینترنت را تست کن، مصرف را بالا ببر و ثبت usage را بررسی کن، و cutoff حجم، لغو و انقضا را جداگانه ثابت کن. افت frontend باید capability `shared-443` و health را fail-closed کند و workerهای managed فعال را متوقف/مسدود کند.

فقط بعد از عبور این field gate می‌توان نود را sales-ready دانست و rule عمومی قدیمی `20000–20999` را، اگر از rollout قبلی باقی مانده، حذف کرد.
