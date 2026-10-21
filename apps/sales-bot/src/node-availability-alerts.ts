// A single D1 read every two minutes covers *every* registered node. No
// added work, polling agent or secrets on the AWS machines.
const OFFLINE_AFTER_SECONDS = 180;

type AvailabilityRow = {
  id: string;
  name: string;
  last_seen: number;
  status: "up" | "down" | null;
  sequence: number | null;
  muted_until: number | null;
};

function adminIds(env: Env): string[] {
  return [
    ...new Set(
      (env.ADMIN_TELEGRAM_IDS || "")
        .split(",")
        .map((id) => id.trim())
        .filter((id) => /^[1-9][0-9]{0,15}$/.test(id)),
    ),
  ];
}

function alertText(
  name: string,
  offline: boolean,
  ageSeconds: number,
): string {
  // Names come from the admin-controlled node table; keep notifications
  // compact and don't allow a node name to spoof multiple Telegram lines.
  const safeName = name.replace(/[\r\n\t\u0000-\u001f]/g, " ").slice(0, 80);
  return offline
    ? `🔴 هشدار مدار — قطع ارتباط سرور\nسرور: ${safeName}\nآخرین ارتباط: بیش از ${Math.floor(ageSeconds / 60).toLocaleString("fa-IR")} دقیقه قبل\nارتباط سرور با ربات قطع شده؛ وضعیت VPN را بررسی کنید.`
    : `🟢 مدار — ارتباط سرور برقرار شد\nسرور: ${safeName}\nسرور دوباره با ربات ارتباط برقرار کرده است.`;
}

/**
 * Detect transitions only from worker-recorded acknowledgements.
 *
 * Healthy=1 is not sufficient: it remains 1 after a crash. Installing nodes,
 * nodes never acknowledged and removed/disabled nodes are not monitored.
 * A node automatically enrolls on its first acknowledged, ready heartbeat.
 *
 * Outbox ids are deterministic by node/transition sequence/admin. A CAS and
 * D1's transactional batch avoid duplicate notifications if cron overlaps.
 */
export async function refreshNodeAvailabilityAlerts(
  env: Env,
  now: number,
): Promise<void> {
  const admins = adminIds(env);
  if (!admins.length) return;

  const nodes = await env.SALES_DB.prepare(
    `SELECT n.id,n.name,n.last_seen,
       a.status,a.sequence,a.muted_until
     FROM nodes n
     LEFT JOIN node_availability_alert_state a ON a.node_id=n.id
     WHERE n.last_seen>0 AND n.state IN ('ready','verifying')
     ORDER BY n.id`,
  ).all<AvailabilityRow>();

  for (const node of nodes.results) {
    try {
      if (!Number.isSafeInteger(node.last_seen) || node.last_seen <= 0)
        continue;
      // Do not treat a future timestamp as a timeout.
      const age = Math.max(0, now - node.last_seen);
      const target: "up" | "down" =
        age > OFFLINE_AFTER_SECONDS ? "down" : "up";

      // First observation is online and silent. A pre-existing stale
      // acknowledged node proceeds through the normal down transition.
      if (node.status === null) {
        await env.SALES_DB.prepare(
          "INSERT OR IGNORE INTO node_availability_alert_state(node_id,status,sequence,changed_at) VALUES(?,'up',0,?)",
        )
          .bind(node.id, now)
          .run();
      }

      const previous = node.status ?? "up";
      const sequence = node.sequence ?? 0;
      if (previous === target) continue;

      if ((node.muted_until ?? 0) > now) {
        // A recovery during maintenance silently clears a prior outage.
        // A continuing outage alerts after maintenance expires.
        if (target === "up")
          await env.SALES_DB.prepare(
            "UPDATE node_availability_alert_state SET status='up',sequence=sequence+1,changed_at=? WHERE node_id=? AND status=? AND sequence=?",
          )
            .bind(now, node.id, previous, sequence)
            .run();
        continue;
      }

      const next = sequence + 1;
      const payload = JSON.stringify({
        text: alertText(node.name, target === "down", age),
      });
      const statements = [
        env.SALES_DB.prepare(
          "UPDATE node_availability_alert_state SET status=?,sequence=?,changed_at=? WHERE node_id=? AND status=? AND sequence=?",
        ).bind(target, next, now, node.id, previous, sequence),
        ...admins.map((adminId) =>
          env.SALES_DB.prepare(
            `INSERT OR IGNORE INTO outbox(id,chat_id,payload,available_at)
             SELECT ?,?,?,0 FROM node_availability_alert_state
             WHERE node_id=? AND status=? AND sequence=?`,
          ).bind(
            `availability:${node.id}:${next}:${adminId}`,
            adminId,
            payload,
            node.id,
            target,
            next,
          ),
        ),
      ];
      await env.SALES_DB.batch(statements);
    } catch {
      // One corrupt node must not prevent checks for the rest. This monitor
      // never modifies VPN policies, entitlements, or per-account quotas.
    }
  }
}
