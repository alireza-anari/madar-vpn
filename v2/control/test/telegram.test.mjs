import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyTelegramSecret,toBotMessage } from '../src/telegram.mjs';
import { dispatchOutbox } from '../src/index.mjs';
import worker from '../src/index.mjs';
import {BRAND_BANNER_URL} from '../src/bot-ux.mjs';

test('rejects missing and mismatched webhook credentials', async () => {
  assert.equal(await verifyTelegramSecret('wrong','correct'),false);
  assert.equal(await verifyTelegramSecret('correct','correct'),true);
  assert.equal(await verifyTelegramSecret(null,'correct'),false);
  const response=await worker.fetch(new Request('https://localhost/telegram/webhook',
    {method:'POST',body:'{}'}),{TELEGRAM_WEBHOOK_SECRET:'correct'},{});
  assert.equal(response.status,401);
});
test('bounded bot parsing does not fake paid VPN issuance', () => {
  const msg=toBotMessage({update_id:123,message:{chat:{id:456,type:'private'},from:{id:456},text:'/start'}});
  assert.equal(msg.chatId,'456');
  assert.match(msg.text,/به مدار خوش آمدید/);
  assert.equal(toBotMessage({update_id:-1}),null);
});
test('callback parsing keeps the owning Telegram message for in-place navigation',()=>{
  const text=toBotMessage({update_id:124,callback_query:{
    id:'callback-1',data:'v2:my',from:{id:456},
    message:{message_id:77,chat:{id:456,type:'private'},text:'پنل مدار'},
  }});
  assert.equal(text.messageId,77);
  assert.equal(text.editKind,'text');
  const photo=toBotMessage({update_id:125,callback_query:{
    id:'callback-2',data:'v2:admin:review:approve:order-1',from:{id:456},
    message:{message_id:78,chat:{id:456,type:'private'},caption:'رسید',photo:[{file_id:'photo-id'}]},
  }});
  assert.equal(photo.messageId,78);
  assert.equal(photo.editKind,'caption');
});
function outboxFixture(row){
  let state='pending';
  const DB={prepare(sql){
    return {bind(...args){return {
      async all(){
        if(sql.includes('FROM telegram_outbox'))return {results:state==='pending'?[row]:[]};
        return {results:[]};
      },
      async run(){
        if(sql.includes("SET state='leased'")){state='leased';return {meta:{changes:1}};}
        if(sql.includes("SET state='sent'")){state='sent';return {meta:{changes:1}};}
        if(sql.includes("SET state=?")){state='pending';return {meta:{changes:1}};}
        return {meta:{changes:1}};
      },
    };}};
  }};
  return {DB,getState:()=>state};
}
test('outbox edits an existing text panel instead of adding another chat message',async()=>{
  const fixture=outboxFixture({
    id:1,chat_id:'456',body:'🌐  مــدار\n━━━━━━━━━━━━━━━━━━\n📦 اشتراک‌های من',
    attempts:0,reply_markup:JSON.stringify({inline_keyboard:[]}),
    media_file_id:null,edit_message_id:77,edit_kind:'text',
  });
  const original=globalThis.fetch,calls=[];
  globalThis.fetch=async(url,init)=>{
    calls.push({method:String(url).split('/').pop(),payload:JSON.parse(init.body)});
    return new Response(JSON.stringify({ok:true,result:{message_id:77}}),{status:200});
  };
  try{await dispatchOutbox({DB:fixture.DB,BOT_TOKEN:'test-token'},1000);}
  finally{globalThis.fetch=original;}
  assert.equal(calls.length,1);
  assert.equal(calls[0].method,'editMessageText');
  assert.equal(calls[0].payload.message_id,77);
  assert.equal(calls[0].payload.chat_id,'456');
  assert.equal(fixture.getState(),'sent');
});
test('outbox treats an unchanged Telegram panel as successfully delivered on retry',async()=>{
  const fixture=outboxFixture({
    id:2,chat_id:'456',body:'🌐  مــدار\n━━━━━━━━━━━━━━━━━━\n📦 اشتراک‌های من',
    attempts:1,reply_markup:JSON.stringify({inline_keyboard:[]}),
    media_file_id:null,edit_message_id:77,edit_kind:'text',
  });
  const original=globalThis.fetch,calls=[];
  globalThis.fetch=async(url,init)=>{
    calls.push(String(url).split('/').pop());
    return new Response(JSON.stringify({ok:false,description:'Bad Request: message is not modified'}),{status:400});
  };
  try{await dispatchOutbox({DB:fixture.DB,BOT_TOKEN:'test-token'},2000);}
  finally{globalThis.fetch=original;}
  assert.deepEqual(calls,['editMessageText']);
  assert.equal(fixture.getState(),'sent');
});
test('branded photo messages use native Telegram sendPhoto and preserve real inline buttons',async()=>{
  const fixture=outboxFixture({
    id:5,chat_id:'456',body:'🌐  مــدار\n👋 پنل کاربری مدار',
    attempts:0,reply_markup:JSON.stringify({inline_keyboard:[[{text:'اشتراک‌های من',callback_data:'v2:my'}]]}),
    media_file_id:BRAND_BANNER_URL,
    edit_message_id:null,edit_kind:null,
  });
  const original=globalThis.fetch,calls=[];
  globalThis.fetch=async(url,init)=>{
    assert.ok(init.body instanceof FormData);
    const photo=init.body.get('photo');
    assert.ok(photo instanceof Blob);
    assert.equal(photo.type,'image/jpeg');
    const bytes=new Uint8Array(await photo.arrayBuffer());
    assert.deepEqual([...bytes.slice(0,3)],[255,216,255]);
    assert.ok(bytes.length>3500);
    calls.push({method:String(url).split('/').pop(),payload:{
      caption:init.body.get('caption'),
      reply_markup:JSON.parse(init.body.get('reply_markup'))
    }});
    return new Response(JSON.stringify({ok:true,result:{message_id:92}}),{status:200});
  };
  try{await dispatchOutbox({DB:fixture.DB,BOT_TOKEN:'test-token'},1000);}
  finally{globalThis.fetch=original;}
  assert.equal(calls.length,1);
  assert.equal(calls[0].method,'sendPhoto');
  assert.match(calls[0].payload.caption,/پنل کاربری مدار/);
  assert.equal(calls[0].payload.reply_markup.inline_keyboard[0][0].callback_data,'v2:my');
  assert.equal(fixture.getState(),'sent');
});
test('branded photo dashboard edits its caption rather than stacking new photos',async()=>{
  const fixture=outboxFixture({
    id:6,chat_id:'456',body:'🌐  مــدار\n📊 پیشخوان مدیریت',
    attempts:0,reply_markup:JSON.stringify({inline_keyboard:[[{text:'سرورها',callback_data:'v2:admin:nodes'}]]}),
    media_file_id:BRAND_BANNER_URL,
    edit_message_id:91,edit_kind:'caption',
  });
  const original=globalThis.fetch,calls=[];
  globalThis.fetch=async(url,init)=>{
    calls.push({method:String(url).split('/').pop(),payload:JSON.parse(init.body)});
    return new Response(JSON.stringify({ok:true,result:{message_id:91}}),{status:200});
  };
  try{await dispatchOutbox({DB:fixture.DB,BOT_TOKEN:'test-token'},1000);}
  finally{globalThis.fetch=original;}
  assert.deepEqual(calls.map(c=>c.method),['editMessageCaption']);
  assert.equal(calls[0].payload.message_id,91);
  assert.ok(calls[0].payload.caption.includes('پیشخوان مدیریت'));
  assert.equal(fixture.getState(),'sent');
});
test('first-party Madar banner serves JPEG without database or secrets',async()=>{
  const response=await worker.fetch(new Request('https://localhost/brand/banner.jpg'),{},{});
  assert.equal(response.status,200);
  assert.match(response.headers.get('content-type'),/image\/jpeg/);
  const pixels=new Uint8Array(await response.arrayBuffer());
  assert.ok(pixels.length>3500);
  assert.deepEqual([...pixels.slice(0,3)],[255,216,255]);
  assert.deepEqual([...pixels.slice(-2)],[255,217]);
});
test('readiness fails closed without required bindings', async () => {
  const response=await worker.fetch(new Request('https://localhost/health/ready'),{},{});
  assert.equal(response.status,503);
});
