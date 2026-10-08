import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { createCreditService } from '../src/credits';
import { PostgresCreditStore } from '../src/credits/postgres';
import { PgDatabase } from '../src/postgres/client';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error('TEST_DATABASE_URL is required for PostgreSQL integration tests.');

const client = new Client({ connectionString });
const database = new PgDatabase(client);
const store = new PostgresCreditStore(database);
const credits = createCreditService({ store });

const BEFORE_MIDNIGHT = new Date('2026-10-08T20:29:59.000Z');
const AFTER_MIDNIGHT = new Date('2026-10-08T20:30:01.000Z');
const CURRENT_DAY = new Date('2026-10-09T08:00:00.000Z');

async function createVerifiedUser(id = 'user-1', verifiedAt = CURRENT_DAY.toISOString()) {
  await client.query(
    `INSERT INTO users (id, email, role, verified_at, suspended_at)
     VALUES ($1, $2, 'user', $3, NULL)`,
    [id, `${id}@example.com`, verifiedAt],
  );
}

async function createUsageSession(userId = 'user-1') {
  await client.query(
    `INSERT INTO usage_sessions (node_id, session_id, user_id, started_at, ended_at)
     VALUES ('node-1', 'session-1', $1, $2, NULL)`,
    [userId, CURRENT_DAY.toISOString()],
  );
}

beforeAll(async () => {
  await client.connect();
});

beforeEach(async () => {
  await client.query(`TRUNCATE TABLE
    premium_adjustments, memberships, credit_ledger, usage_sessions,
    sessions, login_tokens, users
    RESTART IDENTITY CASCADE`);
});

afterAll(async () => {
  await client.end();
});

describe('PostgresCreditStore integration', () => {
  it('awards the initial grant once and deduplicates rewarded-ad events', async () => {
    await createVerifiedUser();

    await expect(credits.getEntitlement('user-1', CURRENT_DAY)).resolves.toMatchObject({ freeSeconds: 1800 });
    await expect(credits.getEntitlement('user-1', CURRENT_DAY)).resolves.toMatchObject({ freeSeconds: 1800 });
    expect((await client.query(
      `SELECT count(*)::int AS count FROM credit_ledger
       WHERE unique_key = 'initial:user-1'`,
    )).rows[0]?.count).toBe(1);

    await expect(credits.awardAd('user-1', 'event-1', CURRENT_DAY)).resolves.toBe(true);
    await expect(credits.awardAd('user-1', 'event-1', CURRENT_DAY)).resolves.toBe(false);
    await expect(credits.getEntitlement('user-1', CURRENT_DAY)).resolves.toMatchObject({ freeSeconds: 2700 });
  });

  it('projects free credit by Tehran accounting day without resetting premium', async () => {
    await createVerifiedUser('user-1', BEFORE_MIDNIGHT.toISOString());
    await credits.adjustPremium(
      'user-1',
      'premium-before-midnight',
      '2026-11-09T00:00:00.000Z',
      BEFORE_MIDNIGHT,
    );

    await expect(credits.getEntitlement('user-1', BEFORE_MIDNIGHT)).resolves.toEqual({
      freeSeconds: 1800,
      premiumUntil: '2026-11-09T00:00:00.000Z',
      tier: 'premium',
    });
    await expect(credits.getEntitlement('user-1', AFTER_MIDNIGHT)).resolves.toEqual({
      freeSeconds: 0,
      premiumUntil: '2026-11-09T00:00:00.000Z',
      tier: 'premium',
    });
  });

  it('deduplicates usage reports and records premium usage with zero free debit', async () => {
    await createVerifiedUser();
    await createUsageSession();
    await credits.getEntitlement('user-1', CURRENT_DAY);

    await expect(credits.recordUsage('node-1', 'session-1', 1, 600, CURRENT_DAY)).resolves.toBe(true);
    await expect(credits.recordUsage('node-1', 'session-1', 1, 600, CURRENT_DAY)).resolves.toBe(false);
    await expect(credits.getEntitlement('user-1', CURRENT_DAY)).resolves.toMatchObject({ freeSeconds: 1200 });

    await credits.adjustPremium('user-1', 'premium-1', '2026-11-09T00:00:00.000Z', CURRENT_DAY);
    await expect(credits.recordUsage('node-1', 'session-1', 2, 600, CURRENT_DAY)).resolves.toBe(true);
    await expect(credits.recordUsage('node-1', 'session-1', 2, 600, CURRENT_DAY)).resolves.toBe(false);
    await expect(credits.getEntitlement('user-1', CURRENT_DAY)).resolves.toMatchObject({
      freeSeconds: 1200,
      tier: 'premium',
    });

    const premiumUsage = await client.query(
      `SELECT delta_seconds FROM credit_ledger
       WHERE unique_key = 'usage:node-1:session-1:2'`,
    );
    expect(premiumUsage.rows).toEqual([{ delta_seconds: 0 }]);
  });

  it('applies one premium adjustment once and does not let a duplicate source rewrite expiry', async () => {
    await createVerifiedUser();

    await expect(
      credits.adjustPremium('user-1', 'premium-source', '2026-11-09T00:00:00.000Z', CURRENT_DAY),
    ).resolves.toBe(true);
    await expect(
      credits.adjustPremium('user-1', 'premium-source', '2027-01-01T00:00:00.000Z', CURRENT_DAY),
    ).resolves.toBe(false);

    await expect(credits.getEntitlement('user-1', CURRENT_DAY)).resolves.toMatchObject({
      premiumUntil: '2026-11-09T00:00:00.000Z',
      tier: 'premium',
    });
    expect((await client.query(
      `SELECT count(*)::int AS count FROM premium_adjustments
       WHERE unique_key = 'premium:premium-source'`,
    )).rows[0]?.count).toBe(1);
  });

  it('prevents concurrent duplicate grants from applying twice', async () => {
    await createVerifiedUser();
    const secondClient = new Client({ connectionString });
    await secondClient.connect();
    try {
      const secondCredits = createCreditService({
        store: new PostgresCreditStore(new PgDatabase(secondClient)),
      });

      const [first, second] = await Promise.all([
        credits.awardAd('user-1', 'concurrent-event', CURRENT_DAY),
        secondCredits.awardAd('user-1', 'concurrent-event', CURRENT_DAY),
      ]);
      expect([first, second].sort()).toEqual([false, true]);
      expect((await client.query(
        `SELECT count(*)::int AS count FROM credit_ledger
         WHERE unique_key = 'ad:concurrent-event'`,
      )).rows[0]?.count).toBe(1);
    } finally {
      await secondClient.end();
    }
  });
});
