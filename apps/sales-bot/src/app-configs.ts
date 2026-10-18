import { effectiveAccountState, type AppConfig } from "./app-presenters";
import { requireSeller, type SalesActor } from "./resellers";
import { loadTelegramProfile, profileDisplayName } from "./telegram-profiles";

function safeOffset(cursor?: string) {
  if (cursor === undefined || cursor === "") return 0;
  if (!/^\d+$/.test(cursor)) throw Error("INVALID_CURSOR");
  const value = Number(cursor);
  if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000)
    throw Error("INVALID_CURSOR");
  return value;
}

export async function listVisibleAppConfigs(
  db: D1Database,
  actor: SalesActor,
  now: number,
  cursor?: string,
): Promise<{ items: AppConfig[]; nextCursor: string | null }> {
  await requireSeller(db, actor);
  const offset = safeOffset(cursor);
  const rows = await db
    .prepare(
      `SELECT id,seller_id,node_id,label,state,quota_bytes,used_bytes,valid_until,created_at
       FROM managed_accounts
       WHERE archived_at IS NULL AND (seller_id=? OR ?=1)
       ORDER BY created_at DESC,id DESC
       LIMIT 21 OFFSET ?`,
    )
    .bind(actor.telegramId, actor.role === "admin" ? 1 : 0, offset)
    .all<{
      id: string;
      seller_id: string;
      node_id: string;
      label: string;
      state: string;
      quota_bytes: number | null;
      used_bytes: number;
      valid_until: number;
      created_at: number;
    }>();
  const visible = rows.results.slice(0, 20);
  return {
    items: visible.map((row) => ({
      id: row.id,
      sellerId: row.seller_id,
      nodeId: row.node_id,
      label: row.label,
      state: effectiveAccountState(row, now),
      quotaBytes: row.quota_bytes,
      usedBytes: row.used_bytes,
      validUntil: row.valid_until,
      createdAt: row.created_at,
    })),
    nextCursor: rows.results.length > 20 ? String(offset + 20) : null,
  };
}

export async function loadAppConfigDetail(
  db: D1Database,
  actor: SalesActor,
  id: string,
  now: number,
) {
  await requireSeller(db, actor);
  const row = await db
    .prepare(
      `SELECT a.id,a.seller_id,a.node_id,a.label,a.state,a.quota_bytes,a.used_bytes,
        a.valid_until,a.created_at,a.archived_at,a.archived_by,n.name server_name
       FROM managed_accounts a
       LEFT JOIN nodes n ON n.id=a.node_id
       WHERE a.id=? AND (a.seller_id=? OR ?=1)`,
    )
    .bind(id, actor.telegramId, actor.role === "admin" ? 1 : 0)
    .first<{
      id: string;
      seller_id: string;
      node_id: string;
      label: string;
      state: string;
      quota_bytes: number | null;
      used_bytes: number;
      valid_until: number;
      created_at: number;
      archived_at: number | null;
      archived_by: string | null;
      server_name: string | null;
    }>();
  if (!row) throw Error("ACCOUNT_NOT_FOUND");
  const profile =
    actor.role === "admin" ? await loadTelegramProfile(db, row.seller_id) : null;
  return {
    id: row.id,
    sellerId: row.seller_id,
    sellerDisplayName: profile ? profileDisplayName(profile) : undefined,
    nodeId: row.node_id,
    serverName: row.server_name || row.node_id,
    label: row.label,
    state: effectiveAccountState(row, now),
    quotaBytes: row.quota_bytes,
    usedBytes: row.used_bytes,
    remainingBytes:
      row.quota_bytes === null ? null : Math.max(0, row.quota_bytes - row.used_bytes),
    validUntil: row.valid_until,
    createdAt: row.created_at,
    archivedAt: row.archived_at,
    archivedBy: row.archived_by,
  };
}
