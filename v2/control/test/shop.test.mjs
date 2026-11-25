import test from 'node:test';
import assert from 'node:assert/strict';
import { adminAllowed, salesConfigured, availableForSale, validAdminIds } from '../src/shop.mjs';

test('admin role fail closed for absent or malformed identifiers',()=>{
  assert.equal(adminAllowed(undefined,'123'),false);
  assert.equal(adminAllowed('','123'),false);
  assert.equal(adminAllowed('12,123,456','123'),true);
  assert.equal(adminAllowed('123','12'),false);
  assert.equal(adminAllowed('123','abc'),false);
});
test('sales require explicit opt-in and valid payment instructions',()=>{
  assert.equal(salesConfigured({}),false);
  assert.equal(salesConfigured({SHOP_ENABLED:'true'}),false);
  assert.equal(salesConfigured({SHOP_ENABLED:'true',PAYMENT_INSTRUCTIONS:'short'}),false);
  assert.equal(salesConfigured({
    SUBSCRIPTION_LINKS_ENABLED:'true',SUBSCRIPTION_API_ENABLED:'true',
    SHOP_ENABLED:'true',PROVISIONING_ENABLED:'true',PAYMENT_INSTRUCTIONS:'Confirmed official payment instructions',
  }),true);
});
test('route availability never guesses capacity from missing evidence', async()=>{
  const db={prepare(sql) {
    assert.match(sql,/verified_ms BETWEEN/);
    assert.match(sql,/node_health/);
    assert.match(sql,/node_acks/);
    assert.match(sql,/route_carrier_variants/);
    return {bind(...args) {
      assert.equal(args.length,11);
      return {first:async()=>null};
    }};
  }};
  assert.equal(await availableForSale(db,{quota_bytes:1234},Date.now()),false);
  assert.equal(await availableForSale(db,null,Date.now()),false);
});

test('nonprovisioning checkout never opens even if a bank destination exists',()=>{
  assert.equal(salesConfigured({
    SUBSCRIPTION_LINKS_ENABLED:'true',SUBSCRIPTION_API_ENABLED:'true',
    SHOP_ENABLED:'true',PAYMENT_INSTRUCTIONS:'Confirmed official payment instructions'
  }),false);
});

test('receipt alerts go only to explicitly configured distinct admin IDs',()=>{
  assert.deepEqual(validAdminIds(' 200,200,garbage,300,400 ', '300'),['200','400']);
  assert.deepEqual(validAdminIds(undefined),[]);
});

test('customer bot start requires confirmed Madar channel membership',async()=>{
  const original=globalThis.fetch;
  let activated=false;
  const db={prepare(sql){
    return {bind(...args){return {
      run:async()=>{
        if(sql.startsWith('INSERT INTO telegram_bot_activations'))activated=true;
        if(sql.startsWith('DELETE FROM telegram_bot_activations'))activated=false;
        return {meta:{changes:1}};
      },
      first:async()=>{
        if(sql.includes('SELECT state FROM customers'))return {state:'active'};
        if(sql.includes('FROM telegram_bot_activations'))return activated?{active:1}:null;
        return null;
      },
    };}};
  }};
  const env={DB:db,BOT_TOKEN:'123456:'+ 'B'.repeat(40),
    MADAR_CHANNEL_ID:'-1001234567890',MADAR_CHANNEL_URL:'https://t.me/MadarChannel'};
  const event={actorId:'1234567',chatId:'1234567',key:'/start',
    inputText:'/start',updateId:700,locale:'fa'};
  globalThis.fetch=async()=>new Response(JSON.stringify({
    ok:true,result:{status:'left'},
  }),{status:200});
  try{
    const reply=await (await import('../src/shop.mjs')).resolveBotAction(env,event,nowForTest());
    assert.match(reply.text,/عضویت در کانال اطلاع‌رسانی مدار الزامی است/);
    assert.equal(reply.replyMarkup.inline_keyboard[0][0].url,env.MADAR_CHANNEL_URL);
    assert.equal(reply.replyMarkup.inline_keyboard[1][0].callback_data,'v2:activation:check');
    assert.equal(activated,false);
  }finally{globalThis.fetch=original;}
});

