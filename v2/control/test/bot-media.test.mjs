import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readdirSync,readFileSync} from 'node:fs';
import {resolveBotAction} from '../src/shop.mjs';
import {toBotMessage} from '../src/telegram.mjs';
import {processInbox} from '../src/index.mjs';

function fixture(){
  const raw=new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys=ON');
  for(const path of readdirSync(new URL('../migrations/',import.meta.url)).sort())
    raw.exec(readFileSync(new URL('../migrations/'+path,import.meta.url),'utf8'));
  raw.exec("INSERT INTO customers(telegram_id) VALUES('100'),('200'),('300'),('400')");
  const prepare=(sql,args=[])=>({
    bind(...params){return prepare(sql,params);},
    async first(){return raw.prepare(sql).get(...args)??null;},
    async all(){return {results:raw.prepare(sql).all(...args)};},
    async run(){return {meta:raw.prepare(sql).run(...args)};},
  });
  const DB={prepare,async batch(steps){
    raw.exec('BEGIN');try{
      const out=[];for(const s of steps)out.push(await s.run());
      raw.exec('COMMIT');return out;
    }catch(e){raw.exec('ROLLBACK');throw e;}
  }};
  const env={DB,ADMIN_TELEGRAM_IDS:'100',SHOP_ENABLED:'false',PROVISIONING_ENABLED:'false'};
  const e=(actorId,key,inputText=null,updateId=1,photoId=null)=>({
    actorId:String(actorId),chatId:String(actorId),key,inputText,updateId,photoId,locale:'fa'
  });
  return {raw,env,e};
}
test('Telegram image caption is available to support, without treating caption as a callback',()=>{
  const parsed=toBotMessage({update_id:71,message:{
    chat:{id:200,type:'private'},from:{id:200},caption:'تصویر مشکل در اینترنت',
    photo:[{file_id:'small-file-12345'},{file_id:'large-file-67890'}],
  }});
  assert.equal(parsed.photoId,'large-file-67890');
  assert.equal(parsed.inputText,'تصویر مشکل در اینترنت');
  assert.equal(parsed.key,'text');
});
test('support screenshot creates a private ticket, never a receipt even with an open order',async()=>{
  const {raw,env,e}=fixture(),now=1000000;
  raw.exec("INSERT INTO plans(id,title_fa,title_en,price_amount,price_currency,quota_bytes,duration_days) "+
    "VALUES('month','ماهیانه','month',50000,'IRT',1073741824,30)");
  raw.exec("INSERT INTO orders(id,customer_telegram_id,plan_id,idempotency_key,quoted_amount,quoted_currency) "+
    "VALUES('order-1','200','month','key1',50000,'IRT')");
  await resolveBotAction(env,e(200,'support',null,70),now);
  const saved=await resolveBotAction(env,e(200,'text','این مشکل روی ایرانسل رخ داده است',71,'img-file-101'),now+1);
  assert.match(saved.text,/درخواست تصویری ثبت شد/);
  assert.equal(raw.prepare("SELECT state FROM orders WHERE id='order-1'").get().state,'pending');
  assert.equal(raw.prepare("SELECT COUNT(*) n FROM receipts").get().n,0);
  const message=raw.prepare("SELECT body,telegram_file_id,role FROM support_messages WHERE id='support-media:71'").get();
  assert.equal(message.telegram_file_id,'img-file-101');
  assert.match(message.body,/ایرانسل/);
  assert.equal(message.role,'customer');
  assert.equal(raw.prepare("SELECT COUNT(*) n FROM telegram_notifications WHERE chat_id='100'").get().n,1);
  const duplicate=await resolveBotAction(env,e(200,'text','همان تصویر',71,'img-file-101'),now+2);
  assert.match(duplicate.text,/قبلاً/);
  assert.equal(raw.prepare("SELECT COUNT(*) n FROM receipts").get().n,0);
  assert.equal(raw.prepare("SELECT COUNT(*) n FROM support_messages").get().n,1);
  const permitted=await resolveBotAction(env,e(200,'customer:ticket:media:71',null,72),now+3);
  assert.equal(permitted.photoId,'img-file-101');
  assert.ok(permitted.replyMarkup.inline_keyboard.flat().some(x=>x.callback_data==='v2:customer:ticket:tg-71'));
  const forbidden=await resolveBotAction(env,e(400,'customer:ticket:media:71',null,73),now+4);
  assert.match(forbidden.text,/اجازه مشاهده/);
  assert.ok(!forbidden.photoId);
  const details=await resolveBotAction(env,e(200,'customer:ticket:tg-71',null,74),now+5);
  assert.ok(details.replyMarkup.inline_keyboard.flat().some(x=>x.callback_data==='v2:customer:ticket:media:71'));
  raw.close();
});
test('customers and support agents exchange photos through tickets, with access checks and notifications',async()=>{
  const {raw,env,e}=fixture(),now=1000000;
  raw.exec("INSERT INTO staff_roles(telegram_id,role,granted_by) VALUES('300','support','100')");
  raw.exec("INSERT INTO support_tickets(id,customer_telegram_id,subject,state) "+
    "VALUES('tg-91','200','کیفیت اتصال','waiting')");
  await resolveBotAction(env,e(200,'customer:ticket:reply:tg-91',null,91),now);
  const customer=await resolveBotAction(env,e(200,'text','اسکرین‌شات سرعت',92,'screenshot-customer-92'),now+1);
  assert.match(customer.text,/تصویر به درخواست/);
  assert.equal(raw.prepare("SELECT state FROM support_tickets WHERE id='tg-91'").get().state,'open');
  await resolveBotAction(env,e(300,'ticket:reply:tg-91',null,93),now+2);
  const support=await resolveBotAction(env,e(300,'text','نتیجه آزمون',94,'screenshot-support-94'),now+3);
  assert.match(support.text,/به مشتری اطلاع داده شد/);
  assert.equal(raw.prepare("SELECT state FROM support_tickets WHERE id='tg-91'").get().state,'waiting');
  assert.equal(raw.prepare("SELECT COUNT(*) n FROM telegram_notifications WHERE chat_id='200'").get().n,1);
  const agents=await resolveBotAction(env,e(300,'ticket:view:tg-91',null,95),now+4);
  assert.ok(agents.replyMarkup.inline_keyboard.flat().some(x=>x.callback_data==='v2:ticket:media:92'));
  assert.ok(agents.replyMarkup.inline_keyboard.flat().some(x=>x.callback_data==='v2:ticket:media:94'));
  const photo=await resolveBotAction(env,e(300,'ticket:media:94',null,96),now+5);
  assert.equal(photo.photoId,'screenshot-support-94');
  const denied=await resolveBotAction(env,e(400,'ticket:media:94',null,97),now+6);
  assert.match(denied.text,/دسترسی پشتیبانی ندارید/);
  assert.ok(!denied.photoId);
  const owner=await resolveBotAction(env,e(200,'customer:ticket:media:94',null,98),now+7);
  assert.equal(owner.photoId,'screenshot-support-94');
  raw.close();
});
test('suspended customer may send a screenshot only inside an active support composer',async()=>{
  const {raw,env,e}=fixture(),now=1000000;
  await resolveBotAction(env,e(200,'support',null,111),now);
  raw.exec("UPDATE customers SET state='suspended' WHERE telegram_id='200'");
  const media=await resolveBotAction(env,e(200,'text',null,112,'suspended-screenshot-112'),now+1);
  assert.match(media.text,/درخواست تصویری ثبت شد/);
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM support_messages').get().n,1);
  const other=await resolveBotAction(env,e(200,'text',null,113,'unknown-photo-113'),now+2);
  assert.match(other.text,/تعلیق/);
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM receipts').get().n,0);
  raw.close();
});

