import { botPage } from './bot-ux.mjs';

export async function verifyTelegramSecret(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string' || !expected) return false;
  const digest = async (s) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  const [a, b] = await Promise.all([digest(provided), digest(expected)]);
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a[i] ^ b[i];
  return mismatch === 0;
}

const commands = Object.freeze({
  '/start':'home', home:'home', '/plans':'plans', '/my':'my',
  '/status':'status', '/support':'support', '/help':'help',
  '/privacy':'privacy',
});

export function toBotMessage(update) {
  if (!Number.isSafeInteger(update?.update_id) || update.update_id < 0) return null;
  const event = update.message ?? update.callback_query?.message;
  const chatId = event?.chat?.id;
  if (!Number.isSafeInteger(chatId)) return null;
  const input = update.callback_query?.data ?? update.message?.text ?? '';
  if (typeof input !== 'string' || input.length > 256) return null;
  const key = input.startsWith('v2:') ? input.slice(3) : input.split(' ')[0].split('@')[0];
  const language = update.message?.from?.language_code ?? update.callback_query?.from?.language_code ?? 'fa';
  const locale = language.startsWith('en') ? 'en' : 'fa';
  const result=botPage(commands[key] ?? key,locale);
  return {
    updateId: update.update_id,
    chatId: String(chatId),
    text:result.text,
    replyMarkup:result.replyMarkup,
    callbackId: typeof update.callback_query?.id==='string' ? update.callback_query.id.slice(0,128) : null,
  };
}
