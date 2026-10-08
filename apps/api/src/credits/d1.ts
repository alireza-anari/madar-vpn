import type { D1DatabaseLike } from '../auth/d1';
import type { CreditLedgerEntry, CreditStore } from './index';

type VerifiedRow = { verified_at: string };
type InsertedRow = { unique_key: string };
type TotalRow = { total: number | null };
type SessionOwnerRow = { user_id: string };
type MembershipRow = { premium_until: string | null };

export class D1CreditStore implements CreditStore {
  constructor(private readonly db: D1DatabaseLike) {}

  async getVerifiedAt(userId: string) {
    const row = await this.db
      .prepare('SELECT verified_at FROM users WHERE id = ? LIMIT 1')
      .bind(userId)
      .first<VerifiedRow>();
    return row?.verified_at ?? null;
  }

  async insertLedgerEntry(entry: CreditLedgerEntry) {
    const row = await this.db
      .prepare(
        `INSERT INTO credit_ledger (
           unique_key, user_id, kind, free_day, delta_seconds, occurred_at,
           node_id, session_id, sequence
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(unique_key) DO NOTHING
         RETURNING unique_key`,
      )
      .bind(
        entry.uniqueKey,
        entry.userId,
        entry.kind,
        entry.freeDay,
        entry.deltaSeconds,
        entry.occurredAt,
        entry.nodeId ?? null,
        entry.sessionId ?? null,
        entry.sequence ?? null,
      )
      .first<InsertedRow>();
    return row !== null;
  }

  async sumFreeSeconds(userId: string, freeDay: string) {
    const row = await this.db
      .prepare(
        `SELECT COALESCE(SUM(delta_seconds), 0) AS total
         FROM credit_ledger
         WHERE user_id = ? AND free_day = ?`,
      )
      .bind(userId, freeDay)
      .first<TotalRow>();
    return Number(row?.total ?? 0);
  }

  async resolveUsageSession(nodeId: string, sessionId: string) {
    const row = await this.db
      .prepare(
        `SELECT user_id
         FROM usage_sessions
         WHERE node_id = ? AND session_id = ?
         LIMIT 1`,
      )
      .bind(nodeId, sessionId)
      .first<SessionOwnerRow>();
    return row?.user_id ?? null;
  }

  async getPremiumUntil(userId: string) {
    const row = await this.db
      .prepare('SELECT premium_until FROM memberships WHERE user_id = ? LIMIT 1')
      .bind(userId)
      .first<MembershipRow>();
    return row?.premium_until ?? null;
  }
}
