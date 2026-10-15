import type { Policy } from "./contracts";
import { hash, sign } from "./crypto";
export async function getSubscription(
  db: D1Database,
  userId: string,
  now: number,
): Promise<{ configs: string[]; validUntil: number }> {
  const e = await db
    .prepare(
      "SELECT uuid,valid_until,revoked FROM entitlements WHERE user_id=?",
    )
    .bind(userId)
    .first<{ uuid: string; valid_until: number; revoked: number }>();
  if (!e || e.revoked || e.valid_until <= now)
    return { configs: [], validUntil: e?.valid_until || 0 };
  const nodes = await db
    .prepare(
      "SELECT * FROM nodes WHERE state='ready' AND healthy=1 AND revision=acked_revision AND last_seen>?",
    )
    .bind(now - 90)
    .all<{
      id: string;
      name: string;
      target_ip: string;
      vpn_port: number;
      public_key: string;
      short_id: string;
      sni: string;
      policy_payload: string;
    }>();
  const configs: string[] = [];
  for (const n of nodes.results) {
    if (!n.public_key || !n.policy_payload) continue;
    const p = JSON.parse(n.policy_payload) as Policy;
    if (
      p.expiresAt <= now ||
      !p.clients.some(
        (c) =>
          c.credentialId === userId &&
          c.uuid === e.uuid &&
          c.validUntil >= e.valid_until,
      )
    )
      continue;
    const q = new URLSearchParams({
      encryption: "none",
      flow: "xtls-rprx-vision",
      security: "reality",
      sni: n.sni,
      fp: "chrome",
      pbk: n.public_key,
      sid: n.short_id,
      type: "tcp",
      headerType: "none",
    });
    configs.push(
      `vless://${e.uuid}@${n.target_ip.includes(":") ? "[" + n.target_ip + "]" : n.target_ip}:${n.vpn_port}?${q}#${encodeURIComponent(n.name)}`,
    );
  }
  return { configs, validUntil: e.valid_until };
}
export async function subscriptionLink(env: Env, userId: string) {
  if (!env.POLICY_SIGNING_SECRET || !env.PUBLIC_BASE_URL)
    throw new Error("NOT_CONFIGURED");
  const token = sign(env.POLICY_SIGNING_SECRET, `subscription:${userId}`);
  await env.SALES_DB.prepare("UPDATE users SET subscription_hash=? WHERE id=?")
    .bind(hash(token), userId)
    .run();
  return `${env.PUBLIC_BASE_URL}/subscription/${token}`;
}
export async function subscriptionResponse(
  env: Env,
  token: string,
  now: number,
) {
  if (!/^[a-f0-9]{64}$/.test(token))
    return new Response("Not found", { status: 404 });
  const user = await env.SALES_DB.prepare(
    "SELECT id FROM users WHERE subscription_hash=?",
  )
    .bind(hash(token))
    .first<{ id: string }>();
  if (!user) return new Response("Not found", { status: 404 });
  const result = await getSubscription(env.SALES_DB, user.id, now);
  return new Response(result.configs.join("\n"), {
    status: result.configs.length ? 200 : 503,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "Subscription-Userinfo": `expire=${result.validUntil}`,
    },
  });
}
