import type { D1DatabaseLike, D1PreparedStatementLike } from '../auth/d1';
import type { PushStore, PushSubscriptionRecord } from './index';

type PushRow = {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  expiration_time: number | null;
  created_at: string;
  updated_at: string;
};

type DeletedRow = { id: string };
type D1ListStatement = D1PreparedStatementLike & { all<T>(): Promise<{ results?: T[] }> };

function mapRow(row: PushRow): PushSubscriptionRecord {
  return {
    id: row.id,
    userId: row.user_id,
    endpoint: row.endpoint,
    p256dh: row.p256dh,
    auth: row.auth,
    expirationTime: row.expiration_time,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function allRows<T>(statement: D1PreparedStatementLike) {
  const result = await (statement as D1ListStatement).all<T>();
  return result.results ?? [];
}

export class D1PushStore implements PushStore {
  constructor(private readonly db: D1DatabaseLike) {}

  async saveSubscription(record: PushSubscriptionRecord) {
    const row = await this.db
      .prepare(
        `INSERT INTO push_subscriptions (
           id, user_id, endpoint, p256dh, auth, expiration_time, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET
           user_id = excluded.user_id,
           p256dh = excluded.p256dh,
           auth = excluded.auth,
           expiration_time = excluded.expiration_time,
           updated_at = excluded.updated_at
         RETURNING id, user_id, endpoint, p256dh, auth, expiration_time, created_at, updated_at`,
      )
      .bind(
        record.id,
        record.userId,
        record.endpoint,
        record.p256dh,
        record.auth,
        record.expirationTime,
        record.createdAt,
        record.updatedAt,
      )
      .first<PushRow>();
    if (!row) throw new Error('Push subscription persistence failed.');
    return mapRow(row);
  }

  async listUserSubscriptions(userId: string) {
    const rows = await allRows<PushRow>(
      this.db
        .prepare(
          `SELECT id, user_id, endpoint, p256dh, auth, expiration_time, created_at, updated_at
           FROM push_subscriptions
           WHERE user_id = ?
           ORDER BY updated_at DESC`,
        )
        .bind(userId),
    );
    return rows.map(mapRow);
  }

  async deleteUserSubscription(userId: string, id: string) {
    const row = await this.db
      .prepare(
        `DELETE FROM push_subscriptions
         WHERE user_id = ? AND id = ?
         RETURNING id`,
      )
      .bind(userId, id)
      .first<DeletedRow>();
    return row !== null;
  }
}
