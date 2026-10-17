import {
  canAllocate,
  liveCommitmentPredicate,
  nodeCapacities,
} from "./node-capacity";
import { sellerLimits } from "./seller-accounting";
import { requireSeller, requireSalesAdmin, type SalesActor } from "./resellers";

export type AccountInput = {
  nodeId?: string;
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
  seller_settlement_epoch: number;
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

  const nodeId =
    input.nodeId ||
    (await db
      .prepare("SELECT node_id FROM node_purposes WHERE purpose=?")
      .bind(input.kind)
      .first<string>("node_id"));
  if (!nodeId) throw Error("NODE_NOT_CONFIGURED");
  if (
    input.nodeId &&
    !(await db
      .prepare(
        "SELECT id FROM nodes WHERE id=? AND healthy=1 AND last_seen>? AND instr(agent_capabilities,'quota-v2')>0",
      )
      .bind(nodeId, now - 90)
      .first())
  )
    throw Error("NODE_UNAVAILABLE");

  const id = crypto.randomUUID();
  const requestedBytes = input.kind === "trial" ? 1e9 : Number(input.quotaBytes);
  const isAdmin = actor.role === "admin" ? 1 : 0;

  await db.batch([
    db
      .prepare(
        `WITH
        node_rows AS (
          SELECT a.*,CASE WHEN ${liveCommitmentPredicate} THEN 1 ELSE 0 END is_live
          FROM managed_accounts a WHERE a.node_id=?
        ),
        node_usage AS (
          SELECT
            COALESCE(SUM(CASE WHEN is_live=1 THEN 1 ELSE 0 END),0) slots,
            COALESCE(SUM(CASE WHEN is_live=1 AND quota_bytes IS NOT NULL THEN quota_bytes ELSE 0 END),0) committed_bytes,
            COALESCE(SUM(CASE WHEN is_live=1 AND quota_bytes IS NULL THEN 1 ELSE 0 END),0) uncapped,
            COALESCE(SUM(CASE
              WHEN is_live=1 THEN 0
              WHEN state='exhausted' AND quota_bytes IS NOT NULL THEN MIN(used_bytes,quota_bytes)
              ELSE used_bytes
            END),0) finalized_bytes
          FROM node_rows
        ),
        seller_rows AS (
          SELECT a.*,CASE WHEN ${liveCommitmentPredicate} THEN 1 ELSE 0 END is_live
          FROM managed_accounts a WHERE a.seller_id=?
        ),
        seller_usage AS (
          SELECT
            COALESCE(SUM(CASE WHEN is_live=1 THEN 1 ELSE 0 END),0) slots,
            COALESCE(SUM(CASE WHEN is_live=1 AND quota_bytes IS NOT NULL THEN quota_bytes ELSE 0 END),0) committed_bytes,
            COALESCE(SUM(CASE WHEN is_live=1 AND quota_bytes IS NULL THEN 1 ELSE 0 END),0) uncapped
          FROM seller_rows
        )
        INSERT OR IGNORE INTO managed_accounts(
          id,seller_id,request_key,node_id,kind,label,uuid,quota_bytes,
          duration_seconds,created_at,seller_settlement_epoch
        )
        SELECT ?,?,?,?,?,?,?,?,?,?,COALESCE(sc.current_settlement_epoch,0)
        FROM nodes n
        CROSS JOIN node_usage nu
        CROSS JOIN seller_usage su
        LEFT JOIN reseller_controls sc ON sc.seller_id=?
        WHERE n.id=?
          AND nu.slots<n.max_accounts
          AND (
            n.max_allocated_bytes IS NULL OR
            (nu.uncapped=0 AND nu.committed_bytes+nu.finalized_bytes+?<=n.max_allocated_bytes)
          )
          AND (?=1 OR sc.max_reserved_accounts IS NULL OR su.slots<sc.max_reserved_accounts)
          AND (
            ?=1 OR sc.max_committed_bytes IS NULL OR
            (su.uncapped=0 AND su.committed_bytes+?<=sc.max_committed_bytes)
          )`,
      )
      .bind(
        now,
        nodeId,
        now,
        actor.telegramId,
        id,
        actor.telegramId,
        input.requestKey,
        nodeId,
        input.kind,
        input.label.trim(),
        crypto.randomUUID(),
        requestedBytes,
        input.durationSeconds,
        now,
        actor.telegramId,
        nodeId,
        requestedBytes,
        isAdmin,
        isAdmin,
        requestedBytes,
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
  if (result) return result;

  // Classification is advisory only; the INSERT above is the atomic authority.
  // Prefer a seller-specific explanation when that seller is independently capped.
  if (actor.role !== "admin") {
    const limits = await sellerLimits(db, actor.telegramId, now);
    if (
      limits.maxReservedAccounts !== null &&
      limits.reservedAccounts >= limits.maxReservedAccounts
    )
      throw Error("SELLER_ACCOUNT_LIMIT");
    if (
      limits.maxCommittedBytes !== null &&
      (limits.uncappedAccounts > 0 ||
        limits.committedBytes + requestedBytes > limits.maxCommittedBytes)
    )
      throw Error("SELLER_ALLOCATION_FULL");
  }

  const n = (await nodeCapacities(db, now, nodeId)).find((item) => item.id === nodeId);
  if (!n || n.reserved_accounts >= n.max_accounts) throw Error("NODE_FULL");
  if (n.max_allocated_bytes !== null && !canAllocate(n, requestedBytes))
    throw Error("NODE_ALLOCATION_FULL");
  throw Error("NODE_FULL");
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
