import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { PgDatabase } from '../src/postgres/client';
import { PostgresPushStore } from '../src/push/postgres';
import type { PushSubscriptionRecord } from '../src/push';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error('TEST_DATABASE_URL is required for PostgreSQL integration tests.');

const client = new Client({ connectionString });
const database = new PgDatabase(client);
const store = new PostgresPushStore(database);

const first: PushSubscriptionRecord = {
  id: 'push-1',
  userId: 'user-1',
  endpoint: 'https://push.example.test/subscription-1',
  p256dh: 'p256dh-secret-1',
  auth: 'auth-secret-1',
  expirationTime: null,
  createdAt: '2026-10-09T12:00:00.000Z',
  updatedAt: '2026-10-09T12:00:00.000Z',
};

beforeAll(async () => {
  await client.connect();
});

beforeEach(async () => {
  await client.query('TRUNCATE TABLE push_subscriptions, users CASCADE');
  await client.query(
    `INSERT INTO users (id, email, role, verified_at, suspended_at)
     VALUES
       ('user-1', 'user1@example.com', 'user', '2026-10-09T00:00:00.000Z', NULL),
       ('user-2', 'user2@example.com', 'user', '2026-10-09T00:00:00.000Z', NULL)`,
  );
});

afterAll(async () => {
  await client.end();
});

describe('PostgresPushStore integration', () => {
  it('upserts by endpoint while preserving the original row identity and creation time', async () => {
    await expect(store.saveSubscription(first)).resolves.toEqual(first);

    const refreshed: PushSubscriptionRecord = {
      ...first,
      id: 'push-ignored',
      p256dh: 'p256dh-secret-2',
      auth: 'auth-secret-2',
      expirationTime: 1893456000000,
      createdAt: '2026-10-09T12:05:00.000Z',
      updatedAt: '2026-10-09T12:05:00.000Z',
    };
    await expect(store.saveSubscription(refreshed)).resolves.toEqual({
      ...refreshed,
      id: 'push-1',
      createdAt: first.createdAt,
    });

    await expect(store.listUserSubscriptions('user-1')).resolves.toEqual([
      {
        ...refreshed,
        id: 'push-1',
        createdAt: first.createdAt,
      },
    ]);

    const persisted = await client.query(
      `SELECT count(*)::int AS endpoint_count
       FROM push_subscriptions
       WHERE endpoint = $1`,
      [first.endpoint],
    );
    expect(persisted.rows[0]?.endpoint_count).toBe(1);
  });

  it('keeps endpoint uniqueness under concurrent saves from separate PostgreSQL clients', async () => {
    const leftClient = new Client({ connectionString });
    const rightClient = new Client({ connectionString });
    await Promise.all([leftClient.connect(), rightClient.connect()]);
    const left = new PostgresPushStore(new PgDatabase(leftClient));
    const right = new PostgresPushStore(new PgDatabase(rightClient));

    try {
      const [leftResult, rightResult] = await Promise.all([
        left.saveSubscription(first),
        right.saveSubscription({
          ...first,
          id: 'push-2',
          p256dh: 'p256dh-secret-2',
          auth: 'auth-secret-2',
          updatedAt: '2026-10-09T12:01:00.000Z',
        }),
      ]);

      expect(leftResult.endpoint).toBe(first.endpoint);
      expect(rightResult.endpoint).toBe(first.endpoint);

      const persisted = await client.query(
        `SELECT id, user_id, endpoint, count(*) OVER ()::int AS endpoint_count
         FROM push_subscriptions
         WHERE endpoint = $1`,
        [first.endpoint],
      );
      expect(persisted.rows).toHaveLength(1);
      expect(persisted.rows[0]).toMatchObject({ user_id: 'user-1', endpoint: first.endpoint, endpoint_count: 1 });
    } finally {
      await Promise.all([leftClient.end(), rightClient.end()]);
    }
  });

  it('deletes only subscriptions owned by the requested user', async () => {
    await store.saveSubscription(first);

    await expect(store.deleteUserSubscription('user-2', 'push-1')).resolves.toBe(false);
    await expect(store.deleteUserSubscription('user-1', 'push-1')).resolves.toBe(true);
    await expect(store.listUserSubscriptions('user-1')).resolves.toEqual([]);
  });
});
