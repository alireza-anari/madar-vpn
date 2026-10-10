import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import type { TelemetryReport } from '../src/nodes';
import { PgDatabase } from '../src/postgres/client';
import { PostgresUsageSettlementStore } from '../src/usage/postgres';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error('TEST_DATABASE_URL is required for PostgreSQL integration tests.');

const client = new Client({ connectionString });
const database = new PgDatabase(client);
const store = new PostgresUsageSettlementStore(database);

const CLIENT_A = '27848739-7e62-4138-9fd3-098a63964b6b';
const CLIENT_B = '50848739-7e62-4138-9fd3-098a63964b6b';
const TEN_BITS = '00000000000003ff';
const FIVE_LOW = '000000000000001f';
const FIVE_HIGH = '00000000000003e0';

function masked(overrides: Partial<TelemetryReport> = {}): TelemetryReport {
  return {
    nodeId: 'node-1',
    clientId: CLIENT_A,
    windowId: 'xray-traffic:2026-10-10T08:00Z',
    sequence: 1,
    seconds: 10,
    timestamp: '2026-10-10T08:00:10.000Z',
    observedFrom: '2026-10-10T08:00:00.000Z',
    observedTo: '2026-10-10T08:00:10.000Z',
    activeSecondsHex: TEN_BITS,
    ...overrides,
  };
}

async function usageTotal(userId = 'user-1', freeDay?: string) {
  const conditions = [`user_id = $1`, `kind = 'usage'`];
  const values: unknown[] = [userId];
  if (freeDay) {
    conditions.push(`free_day = $2::date`);
    values.push(freeDay);
  }
  const result = await client.query(
    `SELECT COALESCE(SUM(delta_seconds), 0)::int AS total
     FROM credit_ledger
     WHERE ${conditions.join(' AND ')}`,
    values,
  );
  return result.rows[0]?.total as number;
}

async function openUsageStore() {
  const connection = new Client({ connectionString });
  await connection.connect();
  return {
    connection,
    store: new PostgresUsageSettlementStore(new PgDatabase(connection)),
  };
}

beforeAll(async () => {
  await client.connect();
});

beforeEach(async () => {
  await client.query(`TRUNCATE TABLE
    usage_debit_events, usage_active_minutes, telemetry_reports,
    premium_entitlement_events, client_credentials, access_profiles,
    credit_ledger, memberships, node_policy_acks, node_policy_revisions,
    node_health_samples, node_capabilities, node_credentials, node_enrollment_tokens,
    node_public_configs, nodes, sessions, login_tokens, users
    RESTART IDENTITY CASCADE`);
  await client.query(
    `INSERT INTO users (id, email, role, verified_at, suspended_at)
     VALUES
       ('user-1', 'usage1@example.com', 'user', '2026-10-10T00:00:00.000Z', NULL),
       ('user-2', 'usage2@example.com', 'user', '2026-10-10T00:00:00.000Z', NULL)`,
  );
  await client.query(
    `INSERT INTO nodes (id, name, status, created_at)
     VALUES
       ('node-1', 'Node 1', 'ready', '2026-10-10T00:00:00.000Z'),
       ('node-2', 'Node 2', 'ready', '2026-10-10T00:00:00.000Z')`,
  );
  await client.query(
    `INSERT INTO client_credentials (id, user_id, uuid, version, created_at, revoked_at)
     VALUES
       ('cred-a', 'user-1', $1, 1, '2026-10-10T00:00:00.000Z', NULL),
       ('cred-b', 'user-1', $2, 2, '2026-10-10T00:00:00.000Z', '2026-10-10T07:30:00.000Z')`,
    [CLIENT_A, CLIENT_B],
  );
  await client.query(
    `UPDATE usage_accounting_config
     SET active_second_epoch = '2026-10-10T00:00:00.000Z'
     WHERE id = 1`,
  );
});

afterAll(async () => {
  await client.end();
});

