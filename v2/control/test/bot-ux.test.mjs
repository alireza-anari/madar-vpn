import test from 'node:test';
import assert from 'node:assert/strict';
import { botMenu,adminMenu,supportMenu,sellerMenu,botPage,faMoney,faGB,faStatus,faDate,usageMeter,sectionNavigation,frameMessage,styleInlineKeyboard,contextualKeyboard,parentPage } from '../src/bot-ux.mjs';
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
  const manager=adminMenu();
  assert.equal(manager.inline_keyboard.length,4);
  assert.equal(manager.inline_keyboard.flat().length,7);
  for(const menu of [manager,sellerMenu(),supportMenu()]){
    for(const button of menu.inline_keyboard.flat())assert.doesNotMatch(button.text,/[A-Za-z]{3,}/);
  }
  assert.equal(faGB(30),'۳۰ گیگابایت');
  assert.equal(faMoney(300000,'IRT'),'۳۰۰٬۰۰۰ تومان');
  assert.equal(faStatus('receipt_submitted'),'رسید ارسال شده');
  assert.match(faDate('2026-11-15'),/۱۴۰۵/);
});

test('contextual navigation stays focused and quota progress is safe',()=>{
  const admin=sectionNavigation('admin').flat();
  assert.equal(admin.length,1);
  assert.ok(admin.some(b=>b.callback_data==='v2:admin:home'));
  assert.ok(!admin.some(b=>b.callback_data==='v2:admin:plans'));
  assert.equal(usageMeter(5,10),'▰▰▰▰▰▱▱▱▱▱  ۵۰٪');
  assert.match(usageMeter(0,0),/نامشخص/);
  assert.equal(usageMeter(-3,100),'▱▱▱▱▱▱▱▱▱▱  ۰٪');
});

test('Telegram native styling highlights the brand and section without parsing user HTML',async()=>{
  const {brandedEntities}=await import('../src/index.mjs');
  const text=frameMessage('🛠  پیشخوان مدیریت مدار\nمشتریان: ۳');
  const entities=brandedEntities(text);
  assert.equal(entities.length,2);
  assert.equal(entities[0].type,'bold');
  assert.equal(text.slice(entities[0].offset,entities[0].offset+entities[0].length),'🌐  مــدار');
  assert.equal(text.slice(entities[1].offset,entities[1].offset+entities[1].length),'🛠  پیشخوان مدیریت مدار');
  assert.deepEqual(brandedEntities('plain text'),[]);
});

test('Telegram semantic button accents are restricted and do not change callback identity',()=>{
  const menu=styleInlineKeyboard(adminMenu());
  const all=menu.inline_keyboard.flat();
  assert.equal(all.find(x=>x.callback_data==='v2:admin:nodes').style,'primary');
  assert.ok(!all.some(x=>x.callback_data==='v2:admin:node:new'));
  const serverMenu=styleInlineKeyboard({inline_keyboard:[[
    {text:'➕ افزودن سرور',callback_data:'v2:admin:node:new'}
  ]]});
  assert.equal(serverMenu.inline_keyboard[0][0].style,'success');
  assert.equal(all.find(x=>x.callback_data==='v2:admin:customers').style,undefined);
  const seller=styleInlineKeyboard(sellerMenu()).inline_keyboard.flat();
  assert.equal(seller.find(x=>x.callback_data==='v2:seller:revoke').style,'danger');
  const original=adminMenu();
  assert.ok(original.inline_keyboard.flat().every(x=>x.style===undefined));
  assert.deepEqual(menu.inline_keyboard.map(row=>row.map(x=>x.callback_data)),
    original.inline_keyboard.map(row=>row.map(x=>x.callback_data)));
});

