import { createAccount } from "./accounts";
import { readManagedWsRollout, type ManagedWsNodeStatus } from "./alternate-transport";
import { canAllocate, nodeCapacities, remainingSlots } from "./node-capacity";
import { requestAdminManagedWsTrial,canPrepareManagedWsTrial } from "./managed-ws-trial";
import { requireSalesAdmin, type SalesActor } from "./resellers";

export const QUICK_TEST_BYTES = 1_000_000_000;
export const QUICK_TEST_SECONDS = 1800;

export type QuickProtocol = "reality" | "ws";

export interface QuickNode {
  name: string;
  eligible: boolean;
  realityReady: boolean;
  wsReady: boolean;
}

export async function quickNodeStatus(
  db: D1Database,
  nodeId: string,
  now: number,
): Promise<QuickNode | null> {
  if (!/^[A-Za-z0-9-]{1,80}$/.test(nodeId)) return null;
  const row = (await nodeCapacities(db, now, nodeId))[0];
  if (!row) return null;
  const node = await db.prepare(
    "SELECT id,name,target_ip,vpn_port,state,healthy,last_seen,revision,acked_revision,policy_payload,agent_capabilities " +
    "FROM nodes WHERE id=?",
  ).bind(nodeId).first<ManagedWsNodeStatus & {
    name: string; target_ip: string; vpn_port: number;
  }>();
  if (!node) return null;
  const capabilities = new Set(
    (node.agent_capabilities || "").split(",").map(v => v.trim()).filter(Boolean),
  );
  // Do not depend on whether account slots are limited or unlimited when
  // judging service health; all capacity checks belong in the final gate.
  const healthy = row.operational_status === "active" &&
    node.state === "ready" && node.healthy === 1 &&
    node.last_seen > now - 90 && node.revision > 0 &&
    node.revision === node.acked_revision &&
    capabilities.has("quota-v2") &&
    capabilities.has("per-account-process") &&
    capabilities.has("shared-443") && node.vpn_port === 443 &&
    !!node.policy_payload;
  const slots = remainingSlots(row);
  const eligible = healthy && (slots === null || slots > 0) &&
    canAllocate(row, QUICK_TEST_BYTES);
  const wsApproved = eligible ? await readManagedWsRollout(db, nodeId) : null;
  return {
    name: row.name,
    eligible,
    realityReady: eligible,
    wsReady: eligible && canPrepareManagedWsTrial(node, wsApproved, now),
  };
}

/** Reserve a short, metered, admin-only field test on the chosen server. */
export async function issueQuickProtocolTest(
  db: D1Database,
  actor: SalesActor,
  nodeId: string,
  protocol: QuickProtocol,
  now: number,
): Promise<{ id: string; state: string }> {
  requireSalesAdmin(actor);
  if (!["reality", "ws"].includes(protocol) ||
      !Number.isSafeInteger(now) || now <= 0)
    throw Error("QUICK_TEST_UNAVAILABLE");
  const status = await quickNodeStatus(db, nodeId, now);
  if (!status?.eligible)
    throw Error("QUICK_TEST_NODE_UNAVAILABLE");
  if (protocol === "ws") {
    if (!status.wsReady) throw Error("QUICK_TEST_WS_UNAVAILABLE");
    // First-account provisioning can begin before ws-metered exists;
    // actual credential delivery still requires a genuine live Agent ACK.
    return requestAdminManagedWsTrial(db, actor, nodeId, now);
  }

  const requestKey = "admin-reality-trial:" + nodeId + ":" + Math.floor(now / QUICK_TEST_SECONDS);
  return createAccount(db, actor, {
    nodeId, kind: "trial",
    label: "Madar-Reality-Node-" + nodeId.slice(0, 12),
    quotaBytes: QUICK_TEST_BYTES, durationSeconds: QUICK_TEST_SECONDS,
    requestKey,
  }, now);
}
