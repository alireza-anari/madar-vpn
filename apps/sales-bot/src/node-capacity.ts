// A live account keeps its full sold quota reserved until it is terminal,
// past its deadline, or exhausted. Blocked accounts are still resumable.
export const liveCommitmentPredicate =
  "(a.state IN ('preparing','active','blocked') AND (a.valid_until=0 OR a.valid_until>?) AND (a.quota_bytes IS NULL OR a.used_bytes<a.quota_bytes))";

// Transitional compatibility for the current account-creation guard. Task 4
// replaces that guard atomically; keeping this predicate avoids changing its
// behavior as a side effect of the read-model refactor in this task.
export const reservationPredicate =
  "(a.state IN ('preparing','active') AND (a.valid_until>? OR (a.state='preparing' AND a.valid_until=0)) AND (a.quota_bytes IS NULL OR a.used_bytes<a.quota_bytes))";

export interface NodeCapacity {
  id: string;
  name: string;
  operational_status: 'active'|'paused'|'archived';
  healthy: number;
  last_seen: number;
  agent_capabilities: string;
  max_accounts: number;
  max_accounts_unlimited?: number;
  max_allocated_bytes: number | null;
  reserved_accounts: number;
  committed_bytes: number;
  finalized_used_bytes: number;
  uncapped_accounts: number;
  // Compatibility alias for existing menu copy until the UX refactor.
  allocated_bytes: number;
}

export async function nodeCapacities(
  db: D1Database,
  now: number,
  nodeId: string | null = null,
) {
  return (
    await db
      .prepare(
        `WITH accounted AS (
          SELECT a.*,CASE WHEN ${liveCommitmentPredicate} THEN 1 ELSE 0 END is_live
          FROM managed_accounts a
        )
        SELECT
          n.id,n.name,COALESCE(os.value,'active') AS operational_status,n.healthy,n.last_seen,n.agent_capabilities,
          n.max_accounts,n.max_accounts_unlimited,n.max_allocated_bytes,
          COALESCE(SUM(CASE WHEN a.is_live=1 THEN 1 ELSE 0 END),0) reserved_accounts,
          COALESCE(SUM(CASE WHEN a.is_live=1 AND a.quota_bytes IS NOT NULL THEN a.quota_bytes ELSE 0 END),0) committed_bytes,
          COALESCE(SUM(CASE WHEN a.is_live=1 AND a.quota_bytes IS NOT NULL THEN a.quota_bytes ELSE 0 END),0) allocated_bytes,
          COALESCE(SUM(CASE WHEN a.is_live=1 AND a.quota_bytes IS NULL THEN 1 ELSE 0 END),0) uncapped_accounts,
          COALESCE(SUM(CASE
            WHEN a.id IS NULL OR a.is_live=1 THEN 0
            WHEN a.state='exhausted' AND a.quota_bytes IS NOT NULL THEN MIN(a.used_bytes,a.quota_bytes)
            ELSE a.used_bytes
          END),0) finalized_used_bytes
        FROM nodes n
        LEFT JOIN settings os ON os.key='node_status:'||n.id
        LEFT JOIN accounted a ON a.node_id=n.id
        WHERE (? IS NULL OR n.id=?)
        GROUP BY n.id
        ORDER BY n.name
        LIMIT 100`,
      )
      .bind(now, nodeId, nodeId)
      .all<NodeCapacity>()
  ).results;
}

export function chargedBytes(n: NodeCapacity) {
  return n.committed_bytes + n.finalized_used_bytes;
}

export function remainingAllocation(n: NodeCapacity) {
  if (n.max_allocated_bytes === null) return null;
  if (n.uncapped_accounts) return 0;
  return Math.max(0, n.max_allocated_bytes - chargedBytes(n));
}

export function remainingSlots(n: NodeCapacity) {
  if (n.max_accounts_unlimited === 1) return null;
  return Math.max(0, n.max_accounts - n.reserved_accounts);
}

export function utilizationPercent(n: NodeCapacity) {
  if (n.max_allocated_bytes === null) return null;
  if (n.uncapped_accounts) return 100;
  return (chargedBytes(n) / n.max_allocated_bytes) * 100;
}

export function canAllocate(n: NodeCapacity, requestedBytes: number) {
  if (!Number.isFinite(requestedBytes) || requestedBytes < 0) return false;
  const remaining = remainingAllocation(n);
  return remaining === null || remaining >= requestedBytes;
}

export function allocationLabel(n: NodeCapacity) {
  const remaining = remainingAllocation(n);
  return remaining === null
    ? "حجم قابل فروش: نامحدود"
    : `${(remaining / 1e9).toLocaleString("fa-IR")} گیگ باقی‌مانده`;
}
