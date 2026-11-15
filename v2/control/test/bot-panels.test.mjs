import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readdirSync,readFileSync} from 'node:fs';
import {
  adminDashboard,adminPanelAction,customerTicketAction,consumePanelInput,staffTicketDetails,
} from '../src/bot-panels.mjs';
import {resolveBotAction} from '../src/shop.mjs';

function database() {
  const raw=new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys=ON');
  for(const file of readdirSync(new URL('../migrations/',import.meta.url)).sort())
    raw.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
  const prepare=(sql,args=[])=>({
    bind(...next){return prepare(sql,next);},
    async first(){return raw.prepare(sql).get(...args)??null;},
    async all(){return {results:raw.prepare(sql).all(...args)};},
    async run(){return {meta:raw.prepare(sql).run(...args)};},
  });
  return {raw,DB:{prepare,async batch(statements) {
    raw.exec('BEGIN');
    try{const out=[];for(const st of statements)out.push(await st.run());raw.exec('COMMIT');return out;}
    catch(err){raw.exec('ROLLBACK');throw err;}
  }}};
}
function fixture() {
  const {raw,DB}=database();
  raw.exec("INSERT INTO customers(telegram_id,locale) VALUES('100','fa'),('200','fa'),('300','en')");
  const env={DB,ADMIN_TELEGRAM_IDS:'100',SHOP_ENABLED:'false',PROVISIONING_ENABLED:'false'};
  const event=(id,key,inputText=null,updateId=5)=>({actorId:String(id),chatId:String(id),
    updateId,locale:'fa',key,inputText,photoId:null});
  return {env,raw,event};
}

test('owner-only dashboard shows real counts with actions but no payment shortcut',async()=>{
  const {env,raw,event}=fixture();
  raw.exec("INSERT INTO nodes(id,provider,region,lifecycle,user_limit,byte_limit) VALUES('test-a','Webdade','test','provisioning',20,5000)");
  const a=await adminDashboard(env,event(100,'admin:home'));
  assert.match(a.text,/مشتریان: ۳/);
  assert.match(a.text,/سرورها: ۱/);
  assert.match(a.text,/فروش عمومی/);
  assert.match(a.photoId,/^https:\/\/madar-v2-staging\.alirezaanari117\.workers\.dev\/brand\/banner\.jpg$/);
  assert.ok(a.text.length<1024);
  assert.doesNotMatch(a.text,/━━━━━━━━/);
  const keys=a.replyMarkup.inline_keyboard.flat().map(x=>x.callback_data);
  for(const required of ['v2:admin:nodes','v2:admin:plans','v2:admin:queue',
    'v2:admin:staff','v2:admin:customers','v2:admin:tickets'])
    assert.ok(keys.includes(required));
  assert.ok(keys.includes('v2:customer:home')); // Admin dashboard preview only.
  assert.ok(!keys.includes('v2:admin:node:new'));
  assert.ok(!keys.includes('v2:admin:node:trials'));
  const nodePage=await resolveBotAction(env,event(100,'admin:nodes'),Date.now());
  const scoped=nodePage.replyMarkup.inline_keyboard.flat().map(b=>b.callback_data);
  assert.ok(scoped.includes('v2:admin:node:new'));
  assert.ok(scoped.includes('v2:admin:node:trials'));
  assert.ok(!nodePage.replyMarkup.inline_keyboard.flat().some(b=>b.text.includes('نمای مشتری')));
  const no=await adminDashboard(env,event(200,'admin:home'));
  assert.match(no.text,/دسترسی به این بخش مجاز نیست/);
  assert.equal(await env.DB.prepare("SELECT COUNT(*) AS n FROM node_trial_links").first().then(x=>x.n),0);
  raw.close();
});

