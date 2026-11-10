import { getSubscription } from './subscription.mjs';
import { nodeRoute } from './node-control.mjs';
import { toBotMessage, verifyTelegramSecret } from './telegram.mjs';
import { resolveBotAction } from './shop.mjs';

const json=(value,status=200)=>new Response(JSON.stringify(value),{
  status,headers:{
    'content-type':'application/json; charset=utf-8','cache-control':'no-store',
    'x-content-type-options':'nosniff','referrer-policy':'no-referrer',
  },
});
const MAX_WEBHOOK_BYTES=32768;
const delay=(n)=>Math.min(3600000,5000*2**Math.min(n,9));

async function readJson(request) {
  if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers.get('content-type')??'')) return {status:415};
  const declared=Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared>MAX_WEBHOOK_BYTES) return {status:413};
  const reader=request.body?.getReader();
  if (!reader) return {status:400};
  const chunks=[]; let length=0;
  try {
    for (;;) {
      const {done,value}=await reader.read();
      if (done) break;
      length+=value.byteLength;
      if(length>MAX_WEBHOOK_BYTES) {await reader.cancel();return {status:413};}
      chunks.push(value);
    }
    const bytes=new Uint8Array(length);let off=0;
    for(const chunk of chunks) {bytes.set(chunk,off);off+=chunk.byteLength;}
    const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
    if(!value || typeof value!=='object' || Array.isArray(value)) return {status:400};
    return {value};
  } catch {return {status:400};}
  finally {reader.releaseLock();}
}

async function telegram(env,method,payload) {
  const response=await fetch('https://api.telegram.org/bot'+env.BOT_TOKEN+'/'+method,{
    method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify(payload),signal:AbortSignal.timeout(12000),
  });
  return response.ok && (await response.json()).ok===true;
}

/** A per-chat ordered durable inbox. A failed update is retried without
 * requiring Telegram to resend it; business writes must remain idempotent. */
export async function processInbox(env,nowMs=Date.now()) {
  if(!env.DB || !env.BOT_TOKEN) return;
  const rows=(await env.DB.prepare(
    "SELECT i.update_id,i.event_json,i.attempts FROM telegram_inbox i WHERE " +
    "((i.state='pending' AND i.due_ms<=?) OR (i.state='leased' AND i.lease_until_ms<=?)) " +
    "AND NOT EXISTS (SELECT 1 FROM telegram_inbox prev WHERE prev.chat_id=i.chat_id " +
    "AND prev.update_id<i.update_id AND prev.state IN ('pending','leased')) " +
    "ORDER BY i.update_id LIMIT 20"
  ).bind(nowMs,nowMs).all()).results??[];
  for(const item of rows) {
    const claim=await env.DB.prepare(
      "UPDATE telegram_inbox SET state='leased',lease_until_ms=?,attempts=attempts+1 WHERE update_id=? " +
      "AND ((state='pending' AND due_ms<=?) OR (state='leased' AND lease_until_ms<=?))"
    ).bind(nowMs+30000,item.update_id,nowMs,nowMs).run();
    if(claim.meta?.changes!==1) continue;
    try {
      const event=JSON.parse(item.event_json);
      if(event.updateId!==item.update_id) throw new Error('inbox_id_mismatch');
      const reply=await resolveBotAction(env,event,nowMs);
      const msg=reply??{text:'Unexpected response',replyMarkup:null};
      // This insert precedes marking inbox done. A crash will re-run the
      // idempotent action but cannot add a second outgoing reply.
      await env.DB.prepare(
        "INSERT OR IGNORE INTO telegram_outbox " +
        "(update_id,chat_id,body,reply_markup,media_file_id,state,due_ms) VALUES (?,?,?,?,?,'pending',?)"
      ).bind(item.update_id,event.chatId,msg.text.slice(0,3800),
        msg.replyMarkup?JSON.stringify(msg.replyMarkup):null,
        msg.photoId??null,nowMs).run();
      await env.DB.prepare(
        "UPDATE telegram_inbox SET state='done',lease_until_ms=0,event_json='{}' " +
        "WHERE update_id=? AND state='leased'"
      ).bind(item.update_id).run();
    } catch {
      const attempt=item.attempts+1;
      await env.DB.prepare(
        "UPDATE telegram_inbox SET state=?,lease_until_ms=0,due_ms=? WHERE update_id=? AND state='leased'"
      ).bind(attempt>=8?'dead':'pending',nowMs+delay(attempt),item.update_id).run();
    }
  }
}

