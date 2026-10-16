import { hash, sign } from "./crypto";
import { requireSalesAdmin, type SalesActor } from "./resellers";
export async function createSellerInvite(
  env: Env,
  actor: SalesActor,
  requestKey: string,
  now: number,
) {
  requireSalesAdmin(actor);
  if (!env.POLICY_SIGNING_SECRET) throw Error("INVITE_UNAVAILABLE");
  const token = sign(
    env.POLICY_SIGNING_SECRET,
    `seller-invite:${actor.telegramId}:${requestKey}`,
  ).slice(0, 32);
  await env.SALES_DB.prepare(
    "INSERT OR IGNORE INTO reseller_invites(token_hash,created_by,created_at,expires_at) VALUES(?,?,?,?)",
  )
    .bind(hash(token), actor.telegramId, now, now + 86400)
    .run();
  return token;
}
export async function claimSellerInvite(
  db: D1Database,
  token: string,
  userId: string,
  now: number,
) {
  if (!/^[a-f0-9]{32}$/.test(token)) return false;
  const digest = hash(token);
  const valid =
    "SELECT 1 FROM reseller_invites WHERE token_hash=? AND claimed_by IS NULL AND expires_at>?";
  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO resellers(telegram_id,enabled,created_at) SELECT ?,1,? WHERE EXISTS(${valid}) ON CONFLICT(telegram_id) DO UPDATE SET enabled=1`,
      )
      .bind(userId, now, digest, now),
    db
      .prepare(
        `INSERT INTO audit_events(actor_id,action,target_id,created_at) SELECT ?,'claim_seller_invite',?,? WHERE EXISTS(${valid})`,
      )
      .bind(userId, userId, now, digest, now),
    db
      .prepare(
        "UPDATE reseller_invites SET claimed_by=?,claimed_at=? WHERE token_hash=? AND claimed_by IS NULL AND expires_at>?",
      )
      .bind(userId, now, digest, now),
  ]);
  if (results[2]?.meta.changes) return true;
  return !!(await db
    .prepare(
      "SELECT 1 FROM reseller_invites i JOIN resellers r ON r.telegram_id=i.claimed_by WHERE i.token_hash=? AND i.claimed_by=? AND r.enabled=1",
    )
    .bind(digest, userId)
    .first());
}
export async function sellerInviteUrl(env: Env, token: string) {
  let username = await env.SALES_DB.prepare(
    "SELECT value FROM settings WHERE key='bot_username'",
  ).first<string>("value");
  if (!username) {
    const response = await fetch(
      `https://api.telegram.org/bot${env.BOT_TOKEN}/getMe`,
      { signal: AbortSignal.timeout(10000) },
    );
    const result = (await response.json()) as {
      ok?: boolean;
      result?: { username?: string };
    };
    if (!response.ok || !result.ok || !result.result?.username)
      throw Error("INVITE_UNAVAILABLE");
    username = result.result.username;
    if (!/^[A-Za-z0-9_]{5,32}$/.test(username))
      throw Error("INVITE_UNAVAILABLE");
    await env.SALES_DB.prepare(
      "INSERT OR REPLACE INTO settings(key,value) VALUES('bot_username',?)",
    )
      .bind(username)
      .run();
  }
  return `https://t.me/${username}?start=seller_${token}`;
}
