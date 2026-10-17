import { liveCommitmentPredicate } from "./node-capacity";
import { requireSalesAdmin, type SalesActor } from "./resellers";

export interface SellerStats {
  sellerId: string;
  epoch: number | null;
  startedAt: number;
  configCount: number;
  soldBytes: number;
  usedBytes: number;
  liveCount: number;
  blockedCount: number;
  expiredCount: number;
  revokedCount: number;
  exhaustedCount: number;
}

export interface SellerNodeStats {
  nodeId: string;
  nodeName: string;
  configCount: number;
  soldBytes: number;
  usedBytes: number;
}

export interface SellerLimits {
  maxReservedAccounts: number | null;
  maxCommittedBytes: number | null;
  reservedAccounts: number;
  committedBytes: number;
  uncappedAccounts: number;
}

type SellerMeta = {
  seller_id: string;
  created_at: number;
  epoch: number;
  started_at: number;
  max_reserved_accounts: number | null;
  max_committed_bytes: number | null;
};

const effectiveState =
  "CASE WHEN a.state='expired' OR (a.state IN ('active','blocked') AND a.valid_until>0 AND a.valid_until<=?) THEN 'expired' WHEN a.state='exhausted' OR (a.state IN ('active','blocked') AND a.quota_bytes IS NOT NULL AND a.used_bytes>=a.quota_bytes) THEN 'exhausted' ELSE a.state END";

async function sellerMeta(db: D1Database, sellerId: string): Promise<SellerMeta> {
  const row = await db
    .prepare(
      `SELECT r.telegram_id seller_id,r.created_at,
        COALESCE(c.current_settlement_epoch,0) epoch,
        CASE WHEN c.settlement_started_at IS NULL OR c.settlement_started_at=0 THEN r.created_at ELSE c.settlement_started_at END started_at,
        c.max_reserved_accounts,c.max_committed_bytes
       FROM resellers r LEFT JOIN reseller_controls c ON c.seller_id=r.telegram_id
       WHERE r.telegram_id=?`,
    )
    .bind(sellerId)
    .first<SellerMeta>();
  if (!row) throw Error("INVALID_SELLER");
  return row;
}

export async function sellerStats(
  db: D1Database,
  sellerId: string,
  scope: "current" | "all",
  now: number,
): Promise<SellerStats> {
  const meta = await sellerMeta(db, sellerId);
  const current = scope === "current";
  const sql = `WITH scoped AS (
    SELECT a.*,
      CASE WHEN ${liveCommitmentPredicate} THEN 1 ELSE 0 END is_live,
      ${effectiveState} effective_state
    FROM managed_accounts a
    WHERE a.seller_id=?${current ? " AND a.seller_settlement_epoch=?" : ""}
  )
  SELECT COUNT(*) config_count,
    COALESCE(SUM(COALESCE(quota_bytes,0)),0) sold_bytes,
    COALESCE(SUM(used_bytes),0) used_bytes,
    COALESCE(SUM(CASE WHEN is_live=1 AND state IN ('preparing','active') THEN 1 ELSE 0 END),0) live_count,
    COALESCE(SUM(CASE WHEN is_live=1 AND state='blocked' THEN 1 ELSE 0 END),0) blocked_count,
    COALESCE(SUM(CASE WHEN effective_state='expired' THEN 1 ELSE 0 END),0) expired_count,
    COALESCE(SUM(CASE WHEN effective_state='revoked' THEN 1 ELSE 0 END),0) revoked_count,
    COALESCE(SUM(CASE WHEN effective_state='exhausted' THEN 1 ELSE 0 END),0) exhausted_count
  FROM scoped`;
  const statement = db.prepare(sql);
  const row = current
    ? await statement
        .bind(now, now, sellerId, meta.epoch)
        .first<{
          config_count: number;
          sold_bytes: number;
          used_bytes: number;
          live_count: number;
          blocked_count: number;
          expired_count: number;
          revoked_count: number;
          exhausted_count: number;
        }>()
    : await statement
        .bind(now, now, sellerId)
        .first<{
          config_count: number;
          sold_bytes: number;
          used_bytes: number;
          live_count: number;
          blocked_count: number;
          expired_count: number;
          revoked_count: number;
          exhausted_count: number;
        }>();
  return {
    sellerId,
    epoch: current ? meta.epoch : null,
    startedAt: current ? meta.started_at : meta.created_at,
    configCount: row?.config_count || 0,
    soldBytes: row?.sold_bytes || 0,
    usedBytes: row?.used_bytes || 0,
    liveCount: row?.live_count || 0,
    blockedCount: row?.blocked_count || 0,
    expiredCount: row?.expired_count || 0,
    revokedCount: row?.revoked_count || 0,
    exhaustedCount: row?.exhausted_count || 0,
  };
}

