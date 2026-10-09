import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { PgDatabase } from '../src/postgres/client';
import { PostgresPaymentStore } from '../src/payments/postgres';
import type { PaymentOrder } from '../src/payments';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error('TEST_DATABASE_URL is required for PostgreSQL integration tests.');

const client = new Client({ connectionString });
const database = new PgDatabase(client);
const store = new PostgresPaymentStore(database);

const order: PaymentOrder = {
  id: 'order-1',
  userId: 'user-1',
  planId: 'monthly',
  durationDays: 30,
  amountMinor: 125000,
  currency: 'IRR',
  status: 'pending',
  createdAt: '2026-10-09T00:01:00.000Z',
  settledAt: null,
};

beforeAll(async () => {
  await client.connect();
});

beforeEach(async () => {
  await client.query('TRUNCATE TABLE payment_events, orders, plans, memberships, users CASCADE');
  await client.query(
    `INSERT INTO users (id, email, role, verified_at, suspended_at)
     VALUES ('user-1', 'user1@example.com', 'user', '2026-10-09T00:00:00.000Z', NULL)`,
  );
  await client.query(
    `INSERT INTO plans (id, title, duration_days, price_minor, currency, enabled, created_at, updated_at)
     VALUES ('monthly', 'ماهانه', 30, 125000, 'IRR', true, '2026-10-09T00:00:00.000Z', '2026-10-09T00:00:00.000Z')`,
  );
});

afterAll(async () => {
  await client.end();
});

describe('PostgresPaymentStore integration', () => {
  it('reads plans and persists the immutable server-created order snapshot', async () => {
    await expect(store.getPlan('monthly')).resolves.toEqual({
      id: 'monthly',
      title: 'ماهانه',
      durationDays: 30,
      priceMinor: 125000,
      currency: 'IRR',
      enabled: true,
    });

    await store.saveOrder(order);
    await expect(store.getOrder('order-1')).resolves.toEqual(order);

    const persisted = await client.query(
      `SELECT user_id, plan_id, duration_days, amount_minor::int, currency, status, settled_at
       FROM orders
       WHERE id = 'order-1'`,
    );
    expect(persisted.rows[0]).toEqual({
      user_id: 'user-1',
      plan_id: 'monthly',
      duration_days: 30,
      amount_minor: 125000,
      currency: 'IRR',
      status: 'pending',
      settled_at: null,
    });
  });

  it('settles one order once and extends premium from the later existing expiry', async () => {
    await store.saveOrder(order);
    await client.query(
      `INSERT INTO memberships (user_id, premium_until)
       VALUES ('user-1', '2026-11-01T00:00:00.000Z')`,
    );

    await expect(
      store.settlePendingOrder('order-1', 'provider:fixture:event-1', '2026-10-15T00:00:00.000Z'),
    ).resolves.toEqual({ applied: true, premiumUntil: '2026-12-01T00:00:00.000Z' });

    await expect(
      store.settlePendingOrder('order-1', 'provider:fixture:event-1', '2026-10-15T00:00:00.000Z'),
    ).resolves.toEqual({ applied: false, premiumUntil: '2026-12-01T00:00:00.000Z' });

    await expect(
      store.settlePendingOrder('order-1', 'provider:fixture:event-2', '2026-10-15T00:00:00.000Z'),
    ).resolves.toEqual({ applied: false, premiumUntil: '2026-12-01T00:00:00.000Z' });

    const persisted = await client.query(
      `SELECT
         (SELECT status FROM orders WHERE id = 'order-1') AS status,
         (SELECT settled_at FROM orders WHERE id = 'order-1') AS settled_at,
         (SELECT count(*)::int FROM payment_events WHERE order_id = 'order-1') AS event_count,
         (SELECT premium_until FROM memberships WHERE user_id = 'user-1') AS premium_until`,
    );
    expect(persisted.rows[0]?.status).toBe('settled');
    expect(persisted.rows[0]?.settled_at.toISOString()).toBe('2026-10-15T00:00:00.000Z');
    expect(persisted.rows[0]?.event_count).toBe(1);
    expect(persisted.rows[0]?.premium_until.toISOString()).toBe('2026-12-01T00:00:00.000Z');
  });

  it('serializes concurrent callbacks so different source keys still settle one order only once', async () => {
    await store.saveOrder({ ...order, id: 'order-concurrent' });

    const leftClient = new Client({ connectionString });
    const rightClient = new Client({ connectionString });
    await Promise.all([leftClient.connect(), rightClient.connect()]);
    const left = new PostgresPaymentStore(new PgDatabase(leftClient));
    const right = new PostgresPaymentStore(new PgDatabase(rightClient));

    try {
      const results = await Promise.all([
        left.settlePendingOrder('order-concurrent', 'provider:fixture:event-a', '2026-10-20T00:00:00.000Z'),
        right.settlePendingOrder('order-concurrent', 'provider:fixture:event-b', '2026-10-20T00:00:00.000Z'),
      ]);

      expect(results.filter((result) => result?.applied)).toHaveLength(1);
      expect(results.filter((result) => result && !result.applied)).toHaveLength(1);
      expect(results.every((result) => result?.premiumUntil === '2026-11-19T00:00:00.000Z')).toBe(true);

      const persisted = await client.query(
        `SELECT
           (SELECT count(*)::int FROM payment_events WHERE order_id = 'order-concurrent') AS event_count,
           (SELECT premium_until FROM memberships WHERE user_id = 'user-1') AS premium_until`,
      );
      expect(persisted.rows[0]?.event_count).toBe(1);
      expect(persisted.rows[0]?.premium_until.toISOString()).toBe('2026-11-19T00:00:00.000Z');
    } finally {
      await Promise.all([leftClient.end(), rightClient.end()]);
    }
  });
});
