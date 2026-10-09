import type { PgDatabase } from '../postgres/client';
import type { PaymentOrder, PaymentPlan, PaymentSettlement, PaymentStore } from './index';

type QueryDatabase = Pick<PgDatabase, 'query' | 'transaction'>;

type PlanRow = Record<string, unknown> & {
  id: string;
  title: string;
  duration_days: number;
  price_minor: number | string | bigint;
  currency: string;
  enabled: boolean;
};

type OrderRow = Record<string, unknown> & {
  id: string;
  user_id: string;
  plan_id: string;
  duration_days: number;
  amount_minor: number | string | bigint;
  currency: string;
  status: 'pending' | 'settled';
  created_at: Date | string;
  settled_at: Date | string | null;
};

type MembershipRow = Record<string, unknown> & { premium_until: Date | string | null };
type IdRow = Record<string, unknown> & { id: string };
type SourceKeyRow = Record<string, unknown> & { source_key: string };

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toNullableIso(value: Date | string | null): string | null {
  return value === null ? null : toIso(value);
}

function mapPlan(row: PlanRow | undefined): PaymentPlan | null {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    durationDays: row.duration_days,
    priceMinor: Number(row.price_minor),
    currency: row.currency,
    enabled: row.enabled,
  };
}

function mapOrder(row: OrderRow | undefined): PaymentOrder | null {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    planId: row.plan_id,
    durationDays: row.duration_days,
    amountMinor: Number(row.amount_minor),
    currency: row.currency,
    status: row.status,
    createdAt: toIso(row.created_at),
    settledAt: toNullableIso(row.settled_at),
  };
}

export class PostgresPaymentStore implements PaymentStore {
  constructor(private readonly db: QueryDatabase) {}

  async getPlan(id: string) {
    const result = await this.db.query<PlanRow>(
      `SELECT id, title, duration_days, price_minor, currency, enabled
       FROM plans
       WHERE id = $1
       LIMIT 1`,
      [id],
    );
    return mapPlan(result.rows[0]);
  }

  async saveOrder(order: PaymentOrder) {
    await this.db.query(
      `INSERT INTO orders (
         id, user_id, plan_id, duration_days, amount_minor, currency,
         status, created_at, settled_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9::timestamptz)`,
      [
        order.id,
        order.userId,
        order.planId,
        order.durationDays,
        order.amountMinor,
        order.currency,
        order.status,
        order.createdAt,
        order.settledAt,
      ],
    );
  }

  async getOrder(id: string) {
    const result = await this.db.query<OrderRow>(
      `SELECT id, user_id, plan_id, duration_days, amount_minor, currency,
              status, created_at, settled_at
       FROM orders
       WHERE id = $1
       LIMIT 1`,
      [id],
    );
    return mapOrder(result.rows[0]);
  }

  async settlePendingOrder(orderId: string, sourceKey: string, settledAt: string): Promise<PaymentSettlement | null> {
    return this.db.transaction(async (transaction) => {
      const orderResult = await transaction.query<OrderRow>(
        `SELECT id, user_id, plan_id, duration_days, amount_minor, currency,
                status, created_at, settled_at
         FROM orders
         WHERE id = $1
         FOR UPDATE`,
        [orderId],
      );
      const order = mapOrder(orderResult.rows[0]);
      if (!order) return null;

      if (order.status === 'settled') {
        return { applied: false, premiumUntil: await this.readPremiumUntil(transaction, order.userId) };
      }

      const userLock = await transaction.query<IdRow>(
        'SELECT id FROM users WHERE id = $1 FOR UPDATE',
        [order.userId],
      );
      if (!userLock.rows[0]) throw new Error('Payment order owner does not exist.');

      const currentPremiumUntil = await this.readPremiumUntil(transaction, order.userId);
      const insertedEvent = await transaction.query<SourceKeyRow>(
        `INSERT INTO payment_events (source_key, order_id, occurred_at)
         VALUES ($1, $2, $3::timestamptz)
         ON CONFLICT (source_key) DO NOTHING
         RETURNING source_key`,
        [sourceKey, orderId, settledAt],
      );
      if (!insertedEvent.rows[0]) {
        return { applied: false, premiumUntil: currentPremiumUntil };
      }

      const settledOrder = await transaction.query<IdRow>(
        `UPDATE orders
         SET status = 'settled', settled_at = $2::timestamptz
         WHERE id = $1 AND status = 'pending'
         RETURNING id`,
        [orderId, settledAt],
      );
      if (!settledOrder.rows[0]) throw new Error('Pending payment order could not be settled.');

      const membership = await transaction.query<MembershipRow>(
        `INSERT INTO memberships (user_id, premium_until)
         VALUES (
           $1,
           GREATEST(
             $2::timestamptz,
             COALESCE((SELECT premium_until FROM memberships WHERE user_id = $1), $2::timestamptz)
           ) + ($3::int * interval '1 day')
         )
         ON CONFLICT (user_id) DO UPDATE SET premium_until = EXCLUDED.premium_until
         RETURNING premium_until`,
        [order.userId, settledAt, order.durationDays],
      );
      const premiumUntil = membership.rows[0]?.premium_until;
      if (!premiumUntil) throw new Error('Premium membership could not be extended.');

      return { applied: true, premiumUntil: toIso(premiumUntil) };
    });
  }

  async getPremiumUntil(userId: string) {
    return this.readPremiumUntil(this.db, userId);
  }

  private async readPremiumUntil(database: Pick<PgDatabase, 'query'>, userId: string) {
    const result = await database.query<MembershipRow>(
      `SELECT premium_until
       FROM memberships
       WHERE user_id = $1
       LIMIT 1`,
      [userId],
    );
    return result.rows[0] ? toNullableIso(result.rows[0].premium_until) : null;
  }
}