export async function sellerNodeStats(
  db: D1Database,
  sellerId: string,
  scope: "current" | "all",
  _now: number,
): Promise<SellerNodeStats[]> {
  const meta = await sellerMeta(db, sellerId);
  const current = scope === "current";
  const statement = db.prepare(
    `SELECT a.node_id node_id,n.name node_name,COUNT(*) config_count,
      COALESCE(SUM(COALESCE(a.quota_bytes,0)),0) sold_bytes,
      COALESCE(SUM(a.used_bytes),0) used_bytes
     FROM managed_accounts a JOIN nodes n ON n.id=a.node_id
     WHERE a.seller_id=?${current ? " AND a.seller_settlement_epoch=?" : ""}
     GROUP BY a.node_id,n.name ORDER BY n.name,a.node_id`,
  );
  const rows = current
    ? await statement
        .bind(sellerId, meta.epoch)
        .all<{
          node_id: string;
          node_name: string;
          config_count: number;
          sold_bytes: number;
          used_bytes: number;
        }>()
    : await statement.bind(sellerId).all<{
        node_id: string;
        node_name: string;
        config_count: number;
        sold_bytes: number;
        used_bytes: number;
      }>();
  return rows.results.map((row) => ({
    nodeId: row.node_id,
    nodeName: row.node_name,
    configCount: row.config_count,
    soldBytes: row.sold_bytes,
    usedBytes: row.used_bytes,
  }));
}

export async function sellerLimits(
  db: D1Database,
  sellerId: string,
  now: number,
): Promise<SellerLimits> {
  const meta = await sellerMeta(db, sellerId);
  const row = await db
    .prepare(
      `WITH scoped AS (
        SELECT a.*,CASE WHEN ${liveCommitmentPredicate} THEN 1 ELSE 0 END is_live
        FROM managed_accounts a WHERE a.seller_id=?
      )
      SELECT
        COALESCE(SUM(CASE WHEN is_live=1 THEN 1 ELSE 0 END),0) reserved_accounts,
        COALESCE(SUM(CASE WHEN is_live=1 AND quota_bytes IS NOT NULL THEN quota_bytes ELSE 0 END),0) committed_bytes,
        COALESCE(SUM(CASE WHEN is_live=1 AND quota_bytes IS NULL THEN 1 ELSE 0 END),0) uncapped_accounts
      FROM scoped`,
    )
    .bind(now, sellerId)
    .first<{
      reserved_accounts: number;
      committed_bytes: number;
      uncapped_accounts: number;
    }>();
  return {
    maxReservedAccounts: meta.max_reserved_accounts,
    maxCommittedBytes: meta.max_committed_bytes,
    reservedAccounts: row?.reserved_accounts || 0,
    committedBytes: row?.committed_bytes || 0,
    uncappedAccounts: row?.uncapped_accounts || 0,
  };
}

function validCount(value: number | null) {
  return value === null || (Number.isSafeInteger(value) && value >= 1 && value <= 10000);
}
function validBytes(value: number | null) {
  return (
    value === null ||
    (Number.isSafeInteger(value) && value >= 1 && value <= 1_000_000_000_000_000)
  );
}

