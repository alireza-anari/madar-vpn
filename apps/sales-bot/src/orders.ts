import { admin, type Actor } from "./contracts";
export type Order = {
  id: string;
  user_id: string;
  plan_id: string;
  price: number;
  currency: string;
  duration: number;
  state: string;
  created_at: number;
};
export async function ensureUser(db: D1Database, userId: string) {
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO users(id) VALUES(?)").bind(userId),
    db
      .prepare("INSERT OR IGNORE INTO entitlements(user_id,uuid) VALUES(?,?)")
      .bind(userId, crypto.randomUUID()),
  ]);
}
export async function createOrder(
  db: D1Database,
  actor: Actor,
  planId: string,
  now: number,
  requestKey?: string,
): Promise<Order> {
  await ensureUser(db, actor.telegramId);
  const id = crypto.randomUUID();
  await db
    .prepare(
      "INSERT OR IGNORE INTO orders(id,user_id,plan_id,price,currency,duration,created_at,request_key) SELECT ?,?,id,price,currency,duration,?,? FROM plans WHERE id=? AND enabled=1 AND EXISTS(SELECT 1 FROM settings WHERE key='payment' AND length(trim(value))>0)",
    )
    .bind(
      id,
      actor.telegramId,
      now,
      requestKey ? `${actor.telegramId}:${requestKey}` : null,
      planId,
    )
    .run();
  const row = await db
    .prepare("SELECT * FROM orders WHERE user_id=? AND (id=? OR request_key=?)")
    .bind(
      actor.telegramId,
      id,
      requestKey ? `${actor.telegramId}:${requestKey}` : null,
    )
    .first<Order>();
  if (!row) throw new Error("SALES_DISABLED");
  return row;
}
export async function approveOrder(
  db: D1Database,
  actor: Actor,
  orderId: string,
  now: number,
): Promise<{ applied: boolean }> {
  admin(actor);
  const r = await db
    .prepare(
      "UPDATE orders SET state='approved',decided_at=?,decided_by=? WHERE id=? AND state='pending_review'",
    )
    .bind(now, actor.telegramId, orderId)
    .run();
  return { applied: r.meta.changes > 0 };
}
export async function reserveTrial(db: D1Database, actor: Actor) {
  await ensureUser(db, actor.telegramId);
  const r = await db
    .prepare("INSERT OR IGNORE INTO trials(user_id) VALUES(?)")
    .bind(actor.telegramId)
    .run();
  return { created: r.meta.changes === 1 };
}
export async function startTrialAfterAck(
  db: D1Database,
  userId: string,
  revision: number,
  now: number,
) {
  await db
    .prepare(
      "UPDATE trials SET started_at=? WHERE user_id=? AND started_at IS NULL AND prepared_revision=? AND acked_revision=?",
    )
    .bind(now, userId, revision, revision)
    .run();
}
export async function rejectOrder(
  db: D1Database,
  actor: Actor,
  id: string,
  reason: string,
  now: number,
) {
  admin(actor);
  if (!reason.trim() || reason.length > 300) throw new Error("INVALID_REASON");
  return db.batch([
    db
      .prepare(
        "UPDATE orders SET state='rejected',reason=?,decided_by=?,decided_at=? WHERE id=? AND state='pending_review'",
      )
      .bind(reason, actor.telegramId, now, id),
    db
      .prepare(
        "INSERT INTO audit_events(actor_id,action,target_id,created_at) SELECT ?,'reject_order',id,? FROM orders WHERE id=? AND state='rejected' AND decided_at=? AND decided_by=?",
      )
      .bind(actor.telegramId, now, id, now, actor.telegramId),
  ]);
}
