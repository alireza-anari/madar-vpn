import test from 'node:test';
import assert from 'node:assert/strict';
import {telegramBindingStatus} from '../src/index.mjs';

const transport=(url)=>Promise.resolve({ok:true,json:async()=>({
  ok:true,result:url.endsWith('getMe')?{id:123456,username:'madar_v2'}:
    {url:'https://madar-sales-bot.alirezaanari117.workers.dev/telegram/webhook',pending_update_count:3}
})});
test('dedicated V2 readiness never trusts a legacy V1 webhook',async()=>{
  const r=await telegramBindingStatus({BOT_TOKEN:'hidden'},transport);
  assert.equal(r.status,200);
  const j=await r.json();
  assert.equal(j.webhook,'legacy_v1');
  assert.equal(j.is_dedicated_v2,false);
  assert.equal(JSON.stringify(j).includes('hidden'),false);
});
test('missing Telegram binding is not accepted as ready',async()=>{
  const r=await telegramBindingStatus({});
  assert.equal(r.status,503);
  assert.equal((await r.json()).webhook,'unknown');
});
