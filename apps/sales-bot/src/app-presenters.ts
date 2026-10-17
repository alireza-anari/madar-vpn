import {
  canAllocate,
  remainingAllocation,
  utilizationPercent,
  type NodeCapacity,
} from "./node-capacity";
import type { SalesActor } from "./resellers";

export interface AppNode {
  id: string;
  displayName: string;
  healthy: boolean;
  sellableBytes: number | null;
  remainingSlots: number | null;
  utilizationPercent: number | null;
  eligible: boolean;
  ineligibleReason?: string;
  recommended?: boolean;
  alertLevel?: number;
  maxAllocatedBytes?: number | null;
  committedBytes?: number;
  finalizedUsedBytes?: number;
  reservedAccounts?: number;
  maxAccounts?: number;
}

export interface AppConfig {
  id: string;
  sellerId: string;
  nodeId: string;
  label: string;
  state: string;
  quotaBytes: number | null;
  usedBytes: number;
  validUntil: number;
  createdAt: number;
}

export function effectiveAccountState(
  row: { state: string; valid_until: number; quota_bytes: number | null; used_bytes: number },
  now: number,
) {
  if (
    ["active", "blocked"].includes(row.state) &&
    row.valid_until > 0 &&
    row.valid_until <= now
  )
    return "expired";
  if (
    ["active", "blocked"].includes(row.state) &&
    row.quota_bytes !== null &&
    row.used_bytes >= row.quota_bytes
  )
    return "exhausted";
  return row.state;
}

export function presentNode(
  n: NodeCapacity,
  actor: SalesActor,
  now: number,
  requestedBytes?: number,
  alertLevel = 0,
): AppNode {
  const healthy =
    n.healthy === 1 &&
    n.last_seen > now - 90 &&
    n.agent_capabilities.split(",").includes("quota-v2");
  const sellableBytes = remainingAllocation(n);
  const remainingSlots = Math.max(0, n.max_accounts - n.reserved_accounts);
  const bytesOk = requestedBytes === undefined || canAllocate(n, requestedBytes);
  const slotsOk = remainingSlots > 0;
  const eligible = healthy && bytesOk && slotsOk;
  const base: AppNode = {
    id: n.id,
    displayName: n.name,
    healthy,
    sellableBytes,
    remainingSlots,
    utilizationPercent: utilizationPercent(n),
    eligible,
  };
  if (!healthy) base.ineligibleReason = "NODE_UNAVAILABLE";
  else if (!slotsOk) base.ineligibleReason = "NODE_SLOT_LIMIT";
  else if (!bytesOk) base.ineligibleReason = "INSUFFICIENT_NODE_CAPACITY";
  if (actor.role === "admin") {
    base.alertLevel = alertLevel;
    base.maxAllocatedBytes = n.max_allocated_bytes;
    base.committedBytes = n.committed_bytes;
    base.finalizedUsedBytes = n.finalized_used_bytes;
    base.reservedAccounts = n.reserved_accounts;
    base.maxAccounts = n.max_accounts;
  }
  return base;
}
