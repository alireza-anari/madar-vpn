import { requireSalesAdmin, type SalesActor } from "./resellers";

async function requireNode(db: D1Database, nodeId: string) {
  const exists = await db
    .prepare("SELECT id FROM nodes WHERE id=?")
    .bind(nodeId)
    .first<string>("id");
  if (!exists) throw Error("INVALID_NODE");
}

export async function setNodeMaxAccounts(
  db: D1Database,
  actor: SalesActor,
  nodeId: string,
  maxAccounts: number,
  now: number,
): Promise<void> {
  requireSalesAdmin(actor);
  if (
    !Number.isSafeInteger(maxAccounts) ||
    maxAccounts < 1 ||
    maxAccounts > 10_000
  )
    throw Error("INVALID_CAPACITY");
  await requireNode(db, nodeId);
  await db.batch([
    db
      .prepare(
        "UPDATE nodes SET max_accounts=?,max_accounts_unlimited=0 WHERE id=?",
      )
      .bind(maxAccounts, nodeId),
    db
      .prepare(
        "INSERT INTO audit_events(actor_id,action,target_id,created_at) VALUES(?,'node_capacity',?,?)",
      )
      .bind(actor.telegramId, nodeId, now),
  ]);
}

export async function setNodeUnlimitedAccounts(
  db: D1Database,
  actor: SalesActor,
  nodeId: string,
  unlimited: boolean,
  now: number,
): Promise<void> {
  requireSalesAdmin(actor);
  if (typeof unlimited !== "boolean") throw Error("INVALID_CAPACITY");
  await requireNode(db, nodeId);
  await db.batch([
    db
      .prepare("UPDATE nodes SET max_accounts_unlimited=? WHERE id=?")
      .bind(unlimited ? 1 : 0, nodeId),
    db
      .prepare(
        "INSERT INTO audit_events(actor_id,action,target_id,created_at) VALUES(?,'node_account_slot_mode',?,?)",
      )
      .bind(actor.telegramId, nodeId, now),
  ]);
}

export async function setNodeMaxAllocatedBytes(
  db: D1Database,
  actor: SalesActor,
  nodeId: string,
  maxAllocatedBytes: number | null,
  now: number,
): Promise<void> {
  requireSalesAdmin(actor);
  if (
    maxAllocatedBytes !== null &&
    (!Number.isSafeInteger(maxAllocatedBytes) ||
      maxAllocatedBytes < 1 ||
      maxAllocatedBytes > 1_000_000_000_000_000)
  )
    throw Error("INVALID_ALLOCATION_CAP");
  await requireNode(db, nodeId);
  await db.batch([
    db
      .prepare("UPDATE nodes SET max_allocated_bytes=? WHERE id=?")
      .bind(maxAllocatedBytes, nodeId),
    db
      .prepare(
        "INSERT INTO audit_events(actor_id,action,target_id,created_at) VALUES(?,'node_allocation_cap',?,?)",
      )
      .bind(actor.telegramId, nodeId, now),
  ]);
}
