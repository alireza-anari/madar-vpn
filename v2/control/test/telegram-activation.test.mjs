import test from 'node:test';
import assert from 'node:assert/strict';
import {activateIsolatedBotWebhook} from '../src/telegram-activation.mjs';
const secret='S'.repeat(42), base={V2_BOT_AUTO_ACTIVATE:'true',BOT_TOKEN:'not-logged',
  TELEGRAM_WEBHOOK_SECRET:secret,ADMIN_TELEGRAM_IDS:'12345678'};
const stub=(id,hook,seen)=>async(url,init)=>{
  const method=url.split('/').at(-1);
  seen.push({method,body:JSON.parse(init.body)});
  let result=method==='getMe'?{id,is_bot:true,username:'new_madar'}:
    method==='getWebhookInfo'?{url:hook}:true;
  return {ok:true,json:async()=>({ok:true,result})};
};
test('V2 never redirects legacy bot even with valid secrets',async()=>{
  const calls=[];
  const r=await activateIsolatedBotWebhook(base,stub(8905373112,'https://old.example.com',calls));
  assert.equal(r.state,'legacy_or_invalid_bot');
  assert.deepEqual(calls.map(x=>x.method),['getMe']);
});
test('V2 rejects an arbitrary existing Telegram webhook',async()=>{
  const calls=[];
  assert.equal((await activateIsolatedBotWebhook(base,stub(8912345678,'https://third.example.org/telegram',calls))).state,
     'existing_other_webhook');
  assert.equal(calls.some(x=>x.method==='setWebhook'),false);
});
test('dedicated new bot may self-register ONLY its V2 webhook',async()=>{
  const calls=[];
  assert.equal((await activateIsolatedBotWebhook(base,stub(8912345678,'',calls))).state,'installed');
  assert.equal(calls.at(-1).method,'setWebhook');
  assert.equal(calls.at(-1).body.url,'https://madar-v2-staging.alirezaanari117.workers.dev/telegram/webhook');
  assert.equal(calls.at(-1).body.secret_token,secret);
  assert.equal(calls.at(-1).body.drop_pending_updates,false);
});
test('no bot provisioning with missing admin, secret or feature flag',async()=>{
  for(const changes of [
    {V2_BOT_AUTO_ACTIVATE:'false'},
    {BOT_TOKEN:''},
    {TELEGRAM_WEBHOOK_SECRET:''},
    {ADMIN_TELEGRAM_IDS:''},
  ])assert.equal((await activateIsolatedBotWebhook({...base,...changes})).state,'disabled');
});
