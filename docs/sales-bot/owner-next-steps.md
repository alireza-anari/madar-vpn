# مرحلهٔ بعد در AWS

کد منبع این دستورات روی نسخهٔ ثابت `254803ab6dc859f7ff5c4436a25613fd5de53115` است. اجرای آن‌ها به دسترسی داخل سرور نیاز دارد؛ اتصال SSH فعالی از محیط اجرای این گفتگو در اختیار نیست. حالت فروش جدید تا تست واقعی فعال نمی‌شود.

## ۱. پورت‌های سرور فروش

در AWS برای Security Group مربوط به Madar_st1، ورودی TCP بازهٔ `20000–20999` را برای اتصال مشتریان مجاز کن. بازهٔ `21000–21999` فقط داخلی است و نباید در AWS باز شود. تنظیم SSH را تغییر نده.

## ۲. به‌روزرسانی Runner روی Node1 قدیمی

این دستور را در ترمینال EC2 سروری که Runner روی آن نصب است (Node1 قدیمی، نه Personal) اجرا کن. کلید و اتصال فعلی Runner حفظ می‌شود و جفت‌سازی دوباره انجام نمی‌شود.

```bash
f=$(mktemp) &&
curl -fsSL https://raw.githubusercontent.com/alireza-anari/madar-vpn/254803ab6dc859f7ff5c4436a25613fd5de53115/sales-runner/bootstrap.sh -o "$f" &&
printf '%s  %s\n' '186920de8ea924b139d90b1fbf8900b078679777bd42b0ecfcd5f44849e47113' "$f" | sha256sum -c - &&
sudo bash "$f" 254803ab6dc859f7ff5c4436a25613fd5de53115 --update &&
rm "$f"
```

## ۳. ارتقای Madar_st1

این دستور مخصوص ترمینال EC2 نود Madar_st1 با شناسهٔ ثبت‌شدهٔ زیر است. اسکریپت مالکیت، هویت و پورت‌ها را بررسی می‌کند و کلیدها را نگه می‌دارد. Worker باید قبلاً برای آماده‌سازی پروتکل فعال شده باشد؛ منوی فروش هنوز تغییر نمی‌کند.

```bash
f=$(mktemp) &&
curl -fsSL https://raw.githubusercontent.com/alireza-anari/madar-vpn/254803ab6dc859f7ff5c4436a25613fd5de53115/sales-node/update_owned.py -o "$f" &&
printf '%s  %s\n' 'baca681331d9d48a20eab593f414d52885b6aace63de3eeab4ce27338bf28b4b' "$f" | sha256sum -c - &&
sudo python3 "$f" --node-id f0e91435-c67d-4541-ae17-5c83832a260f --source-ref 254803ab6dc859f7ff5c4436a25613fd5de53115 --manifest-sha256 127ed930539b84636f63c7102eee1ed132c2ad18af02fd317752a6527f81ea18 --enable-quota &&
rm "$f"
```

خروجی موفق `OWNED_UPDATE_INSTALLED` است. اگر رد شد، متن خطا را بفرست؛ هیچ دستور حذف یا نصب مجدد جایگزین اجرا نکن.

## ۴. بررسی Personal

روی ترمینال Personal، فقط این بررسی خواندنی را اجرا کن و خروجی آن را بفرست. وجود سرویس قبلی نیاز به بررسی دارد و به معنی اجازهٔ جایگزینی خودکار آن نیست.

```bash
python3 - <<'PY'
import json, pathlib, subprocess
units=subprocess.run(['systemctl','list-unit-files','--no-legend','--no-pager'],capture_output=True,text=True,check=True).stdout
print(json.dumps({'os':pathlib.Path('/etc/os-release').read_text(),'vpnUnits':[line for line in units.splitlines() if line.startswith(('madar-','xray','v2ray','sing-box'))],'listeners':subprocess.run(['ss','-H','-ltn'],capture_output=True,text=True,check=True).stdout,'ownedManifest':pathlib.Path('/opt/madar-sales-node/manifest.json').exists()},indent=2))
PY
```

بعد از این مراحل، تست واقعی کانفیگ روی گوشی و لپ‌تاپ، قطع سقف حجم، تست نیم‌ساعته و فوروارد لینک مصرف انجام می‌شود؛ سپس فروشنده از منوی مدیر اضافه و حالت فروش فعال می‌شود.

محدودیت نسخهٔ فعلی: اگر پس از ری‌استارت، پیوستگی شمارنده قابل اثبات نباشد، حساب متوقف می‌شود و پشتیبانی باید آن را بررسی/دوباره صادر کند؛ حجم خودکار صفر نمی‌شود. Runner و VPSهای دیگر در این مراحل جابه‌جا یا خاموش نمی‌شوند.
