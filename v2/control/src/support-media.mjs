/** Private Telegram support photos. Photos are attached only to an explicit
 * live support composer, never silently interpreted as payment receipts. */
import {frameMessage,sectionNavigation} from './bot-ux.mjs';
import {notifySupport} from './bot-panels.mjs';

const ID=/^[0-9]{1,20}$/;
const mediaId=e=>'support-media:'+e.updateId;
const button=(label,key)=>[{text:label,callback_data:'v2:'+key}];
const reply=(message,buttons=[],role='customer')=>({
  text:frameMessage(message),
  replyMarkup:{inline_keyboard:[...buttons,...sectionNavigation(role)]},
});
function admin(env,id){
  return ID.test(id??'')&&typeof env.ADMIN_TELEGRAM_IDS==='string'&&
    env.ADMIN_TELEGRAM_IDS.split(',').map(x=>x.trim()).includes(id);
}
async function canSupport(env,e){
  if(admin(env,e.actorId))return true;
  const allowed=await env.DB.prepare(
    "SELECT 1 AS ok FROM staff_roles sr JOIN customers c ON c.telegram_id=sr.telegram_id "+
    "WHERE sr.telegram_id=? AND sr.role='support' AND c.state='active'"
  ).bind(e.actorId).first();
  return allowed?.ok===1;
}
const caption=e=>(typeof e.inputText==='string'?e.inputText.trim():'').slice(0,1000)||'📷 تصویر پیوست';
export async function receiveSupportPhoto(env,e,nowMs=Date.now()){
  if(typeof e.photoId!=='string'||e.photoId.length<5||e.photoId.length>512)return null;
  const db=env.DB,id=mediaId(e),body=caption(e);
  // Inbox crash/retry safety: once an image is support media, never save it as a receipt.
  const prior=await db.prepare("SELECT ticket_id,role FROM support_messages WHERE id=? AND telegram_file_id=?")
    .bind(id,e.photoId).first();
  if(prior)return reply('✅ تصویر قبلاً به گفت‌وگوی پشتیبانی اضافه شده است.',[
    button('💬 مشاهده گفت‌وگو',prior.role==='support'?'ticket:view:'+prior.ticket_id:
      'customer:ticket:'+prior.ticket_id)],prior.role==='support'?'support':'customer');
  const initial=await db.prepare(
    "SELECT expires_ms FROM customer_sessions WHERE telegram_id=? AND mode='support'"
  ).bind(e.actorId).first();
  if(initial){
    if(initial.expires_ms<=nowMs){
      await db.prepare("DELETE FROM customer_sessions WHERE telegram_id=? AND mode='support'")
        .bind(e.actorId).run();
      return reply('⌛ مهلت ثبت درخواست تمام شد؛ از بخش پشتیبانی دوباره شروع کنید.');
    }
    const ticketId='tg-'+e.updateId;
    await db.batch([
      db.prepare("INSERT OR IGNORE INTO support_tickets(id,customer_telegram_id,subject) VALUES(?,?,?)")
        .bind(ticketId,e.actorId,body==='📷 تصویر پیوست'?'درخواست تصویری':body.slice(0,140)),
      db.prepare("INSERT OR IGNORE INTO support_messages(id,ticket_id,sender_telegram_id,body,role,telegram_file_id) "+
        "VALUES(?,?,?,?,'customer',?)").bind(id,ticketId,e.actorId,body,e.photoId),
      db.prepare("DELETE FROM customer_sessions WHERE telegram_id=? AND mode='support'").bind(e.actorId),
    ]);
    await notifySupport(env,e,ticketId,nowMs);
    return reply('✅ درخواست تصویری ثبت شد.\nکد پیگیری: '+ticketId,[
      button('💬 مشاهده درخواست','customer:ticket:'+ticketId)]);
  }
  const customer=await db.prepare(
    "SELECT context_id,expires_ms FROM v2_bot_input_sessions WHERE telegram_id=? AND mode='ticket_reply'"
  ).bind(e.actorId).first();
  if(customer){
    if(customer.expires_ms<=nowMs){
      await db.prepare("DELETE FROM v2_bot_input_sessions WHERE telegram_id=? AND mode='ticket_reply'")
        .bind(e.actorId).run();
      return reply('⌛ مهلت پاسخ تصویری تمام شد؛ درخواست را دوباره باز کنید.');
    }
    const ticket=await db.prepare(
      "SELECT id FROM support_tickets WHERE id=? AND customer_telegram_id=? AND state IN ('open','waiting')"
    ).bind(customer.context_id,e.actorId).first();
    if(!ticket)return reply('⛔ امکان افزودن تصویر به این گفت‌وگو وجود ندارد.');
    await db.batch([
      db.prepare("INSERT OR IGNORE INTO support_messages(id,ticket_id,sender_telegram_id,body,role,telegram_file_id) "+
        "VALUES(?,?,?,?,'customer',?)").bind(id,ticket.id,e.actorId,body,e.photoId),
      db.prepare("UPDATE support_tickets SET state='open' WHERE id=? AND state='waiting'").bind(ticket.id),
      db.prepare("DELETE FROM v2_bot_input_sessions WHERE telegram_id=? AND mode='ticket_reply'")
        .bind(e.actorId),
    ]);
    await notifySupport(env,e,ticket.id,nowMs);
    return reply('✅ تصویر به درخواست پشتیبانی اضافه شد.',[
      button('💬 مشاهده گفت‌وگو','customer:ticket:'+ticket.id)]);
  }
  const agent=await db.prepare(
    "SELECT ticket_id,expires_ms FROM support_staff_sessions WHERE telegram_id=?"
  ).bind(e.actorId).first();
  if(!agent)return null;
  if(agent.expires_ms<=nowMs){
    await db.prepare("DELETE FROM support_staff_sessions WHERE telegram_id=?").bind(e.actorId).run();
    return reply('⌛ مهلت ارسال تصویر پایان یافته است.',[],'support');
  }
  if(!await canSupport(env,e))return reply('⛔ دسترسی پشتیبانی ندارید.',[],'support');
  const ticket=await db.prepare(
    "SELECT id,customer_telegram_id FROM support_tickets WHERE id=? AND state IN ('open','waiting')"
  ).bind(agent.ticket_id).first();
  if(!ticket)return reply('⛔ درخواست بسته شده یا در دسترس نیست.',[],'support');
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO support_messages(id,ticket_id,sender_telegram_id,body,role,telegram_file_id) "+
      "VALUES(?,?,?,?,'support',?)").bind(id,ticket.id,e.actorId,body,e.photoId),
    db.prepare("UPDATE support_tickets SET state='waiting' WHERE id=? AND state='open'").bind(ticket.id),
    db.prepare("DELETE FROM support_staff_sessions WHERE telegram_id=?").bind(e.actorId),
    db.prepare("INSERT OR IGNORE INTO telegram_notifications(id,chat_id,body,state,due_ms) "+
      "VALUES(?,?,?,'pending',?)").bind('support:photo:'+e.updateId,ticket.customer_telegram_id,
        '📷 یک تصویر جدید از پشتیبانی در درخواست '+ticket.id+' ثبت شد.\nبرای دیدن آن، گفت‌وگو را در ربات باز کنید.',nowMs),
    db.prepare("INSERT OR IGNORE INTO audit_events(event_id,actor_id,object_type,object_id,verb) "+
      "VALUES(?,?,?,?,?)").bind('support:photo:'+e.updateId,e.actorId,'support_ticket',ticket.id,'reply:media'),
  ]);
  return reply('✅ تصویر در گفت‌وگو ثبت و به مشتری اطلاع داده شد.',[
    button('💬 مشاهده درخواست','ticket:view:'+ticket.id)],'support');
}
export async function viewSupportPhoto(env,e,updateId,ownerOnly=true){
  if(!ID.test(updateId??''))return reply('⚠️ تصویر درخواستی معتبر نیست.');
  if(!ownerOnly&&!await canSupport(env,e))return reply('⛔ دسترسی پشتیبانی ندارید.');
  const row=await env.DB.prepare(
    "SELECT m.body,m.telegram_file_id,m.ticket_id,t.customer_telegram_id "+
    "FROM support_messages m JOIN support_tickets t ON t.id=m.ticket_id "+
    "WHERE m.id=? AND m.telegram_file_id IS NOT NULL "+
    (ownerOnly?"AND t.customer_telegram_id=?":'')
  ).bind(...(ownerOnly?['support-media:'+updateId,e.actorId]:['support-media:'+updateId])).first();
  if(!row)return reply('⚠️ تصویر یافت نشد یا اجازه مشاهده آن را ندارید.');
  const parent=(ownerOnly?'customer:ticket:':'ticket:view:')+row.ticket_id;
  return {
    text:frameMessage('🖼 تصویر پشتیبانی\nکد پیگیری: '+row.ticket_id+
      '\n'+row.body.slice(0,500)),
    photoId:row.telegram_file_id,
    replyMarkup:{inline_keyboard:[button('↩️ بازگشت به گفت‌وگو',parent)]},
  };
}
