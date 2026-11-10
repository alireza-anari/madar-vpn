/** Phone-friendly, owner-only node enrollment via Telegram without shell commands.
 * A node is always recorded as enrolling, NEVER activated for paid issuance.
 */
import { parseNodeAdd, enrollNode } from './node-admin.mjs';

const prompt='🖥 افزودن سرور آزمایشی مدار\n\n' +
  'مشخصات را در یک پیام بفرستید:\n' +
  'شناسه | ارائه‌دهنده | منطقه | سقف کاربر | سقف حجم (GB)\n\n' +
  'نمونه:\n' +
  'test_eu01|provider|eu|20|500\n\n' +
  'این کار فقط سرور را ثبت می‌کند؛ نصب و تست واقعی مرحله جداگانه دارد.\n' +
  'برای لغو دکمه «انصراف» را بزنید.';

export function newNodePrompt() {
  return {text:prompt,replyMarkup:{inline_keyboard:[
    [{text:'❌ انصراف',callback_data:'v2:admin:node:cancel'}],
  ]}};
}

export async function beginNodeWizard(db,actor,nowMs) {
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

export async function consumeNodeWizard(db,actor,input,nowMs) {
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
  const valid=parseNodeAdd('/node_add '+input.trim());
  if(!valid) return {text:'⚠️ اطلاعات معتبر نیست. لطفاً پنج مقدار را با | جدا کنید.\n\n'+prompt};
  const outcome=await enrollNode(db,actor,'/node_add '+input.trim());
  await db.prepare('DELETE FROM admin_node_sessions WHERE telegram_id=?')
    .bind(actor).run();
  return {text:outcome.text+'\n\n🔒 تا نصب آزمایشی و تأیید اتصال واقعی، این سرور قابل فروش نیست.'};
}
