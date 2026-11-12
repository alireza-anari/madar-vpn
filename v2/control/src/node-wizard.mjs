import {enqueueAutoNode,parseAutoNode} from './node-auto.mjs';
/** Phone-friendly, owner-only node enrollment via Telegram without shell commands.
 * A node is always recorded as enrolling, NEVER activated for paid issuance.
 */
import { parseNodeAdd, enrollNode } from './node-admin.mjs';

const prompt='🖥 افزودن خودکار سرور در مدار V2\n\n' +
  'این ۶ مقدار را با | جدا کن:\n' +
  'شناسه | ارائه‌دهنده | منطقه | سقف کاربر | سقف حجم گیگ | IP\n\n' +
  'مثال برای سرور آزمایشی فعلی:\n' +
  'test-aria01|arianet|eu|20|500|86.54.42.66\n\n' +
  'پس از ثبت، ربات نصب خودکار را به اجراکننده امن واگذار می‌کند.\n' +
  'رمز SSH یا کلید خصوصی را در تلگرام ارسال نکن.\n' +
  'برای لغو «انصراف» را بزن.';
export function newNodePrompt() {
  return {text:prompt,replyMarkup:{inline_keyboard:[
    [{text:'❌ انصراف',callback_data:'v2:admin:node:cancel'}],
  ]}};
}

export async function beginNodeWizard(db,actor,nowMs,env=null) {
  if(env?.RUNNER_ENROLLMENT_ENABLED==='true')return {
    text:'🖥 افزودن خودکار سرور مدار V2\nفرم امن را باز کن؛ اتصال و نصب توسط اجراکننده انجام می‌شود. رمز یا کلید را در پیام تلگرام نفرست.',
    replyMarkup:{inline_keyboard:[[{text:'🔒 افزودن سرور',web_app:{url:'https://madar-v2-staging.alirezaanari117.workers.dev/enroll'}}]]}
  };
  await db.prepare(
    "INSERT INTO admin_node_sessions(telegram_id,mode,expires_ms) VALUES(?,'add',?) " +
    "ON CONFLICT(telegram_id) DO UPDATE SET mode='add',expires_ms=excluded.expires_ms"
  ).bind(actor,nowMs+10*60*1000).run();
  return newNodePrompt();
}

export async function cancelNodeWizard(db,actor) {
  await db.prepare('DELETE FROM admin_node_sessions WHERE telegram_id=?')
    .bind(actor).run();
  return {text:'✅ ثبت سرور لغو شد.'};
}

export async function consumeNodeWizard(db,actor,input,nowMs,env=null) {
  if(typeof input!=='string'||!input.trim()||input.startsWith('/')||
     input.startsWith('v2:'))return null;
  const session=await db.prepare(
    'SELECT mode,expires_ms FROM admin_node_sessions WHERE telegram_id=?'
  ).bind(actor).first();
  if(!session||session.mode!=='add')return null;
  if(session.expires_ms<nowMs) {
    await db.prepare('DELETE FROM admin_node_sessions WHERE telegram_id=?').bind(actor).run();
    return {text:'⌛ مهلت ثبت سرور تمام شد. از پنل مدیریت دوباره شروع کنید.'};
  }
  const parsed=parseAutoNode(input.trim());
  if(!parsed)
    return {text:'⚠️ اطلاعات معتبر نیست. شش مقدار را طبق نمونه ارسال کن.\n\n'+prompt};
  if(!env)
    return {text:'⚠️ اجرای خودکار تنظیم نشده است؛ هیچ سروری ثبت نشد.'};
  const result=await enqueueAutoNode(env,actor,input.trim(),nowMs);
  if(result.error)
    return {text:'⚠️ ثبت سرور انجام نشد: '+result.error+'. وضعیت سرورهای موجود را بررسی کن.'};
  await db.prepare('DELETE FROM admin_node_sessions WHERE telegram_id=?')
    .bind(actor).run();
  const status=result.dispatched
    ?'🚀 دستور نصب امن به اجراکننده ارسال شد. از بخش سرورها وضعیت را بررسی کن.'
    :'⏸ سرور ثبت شد ولی مجوز اجرای امن هنوز تنظیم نشده است؛ نصب اجرا نشد.';
  return {text:'✅ سرور '+parsed.id+' ثبت شد.\n'+status+
    '\n\n🔒 تا تأیید واقعی مسیرها، صدور کانفیگ برای فروش بسته است.'};
}
