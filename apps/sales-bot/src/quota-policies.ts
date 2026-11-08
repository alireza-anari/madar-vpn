import { readManagedWsRollout, validateManagedWsFallback } from "./alternate-transport";
import type { ManagedWsFallback } from "./alternate-transport";
import { readApprovedRealityPorts, validateManagedRealityPorts } from "./managed-reality-ports";
import type { ManagedRealityPort } from "./managed-reality-ports";
export interface QuotaClient {
  accountId: string;
  uuid: string;
  quotaEpoch: number;
  quotaBytes: number | null;
  usedBytes: number;
  validUntil: number;
  generation: string;
  listenPort: number;
  flow: "" | "xtls-rprx-vision";
}
export interface QuotaPolicy {
  version: 2;
  nodeId: string;
  revision: number;
  expiresAt: number;
  clients: QuotaClient[];
  wsFallback?: ManagedWsFallback;
  realityAltPorts?: ManagedRealityPort[];
}
export async function buildQuotaPolicy(
  db: D1Database,
  nodeId: string,
  now: number,
): Promise<QuotaPolicy> {
  const node = await db
    .prepare("SELECT revision,policy_payload FROM nodes WHERE id=?")
    .bind(nodeId)
    .first<{ revision: number; policy_payload: string | null }>();
  if (!node) throw Error("NODE_NOT_FOUND");
  await db
    .prepare(
      "UPDATE managed_accounts SET state='expired' WHERE node_id=? AND state IN ('active','preparing') AND valid_until>0 AND valid_until<=?",
    )
    .bind(nodeId, now)
    .run();
  const accounts = await db
    .prepare(
      "SELECT * FROM managed_accounts WHERE node_id=? AND state IN ('preparing','active') AND (quota_bytes IS NULL OR used_bytes<quota_bytes) ORDER BY id",
    )
    .bind(nodeId)
    .all<any>();
  for (const a of accounts.results)
    if (a.listen_port === null) {
      await db
        .prepare(
          "UPDATE managed_accounts SET listen_port=COALESCE((SELECT MAX(listen_port)+1 FROM managed_accounts WHERE node_id=?),20000) WHERE id=? AND listen_port IS NULL",
        )
        .bind(nodeId, a.id)
        .run();
      a.listen_port = await db
        .prepare("SELECT listen_port FROM managed_accounts WHERE id=?")
        .bind(a.id)
        .first("listen_port");
    }
  if (accounts.results.some((a) => a.listen_port > 20999))
    throw Error("NODE_ACCOUNT_CAPACITY");
  const clients: QuotaClient[] = accounts.results.map((a) => ({
    accountId: a.id,
    uuid: a.uuid,
    quotaEpoch: a.quota_epoch,
    quotaBytes: a.quota_bytes,
    usedBytes: a.used_bytes,
    validUntil: a.valid_until || now + 300,
    generation: `${a.id}:${a.quota_epoch}`,
    listenPort: a.listen_port,
    flow: a.connection_flow === "xtls-rprx-vision" ? "xtls-rprx-vision" : "",
  }));
  const wsFallback = await readManagedWsRollout(db, nodeId);
  const realityAltPorts = await readApprovedRealityPorts(db, nodeId);
  const old = node.policy_payload ? JSON.parse(node.policy_payload) : null;
  if (
    old?.version === 2 &&
    old.expiresAt > now + 240 &&
    JSON.stringify(old.clients) === JSON.stringify(clients) &&
    JSON.stringify(old.wsFallback ?? null) === JSON.stringify(wsFallback) &&
    JSON.stringify(old.realityAltPorts ?? null) === JSON.stringify(realityAltPorts)
  )
    return old;
  const policy: QuotaPolicy = {
    version: 2,
    nodeId,
    revision: node.revision + 1,
    expiresAt: now + 300,
    clients,
    ...(wsFallback ? { wsFallback } : {}),
    ...(realityAltPorts ? { realityAltPorts } : {}),
  };
  const payload = JSON.stringify(policy);
  const results = await db.batch([
    db
      .prepare(
        "UPDATE nodes SET revision=?,policy_payload=? WHERE id=? AND revision=?",
      )
      .bind(policy.revision, payload, nodeId, node.revision),
    db
      .prepare(
        "UPDATE managed_accounts SET prepared_revision=CASE WHEN started_at IS NULL THEN ? ELSE prepared_revision END,activation_revision=CASE WHEN started_at IS NOT NULL AND state='preparing' THEN ? ELSE activation_revision END WHERE node_id=? AND state='preparing' AND EXISTS(SELECT 1 FROM nodes WHERE id=? AND policy_payload=?)",
      )
      .bind(policy.revision, policy.revision, nodeId, nodeId, payload),
  ]);
  if (!results[0]?.meta.changes) return buildQuotaPolicy(db, nodeId, now);
  return policy;
}
export async function ackQuotaPolicy(
  db: D1Database,
  nodeId: string,
  revision: number,
  health: { healthy: boolean; capabilities: string[] },
  now: number,
) {
  if (
    !health.healthy ||
    !Array.isArray(health.capabilities) ||
    !["quota-v2", "per-account-process"].every((x) =>
      health.capabilities.includes(x),
    )
  )
    return;
  const node = await db
    .prepare("SELECT policy_payload FROM nodes WHERE id=? AND revision=?")
    .bind(nodeId, revision)
    .first<{ policy_payload: string }>();
  if (!node) return;
  const policy = JSON.parse(node.policy_payload) as QuotaPolicy;
  if (policy.version !== 2 || policy.expiresAt <= now) return;
  let realityAltValid = false;
  try {
    if (policy.realityAltPorts) {
      validateManagedRealityPorts(policy.realityAltPorts);
      realityAltValid = true;
    }
  } catch { realityAltValid = false; }
  let wsPolicyValid = false;
  try {
    if (policy.wsFallback) {
      validateManagedWsFallback(policy.wsFallback);
      wsPolicyValid = true;
    }
  } catch {
    // A broken optional WS route must never de-ACK the working REALITY path.
    wsPolicyValid = false;
  }
  // A signed Vision policy must never be acknowledged by a legacy agent.
  if (
    policy.clients.some((client) => client.flow === "xtls-rprx-vision") &&
    !["shared-443", "vision-metered"].every((cap) => health.capabilities.includes(cap))
  ) return;
  await db
    .prepare(
      "UPDATE nodes SET acked_revision=?,last_seen=?,healthy=1,agent_capabilities=?,state='ready' WHERE id=? AND revision=?",
    )
    .bind(
      revision,
      now,
      "quota-v2,per-account-process" +
        (health.capabilities.includes("shared-443") ? ",shared-443" : "") +
        (health.capabilities.includes("shared-443") && health.capabilities.includes("vision-metered") ? ",vision-metered" : "") +
        (wsPolicyValid && health.capabilities.includes("shared-443") && health.capabilities.includes("ws-metered") ? ",ws-metered" : "") +
        (realityAltValid && health.capabilities.includes("shared-443") && health.capabilities.includes("reality-alt-metered") ? ",reality-alt-metered" : ""),
      nodeId,
      revision,
    )
    .run();
  for (const c of policy.clients) {
    await db
      .prepare(
        "UPDATE managed_accounts SET state='active' WHERE id=? AND node_id=? AND state='preparing' AND started_at IS NOT NULL AND activation_revision=? AND valid_until=? AND valid_until>?",
      )
      .bind(c.accountId, nodeId, revision, c.validUntil, now)
      .run();
    await db
      .prepare(
        "UPDATE managed_accounts SET started_at=?,valid_until=?+duration_seconds WHERE id=? AND node_id=? AND state='preparing' AND started_at IS NULL AND prepared_revision=?",
      )
      .bind(now, now, c.accountId, nodeId, revision)
      .run();
  }
}
