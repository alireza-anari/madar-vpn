import {
  nodeCapacities,
  remainingAllocation,
  type NodeCapacity,
} from "./node-capacity";
import {
  sellerLimits,
  sellerNodeStats,
  sellerStats,
} from "./seller-accounting";
import { requireSeller, type SalesActor } from "./resellers";
import {
  effectiveAccountState,
  presentNode,
  type AppConfig,
  type AppNode,
} from "./app-presenters";

export interface AppConfigPage {
  items: AppConfig[];
  nextCursor: string | null;
}

export interface AppSellerStats {
  current: Awaited<ReturnType<typeof sellerStats>>;
  all: Awaited<ReturnType<typeof sellerStats>>;
  limits: Awaited<ReturnType<typeof sellerLimits>>;
  nodes: Awaited<ReturnType<typeof sellerNodeStats>>;
}

export type AppDashboard =
  | {
      role: "admin";
      summary: {
        configsInService: number;
        reservedBytes: number;
        finalizedUsedBytes: number;
        activeSellers: number;
      };
      nodes: AppNode[];
    }
  | {
      role: "seller";
      summary: {
        configsInService: number;
        currentSoldBytes: number;
        allTimeSoldBytes: number;
        usedBytes: number;
        maxReservedAccounts: number | null;
        maxCommittedBytes: number | null;
        reservedAccounts: number;
        committedBytes: number;
      };
      nodes: AppNode[];
    };

function safeOffset(cursor?: string) {
  if (cursor === undefined || cursor === "") return 0;
  if (!/^\d+$/.test(cursor)) throw Error("INVALID_CURSOR");
  const value = Number(cursor);
  if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000)
    throw Error("INVALID_CURSOR");
  return value;
}

function recommendationScore(node: AppNode) {
  return node.sellableBytes === null ? Number.POSITIVE_INFINITY : node.sellableBytes;
}

export async function listAppNodes(
  db: D1Database,
  actor: SalesActor,
  now: number,
  requestedBytes?: number,
): Promise<AppNode[]> {
  await requireSeller(db, actor);
  const capacities = await nodeCapacities(db, now);
  const levels =
    actor.role === "admin"
      ? await db
          .prepare("SELECT node_id,level FROM node_capacity_alert_state")
          .all<{ node_id: string; level: number }>()
      : { results: [] as { node_id: string; level: number }[] };
  const levelByNode = new Map(levels.results.map((row) => [row.node_id, row.level]));
  const nodes = capacities.map((n) =>
    presentNode(n, actor, now, requestedBytes, levelByNode.get(n.id) || 0),
  );
  const recommended = nodes
    .filter((n) => n.eligible)
    .sort((a, b) => {
      const capacity = recommendationScore(b) - recommendationScore(a);
      if (Number.isFinite(capacity) && capacity !== 0) return capacity;
      if (a.displayName !== b.displayName)
        return a.displayName.localeCompare(b.displayName);
      return a.id.localeCompare(b.id);
    })[0];
  if (recommended) recommended.recommended = true;
  return nodes;
}

export async function loadSellerSelfStats(
  db: D1Database,
  actor: SalesActor,
  now: number,
): Promise<AppSellerStats> {
  await requireSeller(db, actor);
  if (actor.role !== "seller") throw Error("SELLER_REQUIRED");
  const [current, all, limits, nodes] = await Promise.all([
    sellerStats(db, actor.telegramId, "current", now),
    sellerStats(db, actor.telegramId, "all", now),
    sellerLimits(db, actor.telegramId, now),
    sellerNodeStats(db, actor.telegramId, "current", now),
  ]);
  return { current, all, limits, nodes };
}

export async function loadAppDashboard(
  db: D1Database,
  actor: SalesActor,
  now: number,
): Promise<AppDashboard> {
  await requireSeller(db, actor);
  if (actor.role === "admin") {
    const [nodes, sellerCount] = await Promise.all([
      nodeCapacities(db, now),
      db
        .prepare("SELECT COUNT(*) count FROM resellers WHERE enabled=1")
        .first<{ count: number }>(),
    ]);
    return {
      role: "admin",
      summary: {
        configsInService: nodes.reduce((sum, n) => sum + n.reserved_accounts, 0),
        reservedBytes: nodes.reduce((sum, n) => sum + n.committed_bytes, 0),
        finalizedUsedBytes: nodes.reduce(
          (sum, n) => sum + n.finalized_used_bytes,
          0,
        ),
        activeSellers: sellerCount?.count || 0,
      },
      nodes: await listAppNodes(db, actor, now),
    };
  }
  const stats = await loadSellerSelfStats(db, actor, now);
  return {
    role: "seller",
    summary: {
      configsInService: stats.limits.reservedAccounts,
      currentSoldBytes: stats.current.soldBytes,
      allTimeSoldBytes: stats.all.soldBytes,
      usedBytes: stats.all.usedBytes,
      maxReservedAccounts: stats.limits.maxReservedAccounts,
      maxCommittedBytes: stats.limits.maxCommittedBytes,
      reservedAccounts: stats.limits.reservedAccounts,
      committedBytes: stats.limits.committedBytes,
    },
    nodes: await listAppNodes(db, actor, now),
  };
}

export async function listAppConfigs(
  db: D1Database,
  actor: SalesActor,
  now: number,
  cursor?: string,
): Promise<AppConfigPage> {
  await requireSeller(db, actor);
  const offset = safeOffset(cursor);
  const rows = await db
    .prepare(
      `SELECT id,seller_id,node_id,label,state,quota_bytes,used_bytes,valid_until,created_at
       FROM managed_accounts
       WHERE (seller_id=? OR ?=1)
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
