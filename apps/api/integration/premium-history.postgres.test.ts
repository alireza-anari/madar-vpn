import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { createCreditService } from '../src/credits';
import { PostgresCreditStore } from '../src/credits/postgres';
import type { PaymentOrder } from '../src/payments';
import { PostgresPaymentStore } from '../src/payments/postgres';
import { PgDatabase } from '../src/postgres/client';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error('TEST_DATABASE_URL is required for PostgreSQL integration tests.');

const client = new Client({ connectionString });
const database = new PgDatabase(client);
const credits = createCreditService({ store: new PostgresCreditStore(database) });
const payments = new PostgresPaymentStore(database);

beforeAll(async () => {
  await client.connect();
});

beforeEach(async () => {
  await client.query(`TRUNCATE TABLE
    premium_entitlement_events, payment_events, orders, plans,
    premium_adjustments, memberships, credit_ledger, usage_sessions,
    sessions, login_tokens, users
    RESTART IDENTITY CASCADE`);
  await client.query(
    `INSERT INTO users (id, email, role, verified_at, suspended_at)
     VALUES ('user-1', 'premium-history@example.com', 'user', '2026-10-10T07:00:00.000Z', NULL)`,
  );
});

afterAll(async () => {
  await client.end();
});

describe('Premium entitlement history', () => {
  it('serializes an admin adjustment and appends the resulting state exactly once', async () => {
    const effectiveAt = new Date('2026-10-10T08:00:00.000Z');
    await expect(
      credits.adjustPremium('user-1', 'admin-premium-1', '2026-11-10T08:00:00.000Z', effectiveAt),
    ).resolves.toBe(true);
    await expect(
      credits.adjustPremium('user-1', 'admin-premium-1', '2027-01-01T00:00:00.000Z', effectiveAt),
    ).resolves.toBe(false);

    const rows = await client.query(
      `SELECT source_key, effective_at, premium_until
       FROM premium_entitlement_events
       WHERE user_id = 'user-1'
       ORDER BY event_order`,
    );
    expect(rows.rows.map((row) => ({
      sourceKey: row.source_key,
      effectiveAt: row.effective_at.toISOString(),
      premiumUntil: row.premium_until?.toISOString() ?? null,
    }))).toEqual([{
      sourceKey: 'adjustment:premium:admin-premium-1',
      effectiveAt: '2026-10-10T08:00:00.000Z',
      premiumUntil: '2026-11-10T08:00:00.000Z',
    }]);
  });

  it('keeps provider occurrence time as evidence but uses server settlement time for Premium state', async () => {
    await client.query(
      `INSERT INTO plans (id, title, duration_days, price_minor, currency, enabled, created_at, updated_at)
       VALUES ('monthly', 'ماهانه', 30, 125000, 'IRR', true,
               '2026-10-10T07:00:00.000Z', '2026-10-10T07:00:00.000Z')`,
    );
    const order: PaymentOrder = {
      id: 'order-history-1',
      userId: 'user-1',
      planId: 'monthly',
      durationDays: 30,
      amountMinor: 125000,
      currency: 'IRR',
      status: 'pending',
      createdAt: '2026-10-10T08:00:00.000Z',
      settledAt: null,
    };
    await payments.saveOrder(order);

    const providerOccurredAt = '2026-10-09T06:00:00.000Z';
    const serverSettledAt = '2026-10-10T09:00:00.000Z';
    await expect(
      payments.settlePendingOrder(
        order.id,
        'provider:fixture:history-event',
        providerOccurredAt,
        serverSettledAt,
      ),
    ).resolves.toEqual({
      applied: true,
      premiumUntil: '2026-11-09T09:00:00.000Z',
    });

    const state = await client.query(
      `SELECT
         (SELECT occurred_at FROM payment_events WHERE source_key = 'provider:fixture:history-event') AS provider_occurred_at,
         (SELECT settled_at FROM orders WHERE id = 'order-history-1') AS settled_at,
         (SELECT premium_until FROM memberships WHERE user_id = 'user-1') AS premium_until,
         (SELECT source_key FROM premium_entitlement_events WHERE user_id = 'user-1') AS history_source,
         (SELECT effective_at FROM premium_entitlement_events WHERE user_id = 'user-1') AS history_effective_at,
         (SELECT premium_until FROM premium_entitlement_events WHERE user_id = 'user-1') AS history_premium_until`,
    );
    expect(state.rows[0]?.provider_occurred_at.toISOString()).toBe(providerOccurredAt);
    expect(state.rows[0]?.settled_at.toISOString()).toBe(serverSettledAt);
    expect(state.rows[0]?.premium_until.toISOString()).toBe('2026-11-09T09:00:00.000Z');
    expect(state.rows[0]?.history_source).toBe('payment:provider:fixture:history-event');
    expect(state.rows[0]?.history_effective_at.toISOString()).toBe(serverSettledAt);
    expect(state.rows[0]?.history_premium_until.toISOString()).toBe('2026-11-09T09:00:00.000Z');

    await expect(
      payments.settlePendingOrder(
        order.id,
        'provider:fixture:history-event',
        providerOccurredAt,
        '2026-10-10T10:00:00.000Z',
      ),
    ).resolves.toEqual({ applied: false, premiumUntil: '2026-11-09T09:00:00.000Z' });
    expect((await client.query(
      `SELECT count(*)::int AS count FROM premium_entitlement_events WHERE user_id = 'user-1'`,
    )).rows[0]?.count).toBe(1);
  });
});
