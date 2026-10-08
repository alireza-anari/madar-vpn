import { describe, expect, it } from 'vitest';
import type { D1DatabaseLike } from '../auth/d1';
import type { PaymentOrder } from './index';
import { D1PaymentStore } from './d1';

class FakeStatement {
  bound: unknown[] = [];

  constructor(readonly sql: string, private readonly db: FakeD1) {}

  bind(...values: unknown[]) {
    this.bound = values;
    return this;
  }

  async run() {
    this.db.executed.push({ sql: this.sql, values: this.bound, mode: 'run' });
    return { success: true };
  }

  async first<T>() {
    this.db.executed.push({ sql: this.sql, values: this.bound, mode: 'first' });
    return (this.db.firstResults.shift() ?? null) as T | null;
  }
}

class FakeD1 implements D1DatabaseLike {
  readonly executed: Array<{ sql: string; values: unknown[]; mode: 'run' | 'first' }> = [];
  readonly firstResults: unknown[] = [];

  prepare(sql: string) {
    return new FakeStatement(sql, this);
  }
}

const order: PaymentOrder = {
  id: 'order-1',
  userId: 'user-1',
  planId: 'monthly',
  durationDays: 30,
  amountMinor: 125000,
  currency: 'IRR',
  status: 'pending',
  createdAt: '2026-10-08T08:00:00.000Z',
  settledAt: null,
};

describe('D1PaymentStore', () => {
  it('reads plans and writes an immutable server-created order snapshot', async () => {
    const db = new FakeD1();
    const store = new D1PaymentStore(db);
    db.firstResults.push({
      id: 'monthly',
      title: 'ماهانه',
      duration_days: 30,
      price_minor: 125000,
      currency: 'IRR',
      enabled: 1,
    });

    await expect(store.getPlan('monthly')).resolves.toMatchObject({
      id: 'monthly', durationDays: 30, priceMinor: 125000, currency: 'IRR', enabled: true,
    });
    await store.saveOrder(order);

    expect(db.executed[0]!.sql).toMatch(/FROM\s+plans/i);
    expect(db.executed[1]!.sql).toMatch(/INSERT\s+INTO\s+orders/i);
    expect(db.executed[1]!.values).toEqual([
      'order-1', 'user-1', 'monthly', 30, 125000, 'IRR', 'pending', '2026-10-08T08:00:00.000Z', null,
    ]);
  });

  it('uses one idempotent payment-event insert as the atomic settlement mutation', async () => {
    const db = new FakeD1();
    const store = new D1PaymentStore(db);
    db.firstResults.push(
      { order_id: 'order-1' },
      { premium_until: '2026-11-07T08:00:00.000Z' },
      null,
      { user_id: 'user-1' },
      { premium_until: '2026-11-07T08:00:00.000Z' },
    );

    await expect(store.settlePendingOrder('order-1', 'provider:fixture:event-1', '2026-10-08T08:00:00.000Z'))
      .resolves.toEqual({ applied: true, premiumUntil: '2026-11-07T08:00:00.000Z' });
    await expect(store.settlePendingOrder('order-1', 'provider:fixture:event-1', '2026-10-08T08:00:00.000Z'))
      .resolves.toEqual({ applied: false, premiumUntil: '2026-11-07T08:00:00.000Z' });

    const mutations = db.executed.filter((entry) => /INSERT\s+INTO\s+payment_events/i.test(entry.sql));
    expect(mutations).toHaveLength(2);
    for (const mutation of mutations) {
      expect(mutation.sql).toMatch(/FROM\s+orders/i);
      expect(mutation.sql).toMatch(/status\s*=\s*'pending'/i);
      expect(mutation.sql).toMatch(/ON\s+CONFLICT\s*\(source_key\)\s+DO\s+NOTHING/i);
      expect(mutation.sql).toMatch(/RETURNING\s+order_id/i);
      expect(mutation.values).toEqual([
        'provider:fixture:event-1',
        'order-1',
        '2026-10-08T08:00:00.000Z',
      ]);
    }
  });
});
