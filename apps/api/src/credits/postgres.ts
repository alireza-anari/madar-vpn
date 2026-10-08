import type { CreditLedgerEntry, CreditStore } from './index';
import type { PgDatabase } from '../postgres/client';

type QueryDatabase = Pick<PgDatabase, 'query' | 'transaction'>;

type VerificationRow = Record<string, unknown> & { verified_at: Date | string };
type InsertedKeyRow = Record<string, unknown> & { unique_key: string };
type TotalRow = Record<string, unknown> & { total: number | string | bigint | null };
type UsageSessionRow = Record<string, unknown> & { user_id: string };
type MembershipRow = Record<string, unknown> & { premium_until: Date | string | null };

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toNullableIso(value: Date | string | null): string | null {
  return value === null ? null : toIso(value);
}

export class PostgresCreditStore implements CreditStore {
  constructor(private readonly db: QueryDatabase) {}

  async getVerifiedAt(userId: string) {
    const result = await this.db.query<VerificationRow>(
      `SELECT verified_at
       FROM users
       WHERE id = $1
       LIMIT 1`,
      [userId],
    );
    const row = result.rows[0];
    return row ? toIso(row.verified_at) : null;
  }

  async insertLedgerEntry(entry: CreditLedgerEntry) {
    const result = await this.db.query<InsertedKeyRow>(
      `INSERT INTO credit_ledger (
         unique_key, user_id, kind, free_day, delta_seconds, occurred_at,
         node_id, session_id, sequence
       )
       VALUES ($1, $2, $3, $4::date, $5, $6::timestamptz, $7, $8, $9)
       ON CONFLICT (unique_key) DO NOTHING
       RETURNING unique_key`,
      [
        entry.uniqueKey,
        entry.userId,
        entry.kind,
        entry.freeDay,
        entry.deltaSeconds,
        entry.occurredAt,
        entry.nodeId ?? null,
        entry.sessionId ?? null,
        entry.sequence ?? null,
      ],
    );
    return result.rows.length > 0;
  }

  async sumFreeSeconds(userId: string, freeDay: string) {
    const result = await this.db.query<TotalRow>(
      `SELECT COALESCE(SUM(delta_seconds), 0) AS total
       FROM credit_ledger
       WHERE user_id = $1
         AND free_day = $2::date`,
      [userId, freeDay],
    );
    return Number(result.rows[0]?.total ?? 0);
  }

  async resolveUsageSession(nodeId: string, sessionId: string) {
    const result = await this.db.query<UsageSessionRow>(
      `SELECT user_id
       FROM usage_sessions
       WHERE node_id = $1
         AND session_id = $2
       LIMIT 1`,
      [nodeId, sessionId],
    );
    return result.rows[0]?.user_id ?? null;
  }

  async getPremiumUntil(userId: string) {
    const result = await this.db.query<MembershipRow>(
      `SELECT premium_until
       FROM memberships
       WHERE user_id = $1
       LIMIT 1`,
      [userId],
    );
    const row = result.rows[0];
    return row ? toNullableIso(row.premium_until) : null;
  }

  async applyPremiumAdjustment(
    userId: string,
    uniqueKey: string,
    premiumUntil: string | null,
    occurredAt: string,
  ) {
    return this.db.transaction(async (transaction) => {
      const inserted = await transaction.query<InsertedKeyRow>(
        `INSERT INTO premium_adjustments (unique_key, user_id, premium_until, occurred_at)
         VALUES ($1, $2, $3::timestamptz, $4::timestamptz)
         ON CONFLICT (unique_key) DO NOTHING
         RETURNING unique_key`,
        [uniqueKey, userId, premiumUntil, occurredAt],
      );
      if (inserted.rows.length === 0) return false;

      await transaction.query(
        `INSERT INTO memberships (user_id, premium_until)
         VALUES ($1, $2::timestamptz)
         ON CONFLICT (user_id) DO UPDATE SET
           premium_until = EXCLUDED.premium_until`,
        [userId, premiumUntil],
      );
      return true;
    });
  }
}