test('customer support ticket has owner-scoped messages, replies, and staff notifications',async()=>{
  const {env,raw,event}=fixture();
  const start=await resolveBotAction(env,event(200,'support',null,10),1_000_000);
  assert.match(start.text,/موضوع/);
  const opened=await resolveBotAction(env,event(200,'Need help','تصاویر اینستاگرام لود نمی‌شوند',11),1_000_100);
  assert.match(opened.text,/tg-11/);
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM support_messages WHERE ticket_id='tg-11'").get().n,1);
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM telegram_notifications WHERE chat_id='100'").get().n,1);
  const tickets=await customerTicketAction(env,event(200,'customer:tickets'));
  assert.match(tickets.text,/tg-11/);
  const denied=await customerTicketAction(env,event(300,'customer:ticket:tg-11'));
  assert.match(denied.text,/پیدا نشد/);
  const details=await customerTicketAction(env,event(200,'customer:ticket:tg-11'));
  assert.match(details.text,/تصاویر اینستاگرام/);
  const wait=await customerTicketAction(env,event(200,'customer:ticket:reply:tg-11'),1_100_000);
  assert.match(wait.text,/۱۰ دقیقه/);
  const sent=await consumePanelInput(env,event(200,'text','با اینترنت موبایل تست کردم',12),1_100_100);
  assert.match(sent.text,/ثبت شد/);
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM support_messages WHERE ticket_id='tg-11'").get().n,2);
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM telegram_notifications WHERE chat_id='100'").get().n,2);
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM v2_bot_input_sessions").get().n,0);
  raw.close();
});

test('admin plan wizard creates disabled plan and cannot be opened by customers',async()=>{
  const {env,raw,event}=fixture();
  assert.match((await adminPanelAction(env,event(200,'admin:plan:new'),1000)).text,/دسترسی به این بخش مجاز نیست/);
  const prompt=await adminPanelAction(env,event(100,'admin:plan:new'),1000);
  assert.match(prompt.text,/پلن جدید/);
  const invalid=await consumePanelInput(env,event(100,'text','not valid',16),1100);
  assert.match(invalid.text,/فرمت معتبر/);
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM plans').get().n,0);
  const created=await consumePanelInput(env,event(100,'text','monthly|یک ماهه|300000|30|30',17),1200);
  assert.match(created.text,/غیرفعال ثبت شد/);
  const row=raw.prepare("SELECT id,active,price_amount FROM plans WHERE id='monthly'").get();
  assert.equal(row.active,0);
  assert.equal(row.price_amount,300000);
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM v2_bot_input_sessions').get().n,0);
  raw.close();
});

test('staff grants and revokes require admin, with session expiry and admin protection',async()=>{
  const {env,raw,event}=fixture();
  assert.match((await adminPanelAction(env,event(300,'admin:staff'),1000)).text,/دسترسی به این بخش مجاز نیست/);
  const start=await adminPanelAction(env,event(100,'admin:staff:grant:seller'),1000);
  assert.match(start.text,/شناسه عددی/);
  assert.match((await consumePanelInput(env,event(100,'text','100',20),1500)).text,/دسترسی مدیر/);
  const granted=await consumePanelInput(env,event(100,'text','300',21),1600);
  assert.match(granted.text,/فعال شد/);
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM staff_roles WHERE telegram_id='300' AND role='seller'").get().n,1);
  await adminPanelAction(env,event(100,'admin:staff:revoke:seller'),2000);
  await consumePanelInput(env,event(100,'text','300',22),2100);
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM staff_roles WHERE telegram_id='300'").get().n,0);
  await adminPanelAction(env,event(100,'admin:staff:grant:support'),3000);
  assert.match((await consumePanelInput(env,event(100,'text','300',24),700000)).text,/مهلت/);
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM staff_roles WHERE telegram_id='300'").get().n,0);
  raw.close();
});

test('bot language stays Persian for every Telegram device locale',async()=>{
  const {env,raw,event}=fixture();
  const home=await resolveBotAction(env,event(100,'/start','/start',25));
  assert.match(home.text,/پیشخوان مدیریت/);
  assert.ok(home.replyMarkup.inline_keyboard.flat().some(b=>b.callback_data==='v2:admin:home'));
  const lang=await resolveBotAction(env,event(200,'lang:en',null,26));
  assert.match(lang.text,/زبان ربات مدار فارسی است/);
  assert.equal(raw.prepare("SELECT locale FROM customers WHERE telegram_id='200'").get().locale,'fa');
  const next=await resolveBotAction(env,event(200,'home',null,27));
  assert.match(next.text,/در حال حاضر اشتراک فعالی در این نسخه ندارید/);
  assert.ok(next.replyMarkup.inline_keyboard.flat().some(b=>b.callback_data==='v2:customer:tickets'));
  raw.close();
});

