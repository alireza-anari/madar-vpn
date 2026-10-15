import type { Policy } from "./contracts";
import { startTrialAfterAck } from "./orders";
export async function buildPolicy(
  db: D1Database,
  nodeId: string,
  now: number,
): Promise<Policy> {
  const node = await db
    .prepare("SELECT revision,policy_payload FROM nodes WHERE id=?")
    .bind(nodeId)
    .first<{ revision: number; policy_payload: string | null }>();
  if (!node) throw new Error("NODE_NOT_FOUND");
  const clients = await db
    .prepare(
      "SELECT e.user_id,e.uuid,e.valid_until,t.started_at FROM entitlements e LEFT JOIN trials t ON t.user_id=e.user_id WHERE e.revoked=0 AND (e.valid_until>? OR t.user_id IS NOT NULL AND t.started_at IS NULL) ORDER BY e.user_id",
    )
    .bind(now)
    .all<{
      user_id: string;
      uuid: string;
      valid_until: number;
      started_at: number | null;
    }>();
  const policy: Policy = {
    nodeId,
    revision: node.revision + 1,
    expiresAt: now + 300,
    clients: clients.results.map((e) => ({
      credentialId: e.user_id,
      uuid: e.uuid,
      validUntil: e.valid_until > now ? e.valid_until : now + 300,
    })),
  };
  const old = node.policy_payload
    ? (JSON.parse(node.policy_payload) as Policy)
    : null;
  if (
    old &&
    old.expiresAt > now + 240 &&
    JSON.stringify(old.clients) === JSON.stringify(policy.clients)
  )
    return old;
  const payload = JSON.stringify(policy);
  const result = await db.batch([
    db
      .prepare(
        "UPDATE nodes SET revision=?,policy_payload=? WHERE id=? AND revision=?",
      )
      .bind(policy.revision, payload, nodeId, node.revision),
    db
      .prepare(
        "UPDATE trials SET prepared_revision=? WHERE started_at IS NULL AND EXISTS(SELECT 1 FROM nodes WHERE id=? AND policy_payload=?)",
      )
      .bind(policy.revision, nodeId, payload),
  ]);
  if (!result[0]?.meta.changes) return buildPolicy(db, nodeId, now);
  return policy;
}
export async function ackPolicy(
  db: D1Database,
  nodeId: string,
  revision: number,
  health: { healthy: boolean },
  now: number,
) {
  const node = await db
    .prepare(
      "SELECT revision,policy_payload FROM nodes WHERE id=? AND revision=?",
    )
    .bind(nodeId, revision)
    .first<{ revision: number; policy_payload: string }>();
  if (!node) return;
  const policy = JSON.parse(node.policy_payload) as Policy;
  if (policy.expiresAt <= now) return;
  await db
    .prepare(
      "UPDATE nodes SET acked_revision=?,healthy=?,last_seen=?,state=CASE WHEN ?=1 THEN 'ready' ELSE 'verifying' END WHERE id=? AND revision=?",
    )
    .bind(
      revision,
      health.healthy ? 1 : 0,
      now,
      health.healthy ? 1 : 0,
      nodeId,
      revision,
    )
    .run();
  if (!health.healthy) return;
  for (const client of policy.clients) {
    await db
      .prepare(
        "UPDATE trials SET acked_revision=? WHERE user_id=? AND prepared_revision=? AND started_at IS NULL",
      )
      .bind(revision, client.credentialId, revision)
      .run();
    await startTrialAfterAck(db, client.credentialId, revision, now);
  }
}
