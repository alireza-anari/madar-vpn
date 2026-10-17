import {
  nodeCapacities,
  remainingAllocation,
  utilizationPercent,
} from "./node-capacity";

function targetLevel(percent: number | null) {
  if (percent === null || percent < 80) return 0;
  if (percent >= 95) return 95;
  if (percent >= 90) return 90;
  return 80;
}

function adminIds(env: Env) {
  return [
    ...new Set(
      env.ADMIN_TELEGRAM_IDS.split(",")
        .map((id) => id.trim())
        .filter((id) => /^[1-9][0-9]{0,15}$/.test(id)),
    ),
  ];
}

function gb(bytes: number) {
  return (bytes / 1e9).toLocaleString("fa-IR", {
    maximumFractionDigits: 3,
  });
}

export async function refreshCapacityAlert(
  env: Env,
  nodeId: string,
  now: number,
): Promise<number | null> {
  const n = (await nodeCapacities(env.SALES_DB, now, nodeId)).find(
    (node) => node.id === nodeId,
  );
  if (!n) return null;

  const target = targetLevel(utilizationPercent(n));
  await env.SALES_DB.prepare(
    "INSERT OR IGNORE INTO node_capacity_alert_state(node_id,level,sequence,updated_at) VALUES(?,0,0,?)",
  )
    .bind(nodeId, now)
    .run();
  const current = await env.SALES_DB.prepare(
    "SELECT level,sequence FROM node_capacity_alert_state WHERE node_id=?",
  )
    .bind(nodeId)
    .first<{ level: number; sequence: number }>();
  if (!current || target === current.level) return null;

  if (target < current.level) {
    await env.SALES_DB.prepare(
      "UPDATE node_capacity_alert_state SET level=?,updated_at=? WHERE node_id=? AND level=? AND sequence=?",
    )
      .bind(target, now, nodeId, current.level, current.sequence)
      .run();
    return null;
  }

  const nextSequence = current.sequence + 1;
  const remaining = remainingAllocation(n);
  const text =
    `⚠️ هشدار ظرفیت سرور\n${n.name}\n` +
    `استفاده ظرفیت: ${target.toLocaleString("fa-IR")}٪\n` +
    `رزرو فعال: ${gb(n.committed_bytes)} گیگ\n` +
    `مصرف قطعی: ${gb(n.finalized_used_bytes)} گیگ\n` +
    `قابل فروش: ${remaining === null ? "نامحدود" : `${gb(remaining)} گیگ`}`;
  const payload = JSON.stringify({ text });
  const admins = adminIds(env);
  const statements = [
    env.SALES_DB.prepare(
      "UPDATE node_capacity_alert_state SET level=?,sequence=?,updated_at=? WHERE node_id=? AND level=? AND sequence=?",
    ).bind(target, nextSequence, now, nodeId, current.level, current.sequence),
    ...admins.map((adminId) =>
      env.SALES_DB.prepare(
        `INSERT OR IGNORE INTO outbox(id,chat_id,payload,available_at)
         SELECT ?,?,?,0 FROM node_capacity_alert_state
         WHERE node_id=? AND level=? AND sequence=?`,
      ).bind(
        `capacity:${nodeId}:${nextSequence}:${adminId}`,
        adminId,
        payload,
        nodeId,
        target,
        nextSequence,
      ),
    ),
  ];
  const results = await env.SALES_DB.batch(statements);
  return results[0]?.meta.changes ? target : null;
}

export async function refreshAllCapacityAlerts(env: Env, now: number) {
  const nodes = await env.SALES_DB.prepare("SELECT id FROM nodes ORDER BY id").all<{
    id: string;
  }>();
  for (const node of nodes.results) {
    try {
      await refreshCapacityAlert(env, node.id, now);
    } catch {
      // Alerts are operational best-effort and must not block the sweep.
    }
  }
}
