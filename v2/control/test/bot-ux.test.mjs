import test from 'node:test';
import assert from 'node:assert/strict';
import { botMenu,adminMenu,supportMenu,sellerMenu,botPage,faMoney,faGB,faStatus,faDate } from '../src/bot-ux.mjs';
import {toBotMessage} from '../src/telegram.mjs';

test('all menu callbacks lead to a meaningful supported page',()=>{
  const menu=botMenu();
  const buttons=menu.inline_keyboard.flat();
  assert.equal(buttons.length,8);
  for(const button of buttons){
    const msg=toBotMessage({update_id:3,callback_query:{id:'callback',
      from:{id:900,language_code:'fa'},data:button.callback_data,message:{chat:{id:900,type:'private'}}}});
    assert.equal(msg.chatId,'900');
    assert.ok(msg.text.length>15);
    assert.doesNotMatch(msg.text,/نشناختم/);
    assert.deepEqual(msg.replyMarkup,menu);
  }
});
test('no false advertising of live VPN or payment readiness',()=>{
  const plans=botPage('plans').text;
  assert.match(plans,/فروش عمومی غیرفعال است/);
  assert.match(botPage('status').text,/تأییدنشده/);
  assert.match(botPage('home','en').text,/به مدار خوش آمدید/);
});
test('validates Telegram updates and displays localized help',()=>{
  assert.equal(toBotMessage({update_id:1,message:{chat:{id:'not an integer'},text:'/start'}}),null);
  assert.equal(toBotMessage({update_id:1,message:{chat:{id:123,type:'private'},from:{id:123},text:'x'.repeat(2001)}}),null);
  const msg=toBotMessage({update_id:2,message:{chat:{id:123,type:'private'},from:{id:123,language_code:'en-US'},text:'/help'}});
  assert.match(msg.text,/راهنمای استفاده/);
});

test('private Telegram identity enforced for all customer and admin entrypoints',()=>{
  const base={update_id:500,message:{chat:{id:123,type:'private'},from:{id:123},text:'/my'}};
  assert.ok(toBotMessage(base));
  assert.equal(toBotMessage({...base,message:{...base.message,chat:{id:123,type:'group'}}}),null);
  assert.equal(toBotMessage({...base,message:{...base.message,from:{id:456}}}),null);
  assert.equal(toBotMessage({...base,message:{...base.message,from:{id:123,is_bot:true}}}),null);
});

test('support and plan messages may exceed callback limits, typed callbacks cannot impersonate buttons',()=>{
  const long='شرح مشکل و اتصال اینترنت '.repeat(25);
  const note=toBotMessage({update_id:901,message:{chat:{id:123,type:'private'},from:{id:123},text:long}});
  assert.ok(note);
  assert.equal(note.inputText,long);
  assert.equal(note.key,'text');
  const forged=toBotMessage({update_id:902,message:{chat:{id:123,type:'private'},from:{id:123},text:'v2:admin:home'}});
  assert.ok(forged);
  assert.equal(forged.key,'text');
  assert.notEqual(forged.key,'admin:home');
  const invalidCallback=toBotMessage({update_id:903,callback_query:{
    from:{id:123},data:'v2:'+('x'.repeat(300)),message:{chat:{id:123,type:'private'}}
  }});
  assert.equal(invalidCallback,null);
});

test('bot menus are Persian-only, compact and visually consistent',()=>{
  const menu=botMenu();
  assert.equal(menu.inline_keyboard.length,4);
  for(const row of menu.inline_keyboard)assert.ok(row.length<=2);
  for(const button of menu.inline_keyboard.flat())assert.doesNotMatch(button.text,/[A-Za-z]/);
  const page=botPage('home','en');
  assert.match(page.text,/🌐  مــدار/);
  assert.doesNotMatch(page.text,/[A-Za-z]{3,}/);
});

test('manager, seller and support menus use Persian labels and local display formats',()=>{
  for(const menu of [adminMenu(),sellerMenu(),supportMenu()]){
    for(const button of menu.inline_keyboard.flat())assert.doesNotMatch(button.text,/[A-Za-z]{3,}/);
  }
  assert.equal(faGB(30),'۳۰ گیگابایت');
  assert.equal(faMoney(300000,'IRT'),'۳۰۰٬۰۰۰ تومان');
  assert.equal(faStatus('receipt_submitted'),'رسید ارسال شده');
  assert.match(faDate('2026-11-15'),/۱۴۰۵/);
});