test('Telegram inbox never edits a screenshot caption into another photo or dashboard',async()=>{
  const {raw,env,e}=fixture(),now=1000000;
  raw.exec("INSERT INTO support_tickets(id,customer_telegram_id,subject) VALUES('tg-71','200','تصویر')");
  raw.exec("INSERT INTO support_messages(id,ticket_id,sender_telegram_id,body,role,telegram_file_id) "+
    "VALUES('support-media:71','tg-71','200','تصویر مشکل','customer','img-file-101')");
  const callback=(updateId,key,sourcePhotoId)=>({
    ...e(200,key,null,updateId),messageId:77,editKind:'caption',sourcePhotoId,
  });
  for(const item of [
    callback(400,'customer:ticket:media:71','brand-not-in-db'),
    callback(401,'customer:ticket:tg-71','img-file-101'),
    callback(402,'customer:ticket:tg-71','some-other-brand-image'),
  ]){
    raw.prepare("INSERT INTO telegram_inbox(update_id,chat_id,event_json,state,due_ms) "+
      "VALUES(?,'200',?,'pending',0)").run(item.updateId,JSON.stringify(item));
  }
  await processInbox(env,now);
  const photo=raw.prepare('SELECT media_file_id,edit_message_id,edit_kind FROM telegram_outbox WHERE update_id=400').get();
  assert.equal(photo.media_file_id,'img-file-101');
  assert.equal(photo.edit_message_id,null);
  assert.equal(photo.edit_kind,null);
  const fromAttachment=raw.prepare('SELECT media_file_id,edit_message_id FROM telegram_outbox WHERE update_id=401').get();
  assert.equal(fromAttachment.media_file_id,null);
  assert.equal(fromAttachment.edit_message_id,null);
  const fromBrand=raw.prepare('SELECT media_file_id,edit_message_id,edit_kind FROM telegram_outbox WHERE update_id=402').get();
  assert.equal(fromBrand.media_file_id,null);
  assert.equal(fromBrand.edit_message_id,77);
  assert.equal(fromBrand.edit_kind,'caption');
  assert.equal(raw.prepare("SELECT COUNT(*) n FROM receipts").get().n,0);
  raw.close();
});
