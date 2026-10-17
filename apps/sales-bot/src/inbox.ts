import { refreshCapacityAlert } from "./capacity-alerts";
import type { TelegramUpdate } from "./contracts";
import { handleUpdate } from "./menus";

async function capacityNodeForUpdate(
  db: D1Database,
  update: TelegramUpdate,
): Promise<{ nodeId: string; before: boolean } | null> {
  const data = update.callback_query?.data;
  const actorId = update.callback_query?.from.id ?? update.message?.from?.id;
  if (!data || !actorId) return null;
  if (data.startsWith("rs:confirm:")) {
    const raw = await db
      .prepare("SELECT conversation FROM users WHERE id=?")
      .bind(String(actorId))
      .first<string>("conversation");
    if (!raw) return null;
    try {
      const state = JSON.parse(raw) as {
        step?: string;
        requestKey?: string;
        nodeId?: string;
      };
      if (
        state.step === "confirm" &&
        state.requestKey === data.slice(11) &&
        state.nodeId
      )
        return { nodeId: state.nodeId, before: true };
    } catch {
      return null;
    }
  }
  if (data.startsWith("rs:revokeok:")) {
    const nodeId = await db
      .prepare("SELECT node_id FROM managed_accounts WHERE id=?")
      .bind(data.slice(12))
      .first<string>("node_id");
    if (nodeId) return { nodeId, before: false };
  }
  return null;
}

async function bestEffortCapacityAlert(env: Env, nodeId: string, now: number) {
  try {
    await refreshCapacityAlert(env, nodeId, now);
  } catch {
    // Operational alerts must never make a Telegram action retry or fail.
  }
}

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
      const update = JSON.parse(row.payload) as TelegramUpdate;
      const alert = await capacityNodeForUpdate(env.SALES_DB, update);
      if (alert?.before)
        await bestEffortCapacityAlert(env, alert.nodeId, now);
      await handleUpdate(env, update, now);
      if (alert) await bestEffortCapacityAlert(env, alert.nodeId, now);
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
