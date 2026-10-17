export interface QuotaReport {
  accountId: string;
  quotaEpoch: number;
  sequence: number;
  totalBytes: number;
  observedAt: number;
  generation: string;
  blocked?: boolean;
}
const safe = (n: unknown) => Number.isSafeInteger(n) && Number(n) >= 0;
export async function acceptQuotaReports(
  db: D1Database,
  nodeId: string,
  reports: QuotaReport[],
  now: number,
) {
  if (!Array.isArray(reports) || reports.length > 100)
    throw Error("INVALID_REPORTS");
  let accepted = 0,
    duplicates = 0;
  for (const r of reports) {
    if (
      !r ||
      typeof r.accountId !== "string" ||
      r.accountId.length > 80 ||
      !safe(r.quotaEpoch) ||
      !safe(r.sequence) ||
      r.sequence < 1 ||
      !safe(r.totalBytes) ||
      !safe(r.observedAt) ||
      r.observedAt > now + 30 ||
      r.generation !== `${r.accountId}:${r.quotaEpoch}` ||
      (r.blocked !== undefined && typeof r.blocked !== "boolean")
    )
      throw Error("INVALID_REPORT");
    const a = await db
      .prepare(
        "SELECT id FROM managed_accounts WHERE id=? AND node_id=? AND quota_epoch=?",
      )
      .bind(r.accountId, nodeId, r.quotaEpoch)
      .first();
    if (!a) throw Error("FOREIGN_ACCOUNT");
    const existing = await db
      .prepare(
        "SELECT total_bytes,generation,observed_at,blocked FROM account_quota_reports WHERE node_id=? AND account_id=? AND quota_epoch=? AND sequence=?",
      )
      .bind(nodeId, r.accountId, r.quotaEpoch, r.sequence)
      .first<{
        total_bytes: number;
        generation: string;
        observed_at: number;
        blocked: number;
      }>();
    if (
      existing &&
      (existing.total_bytes !== r.totalBytes ||
        existing.generation !== r.generation ||
        existing.observed_at !== r.observedAt ||
        existing.blocked !== (r.blocked ? 1 : 0))
    )
      throw Error("CONFLICTING_REPORT");
    const result = await db.batch([
      db
        .prepare(
          "INSERT OR IGNORE INTO account_quota_reports(node_id,account_id,quota_epoch,sequence,total_bytes,generation,observed_at,blocked) VALUES(?,?,?,?,?,?,?,?)",
        )
        .bind(
          nodeId,
          r.accountId,
          r.quotaEpoch,
          r.sequence,
          r.totalBytes,
          r.generation,
          r.observedAt,
          r.blocked ? 1 : 0,
        ),
      db
        .prepare(
          "UPDATE managed_accounts SET used_bytes=MAX(used_bytes,?),last_report_at=MAX(COALESCE(last_report_at,0),?),state=CASE WHEN state IN ('revoked','expired','exhausted','blocked') THEN state WHEN valid_until>0 AND valid_until<=? THEN 'expired' WHEN ?=1 THEN 'blocked' WHEN quota_bytes IS NOT NULL AND MAX(used_bytes,?)>=quota_bytes THEN 'exhausted' ELSE state END WHERE id=? AND node_id=? AND quota_epoch=?",
        )
        .bind(
          r.totalBytes,
          r.observedAt,
          now,
          r.blocked ? 1 : 0,
          r.totalBytes,
          r.accountId,
          nodeId,
          r.quotaEpoch,
        ),
    ]);
    if (result[0]?.meta.changes) accepted++;
    else duplicates++;
  }
  return { accepted, duplicates };
}