test('suspension needs confirmation and never blocks the support path',async()=>{
  const {env,raw,event}=fixture();
  const prompt=await adminPanelAction(env,event(100,'admin:customer:suspend:200',null,40),1000);
  assert.match(prompt.text,/مطمئن هستید/);
  assert.equal(raw.prepare("SELECT state FROM customers WHERE telegram_id='200'").get().state,'active');
  const done=await adminPanelAction(env,event(100,'admin:customer:confirm:suspend:200',null,41),1001);
  assert.match(done.text,/تعلیق‌شده/);
  assert.equal(raw.prepare("SELECT state FROM customers WHERE telegram_id='200'").get().state,'suspended');
  const forbidden=await resolveBotAction(env,event(200,'buy:someplan',null,42),1100);
  assert.match(forbidden.text,/تعلیق/);
  const support=await resolveBotAction(env,event(200,'support',null,43),1100);
  assert.match(support.text,/موضوع/);
  const ticket=await resolveBotAction(env,event(200,'text','مشکل در تست اتصال',44),1200);
  assert.match(ticket.text,/tg-44/);
  const replyPrompt=await resolveBotAction(env,event(200,'customer:ticket:reply:tg-44',null,45),1300);
  assert.match(replyPrompt.text,/۱۰ دقیقه/);
  const replied=await resolveBotAction(env,event(200,'more','با همراه اول تست شد',46),1400);
  assert.match(replied.text,/ثبت شد/);
  const restored=await adminPanelAction(env,event(100,'admin:customer:confirm:activate:200',null,47),1500);
  assert.match(restored.text,/وضعیت مشتری به‌روزرسانی شد/);
  raw.close();
});

test('support staff can inspect conversations but customers cannot inspect staff-only details',async()=>{
  const {env,raw,event}=fixture();
  raw.exec("INSERT INTO staff_roles(telegram_id,role,granted_by) VALUES('300','support','100')");
  raw.exec("INSERT INTO support_tickets(id,customer_telegram_id,subject) VALUES('tg-22','200','Connection issue')");
  raw.exec("INSERT INTO support_messages(id,ticket_id,sender_telegram_id,body,role) VALUES('msg-1','tg-22','200','سلام یک سوال دارم','customer')");
  const view=await staffTicketDetails(env,event(300,'ticket:view:tg-22'),'tg-22');
  assert.match(view.text,/یک سوال دارم/);
  assert.ok(view.replyMarkup.inline_keyboard.flat().some(x=>x.callback_data==='v2:ticket:reply:tg-22'));
  const supportKeys=view.replyMarkup.inline_keyboard.flat().map(x=>x.callback_data);
  assert.ok(supportKeys.includes('v2:admin:tickets'));
  assert.ok(!supportKeys.includes('v2:admin:customers'));
  const denied=await staffTicketDetails(env,event(200,'ticket:view:tg-22'),'tg-22');
  assert.match(denied.text,/دسترسی به این بخش مجاز نیست/);
  raw.close();
});