/** Every table is a compile-time constant; never interpolate user data as SQL. */
async function deliverTable(env,name,nowMs,withPhoto) {
  const rows=(await env.DB.prepare(
    'SELECT id,chat_id,body,attempts'+(withPhoto?',reply_markup,media_file_id':'')+
    ' FROM '+name+" WHERE (state='pending' AND due_ms<=?) OR "+
    "(state='leased' AND lease_until_ms<=?) ORDER BY id LIMIT 20"
  ).bind(nowMs,nowMs).all()).results??[];
  for(const item of rows) {
    const claimed=await env.DB.prepare(
      'UPDATE '+name+" SET state='leased',lease_until_ms=?,attempts=attempts+1 WHERE id=? " +
      "AND ((state='pending' AND due_ms<=?) OR (state='leased' AND lease_until_ms<=?))"
    ).bind(nowMs+30000,item.id,nowMs,nowMs).run();
    if(claimed.meta?.changes!==1) continue;
    let sent=false;
    try {
      const markup=withPhoto && item.reply_markup?JSON.parse(item.reply_markup):null;
      const media=withPhoto && typeof item.media_file_id==='string' && item.media_file_id.length>0;
      sent=await telegram(env,media?'sendPhoto':'sendMessage',{
        chat_id:item.chat_id,
        ...(media?{photo:item.media_file_id,caption:item.body.slice(0,1024)}:{text:item.body}),
        ...(markup?{reply_markup:markup}:{}),
      });
    } catch { /* retry; no credentials, content or chat IDs in logs */ }
    if(sent) {
      await env.DB.prepare('UPDATE '+name+" SET state='sent',lease_until_ms=0 "+
        "WHERE id=? AND state='leased'").bind(item.id).run();
    } else {
      const attempt=item.attempts+1;
      await env.DB.prepare('UPDATE '+name+" SET state=?,lease_until_ms=0,due_ms=? " +
        "WHERE id=? AND state='leased'").bind(attempt>=8?'dead':'pending',nowMs+delay(attempt),item.id).run();
    }
  }
}

export async function dispatchOutbox(env,nowMs=Date.now()) {
  if(!env.DB || !env.BOT_TOKEN) return;
  await deliverTable(env,'telegram_outbox',nowMs,true);
  await deliverTable(env,'telegram_notifications',nowMs,false);
}

async function poll(env) {
  await processInbox(env);
  await dispatchOutbox(env);
}

async function receive(request,env,ctx) {
  if(!(await verifyTelegramSecret(request.headers.get('x-telegram-bot-api-secret-token'),
    env.TELEGRAM_WEBHOOK_SECRET))) return json({error:'unauthorized'},401);
  if(!env.DB || !env.BOT_TOKEN) return json({error:'not_ready'},503);
  const parsed=await readJson(request);
  if(parsed.status) return json({error:parsed.status===413?'too_large':'bad_request'},parsed.status);
  const event=toBotMessage(parsed.value);
  if(!event) return json({ok:true,ignored:true});
  const minimal={
    updateId:event.updateId,chatId:event.chatId,actorId:event.actorId,
    locale:event.locale,key:event.key,inputText:event.inputText,photoId:event.photoId,
  };
  const payload=JSON.stringify(minimal);
  if(payload.length>8192) return json({error:'too_large'},413);
  // Acknowledgement is sent only after the event has been persisted.
  await env.DB.prepare(
    "INSERT OR IGNORE INTO telegram_inbox(update_id,chat_id,event_json,state,due_ms) "+
    "VALUES(?,?,?,'pending',?)"
  ).bind(event.updateId,event.chatId,payload,Date.now()).run();
  ctx?.waitUntil?.(poll(env).catch(()=>{}));
  if(event.callbackId) ctx?.waitUntil?.(
    telegram(env,'answerCallbackQuery',{callback_query_id:event.callbackId,cache_time:0}).catch(()=>false)
  );
  return json({ok:true});
}

export default {
  async fetch(request,env,ctx) {
    const path=new URL(request.url).pathname;
    if(request.method==='GET' && path==='/health/live')
      return json({status:'alive',service:'madar-v2'});
    if(request.method==='GET' && path==='/health/ready') {
      if(!env.DB || !env.BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET)
        return json({status:'not_ready'},503);
      try {
        await env.DB.prepare('SELECT media_file_id FROM telegram_outbox LIMIT 1').first();
        await env.DB.prepare('SELECT event_json FROM telegram_inbox LIMIT 1').first();
        return json({status:'ready'});
      } catch {return json({status:'not_ready'},503);}
    }
    if(path==='/api/v2/subscription') {
      if(new URL(request.url).search) return json({error:'query_not_allowed'},400);
      try{return await getSubscription(request,env);}
      catch {return json({error:'temporary_failure'},503);}
    }
    if(path.startsWith('/api/node/v1/')) {
      try {return await nodeRoute(request,env);}
      catch {return json({error:'node_temporary_failure'},503);}
    }
    if(request.method==='POST' && path==='/telegram/webhook') {
      try{return await receive(request,env,ctx);}
      catch{return json({error:'temporary_failure'},503);}
    }
    return json({error:'not_found'},404);
  },
  async scheduled(_event,env) {
    await poll(env);
    if(env.DB) await env.DB.prepare('DELETE FROM node_nonces WHERE created_ms<?')
      .bind(Date.now()-10*60*1000).run();
  }
};
