import { createAccount } from "./accounts";
import { readManagedWsRollout, type ManagedWsFallback, type ManagedWsNodeStatus } from "./alternate-transport";
import { requireSalesAdmin, type SalesActor } from "./resellers";

/**
 * Bootstrapping readiness is DIFFERENT from customer delivery readiness:
 * the first test account must be allowed to provision a loopback backend
 * before the Agent can report ws-metered for its attached account.
 * Customer-facing delivery is still strictly gated by ws-metered.
 */
export function canPrepareManagedWsTrial(
  node: ManagedWsNodeStatus,
  approved: ManagedWsFallback | null,
  now: number,
): boolean {
  if (!approved || node.state !== "ready" || node.healthy !== 1 ||
      !Number.isSafeInteger(node.last_seen) || node.last_seen <= now - 90 ||
      !Number.isSafeInteger(node.revision) || node.revision < 1 ||
      node.revision !== node.acked_revision || !node.policy_payload)
    return false;
  const capabilities = new Set(
    (node.agent_capabilities || "").split(",").map(v => v.trim()).filter(Boolean),
  );
  if (!["quota-v2","per-account-process","shared-443"].every(
    cap => capabilities.has(cap)
  )) return false;
  try {
    const policy = JSON.parse(node.policy_payload) as {
      version?: number; nodeId?: string; revision?: number;
      expiresAt?: number; wsFallback?: unknown;
    };
    return policy.version === 2 &&
      policy.nodeId === node.id &&
      policy.revision === node.revision &&
      Number.isSafeInteger(policy.expiresAt) &&
      (policy.expiresAt as number) > now &&
      (policy.expiresAt as number) <= now + 330 &&
      JSON.stringify(policy.wsFallback) === JSON.stringify(approved);
  } catch {
    return false;
  }
}

/**
 * Test the actual per-node, shared-quota VMess/WSS transport — never the
 * one-use unmetered/approximately metered EC2 canary.
 *
 * No account is provisioned until the server's signed quota policy,
 * approved endpoint and fresh ws-metered ACK ALL match. Deliveries
 * independently recheck this contract and only contain the WSS profile.
 */
export async function requestAdminManagedWsTrial(
  db: D1Database,
  actor: SalesActor,
  nodeId: string,
  now: number,
): Promise<{ id: string; state: string }> {
  requireSalesAdmin(actor);
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(nodeId) ||
      !Number.isSafeInteger(now) || now <= 0)
    throw Error("WS_TRIAL_INVALID");

  // One admin test per node per 30-minute window. The existing atomic account
  // reservation handles per-node slots and allocated traffic limits.
  const requestKey = "admin-ws-trial:" + nodeId + ":" + Math.floor(now / 1800);
  const previous = await db.prepare(
    "SELECT id,state FROM managed_accounts WHERE seller_id=? AND request_key=?",
  ).bind(actor.telegramId, requestKey).first<{ id: string; state: string }>();
  if (previous) return previous;

  const node = await db.prepare(
    "SELECT id,state,healthy,last_seen,revision,acked_revision,policy_payload,agent_capabilities FROM nodes WHERE id=?",
  ).bind(nodeId).first<ManagedWsNodeStatus>();
  const endpoint = await readManagedWsRollout(db, nodeId);
  if (!node || !canPrepareManagedWsTrial(node, endpoint, now))
    throw Error("WS_TRIAL_NOT_METERED");

  return createAccount(db, actor, {
    nodeId, kind: "trial",
    label: "Madar-WS-Node-" + nodeId.slice(0, 12),
    quotaBytes: 1_000_000_000,
    durationSeconds: 1800,
    requestKey,
  }, now);
}
