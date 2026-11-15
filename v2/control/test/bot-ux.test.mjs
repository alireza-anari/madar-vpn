import test from 'node:test';
import assert from 'node:assert/strict';
import { botMenu,botPage } from '../src/bot-ux.mjs';
import {toBotMessage} from '../src/telegram.mjs';

test('all menu callbacks lead to a meaningful supported page',()=>{
  const menu=botMenu();
  const buttons=menu.inline_keyboard.flat();
  assert.equal(buttons.length,10);
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
  assert.match(plans,/فروش.*غیرفعال/);
  assert.match(botPage('status').text,/تأیید نشده/);
  assert.match(botPage('home','en').text,/not enabled/);
});
test('validates Telegram updates and displays localized help',()=>{
  assert.equal(toBotMessage({update_id:1,message:{chat:{id:'not an integer'},text:'/start'}}),null);
  assert.equal(toBotMessage({update_id:1,message:{chat:{id:123,type:'private'},from:{id:123},text:'x'.repeat(2001)}}),null);
  const msg=toBotMessage({update_id:2,message:{chat:{id:123,type:'private'},from:{id:123,language_code:'en-US'},text:'/help'}});
  assert.match(msg.text,/Help/);
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
