import { loadAppDashboard } from "./app-dashboard";
import {
  nodeCapacities,
  remainingAllocation,
  remainingSlots,
  utilizationPercent,
} from "./node-capacity";
import {
  sellerLimits,
  sellerNodeStats,
  sellerStats,
} from "./seller-accounting";
import { requireSalesAdmin, type SalesActor } from "./resellers";

export async function loadAdminNodeDetail(
  db: D1Database,
  actor: SalesActor,
  nodeId: string,
  now: number,
) {
  requireSalesAdmin(actor);
  const [capacity] = await nodeCapacities(db, now, nodeId);
  if (!capacity) throw Error("INVALID_NODE");
  const technical = await db
    .prepare(
      `SELECT target_ip,vpn_port,state,revision,acked_revision,last_seen,healthy,
        agent_capabilities,public_key,short_id,sni
       FROM nodes WHERE id=?`,
    )
    .bind(nodeId)
    .first<{
      target_ip: string;
      vpn_port: number;
      state: string;
      revision: number;
      acked_revision: number;
      last_seen: number;
      healthy: number;
      agent_capabilities: string;
      public_key: string | null;
      short_id: string | null;
      sni: string | null;
    }>();
  if (!technical) throw Error("INVALID_NODE");
  const alertLevel =
    (await db
      .prepare("SELECT level FROM node_capacity_alert_state WHERE node_id=?")
      .bind(nodeId)
      .first<number>("level")) || 0;
  const purposes = await db
    .prepare("SELECT purpose FROM node_purposes WHERE node_id=? ORDER BY purpose")
    .bind(nodeId)
    .all<{ purpose: string }>();
  const slots = remainingSlots(capacity);
  return {
    id: capacity.id,
    displayName: capacity.name,
    targetIp: technical.target_ip,
    vpnPort: technical.vpn_port,
    state: technical.state,
    revision: technical.revision,
    ackedRevision: technical.acked_revision,
    lastSeen: technical.last_seen,
    healthy:
      technical.healthy === 1 &&
      technical.last_seen > now - 90 &&
      technical.agent_capabilities.split(",").includes("quota-v2"),
    agentCapabilities: technical.agent_capabilities
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    publicKey: technical.public_key,
    shortId: technical.short_id,
    sni: technical.sni,
    purposes: purposes.results.map((row) => row.purpose),
    maxAllocatedBytes: capacity.max_allocated_bytes,
    committedBytes: capacity.committed_bytes,
    finalizedUsedBytes: capacity.finalized_used_bytes,
    sellableBytes: remainingAllocation(capacity),
    utilizationPercent: utilizationPercent(capacity),
    reservedAccounts: capacity.reserved_accounts,
    maxAccounts: capacity.max_accounts_unlimited === 1 ? null : capacity.max_accounts,
    remainingSlots: slots,
    accountSlotsUnlimited: capacity.max_accounts_unlimited === 1,
    alertLevel,
  };
}

export async function loadAdminSellerDetail(
  db: D1Database,
  actor: SalesActor,
  sellerId: string,
  now: number,
) {
  requireSalesAdmin(actor);
  const seller = await db
    .prepare("SELECT enabled,created_at FROM resellers WHERE telegram_id=?")
    .bind(sellerId)
    .first<{ enabled: number; created_at: number }>();
  if (!seller) throw Error("INVALID_SELLER");
  const [current, all, limits, currentNodes, allNodes] = await Promise.all([
    sellerStats(db, sellerId, "current", now),
    sellerStats(db, sellerId, "all", now),
    sellerLimits(db, sellerId, now),
    sellerNodeStats(db, sellerId, "current", now),
    sellerNodeStats(db, sellerId, "all", now),
  ]);
  return {
    sellerId,
    enabled: seller.enabled === 1,
    createdAt: seller.created_at,
    current,
    all,
    limits,
    currentNodes,
    allNodes,
  };
}