export async function setSellerLimits(
  db: D1Database,
  actor: SalesActor,
  sellerId: string,
  limits: {
    maxReservedAccounts: number | null;
    maxCommittedBytes: number | null;
  },
  now: number,
) {
  requireSalesAdmin(actor);
  if (!validCount(limits.maxReservedAccounts) || !validBytes(limits.maxCommittedBytes))
    throw Error("INVALID_SELLER_LIMITS");
  await sellerMeta(db, sellerId);
  await db.batch([
    db
      .prepare(
        `INSERT INTO reseller_controls(seller_id,current_settlement_epoch,settlement_started_at,max_reserved_accounts,max_committed_bytes,updated_at)
         SELECT telegram_id,0,created_at,?,?,? FROM resellers WHERE telegram_id=?
         ON CONFLICT(seller_id) DO UPDATE SET
           max_reserved_accounts=excluded.max_reserved_accounts,
           max_committed_bytes=excluded.max_committed_bytes,
           updated_at=excluded.updated_at`,
      )
      .bind(limits.maxReservedAccounts, limits.maxCommittedBytes, now, sellerId),
    db
      .prepare(
        "INSERT INTO audit_events(actor_id,action,target_id,created_at) VALUES(?,'seller_limits',?,?)",
      )
      .bind(actor.telegramId, sellerId, now),
  ]);
}

export async function settleSeller(
  db: D1Database,
  actor: SalesActor,
  sellerId: string,
  now: number,
): Promise<{ settlementId: string; closedEpoch: number }> {
  requireSalesAdmin(actor);
  await sellerMeta(db, sellerId);
  await db
    .prepare(
      `INSERT OR IGNORE INTO reseller_controls(seller_id,current_settlement_epoch,settlement_started_at,updated_at)
       SELECT telegram_id,0,created_at,? FROM resellers WHERE telegram_id=?`,
    )
    .bind(now, sellerId)
    .run();
  const meta = await sellerMeta(db, sellerId);
  const settlementId = crypto.randomUUID();
  const results = await db.batch([
    db
      .prepare(
        `WITH scoped AS (
          SELECT a.*,
            CASE WHEN ${liveCommitmentPredicate} THEN 1 ELSE 0 END is_live,
            ${effectiveState} effective_state
          FROM managed_accounts a
          WHERE a.seller_id=? AND a.seller_settlement_epoch=?
        )
        INSERT INTO reseller_settlements(
          id,seller_id,epoch,started_at,ended_at,config_count,sold_bytes,used_bytes,
          live_count,blocked_count,expired_count,revoked_count,exhausted_count,created_by,created_at
        )
        SELECT ?,?,?,?,?,COUNT(*),
          COALESCE(SUM(COALESCE(quota_bytes,0)),0),COALESCE(SUM(used_bytes),0),
          COALESCE(SUM(CASE WHEN is_live=1 AND state IN ('preparing','active') THEN 1 ELSE 0 END),0),
          COALESCE(SUM(CASE WHEN is_live=1 AND state='blocked' THEN 1 ELSE 0 END),0),
          COALESCE(SUM(CASE WHEN effective_state='expired' THEN 1 ELSE 0 END),0),
          COALESCE(SUM(CASE WHEN effective_state='revoked' THEN 1 ELSE 0 END),0),
          COALESCE(SUM(CASE WHEN effective_state='exhausted' THEN 1 ELSE 0 END),0),?,?
        FROM scoped`,
      )
      .bind(
        now,
        now,
        sellerId,
        meta.epoch,
        settlementId,
        sellerId,
        meta.epoch,
        meta.started_at,
        now,
        actor.telegramId,
        now,
      ),
    db
      .prepare(
        `INSERT INTO reseller_settlement_nodes(settlement_id,node_id,config_count,sold_bytes,used_bytes)
         SELECT ?,a.node_id,COUNT(*),COALESCE(SUM(COALESCE(a.quota_bytes,0)),0),COALESCE(SUM(a.used_bytes),0)
         FROM managed_accounts a
         WHERE a.seller_id=? AND a.seller_settlement_epoch=?
         GROUP BY a.node_id`,
      )
      .bind(settlementId, sellerId, meta.epoch),
    db
      .prepare(
        "UPDATE reseller_controls SET current_settlement_epoch=current_settlement_epoch+1,settlement_started_at=?,updated_at=? WHERE seller_id=? AND current_settlement_epoch=?",
      )
      .bind(now, now, sellerId, meta.epoch),
    db
      .prepare(
        "INSERT INTO audit_events(actor_id,action,target_id,created_at) VALUES(?,'seller_settlement',?,?)",
      )
      .bind(actor.telegramId, sellerId, now),
  ]);
  if (!results[2]?.meta.changes) throw Error("SETTLEMENT_CONFLICT");
  return { settlementId, closedEpoch: meta.epoch };
}
