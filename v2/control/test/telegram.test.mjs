import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyTelegramSecret,toBotMessage } from '../src/telegram.mjs';
import worker from '../src/index.mjs';
test('rejects missing and mismatched webhook credentials', async () => {
  assert.equal(await verifyTelegramSecret('wrong','correct'),false);
  assert.equal(await verifyTelegramSecret('correct','correct'),true);
  assert.equal(await verifyTelegramSecret(null,'correct'),false);
  const response=await worker.fetch(new Request('https://localhost/telegram/webhook',
    {method:'POST',body:'{}'}),{TELEGRAM_WEBHOOK_SECRET:'correct'},{});
  assert.equal(response.status,401);
});
test('bounded bot parsing does not fake paid VPN issuance', () => {
  const msg=toBotMessage({update_id:123,message:{chat:{id:456,type:'private'},from:{id:456},text:'/start'}});
  assert.equal(msg.chatId,'456');
  assert.match(msg.text,/آماده‌سازی/);
  assert.equal(toBotMessage({update_id:-1}),null);
});
test('readiness fails closed without required bindings', async () => {
  const response=await worker.fetch(new Request('https://localhost/health/ready'),{},{});
  assert.equal(response.status,503);
});
