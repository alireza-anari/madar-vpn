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
  return {DB,TELEGRAM_WEBHOOK_SECRET:'one-time-secret',calls};
}
function post(env, value, headers={}) {
  return worker.fetch(new Request(endpoint,{
    method:'POST',
    headers:{'x-telegram-bot-api-secret-token':env.TELEGRAM_WEBHOOK_SECRET,
      'content-type':'application/json',...headers},
    body: typeof value==='string'?value:JSON.stringify(value),
  }),env,{waitUntil() {}});
}
test('authenticated webhook stores localized Telegram message and menu',async()=>{
  const env=mockEnv();
  const reply=await post(env,{update_id:101,message:{
    chat:{id:202,type:'private'},from:{id:202,language_code:'fa'},text:'/start'}});
  assert.equal(reply.status,200);
  const insert=env.calls.find(x=>/INSERT OR IGNORE/.test(x.sql));
  assert.ok(insert);
  assert.equal(insert.params[0],101);
  assert.equal(insert.params[1],'202');
  assert.equal(JSON.parse(insert.params[3]).inline_keyboard.length,4);
});
test('invalid JSON and unsupported content type are rejected',async()=>{
  const env=mockEnv();
  assert.equal((await post(env,'{bad')).status,400);
  assert.equal((await post(env,'{}',{'content-type':'text/plain'})).status,415);
  assert.equal(env.calls.length,0);
});
test('oversized body rejected even without content-length header',async()=>{
  const env=mockEnv();
  const reply=await post(env,JSON.stringify({huge:'x'.repeat(50_000)}));
  assert.equal(reply.status,413);
  assert.equal(env.calls.length,0);
});
test('untrusted webhook secret rejected without database writes',async()=>{
  const env=mockEnv();
  const reply=await post(env,{}, {'x-telegram-bot-api-secret-token':'invalid'});
  assert.equal(reply.status,401);
  assert.equal(env.calls.length,0);
});
