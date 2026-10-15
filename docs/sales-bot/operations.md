# عملیات

وضعیت inbox/outbox با query فقط‌خواندنی count بر حسب state پایش شود؛ محتوای payload شامل رسید یا لینک است و نباید چاپ شود. dead-letter باید علت ثابت و بدون secrets داشته باشد. تکرار sendMessage در پاسخ مبهم شبکه ممکن است؛ اعتبار مالی با trigger یکتا دوباره اعمال نمی‌شود.

D1 با `wrangler d1 export madar-sales-bot-db --remote --output <private-path>` پشتیبان گرفته شود؛ فایل شامل داده مشتری و سیاست نود است و باید با دسترسی 0600، خارج git نگهداری شود. بازیابی ابتدا روی دیتابیس آزمایشی مستقل و با غیرفعال‌بودن Runner و webhook بررسی شود. UUID، لینک اشتراک و کلیدها در evidence قرار نگیرند.

در رخداد امنیتی: webhook secret و Runner service secret را rotate کن؛ bot token در BotFather قابل لغو است. credential هر نود با پاک‌کردن token_hash آن در D1 لغو می‌شود؛ نود پس از انقضای policy حداکثر ۳۰۰ ثانیه fail-closed خواهد شد. خاموشی فوری فقط از پنل میزبان تأییدشده و سرویس مستقل madar-sales ممکن است. لغو مشتری از منوی ربات به revision جدید و ACK واقعی نیاز دارد.

لغو نصب و rollback فقط با manifest همان job و فقط برای فایل‌ها و unitهای madar-sales انجام شود. هیچ VPS حذف نشود. SSH و firewall برای عیب‌یابی خودکار تغییر نکنند.