describe('Postgres active-second telemetry settlement', () => {
  it('settles one report exactly once and persists immutable debit evidence', async () => {
    const report = masked();
    await expect(store.accept(report)).resolves.toBe('accepted');
    await expect(store.accept(report)).resolves.toBe('duplicate');

    expect(await usageTotal()).toBe(-10);
    const state = await client.query(
      `SELECT
         (SELECT count(*)::int FROM telemetry_reports) AS raw_count,
         (SELECT settled_mask::text FROM usage_active_minutes WHERE user_id = 'user-1') AS settled_mask,
         (SELECT observed_mask::text FROM usage_debit_events) AS observed_mask,
         (SELECT new_mask::text FROM usage_debit_events) AS new_mask,
         (SELECT debited_mask::text FROM usage_debit_events) AS debited_mask,
         (SELECT debit_seconds FROM usage_debit_events) AS debit_seconds,
         (SELECT settlement_status FROM telemetry_reports) AS status`,
    );
    expect(state.rows[0]).toMatchObject({
      raw_count: 1,
      settled_mask: '1023',
      observed_mask: '1023',
      new_mask: '1023',
      debited_mask: '1023',
      debit_seconds: 10,
      status: 'settled',
    });
  });

  it('rejects a contradictory replay without changing persisted accounting state', async () => {
    const report = masked();
    await expect(store.accept(report)).resolves.toBe('accepted');
    await expect(store.accept({ ...report, seconds: 1, activeSecondsHex: '0000000000000001' })).resolves.toBe('conflict');
    await expect(store.accept({ ...report, clientId: CLIENT_B })).resolves.toBe('conflict');
    await expect(store.accept({ ...report, timestamp: '2026-10-10T08:00:11.000Z' })).resolves.toBe('conflict');
    expect(await usageTotal()).toBe(-10);
    expect((await client.query('SELECT count(*)::int AS count FROM telemetry_reports')).rows[0]?.count).toBe(1);
  });

  it('deduplicates overlapping seconds across nodes under concurrent settlement', async () => {
    const left = await openUsageStore();
    const right = await openUsageStore();
    try {
      const results = await Promise.all([
        left.store.accept(masked({ nodeId: 'node-1', sequence: 1 })),
        right.store.accept(masked({ nodeId: 'node-2', sequence: 1 })),
      ]);
      expect(results).toEqual(['accepted', 'accepted']);
    } finally {
      await Promise.all([left.connection.end(), right.connection.end()]);
    }

    expect(await usageTotal()).toBe(-10);
    expect((await client.query(
      `SELECT settled_mask::text AS mask FROM usage_active_minutes
       WHERE user_id = 'user-1' AND minute_start = '2026-10-10T08:00:00.000Z'`,
    )).rows[0]?.mask).toBe('1023');
  });

  it('adds disjoint concurrent node masks but still accounts at user-minute scope', async () => {
    const left = await openUsageStore();
    const right = await openUsageStore();
    try {
      await Promise.all([
        left.store.accept(masked({ nodeId: 'node-1', seconds: 5, activeSecondsHex: FIVE_LOW })),
        right.store.accept(masked({ nodeId: 'node-2', seconds: 5, activeSecondsHex: FIVE_HIGH })),
      ]);
    } finally {
      await Promise.all([left.connection.end(), right.connection.end()]);
    }
    expect(await usageTotal()).toBe(-10);
  });

  it('deduplicates overlap across credential rotations and resolves revoked credentials', async () => {
    await expect(store.accept(masked({ clientId: CLIENT_A, nodeId: 'node-1' }))).resolves.toBe('accepted');
    await expect(store.accept(masked({ clientId: CLIENT_B, nodeId: 'node-2' }))).resolves.toBe('accepted');
    expect(await usageTotal()).toBe(-10);
    expect((await client.query(
      `SELECT count(*)::int AS count FROM telemetry_reports WHERE client_id = $1`,
      [CLIENT_B],
    )).rows[0]?.count).toBe(1);
  });

  it('durably accepts unmapped masked and legacy telemetry without creating debit', async () => {
    await expect(store.accept(masked({ clientId: '99999999-9999-4999-8999-999999999999' }))).resolves.toBe('accepted');
    await expect(store.accept({
      nodeId: 'node-1',
      clientId: CLIENT_A,
      windowId: 'legacy-window-1',
      sequence: 2,
      seconds: 17,
      timestamp: '2026-10-10T08:01:00.000Z',
    })).resolves.toBe('accepted');

    expect(await usageTotal()).toBe(0);
    const statuses = await client.query(
      `SELECT window_id, settlement_status FROM telemetry_reports ORDER BY sequence`,
    );
    expect(statuses.rows).toEqual([
      { window_id: 'xray-traffic:2026-10-10T08:00Z', settlement_status: 'unmapped' },
      { window_id: 'legacy-window-1', settlement_status: 'legacy' },
    ]);
  });

  it('uses observed Premium history even when the report arrives after Premium expiry', async () => {
    await client.query(
      `INSERT INTO premium_entitlement_events (user_id, source_key, effective_at, premium_until)
       VALUES ('user-1', 'fixture:premium', '2026-10-10T07:00:00.000Z', '2026-10-10T09:00:00.000Z')`,
    );
    await expect(store.accept(masked({ timestamp: '2026-10-10T10:00:00.000Z' }))).resolves.toBe('accepted');
    expect(await usageTotal()).toBe(0);
    expect((await client.query('SELECT debit_seconds FROM usage_debit_events')).rows[0]?.debit_seconds).toBe(0);
  });

  it('assigns delayed debit to the observed Tehran day rather than arrival day', async () => {
    await client.query(
      `UPDATE usage_accounting_config
       SET active_second_epoch = '2026-10-09T00:00:00.000Z'
       WHERE id = 1`,
    );
    const report = masked({
      windowId: 'xray-traffic:2026-10-09T20:29Z',
      seconds: 1,
      activeSecondsHex: '0800000000000000',
      timestamp: '2026-10-10T01:00:00.000Z',
      observedFrom: '2026-10-09T20:29:58.000Z',
      observedTo: '2026-10-09T20:29:59.500Z',
    });
    await expect(store.accept(report)).resolves.toBe('accepted');
    expect(await usageTotal('user-1', '2026-10-09')).toBe(-1);
    expect(await usageTotal('user-1', '2026-10-10')).toBe(0);
  });

  it('preserves bit 59 through PostgreSQL bigint without JavaScript number conversion', async () => {
    await expect(store.accept(masked({
      windowId: 'xray-traffic:2026-10-10T08:01Z',
      sequence: 59,
      seconds: 1,
      activeSecondsHex: '0800000000000000',
    }))).resolves.toBe('accepted');
    const state = await client.query(
      `SELECT settled_mask::text AS mask FROM usage_active_minutes
       WHERE user_id = 'user-1' AND minute_start = '2026-10-10T08:01:00.000Z'`,
    );
    expect(state.rows[0]?.mask).toBe('576460752303423488');
    expect(await usageTotal()).toBe(-1);
  });

  it('rolls back raw telemetry and every accounting mutation when settlement fails after raw insert', async () => {
    const failingDatabase = {
      query: database.query.bind(database),
      transaction: async <T>(callback: (transaction: PgDatabase) => Promise<T>) => database.transaction(async (transaction) => {
        let rawInserted = false;
        const proxy = {
          query: async <Row extends Record<string, unknown> = Record<string, unknown>>(
            text: string,
            values?: readonly unknown[],
          ) => {
            const result = await transaction.query<Row>(text, values);
            if (/INSERT\s+INTO\s+telemetry_reports/i.test(text) && result.rows.length > 0) rawInserted = true;
            if (rawInserted && /SELECT\s+user_id\s+FROM\s+client_credentials/i.test(text)) {
              throw new Error('injected settlement failure');
            }
            return result;
          },
          transaction: transaction.transaction.bind(transaction),
        } as unknown as PgDatabase;
        return callback(proxy);
      }),
    };
    const failingStore = new PostgresUsageSettlementStore(failingDatabase);

    await expect(failingStore.accept(masked())).rejects.toThrow('injected settlement failure');
    expect((await client.query('SELECT count(*)::int AS count FROM telemetry_reports')).rows[0]?.count).toBe(0);
    expect((await client.query('SELECT count(*)::int AS count FROM usage_active_minutes')).rows[0]?.count).toBe(0);
    expect((await client.query('SELECT count(*)::int AS count FROM usage_debit_events')).rows[0]?.count).toBe(0);
    expect(await usageTotal()).toBe(0);

    await expect(store.accept(masked())).resolves.toBe('accepted');
    expect(await usageTotal()).toBe(-10);
  });
});
