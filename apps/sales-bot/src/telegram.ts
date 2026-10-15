import type { TelegramUpdate } from "./contracts";
export async function recordUpdate(db: D1Database, update: TelegramUpdate) {
  const r = await db
    .prepare("INSERT OR IGNORE INTO telegram_updates(id,payload) VALUES(?,?)")
    .bind(update.update_id, JSON.stringify(update))
    .run();
  return r.meta.changes === 1;
}
export async function enqueue(
  db: D1Database,
  id: string,
  chatId: string,
  payload: Record<string, unknown>,
) {
  await db
    .prepare(
      "INSERT OR IGNORE INTO outbox(id,chat_id,payload,available_at) VALUES(?,?,?,0)",
    )
    .bind(id, chatId, JSON.stringify(payload))
    .run();
}
