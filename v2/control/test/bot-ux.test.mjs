import test from 'node:test';
import assert from 'node:assert/strict';
import { botMenu,botPage } from '../src/bot-ux.mjs';
import {toBotMessage} from '../src/telegram.mjs';

test('all menu callbacks lead to a meaningful supported page',()=>{
  const menu=botMenu();
  const buttons=menu.inline_keyboard.flat();
  assert.equal(buttons.length,7);
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
  assert.equal(toBotMessage({update_id:1,message:{chat:{id:123,type:'private'},from:{id:123},text:'x'.repeat(300)}}),null);
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
