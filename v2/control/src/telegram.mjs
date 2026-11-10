export async function verifyTelegramSecret(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string' || !expected) return false;
  // Compare equal-length digests to avoid a character-by-character timing leak.
  const digest = async (s) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  const [a, b] = await Promise.all([digest(provided), digest(expected)]);
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a[i] ^ b[i];
  return mismatch === 0;
}

export function toBotMessage(update) {
  if (!Number.isSafeInteger(update?.update_id) || update.update_id < 0) return null;
  const event = update.message ?? update.callback_query?.message;
  const chatId = event?.chat?.id;
  if (!Number.isSafeInteger(chatId)) return null;
  const raw = update.callback_query?.data ?? update.message?.text ?? '';
  const command = String(raw).split(' ')[0].split('@')[0];
  let text;
  if (command === '/start' || command === 'home') {
    text = 'به مدار خوش آمدید 🌐\n\nنسخه جدید در حال آماده‌سازی است.\n/start — صفحه اصلی\n/status — وضعیت سرویس\n/help — راهنما';
  } else if (command === '/status' || command === 'status') {
    text = 'وضعیت: نسخه جدید در محیط آزمایشی است. هنوز هیچ کانفیگ تاییدنشده‌ای صادر نمی‌شود.';
  } else if (command === '/help' || command === 'help') {
    text = 'مدار | راهنما\nپشتیبانی و صدور اشتراک پس از تأیید تست‌های عملیاتی نسخه جدید فعال می‌شوند.';
  } else {
    text = 'دستور شناخته نشد. /start را ارسال کنید.';
  }
  return { updateId: update.update_id, chatId: String(chatId), text };
}
