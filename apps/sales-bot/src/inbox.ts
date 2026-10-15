import type { TelegramUpdate } from "./contracts";
import { handleUpdate } from "./menus";
export async function drainInbox(env: Env, now: number) {
  const rows = await env.SALES_DB.prepare(
    "SELECT id,payload,attempts FROM telegram_updates WHERE state='pending' AND available_at<=? AND lease_until<=? ORDER BY id LIMIT 20",
  )
    .bind(now, now)
    .all<{ id: number; payload: string; attempts: number }>();
  for (const row of rows.results) {
    const lease = await env.SALES_DB.prepare(
      "UPDATE telegram_updates SET lease_until=? WHERE id=? AND state='pending' AND lease_until<=?",
    )
      .bind(now + 60, row.id, now)
      .run();
    if (!lease.meta.changes) continue;
    try {
      await handleUpdate(env, JSON.parse(row.payload) as TelegramUpdate, now);
      await env.SALES_DB.prepare(
        "UPDATE telegram_updates SET state='done',lease_until=0 WHERE id=?",
      )
        .bind(row.id)
        .run();
    } catch {
      await env.SALES_DB.prepare(
        "UPDATE telegram_updates SET attempts=attempts+1,state=?,available_at=?,lease_until=0 WHERE id=?",
      )
        .bind(row.attempts >= 9 ? "dead" : "pending", now + 30, row.id)
        .run();
    }
  }
}
