import type { Actor } from "./contracts";
export async function recordReceipt(
  db: D1Database,
  actor: Actor,
  orderId: string,
  fileId: string,
  kind: "photo" | "document" = "document",
) {
  if (!fileId || fileId.length > 1000) throw new Error("INVALID_RECEIPT");
  const r = await db.batch([
    db
      .prepare(
        "INSERT OR IGNORE INTO receipts(order_id,file_id,kind) SELECT id,?,? FROM orders WHERE id=? AND user_id=? AND state='awaiting_receipt'",
      )
      .bind(fileId, kind, orderId, actor.telegramId),
    db
      .prepare(
        "UPDATE orders SET state='pending_review' WHERE id=? AND user_id=? AND state='awaiting_receipt' AND EXISTS(SELECT 1 FROM receipts WHERE order_id=?)",
      )
      .bind(orderId, actor.telegramId, orderId),
  ]);
  if (!r[1]?.meta.changes) throw new Error("ORDER_NOT_AVAILABLE");
}
