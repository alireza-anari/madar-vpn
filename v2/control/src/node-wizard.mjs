import {enqueueAutoNode,parseAutoNode} from './node-auto.mjs';
import {frameMessage,panelHeading} from './bot-ux.mjs';

/** راهنمای افزودن امن سرور؛ رمز و کلید خصوصی هرگز در تلگرام دریافت نمی‌شود. */
const prompt=panelHeading('🖥','افزودن خودکار سرور','راه‌اندازی امن از داخل پنل مدیریت')+'\n\n'+
  'اطلاعات زیر را به همین ترتیب و با علامت | از هم جدا کنید:\n'+
  'شناسه فنی | ارائه‌دهنده | منطقه | سقف کاربر | ظرفیت گیگابایت | نشانی IP\n\n'+
  'نمونه سرور آزمایشی:\n'+
  'test-aria01 | arianet | eu | 20 | 500 | 86.54.42.66\n\n'+
  'پس از ثبت، درخواست نصب به اجراکننده امن ارسال می‌شود.\n'+
  '🔐 رمز SSH، رمز عبور یا کلید خصوصی را در تلگرام ارسال نکنید.\n'+
  'برای لغو، دکمه «انصراف» را بزنید.';

export function newNodePrompt() {
  return {text:frameMessage(prompt),replyMarkup:{inline_keyboard:[
    [{text:'❌ انصراف',callback_data:'v2:admin:node:cancel'}],
    [{text:'↩️ مدیریت سرورها',callback_data:'v2:admin:nodes'}],
  ]}};
}

export async function beginNodeWizard(db,actor,nowMs,env=null) {
  if(env?.RUNNER_ENROLLMENT_ENABLED==='true')return {
    text:frameMessage(panelHeading('🖥','افزودن امن سرور','فرایند نصب خودکار و کنترل‌شده')+
      '\n\nفرم امن را باز کنید؛ بررسی اتصال و نصب توسط اجراکننده انجام می‌شود.\n'+
      '🔐 رمز عبور یا کلید خصوصی را در پیام تلگرام ارسال نکنید.'),
    replyMarkup:{inline_keyboard:[
      [{text:'🔒 باز کردن فرم امن افزودن سرور',web_app:{url:'https://madar-v2-staging.alirezaanari117.workers.dev/enroll'}}],
      [{text:'↩️ مدیریت سرورها',callback_data:'v2:admin:nodes'}],
    ]}
  };
  await db.prepare(
    "INSERT INTO admin_node_sessions(telegram_id,mode,expires_ms) VALUES(?,'add',?) "+
    "ON CONFLICT(telegram_id) DO UPDATE SET mode='add',expires_ms=excluded.expires_ms"
  ).bind(actor,nowMs+10*60*1000).run();
  return newNodePrompt();
}

export async function cancelNodeWizard(db,actor) {
  await db.prepare('DELETE FROM admin_node_sessions WHERE telegram_id=?')
    .bind(actor).run();
  return {text:frameMessage('✅ فرایند افزودن سرور لغو شد.'),replyMarkup:{inline_keyboard:[[{text:'↩️ مدیریت سرورها',callback_data:'v2:admin:nodes'}]]}};
}

export async function consumeNodeWizard(db,actor,input,nowMs,env=null) {
  if(typeof input!=='string'||!input.trim()||input.startsWith('/')||input.startsWith('v2:'))return null;
  const session=await db.prepare(
    'SELECT mode,expires_ms FROM admin_node_sessions WHERE telegram_id=?'
  ).bind(actor).first();
  if(!session||session.mode!=='add')return null;
  if(session.expires_ms<nowMs) {
    await db.prepare('DELETE FROM admin_node_sessions WHERE telegram_id=?').bind(actor).run();
    return {text:frameMessage('⌛ مهلت ثبت سرور به پایان رسید. از پنل مدیریت دوباره شروع کنید.'),replyMarkup:{inline_keyboard:[[{text:'↩️ مدیریت سرورها',callback_data:'v2:admin:nodes'}]]}};
  }
  const parsed=parseAutoNode(input.trim());
  if(!parsed)return {text:frameMessage('⚠️ اطلاعات واردشده معتبر نیست. شش مقدار را مطابق نمونه ارسال کنید.\n\n'+prompt),replyMarkup:{inline_keyboard:[[{text:'↩️ مدیریت سرورها',callback_data:'v2:admin:nodes'}]]}};
  if(!env)return {text:frameMessage('⚠️ اجرای خودکار تنظیم نشده است؛ هیچ سروری ثبت نشد.'),replyMarkup:{inline_keyboard:[[{text:'↩️ مدیریت سرورها',callback_data:'v2:admin:nodes'}]]}};
  const result=await enqueueAutoNode(env,actor,input.trim(),nowMs);
  if(result.error) {
    const errors={
      bad_input:'اطلاعات سرور معتبر نیست.',
      not_ready:'پایگاه داده آماده نیست.',
      automation_not_configured:'اتصال اجراکننده امن کامل نشده است.',
      already_exists:'این شناسه سرور قبلاً ثبت شده است.',
    };
    return {text:frameMessage('⚠️ ثبت سرور انجام نشد.\n'+(errors[result.error]??'خطای پیش‌بینی‌نشده؛ تنظیمات را بررسی کنید.')),replyMarkup:{inline_keyboard:[[{text:'↩️ مدیریت سرورها',callback_data:'v2:admin:nodes'}]]}};
  }
  await db.prepare('DELETE FROM admin_node_sessions WHERE telegram_id=?')
    .bind(actor).run();
  const status=result.dispatched
    ?'🚀 درخواست نصب امن به اجراکننده ارسال شد. وضعیت را از بخش «مدیریت سرورها» پیگیری کنید.'
    :'⏸ سرور ثبت شد، اما دسترسی امن اجراکننده هنوز برقرار نیست؛ نصب آغاز نشد.';
  return {text:frameMessage('✅ سرور '+parsed.id+' ثبت شد.\n'+status+
    '\n\n🔒 تا تأیید واقعی مسیرها، صدور کانفیگ برای فروش غیرفعال می‌ماند.'),replyMarkup:{inline_keyboard:[[{text:'↩️ مدیریت سرورها',callback_data:'v2:admin:nodes'}]]}};
}
