import { createAccount } from "./accounts";
import { readManagedWsRollout, managedWsStatusReady, type ManagedWsNodeStatus } from "./alternate-transport";
import { requireSalesAdmin, type SalesActor } from "./resellers";

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
  if (!node || !managedWsStatusReady(node, endpoint, now))
    throw Error("WS_TRIAL_NOT_METERED");

  return createAccount(db, actor, {
    nodeId, kind: "trial",
    label: "Madar-WS-Node-" + nodeId.slice(0, 12),
    quotaBytes: 1_000_000_000,
    durationSeconds: 1800,
    requestKey,
  }, now);
}
