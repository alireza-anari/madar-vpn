import type { D1DatabaseLike } from '../auth/d1';
import type { PaymentOrder, PaymentPlan, PaymentSettlement, PaymentStore } from './index';

type PlanRow = {
  id: string;
  title: string;
  duration_days: number;
  price_minor: number;
  currency: string;
  enabled: number;
};

type OrderRow = {
  id: string;
  user_id: string;
  plan_id: string;
  duration_days: number;
  amount_minor: number;
  currency: string;
  status: 'pending' | 'settled';
  created_at: string;
  settled_at: string | null;
};

type InsertedPaymentEventRow = { order_id: string };
type OrderOwnerRow = { user_id: string };
type MembershipRow = { premium_until: string | null };

function mapPlan(row: PlanRow | null): PaymentPlan | null {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    durationDays: Number(row.duration_days),
    priceMinor: Number(row.price_minor),
    currency: row.currency,
    enabled: row.enabled === 1,
  };
}

function mapOrder(row: OrderRow | null): PaymentOrder | null {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    planId: row.plan_id,
    durationDays: Number(row.duration_days),
    amountMinor: Number(row.amount_minor),
    currency: row.currency,
    status: row.status,
    createdAt: row.created_at,
    settledAt: row.settled_at,
  };
}

export class D1PaymentStore implements PaymentStore {
  constructor(private readonly db: D1DatabaseLike) {}

  async getPlan(id: string) {
    const row = await this.db
      .prepare(
        `SELECT id, title, duration_days, price_minor, currency, enabled
         FROM plans
         WHERE id = ?
         LIMIT 1`,
      )
      .bind(id)
      .first<PlanRow>();
    return mapPlan(row);
  }

  async saveOrder(order: PaymentOrder) {
    await this.db
      .prepare(
        `INSERT INTO orders (
           id, user_id, plan_id, duration_days, amount_minor, currency,
           status, created_at, settled_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        order.id,
        order.userId,
        order.planId,
        order.durationDays,
        order.amountMinor,
        order.currency,
        order.status,
        order.createdAt,
        order.settledAt,
      )
      .run();
  }

  async getOrder(id: string) {
    const row = await this.db
      .prepare(
        `SELECT id, user_id, plan_id, duration_days, amount_minor, currency,
                status, created_at, settled_at
         FROM orders
         WHERE id = ?
         LIMIT 1`,
      )
      .bind(id)
      .first<OrderRow>();
    return mapOrder(row);
  }

  async settlePendingOrder(orderId: string, sourceKey: string, settledAt: string): Promise<PaymentSettlement | null> {
    const inserted = await this.db
      .prepare(
        `WITH input(source_key, order_id, occurred_at) AS (VALUES (?, ?, ?))
         INSERT INTO payment_events (source_key, order_id, occurred_at)
         SELECT input.source_key, orders.id, input.occurred_at
         FROM orders, input
         WHERE orders.id = input.order_id
           AND orders.status = 'pending'
         ON CONFLICT(source_key) DO NOTHING
         RETURNING order_id`,
      )
      .bind(sourceKey, orderId, settledAt)
      .first<InsertedPaymentEventRow>();

    if (inserted) {
      const membership = await this.db
        .prepare(
          `SELECT memberships.premium_until
           FROM orders
           LEFT JOIN memberships ON memberships.user_id = orders.user_id
           WHERE orders.id = ?
           LIMIT 1`,
        )
        .bind(orderId)
        .first<MembershipRow>();
      return { applied: true, premiumUntil: membership?.premium_until ?? null };
    }

    const owner = await this.db
      .prepare('SELECT user_id FROM orders WHERE id = ? LIMIT 1')
      .bind(orderId)
      .first<OrderOwnerRow>();
    if (!owner) return null;
    return { applied: false, premiumUntil: await this.getPremiumUntil(owner.user_id) };
  }

  async getPremiumUntil(userId: string) {
    const row = await this.db
      .prepare('SELECT premium_until FROM memberships WHERE user_id = ? LIMIT 1')
      .bind(userId)
      .first<MembershipRow>();
    return row?.premium_until ?? null;
  }
}