test('suspended account cannot use an existing carrier subscription token',async()=>{
  const {env,raw}=fixture();
  const {tokenDigest,getSubscription}=await import('../src/subscription.mjs');
  const token='A'.repeat(43),hash=await tokenDigest(token);
  raw.prepare("INSERT INTO subscriptions(id,owner_telegram_id,state,expires_at,max_bytes,used_bytes) VALUES('sub-1','200','active',4000000,100000000,0)").run();
  raw.prepare("INSERT INTO subscription_tokens(token_hash,subscription_id,expires_at) VALUES(?,'sub-1',4000000)").run(hash);
  const req=new Request('https://v2.example.test/api/v2/subscription',{headers:{authorization:'Bearer '+token}});
  const protectedEnv={...env,SUBSCRIPTION_API_ENABLED:'true',SUBSCRIPTION_CREDENTIAL_KEY:'A'.repeat(43)};
  raw.prepare("UPDATE customers SET state='suspended' WHERE telegram_id='200'").run();
  assert.equal((await getSubscription(req,protectedEnv,1000000)).status,403);
  raw.prepare("UPDATE customers SET state='active' WHERE telegram_id='200'").run();
  // Valid owner passes token check but must still have a verified node route.
  assert.equal((await getSubscription(req,protectedEnv,1000000)).status,503);
  raw.close();
});

test('customer messages are branded and customer panel never exposes English labels',async()=>{
  const {env,raw,event}=fixture();
  const home=await resolveBotAction(env,event(300,'/start','/start',90));
  assert.match(home.text,/🌐  مــدار/);
  assert.doesNotMatch(home.text,/[A-Za-z]{3,}/);
  assert.ok(home.replyMarkup.inline_keyboard.flat().some(x=>x.text==='🛍 خرید اشتراک'));
  raw.close();
});

test('support agents see a focused Persian support menu from home',async()=>{
  const {env,raw,event}=fixture();
  raw.exec("INSERT INTO staff_roles(telegram_id,role,granted_by) VALUES('300','support','100')");
  const home=await resolveBotAction(env,event(300,'/start','/start',91));
  assert.match(home.text,/به مدار خوش آمدید/);
  const keys=home.replyMarkup.inline_keyboard.flat().map(x=>x.callback_data);
  assert.ok(keys.includes('v2:admin:tickets'));
  assert.ok(!keys.includes('v2:admin:customers'));
  raw.close();
});


test('customer order details are account-scoped and show the next action',async()=>{
  const {env,raw,event}=fixture();
  raw.exec("INSERT INTO plans(id,title_fa,title_en,price_amount,price_currency,quota_bytes,duration_days) VALUES('monthly','یک ماهه','Monthly',300000,'IRT',32212254720,30)");
  raw.exec("INSERT INTO orders(id,customer_telegram_id,plan_id,idempotency_key,quoted_amount,quoted_currency) VALUES('order-demo','200','monthly','order-test','300000','IRT')");
  const list=await resolveBotAction(env,event(200,'orders',null,101));
  assert.match(list.text,/پیگیری سفارش‌ها/);
  assert.ok(list.replyMarkup.inline_keyboard.flat().some(b=>b.callback_data==='v2:orders:view:order-demo'));
  const details=await resolveBotAction(env,event(200,'orders:view:order-demo',null,102));
  assert.match(details.text,/کد پیگیری: order-demo/);
  assert.match(details.text,/مرحله بعد/);
  assert.match(details.text,/تصویر رسید پرداخت/);
  const forbidden=await resolveBotAction(env,event(300,'orders:view:order-demo',null,103));
  assert.match(forbidden.text,/پیدا نشد/);
  raw.close();
});

