import { botPage } from './bot-ux.mjs';

export async function verifyTelegramSecret(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string' || !expected) return false;
  const digest = async (s) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  const [a,b]=await Promise.all([digest(provided),digest(expected)]);
  let mismatch=0;
  for(let i=0;i<a.length;i++) mismatch|=a[i]^b[i];
  return mismatch===0;
}

/** Returns only a safe, minimal event; never store raw Telegram update JSON. */
export function toBotMessage(update) {
  if (!Number.isSafeInteger(update?.update_id) || update.update_id < 0) return null;
  const event = update.message ?? update.callback_query?.message;
  const chatId=event?.chat?.id;
  const sender=update.message?.from ?? update.callback_query?.from;
  if (event?.chat?.type!=='private' || !Number.isSafeInteger(chatId) ||
      !Number.isSafeInteger(sender?.id) || sender.id!==chatId ||
      sender.is_bot===true) return null;
  const raw=update.callback_query?.data ?? update.message?.text ?? '';
  if (typeof raw!=='string' || raw.length>256) return null;
  const key=raw.startsWith('v2:') ? raw.slice(3) : raw.trim().split(/\s+/)[0].split('@')[0];
  const language=sender?.language_code;
  const locale=typeof language==='string' && language.startsWith('en')?'en':'fa';
  const photos=update.message?.photo;
  const lastPhoto=Array.isArray(photos)?photos.at(-1):null;
  const document=update.message?.document;
  const photoId=typeof lastPhoto?.file_id==='string' ? lastPhoto.file_id :
    (/^image\/(jpeg|png|webp)$/.test(document?.mime_type??'') &&
     typeof document.file_id==='string' ? document.file_id : null);
  const initialPage=key==='/start'?'home':key.startsWith('/')?key.slice(1):key;
  const page=botPage(initialPage || 'unknown',locale);
  return {
    updateId:update.update_id,
    actorId:String(sender.id),
    chatId:String(chatId),
    key,
    locale,
    inputText:typeof update.message?.text==='string' ? update.message.text.slice(0,2000) : null,
    photoId:photoId && photoId.length>=5 && photoId.length<=512 ? photoId : null,
    callbackId:typeof update.callback_query?.id==='string' ? update.callback_query.id.slice(0,128) : null,
    // Compatibility with early V2 preview tests, before inbox processing:
    text:page.text,
    replyMarkup:page.replyMarkup,
  };
}
