import { requireSeller, requireSalesAdmin, type SalesActor } from "./resellers";
export type AccountInput = {
  kind: "sale" | "trial";
  label: string;
  quotaBytes: number | null;
  durationSeconds: number;
  requestKey: string;
};
export interface ManagedAccount {
  id: string;
  seller_id: string;
  node_id: string;
  kind: "sale" | "trial";
  label: string;
  uuid: string;
  state: string;
  quota_bytes: number | null;
  used_bytes: number;
  quota_epoch: number;
  duration_seconds: number;
  started_at: number | null;
  valid_until: number;
  prepared_revision: number | null;
  activation_revision: number | null;
  status_token_hash: string | null;
  last_report_at: number | null;
  created_at: number;
}
export async function createAccount(
  db: D1Database,
  actor: SalesActor,
  input: AccountInput,
  now: number,
): Promise<{ id: string; state: string }> {
  await requireSeller(db, actor);
  if (
    !["sale", "trial"].includes(input.kind) ||
    typeof input.label !== "string" ||
    !input.label.trim() ||
    input.label.length > 80 ||
    typeof input.requestKey !== "string" ||
    input.requestKey.length < 1 ||
    input.requestKey.length > 120 ||
    !Number.isSafeInteger(input.durationSeconds) ||
    input.durationSeconds < 1 ||
    input.durationSeconds > 31536000 ||
    (input.kind === "trial"
      ? input.durationSeconds !== 1800 ||
        (input.quotaBytes !== null && input.quotaBytes !== 1e9)
      : !Number.isSafeInteger(input.quotaBytes) ||
        Number(input.quotaBytes) <= 0 ||
        Number(input.quotaBytes) > 1e12)
  )
    throw Error("INVALID_ACCOUNT");
  const previous = await db
    .prepare(
      "SELECT id,state FROM managed_accounts WHERE seller_id=? AND request_key=?",
    )
    .bind(actor.telegramId, input.requestKey)
    .first<{ id: string; state: string }>();
  if (previous) return previous;
  const nodeId = await db
    .prepare("SELECT node_id FROM node_purposes WHERE purpose=?")
    .bind(input.kind)
    .first<string>("node_id");
  if (!nodeId) throw Error("NODE_NOT_CONFIGURED");
  const id = crypto.randomUUID();
  await db.batch([
    db
      .prepare(
        "INSERT OR IGNORE INTO managed_accounts(id,seller_id,request_key,node_id,kind,label,uuid,quota_bytes,duration_seconds,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
      )
      .bind(
        id,
        actor.telegramId,
        input.requestKey,
        nodeId,
        input.kind,
        input.label.trim(),
        crypto.randomUUID(),
        input.kind === "trial" ? 1e9 : input.quotaBytes,
        input.durationSeconds,
        now,
      ),
    db
      .prepare(
        "INSERT INTO audit_events(actor_id,action,target_id,created_at) SELECT ?,'create_account',id,? FROM managed_accounts WHERE id=?",
      )
      .bind(actor.telegramId, now, id),
  ]);
  const result = await db
    .prepare(
      "SELECT id,state FROM managed_accounts WHERE seller_id=? AND request_key=?",
    )
    .bind(actor.telegramId, input.requestKey)
    .first<{ id: string; state: string }>();
  if (!result) throw Error("ACCOUNT_CREATE_FAILED");
  return result;
}
export async function ownedAccount(
  db: D1Database,
  actor: SalesActor,
  id: string,
): Promise<ManagedAccount> {
  await requireSeller(db, actor);
  const account = await db
    .prepare(
      "SELECT * FROM managed_accounts WHERE id=? AND (seller_id=? OR ?=1)",
    )
    .bind(id, actor.telegramId, actor.role === "admin" ? 1 : 0)
    .first<ManagedAccount>();
  if (!account) throw Error("ACCOUNT_NOT_FOUND");
  return account;
}
export async function revokeAccount(
  db: D1Database,
  actor: SalesActor,
  id: string,
  now: number,
) {
  requireSalesAdmin(actor);
  await db.batch([
    db
      .prepare(
        "UPDATE managed_accounts SET state='revoked',status_token_hash=NULL WHERE id=?",
      )
      .bind(id),
    db
      .prepare("UPDATE outbox SET state='dead' WHERE id=? AND state='pending'")
      .bind(`account:${id}`),
    db
      .prepare(
        "INSERT INTO audit_events(actor_id,action,target_id,created_at) SELECT ?,'revoke_account',id,? FROM managed_accounts WHERE id=?",
      )
      .bind(actor.telegramId, now, id),
  ]);
}