test('the new admin plan and receipt flows require confirmation before changing records',async()=>{
  const {env,raw,event}=fixture();
  raw.exec("INSERT INTO plans(id,title_fa,title_en,price_amount,price_currency,quota_bytes,duration_days,active) VALUES('monthly','اشتراک یک‌ماهه','Monthly',300000,'IRT',32212254720,30,1)");
  raw.exec("INSERT INTO orders(id,customer_telegram_id,plan_id,idempotency_key,quoted_amount,quoted_currency) VALUES('order-demo','200','monthly','order-test','300000','IRT')");
  raw.exec("INSERT INTO receipts(id,order_id,telegram_file_id,upload_by_telegram_id) VALUES('receipt-1','order-demo','telegram-photo-test','200')");
  raw.exec("UPDATE orders SET state='receipt_submitted' WHERE id='order-demo'");
  const plan=await resolveBotAction(env,event(100,'admin:plans',null,110));
  assert.ok(plan.replyMarkup.inline_keyboard.flat().some(b=>b.callback_data==='v2:admin:plan:confirm:off:monthly'));
  const caution=await resolveBotAction(env,event(100,'admin:plan:confirm:off:monthly',null,111));
  assert.match(caution.text,/تأیید تغییر پلن/);
  assert.equal(raw.prepare("SELECT active FROM plans WHERE id='monthly'").get().active,1);
  const review=await resolveBotAction(env,event(100,'admin:queue',null,112));
  assert.ok(review.replyMarkup.inline_keyboard.flat().some(b=>b.callback_data==='v2:admin:receipt:order-demo'));
  assert.ok(!review.replyMarkup.inline_keyboard.flat().some(b=>b.callback_data==='v2:approve:order-demo'));
  const preview=await resolveBotAction(env,event(100,'admin:receipt:order-demo',null,113));
  assert.equal(preview.photoId,'telegram-photo-test');
  assert.ok(preview.replyMarkup.inline_keyboard.flat().some(b=>b.callback_data==='v2:admin:review:approve:order-demo'));
  const confirm=await resolveBotAction(env,event(100,'admin:review:approve:order-demo',null,114));
  assert.match(confirm.text,/تأیید تصمیم/);
  assert.equal(raw.prepare("SELECT state FROM orders WHERE id='order-demo'").get().state,'receipt_submitted');
  raw.close();
});

test('support and customer directories paginate with fewer buttons and contextual navigation',async()=>{
  const {env,raw,event}=fixture();
  for(let i=400;i<412;i++)raw.prepare('INSERT INTO customers(telegram_id) VALUES(?)').run(String(i));
  const first=await resolveBotAction(env,event(100,'admin:customers',null,120));
  const firstKeys=first.replyMarkup.inline_keyboard.flat().map(x=>x.callback_data);
  assert.ok(firstKeys.includes('v2:admin:customers:1'));
  assert.ok(firstKeys.includes('v2:admin:home'));
  assert.ok(!firstKeys.includes('v2:admin:plans'));
  const second=await resolveBotAction(env,event(100,'admin:customers:1',null,121));
  assert.match(second.text,/صفحه ۲/);
  assert.ok(second.replyMarkup.inline_keyboard.flat().some(x=>x.callback_data==='v2:admin:customers:0'));
  for(let i=300;i<308;i++)raw.prepare("INSERT INTO support_tickets(id,customer_telegram_id,subject) VALUES(?,'200',?)")
    .run('tg-'+i,'درخواست آزمایشی '+i);
  const inbox=await resolveBotAction(env,event(200,'customer:tickets',null,122));
  assert.ok(inbox.replyMarkup.inline_keyboard.flat().some(x=>x.callback_data==='v2:customer:tickets:1'));
  const next=await resolveBotAction(env,event(200,'customer:tickets:1',null,123));
  assert.match(next.text,/صفحه ۲/);
  assert.ok(next.replyMarkup.inline_keyboard.flat().some(x=>x.callback_data==='v2:customer:tickets:0'));
  raw.close();
});

test('support ticket closure is protected by a human confirmation',async()=>{
  const {env,raw,event}=fixture();
  raw.exec("INSERT INTO staff_roles(telegram_id,role,granted_by) VALUES('300','support','100')");
  raw.exec("INSERT INTO support_tickets(id,customer_telegram_id,subject) VALUES('tg-300','200','تست سرعت')");
  const thread=await resolveBotAction(env,event(300,'ticket:view:tg-300',null,130));
  assert.ok(thread.replyMarkup.inline_keyboard.flat().some(x=>x.callback_data==='v2:ticket:confirm-close:tg-300'));
  const warning=await resolveBotAction(env,event(300,'ticket:confirm-close:tg-300',null,131));
  assert.match(warning.text,/بستن گفت‌وگوی پشتیبانی/);
  assert.equal(raw.prepare("SELECT state FROM support_tickets WHERE id='tg-300'").get().state,'open');
  assert.ok(warning.replyMarkup.inline_keyboard.flat().some(x=>x.callback_data==='v2:ticket:close:tg-300'));
  raw.close();
});
