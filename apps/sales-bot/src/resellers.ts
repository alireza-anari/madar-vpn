import { resolveActor } from "./auth";
export type SalesActor = {
  telegramId: string;
  role: "admin" | "seller" | "ordinary";
};
export function requireSalesAdmin(actor: SalesActor) {
  if (actor.role !== "admin") throw Error("ADMIN_REQUIRED");
}
export async function resolveSalesActor(
  db: D1Database,
  id: string,
  env: Env,
): Promise<SalesActor> {
  if (resolveActor(id, env).role === "admin")
    return { telegramId: id, role: "admin" };
  const enabled = await db
    .prepare("SELECT enabled FROM resellers WHERE telegram_id=?")
    .bind(id)
    .first<number>("enabled");
  return { telegramId: id, role: enabled === 1 ? "seller" : "ordinary" };
}
export async function requireSeller(db: D1Database, actor: SalesActor) {
  if (actor.role === "admin") return;
  if (
    actor.role !== "seller" ||
    (await db
      .prepare("SELECT enabled FROM resellers WHERE telegram_id=?")
      .bind(actor.telegramId)
      .first<number>("enabled")) !== 1
  )
    throw Error("SELLER_REQUIRED");
}
export async function setReseller(
  db: D1Database,
  actor: SalesActor,
  id: string,
  enabled: boolean,
  now: number,
) {
  requireSalesAdmin(actor);
  if (!/^[1-9][0-9]{0,15}$/.test(id)) throw Error("INVALID_SELLER");
  await db.batch([
    db
      .prepare(
        "INSERT INTO resellers(telegram_id,enabled,created_at) VALUES(?,?,?) ON CONFLICT(telegram_id) DO UPDATE SET enabled=excluded.enabled",
      )
      .bind(id, enabled ? 1 : 0, now),
    db
      .prepare(
        "INSERT INTO audit_events(actor_id,action,target_id,created_at) VALUES(?,'set_reseller',?,?)",
      )
      .bind(actor.telegramId, id, now),
  ]);
}
export async function setNodePurpose(
  db: D1Database,
  actor: SalesActor,
  nodeId: string,
  purpose: "sale" | "trial",
  now: number,
) {
  requireSalesAdmin(actor);
  if (
    !["sale", "trial"].includes(purpose) ||
    !(await db.prepare("SELECT id FROM nodes WHERE id=? AND NOT EXISTS(SELECT 1 FROM settings WHERE key='node_status:'||id AND value IN ('paused','archived'))").bind(nodeId).first())
  )
    throw Error("INVALID_NODE");
  await db.batch([
    db
      .prepare(
        "INSERT INTO node_purposes(purpose,node_id) VALUES(?,?) ON CONFLICT(purpose) DO UPDATE SET node_id=excluded.node_id",
      )
      .bind(purpose, nodeId),
    db
      .prepare(
        "INSERT INTO audit_events(actor_id,action,target_id,created_at) VALUES(?,'node_purpose',?,?)",
      )
      .bind(actor.telegramId, nodeId, now),
  ]);
}
export async function salesMode(db: D1Database) {
  return (
    (await db
      .prepare("SELECT value FROM settings WHERE key='app_mode'")
      .first<string>("value")) === "reseller"
  );
}
