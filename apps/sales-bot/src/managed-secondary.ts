import { validateManagedRealityPorts, type ManagedRealityPort } from "./managed-reality-ports";

interface SecondaryRecord {
  nodeId: string;
  revision: number;
  observedAt: number;
  ports: ManagedRealityPort[];
}
const PREFIX = "managed_secondary:";

/** An authenticated sidecar heartbeat is independent of the primary agent ACK.
 * A stale sidecar cannot inherit freshness from the primary REALITY 443 agent.
 */
export async function readConfirmedSecondaryPorts(
  db: D1Database,
  nodeId: string,
  revision: number,
  now: number,
): Promise<ManagedRealityPort[] | null> {
  const raw = await db.prepare("SELECT value FROM settings WHERE key=?")
    .bind(PREFIX + nodeId).first<string>("value");
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as SecondaryRecord;
    if (value.nodeId !== nodeId || value.revision !== revision ||
        !Number.isSafeInteger(value.observedAt) ||
        value.observedAt > now + 2 ||
        value.observedAt <= now - 20) return null;
    return validateManagedRealityPorts(value.ports);
  } catch {
    return null;
  }
}

/** Node token authentication happens in nodeApi before this function runs.
 * Every acknowledgment matches the precise approved signed policy revision.
 */
export async function acceptSecondaryAck(
  db: D1Database,
  nodeId: string,
  raw: unknown,
  now: number,
): Promise<void> {
  if (!raw || typeof raw !== "object") throw Error("INVALID_SECONDARY_ACK");
  const body = raw as {revision?: unknown;ports?: unknown;healthy?:unknown};
  if (!Number.isSafeInteger(body.revision) || body.healthy !== true)
    throw Error("INVALID_SECONDARY_ACK");
  const ports = validateManagedRealityPorts(body.ports);
  const node = await db.prepare(
    "SELECT id,state,healthy,last_seen,revision,acked_revision,policy_payload,agent_capabilities FROM nodes WHERE id=?",
  ).bind(nodeId).first<{
    id: string; state: string; healthy: number; last_seen: number;
    revision: number; acked_revision: number; policy_payload: string | null;
    agent_capabilities: string;
  }>();
  if (!node || node.state !== "ready" || node.healthy !== 1 ||
      node.revision !== body.revision ||
      node.acked_revision !== node.revision ||
      node.last_seen <= now - 90 ||
      !node.agent_capabilities.split(",").includes("shared-443"))
    throw Error("NODE_NOT_READY");
  let policy: {version?:number;nodeId?:string;revision?:number;
    expiresAt?:number;realityAltPorts?:unknown};
  try { policy = JSON.parse(node.policy_payload || ""); }
  catch { throw Error("INVALID_SECONDARY_POLICY"); }
  if (policy.version !== 2 || policy.nodeId !== nodeId ||
      policy.revision !== node.revision ||
      !Number.isSafeInteger(policy.expiresAt) ||
      (policy.expiresAt as number) <= now ||
      (policy.expiresAt as number) > now + 330 ||
      JSON.stringify(validateManagedRealityPorts(policy.realityAltPorts)) !==
        JSON.stringify(ports))
    throw Error("INVALID_SECONDARY_POLICY");
  const { readApprovedRealityPorts } = await import("./managed-reality-ports");
  const approved = await readApprovedRealityPorts(db, nodeId);
  if (JSON.stringify(approved) !== JSON.stringify(ports))
    throw Error("SECONDARY_NOT_APPROVED");
  // Status expires automatically in delivery checks; no D1 migration required.
  const value: SecondaryRecord = {
    nodeId, revision: node.revision, ports, observedAt: now,
  };
  await db.prepare(
    "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  ).bind(PREFIX + nodeId, JSON.stringify(value)).run();
}