test('bot activation check unlocks the customer menu after Telegram confirms membership',async()=>{
  const original=globalThis.fetch;
  let activated=false;
  const db={prepare(sql){
    return {bind(...args){return {
      run:async()=>{
        if(sql.startsWith('INSERT INTO telegram_bot_activations'))activated=true;
        return {meta:{changes:1}};
      },
      first:async()=>{
        if(sql.includes('SELECT state FROM customers'))return {state:'active'};
        if(sql.includes('FROM telegram_bot_activations'))return activated?{active:1}:null;
        return null;
      },
    };}};
  }};
  const env={DB:db,BOT_TOKEN:'123456:'+ 'B'.repeat(40),
    MADAR_CHANNEL_ID:'-1001234567890',MADAR_CHANNEL_URL:'https://t.me/MadarChannel'};
  globalThis.fetch=async()=>new Response(JSON.stringify({
    ok:true,result:{status:'member'},
  }),{status:200});
  try{
    const reply=await (await import('../src/shop.mjs')).resolveBotAction(env,{
      actorId:'1234567',chatId:'1234567',key:'activation:check',
      inputText:null,updateId:701,locale:'fa',
    },Date.now());
    assert.match(reply.text,/ربات مدار برای حساب شما فعال است/);
    assert.ok(reply.replyMarkup.inline_keyboard.flat().some(x=>x.callback_data==='v2:plans'));
    assert.equal(activated,true);
  }finally{globalThis.fetch=original;}
});

function nowForTest(){return 1_900_000_000_000;}

test('private Telegram user cannot mint another user subscription link',async()=>{
  const {resolveBotAction}=await import('../src/shop.mjs');
  let issuedLookups=0;
  const db={prepare(sql) {
    return {bind(){return {
      run:async()=>({meta:{changes:1}}),
      first:async()=>{
        if(sql.includes('SELECT state FROM customers'))return {state:'active'};
        if(sql.includes('FROM telegram_bot_activations'))return {active:1};
        if(sql.includes('FROM subscriptions WHERE id=? AND owner_telegram_id=?')) {
          issuedLookups++;
          return null;
        }
        return null;
      },
    }}};
  }};
  const response=await resolveBotAction({DB:db,SUBSCRIPTION_LINKS_ENABLED:'true'},{
    actorId:'123',chatId:'123',locale:'fa',
    updateId:501,key:'my:link:sub-other-owner',inputText:null,photoId:null,
  });
  assert.equal(issuedLookups,1);
  assert.match(response.text,/اشتراک فعال شما پیدا نشد/);
  assert.doesNotMatch(response.text,/https:\/\/.*\/s\//);
});

test('production secret overrides can enable sales only with payment instructions',()=>{
  assert.equal(salesConfigured({
    SUBSCRIPTION_LINKS_ENABLED:'true',SUBSCRIPTION_API_ENABLED:'true',
    SHOP_ENABLED:'false',SHOP_ENABLED_SECRET:'true',
    PROVISIONING_ENABLED:'false',PROVISIONING_ENABLED_SECRET:'true',
    PAYMENT_INSTRUCTIONS:'Verified payment details provided by the merchant',
  }),true);
  assert.equal(salesConfigured({
    SUBSCRIPTION_LINKS_ENABLED:'true',SUBSCRIPTION_API_ENABLED:'true',
    SHOP_ENABLED:'false',SHOP_ENABLED_SECRET:'true',
    PROVISIONING_ENABLED:'false',PROVISIONING_ENABLED_SECRET:'true',
  }),false);
});

test('an explicit secret false cannot be bypassed by public sales variables',()=>{
  assert.equal(salesConfigured({
    SUBSCRIPTION_LINKS_ENABLED:'true',SUBSCRIPTION_API_ENABLED:'true',
    SHOP_ENABLED:'true',SHOP_ENABLED_SECRET:'false',
    PROVISIONING_ENABLED:'true',
    PAYMENT_INSTRUCTIONS:'Valid independently verified payment instructions',
  }),false);
  assert.equal(salesConfigured({
    SUBSCRIPTION_LINKS_ENABLED:'true',SUBSCRIPTION_API_ENABLED:'true',
    SHOP_ENABLED:'true',
    PROVISIONING_ENABLED:'true',PROVISIONING_ENABLED_SECRET:'false',
    PAYMENT_INSTRUCTIONS:'Valid independently verified payment instructions',
  }),false);
});

test('checkout requires both retail delivery flags',()=>{
  const env={SHOP_ENABLED:'true',PROVISIONING_ENABLED:'true',SUBSCRIPTION_LINKS_ENABLED:'true',
    SUBSCRIPTION_API_ENABLED:'true',PAYMENT_INSTRUCTIONS:'Confirmed official payment instructions'};
  for(const flag of ['SUBSCRIPTION_LINKS_ENABLED','SUBSCRIPTION_API_ENABLED'])
    assert.equal(salesConfigured({...env,[flag+'_SECRET']:'false'}),false);
});
