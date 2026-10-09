import type { PgDatabase } from '../postgres/client';
import type { PushStore, PushSubscriptionRecord } from './index';

type QueryDatabase = Pick<PgDatabase, 'query'>;

type PushRow = Record<string, unknown> & {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  expiration_time: number | string | bigint | null;
  created_at: Date | string;
  updated_at: Date | string;
};

type DeletedRow = Record<string, unknown> & { id: string };

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapRow(row: PushRow): PushSubscriptionRecord {
  return {
    id: row.id,
    userId: row.user_id,
    endpoint: row.endpoint,
    p256dh: row.p256dh,
    auth: row.auth,
    expirationTime: row.expiration_time === null ? null : Number(row.expiration_time),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

export class PostgresPushStore implements PushStore {
  constructor(private readonly db: QueryDatabase) {}

  async saveSubscription(record: PushSubscriptionRecord) {
    const result = await this.db.query<PushRow>(
      `INSERT INTO push_subscriptions (
         id, user_id, endpoint, p256dh, auth, expiration_time, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz)
       ON CONFLICT (endpoint) DO UPDATE SET
         user_id = EXCLUDED.user_id,
         p256dh = EXCLUDED.p256dh,
         auth = EXCLUDED.auth,
         expiration_time = EXCLUDED.expiration_time,
         updated_at = EXCLUDED.updated_at
       RETURNING id, user_id, endpoint, p256dh, auth, expiration_time, created_at, updated_at`,
      [
        record.id,
        record.userId,
        record.endpoint,
        record.p256dh,
        record.auth,
        record.expirationTime,
        record.createdAt,
        record.updatedAt,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Push subscription persistence failed.');
    return mapRow(row);
  }

  async listUserSubscriptions(userId: string) {
    const result = await this.db.query<PushRow>(
      `SELECT id, user_id, endpoint, p256dh, auth, expiration_time, created_at, updated_at
       FROM push_subscriptions
       WHERE user_id = $1
       ORDER BY updated_at DESC`,
      [userId],
    );
    return result.rows.map(mapRow);
  }

  async deleteUserSubscription(userId: string, id: string) {
    const result = await this.db.query<DeletedRow>(
      `DELETE FROM push_subscriptions
       WHERE user_id = $1 AND id = $2
       RETURNING id`,
      [userId, id],
    );
    return result.rows.length > 0;
  }
}
