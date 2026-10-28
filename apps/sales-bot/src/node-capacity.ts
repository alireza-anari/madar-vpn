// A partially consumed account still reserves its full assigned quota.
export const reservationPredicate =
  "(a.state IN ('preparing','active') AND (a.valid_until>? OR (a.state='preparing' AND a.valid_until=0)) AND (a.quota_bytes IS NULL OR a.used_bytes<a.quota_bytes))";
export interface NodeCapacity {
  id: string;
  name: string;
  healthy: number;
  last_seen: number;
  agent_capabilities: string;
  max_accounts: number;
  max_allocated_bytes: number | null;
  reserved_accounts: number;
  allocated_bytes: number;
  uncapped_accounts: number;
}
export async function nodeCapacities(
  db: D1Database,
  now: number,
  nodeId: string | null = null,
) {
  return (
    await db
      .prepare(
        `SELECT n.id,n.name,CASE WHEN n.healthy=1 AND n.state='ready' AND n.revision=n.acked_revision AND n.last_seen>? THEN 1 ELSE 0 END AS healthy,n.last_seen,n.agent_capabilities,n.max_accounts,n.max_allocated_bytes,COUNT(a.id) reserved_accounts,COALESCE(SUM(a.quota_bytes),0) allocated_bytes,COUNT(a.id)-COUNT(a.quota_bytes) uncapped_accounts FROM nodes n LEFT JOIN managed_accounts a ON a.node_id=n.id AND ${reservationPredicate} WHERE (? IS NULL OR n.id=?) GROUP BY n.id ORDER BY n.name LIMIT 100`,
      )
      .bind(now - 90, now, nodeId, nodeId)
      .all<NodeCapacity>()
  ).results;
}
export function remainingAllocation(n: NodeCapacity) {
  return n.max_allocated_bytes === null
    ? null
    : n.uncapped_accounts
      ? 0
      : Math.max(0, n.max_allocated_bytes - n.allocated_bytes);
}
export function allocationLabel(n: NodeCapacity) {
  const remaining = remainingAllocation(n);
  return remaining === null
    ? "حجم بدون سقف"
    : `${(remaining / 1e9).toLocaleString("fa-IR")} گیگ باقی‌مانده`;
}
