import { revokeAccount } from "./accounts";
import { requireSalesAdmin, type SalesActor } from "./resellers";

const liveStates = new Set(["preparing", "active", "blocked"]);

export async function archiveAccount(
  db: D1Database,
  actor: SalesActor,
  id: string,
  now: number,
): Promise<void> {
  requireSalesAdmin(actor);
  const account = await db
    .prepare("SELECT state,archived_at FROM managed_accounts WHERE id=?")
    .bind(id)
    .first<{ state: string; archived_at: number | null }>();
  if (!account) throw Error("ACCOUNT_NOT_FOUND");
  if (account.archived_at !== null) return;

  if (liveStates.has(account.state)) await revokeAccount(db, actor, id, now);

  await db.batch([
    db
      .prepare(
        "UPDATE managed_accounts SET archived_at=?,archived_by=? WHERE id=? AND archived_at IS NULL",
      )
      .bind(now, actor.telegramId, id),
    db
      .prepare(
        "INSERT INTO audit_events(actor_id,action,target_id,created_at) SELECT ?,'archive_account',id,? FROM managed_accounts WHERE id=? AND archived_at=? AND NOT EXISTS(SELECT 1 FROM audit_events WHERE action='archive_account' AND target_id=?)",
      )
      .bind(actor.telegramId, now, id, now, id),
  ]);
}