export async function listAdminSellerCards(
  db: D1Database,
  actor: SalesActor,
  now: number,
) {
  requireSalesAdmin(actor);
  const sellers = await db
    .prepare(
      "SELECT telegram_id,enabled,created_at FROM resellers ORDER BY enabled DESC,created_at DESC,telegram_id LIMIT 100",
    )
    .all<{ telegram_id: string; enabled: number; created_at: number }>();
  return Promise.all(
    sellers.results.map(async (seller) => {
      const [current, all, limits] = await Promise.all([
        sellerStats(db, seller.telegram_id, "current", now),
        sellerStats(db, seller.telegram_id, "all", now),
        sellerLimits(db, seller.telegram_id, now),
      ]);
      return {
        sellerId: seller.telegram_id,
        enabled: seller.enabled === 1,
        createdAt: seller.created_at,
        current,
        all,
        limits,
      };
    }),
  );
}

export async function listAdminSellerSettlements(
  db: D1Database,
  actor: SalesActor,
  sellerId: string,
) {
  requireSalesAdmin(actor);
  const exists = await db
    .prepare("SELECT telegram_id FROM resellers WHERE telegram_id=?")
    .bind(sellerId)
    .first<string>("telegram_id");
  if (!exists) throw Error("INVALID_SELLER");
  const rows = await db
    .prepare(
      `SELECT id,epoch,started_at,ended_at,config_count,sold_bytes,used_bytes,
        live_count,blocked_count,expired_count,revoked_count,exhausted_count,
        created_by,created_at
       FROM reseller_settlements
       WHERE seller_id=? ORDER BY ended_at DESC,epoch DESC LIMIT 20`,
    )
    .bind(sellerId)
    .all<{
      id: string;
      epoch: number;
      started_at: number;
      ended_at: number;
      config_count: number;
      sold_bytes: number;
      used_bytes: number;
      live_count: number;
      blocked_count: number;
      expired_count: number;
      revoked_count: number;
      exhausted_count: number;
      created_by: string;
      created_at: number;
    }>();
  return Promise.all(
    rows.results.map(async (row) => {
      const nodes = await db
        .prepare(
          `SELECT sn.node_id,n.name node_name,sn.config_count,sn.sold_bytes,sn.used_bytes
           FROM reseller_settlement_nodes sn
           LEFT JOIN nodes n ON n.id=sn.node_id
           WHERE sn.settlement_id=? ORDER BY COALESCE(n.name,''),sn.node_id`,
        )
        .bind(row.id)
        .all<{
          node_id: string;
          node_name: string | null;
          config_count: number;
          sold_bytes: number;
          used_bytes: number;
        }>();
      return {
        settlementId: row.id,
        epoch: row.epoch,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        configCount: row.config_count,
        soldBytes: row.sold_bytes,
        usedBytes: row.used_bytes,
        liveCount: row.live_count,
        blockedCount: row.blocked_count,
        expiredCount: row.expired_count,
        revokedCount: row.revoked_count,
        exhaustedCount: row.exhausted_count,
        createdBy: row.created_by,
        createdAt: row.created_at,
        nodes: nodes.results.map((node) => ({
          nodeId: node.node_id,
          nodeName: node.node_name || node.node_id,
          configCount: node.config_count,
          soldBytes: node.sold_bytes,
          usedBytes: node.used_bytes,
        })),
      };
    }),
  );
}

export async function loadAdminReportOverview(
  db: D1Database,
  actor: SalesActor,
  now: number,
) {
  requireSalesAdmin(actor);
  const [dashboard, sellers] = await Promise.all([
    loadAppDashboard(db, actor, now),
    listAdminSellerCards(db, actor, now),
  ]);
  if (dashboard.role !== "admin") throw Error("ADMIN_REQUIRED");
  return {
    summary: dashboard.summary,
    nodes: dashboard.nodes,
    sellers,
  };
}
