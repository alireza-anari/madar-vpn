import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.mjs';

const endpoint='https://v2.example.test/telegram/webhook';
function mockEnv() {
  const calls=[];
  const DB={prepare(sql) {
    return {bind(...params) {
      return {
        async run(){calls.push({sql,params});return {meta:{changes:1}};},
        async all(){return {results:[]};},
        async first(){return {ok:1};},
      };
    },async first(){return {ok:1};}};
  }};
  return {DB,BOT_TOKEN:'test-bot-token-not-used',TELEGRAM_WEBHOOK_SECRET:'one-time-secret',calls};
}
function post(env,value,headers={}) {
  return worker.fetch(new Request(endpoint,{
    method:'POST',headers:{
      'x-telegram-bot-api-secret-token':env.TELEGRAM_WEBHOOK_SECRET,
      'content-type':'application/json',...headers,
    },
    body:typeof value==='string'?value:JSON.stringify(value),
  }),env,{waitUntil() {}});
}
test('authenticated update enters durable inbox (not directly delivered)',async()=>{
  const env=mockEnv();
  const reply=await post(env,{update_id:101,message:{
    chat:{id:202,type:'private'},from:{id:202,language_code:'fa'},text:'/start'}});
  assert.equal(reply.status,200);
  const insert=env.calls.find(x=>/INSERT OR IGNORE INTO telegram_inbox/.test(x.sql));
  assert.ok(insert);
  assert.equal(insert.params[0],101);
  assert.equal(insert.params[1],'202');
  const event=JSON.parse(insert.params[2]);
  assert.equal(event.key,'/start');
  assert.equal(event.actorId,'202');
  assert.equal(env.calls.filter(x=>/INSERT OR IGNORE INTO orders/.test(x.sql)).length,0);
});
test('malformed input rejected without database writes',async()=>{
  const env=mockEnv();
  assert.equal((await post(env,'{bad')).status,400);
  assert.equal((await post(env,'{}',{'content-type':'text/plain'})).status,415);
  assert.equal((await post(env,JSON.stringify({big:'x'.repeat(50000)}))).status,413);
  assert.equal(env.calls.length,0);
});
test('unauthorized and unconfigured bot are fail-closed',async()=>{
  const env=mockEnv();
  assert.equal((await post(env,{}, {'x-telegram-bot-api-secret-token':'invalid'})).status,401);
  delete env.BOT_TOKEN;
  assert.equal((await post(env,{})).status,503);
  assert.equal(env.calls.length,0);
});
test('no private identity, no persisted update',async()=>{
  const env=mockEnv();
  const r=await post(env,{update_id:7,message:{
    chat:{id:-100,type:'group'},from:{id:200},text:'/start'}});
  assert.equal(r.status,200);
  assert.equal(env.calls.length,0);
});