test('nested Telegram sections show only local actions plus one back button',()=>{
  const adminRoot=adminMenu();
  const view={text:'👤 مشاهده نمای مشتری',callback_data:'v2:customer:home'};
  const root=contextualKeyboard('admin:home',{inline_keyboard:[[view],...adminRoot.inline_keyboard]},
    {isAdmin:true});
  assert.equal(root.inline_keyboard.flat().filter(x=>x.text.includes('نمای مشتری')).length,1);

  const server=contextualKeyboard('admin:nodes',{inline_keyboard:[
    [{text:'➕ افزودن سرور',callback_data:'v2:admin:node:new'},
     {text:'🧪 آزمون سرورها',callback_data:'v2:admin:node:trials'}],
    ...sectionNavigation('admin'),
    [view],
    ...adminRoot.inline_keyboard,
  ]},{isAdmin:true});
  const actions=server.inline_keyboard.flat();
  assert.deepEqual(actions.map(x=>x.callback_data),[
    'v2:admin:node:new','v2:admin:node:trials','v2:admin:home'
  ]);
  assert.equal(actions.at(-1).text,'↩️ بازگشت');
  assert.ok(!actions.some(x=>x.text.includes('نمای مشتری')));
  assert.ok(!actions.some(x=>x.callback_data==='v2:admin:plans'));

  const wizard=contextualKeyboard('admin:node:new',{inline_keyboard:[
    [{text:'❌ انصراف',callback_data:'v2:admin:node:cancel'}],
    ...adminRoot.inline_keyboard,
  ]},{isAdmin:true});
  assert.deepEqual(wizard.inline_keyboard.flat().map(x=>x.callback_data),
    ['v2:admin:node:cancel']);
  const seller=contextualKeyboard('seller:orders',{inline_keyboard:[
    ...sellerMenu().inline_keyboard,
    ...sectionNavigation('seller')
  ]});
  assert.equal(seller.inline_keyboard.at(-1)[0].callback_data,'v2:seller:home');
  assert.ok(seller.inline_keyboard.flat().length<=5);
});

test('back routes follow section hierarchy without self-links or customer preview',()=>{
  assert.equal(parentPage('admin:customer:123',true),'admin:customers');
  assert.equal(parentPage('admin:customer:suspend:123',true),'admin:customer:123');
  assert.equal(parentPage('admin:customer:confirm:activate:123',true),'admin:customer:123');
  assert.equal(parentPage('admin:receipt:order-1',true),'admin:queue');
  assert.equal(parentPage('admin:review:approve:order-1',true),'admin:receipt:order-1');
  assert.equal(parentPage('admin:plan:new',true),'admin:plans');
  assert.equal(parentPage('admin:staff:grant:seller',true),'admin:staff');
  assert.equal(parentPage('ticket:view:tg-19',true),'admin:tickets');
  assert.equal(parentPage('ticket:page:tg-19:2',true),'ticket:view:tg-19');
  assert.equal(parentPage('customer:ticket:page:tg-19:1'),'customer:ticket:tg-19');
  assert.equal(parentPage('admin:tickets:closed:2',true),'admin:tickets');
  assert.equal(parentPage('admin:configs',true),'admin:home');
  assert.equal(parentPage('admin:configs:trials:0',true),'admin:configs');
  assert.equal(parentPage('admin:configs:trial:'+'a'.repeat(24),true),'admin:configs:trials:0');
  assert.equal(parentPage('customer:ticket:tg-19'),'customer:tickets');
  assert.equal(parentPage('customer:ticket:reply:tg-19'),'customer:ticket:tg-19');
  assert.equal(parentPage('orders:view:order-1'),'orders');
  assert.equal(parentPage('my:link:sub-1'),'my');
  const nested=contextualKeyboard('admin:receipt:order-1',{
    inline_keyboard:[
      [{text:'✅ تأیید رسید',callback_data:'v2:admin:review:approve:order-1'}],
      ...sectionNavigation('admin')
    ]
  },{isAdmin:true}).inline_keyboard.flat();
  assert.deepEqual(nested.map(x=>x.callback_data),[
    'v2:admin:review:approve:order-1','v2:admin:queue'
  ]);
  const typed=contextualKeyboard('text',{inline_keyboard:[
    [{text:'↩️ مدیریت سرورها',callback_data:'v2:admin:nodes'}]
  ]},{isAdmin:true});
  assert.equal(typed.inline_keyboard.flat()[0].callback_data,'v2:admin:nodes');
});
