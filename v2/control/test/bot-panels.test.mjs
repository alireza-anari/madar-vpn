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
  assert.match(a.text,/مشتریان: 3/);
  assert.match(a.text,/سرورها: 1/);
  assert.match(a.text,/فروش عمومی/);
  const keys=a.replyMarkup.inline_keyboard.flat().map(x=>x.callback_data);
  for(const required of ['v2:admin:plans','v2:admin:queue','v2:admin:staff','v2:admin:customers','v2:admin:node:trials'])
    assert.ok(keys.includes(required));
  const no=await adminDashboard(env,event(200,'admin:home'));
  assert.match(no.text,/Access denied/);
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
  assert.match((await adminPanelAction(env,event(200,'admin:plan:new'),1000)).text,/Access denied/);
  const prompt=await adminPanelAction(env,event(100,'admin:plan:new'),1000);
  assert.match(prompt.text,/پلن جدید/);
  const invalid=await consumePanelInput(env,event(100,'text','not valid',16),1100);
  assert.match(invalid.text,/فرمت معتبر/);
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM plans').get().n,0);
  const created=await consumePanelInput(env,event(100,'text','monthly|یک ماهه|Monthly|300000|IRT|30|30',17),1200);
  assert.match(created.text,/غیرفعال ثبت شد/);
  const row=raw.prepare("SELECT id,active,price_amount FROM plans WHERE id='monthly'").get();
  assert.equal(row.active,0);
  assert.equal(row.price_amount,300000);
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM v2_bot_input_sessions').get().n,0);
  raw.close();
});

test('staff grants and revokes require admin, with session expiry and admin protection',async()=>{
  const {env,raw,event}=fixture();
  assert.match((await adminPanelAction(env,event(300,'admin:staff'),1000)).text,/Access denied/);
  const start=await adminPanelAction(env,event(100,'admin:staff:grant:seller'),1000);
  assert.match(start.text,/شناسه عددی/);
  assert.match((await consumePanelInput(env,event(100,'text','100',20),1500)).text,/دسترسی مدیر/);
  const granted=await consumePanelInput(env,event(100,'text','300',21),1600);
  assert.match(granted.text,/grant/);
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM staff_roles WHERE telegram_id='300' AND role='seller'").get().n,1);
  await adminPanelAction(env,event(100,'admin:staff:revoke:seller'),2000);
  await consumePanelInput(env,event(100,'text','300',22),2100);
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM staff_roles WHERE telegram_id='300'").get().n,0);
  await adminPanelAction(env,event(100,'admin:staff:grant:support'),3000);
  assert.match((await consumePanelInput(env,event(100,'text','300',24),700000)).text,/مهلت/);
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM staff_roles WHERE telegram_id='300'").get().n,0);
  raw.close();
});

test('language switch persists and customer home never claims a paid subscription',async()=>{
  const {env,raw,event}=fixture();
  const home=await resolveBotAction(env,event(100,'/start','/start',25));
  assert.ok(home.replyMarkup.inline_keyboard.flat().some(b=>b.callback_data==='v2:admin:home'));
  const lang=await resolveBotAction(env,event(200,'lang:en',null,26));
  assert.match(lang.text,/Madar VPN/);
  assert.equal(raw.prepare("SELECT locale FROM customers WHERE telegram_id='200'").get().locale,'en');
  const next=await resolveBotAction(env,event(200,'home',null,27));
  assert.match(next.text,/You have no active/);
  assert.ok(next.replyMarkup.inline_keyboard.flat().some(b=>b.callback_data==='v2:customer:tickets'));
  raw.close();
});

test('suspension needs confirmation and never blocks the support path',async()=>{
  const {env,raw,event}=fixture();
  const prompt=await adminPanelAction(env,event(100,'admin:customer:suspend:200',null,40),1000);
  assert.match(prompt.text,/مطمئنی/);
  assert.equal(raw.prepare("SELECT state FROM customers WHERE telegram_id='200'").get().state,'active');
  const done=await adminPanelAction(env,event(100,'admin:customer:confirm:suspend:200',null,41),1001);
  assert.match(done.text,/suspended/);
  assert.equal(raw.prepare("SELECT state FROM customers WHERE telegram_id='200'").get().state,'suspended');
  const forbidden=await resolveBotAction(env,event(200,'buy:someplan',null,42),1100);
  assert.match(forbidden.text,/تعلیق/);
  const support=await resolveBotAction(env,event(200,'support',null,43),1100);
  assert.match(support.text,/موضوع/);
  const ticket=await resolveBotAction(env,event(200,'help','مشکل در تست اتصال',44),1200);
  assert.match(ticket.text,/tg-44/);
  const replyPrompt=await resolveBotAction(env,event(200,'customer:ticket:reply:tg-44',null,45),1300);
  assert.match(replyPrompt.text,/۱۰ دقیقه/);
  const replied=await resolveBotAction(env,event(200,'more','با همراه اول تست شد',46),1400);
  assert.match(replied.text,/ثبت شد/);
  const restored=await adminPanelAction(env,event(100,'admin:customer:confirm:activate:200',null,47),1500);
  assert.match(restored.text,/active/);
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
  const denied=await staffTicketDetails(env,event(200,'ticket:view:tg-22'),'tg-22');
  assert.match(denied.text,/Access denied/);
  raw.close();
});
