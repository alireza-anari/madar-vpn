import { toBotMessage, verifyTelegramSecret } from './telegram.mjs';

const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});
const attemptDelayMs = (n) => Math.min(3_600_000, 5_000 * (2 ** Math.min(n, 9)));

async function dispatchOutbox(env, nowMs = Date.now()) {
  if (!env.DB || !env.BOT_TOKEN) return;
  const results = await env.DB.prepare(
    "SELECT id, chat_id, body, attempts FROM telegram_outbox WHERE (state = 'pending' AND due_ms <= ?) OR (state = 'leased' AND lease_until_ms <= ?) ORDER BY id LIMIT 20"
  ).bind(nowMs, nowMs).all();
  for (const item of results.results ?? []) {
    const claim = await env.DB.prepare(
      "UPDATE telegram_outbox SET state='leased', lease_until_ms=?, attempts=attempts+1 WHERE id=? AND ((state='pending' AND due_ms<=?) OR (state='leased' AND lease_until_ms<=?))"
    ).bind(nowMs + 30_000, item.id, nowMs, nowMs).run();
    if (claim.meta?.changes !== 1) continue;
    let sent = false;
    try {
      const response = await fetch('https://api.telegram.org/bot' + env.BOT_TOKEN + '/sendMessage', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: item.chat_id, text: item.body }),
        signal: AbortSignal.timeout(12_000),
      });
      sent = response.ok && (await response.json()).ok === true;
    } catch { /* retry below, never log credentials or full Telegram payloads */ }
    if (sent) {
      await env.DB.prepare("UPDATE telegram_outbox SET state='sent', lease_until_ms=0 WHERE id=? AND state='leased'")
        .bind(item.id).run();
    } else {
      const nextAttempt = item.attempts + 1;
      await env.DB.prepare(
        "UPDATE telegram_outbox SET state=?, lease_until_ms=0, due_ms=? WHERE id=? AND state='leased'"
      ).bind(nextAttempt >= 8 ? 'dead' : 'pending', nowMs + attemptDelayMs(nextAttempt), item.id).run();
    }
  }
}

async function receiveTelegram(request, env, ctx) {
  if (!(await verifyTelegramSecret(request.headers.get('x-telegram-bot-api-secret-token'),
    env.TELEGRAM_WEBHOOK_SECRET))) return json({ error: 'unauthorized' }, 401);
  if (!env.DB) return json({ error: 'not_ready' }, 503);
  if (Number(request.headers.get('content-length') || 0) > 32_768) return json({ error: 'too_large' }, 413);
  let update;
  try { update = await request.json(); } catch { return json({ error: 'bad_request' }, 400); }
  const msg = toBotMessage(update);
  if (!msg) return json({ ok: true, ignored: true });
  await env.DB.prepare(
    "INSERT OR IGNORE INTO telegram_outbox (update_id, chat_id, body, state, due_ms) VALUES (?, ?, ?, 'pending', ?)"
  ).bind(msg.updateId, msg.chatId, msg.text, Date.now()).run();
  ctx?.waitUntil?.(dispatchOutbox(env));
  return json({ ok: true });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health/live') return json({ status: 'alive', service: 'madar-v2' });
    if (request.method === 'GET' && url.pathname === '/health/ready') {
      const bound = Boolean(env.DB && env.BOT_TOKEN && env.TELEGRAM_WEBHOOK_SECRET);
      if (!bound) return json({ status: 'not_ready' }, 503);
      try {
        await env.DB.prepare('SELECT 1 AS ok').first();
        return json({ status: 'ready' });
      } catch { return json({ status: 'not_ready' }, 503); }
    }
    if (request.method === 'POST' && url.pathname === '/telegram/webhook') {
      try { return await receiveTelegram(request, env, ctx); }
      catch { return json({ error: 'temporary_failure' }, 503); }
    }
    return json({ error: 'not_found' }, 404);
  },
  async scheduled(_event, env) { await dispatchOutbox(env); },
};
