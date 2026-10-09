import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { PgDatabase } from '../src/postgres/client';
import { createMissionService, type MissionSubmission } from '../src/missions';
import { PostgresMissionStore } from '../src/missions/postgres';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error('TEST_DATABASE_URL is required for PostgreSQL integration tests.');

const client = new Client({ connectionString });
const database = new PgDatabase(client);
const store = new PostgresMissionStore(database);

const pendingSubmission: MissionSubmission = {
  id: 'submission-1',
  userId: 'user-1',
  missionId: 'mission-1',
  evidence: { kind: 'text', value: 'proof' },
  status: 'pending',
  submittedAt: '2026-10-09T11:00:00.000Z',
  reviewedAt: null,
  reviewedBy: null,
  rejectionReason: null,
};

beforeAll(async () => {
  await client.connect();
});

beforeEach(async () => {
  await client.query('TRUNCATE TABLE mission_submissions, verified_referrals, missions, credit_ledger, users CASCADE');
  await client.query(
    `INSERT INTO users (id, email, role, verified_at, suspended_at)
     VALUES
       ('user-1', 'user1@example.com', 'user', '2026-10-09T00:00:00.000Z', NULL),
       ('admin-1', 'admin@example.com', 'admin', '2026-10-09T00:00:00.000Z', NULL)`,
  );
  await client.query(
    `INSERT INTO missions (
       id, title, description, reward_seconds, status, verification_kind, created_at, updated_at
     ) VALUES (
       'mission-1', 'Mission 1', 'Fixture mission', 900, 'active', 'evidence',
       '2026-10-09T00:00:00.000Z', '2026-10-09T00:00:00.000Z'
     )`,
  );
});

afterAll(async () => {
  await client.end();
});

describe('PostgresMissionStore integration', () => {
  it('round-trips mission definitions and JSON evidence submissions', async () => {
    await expect(store.getMission('mission-1')).resolves.toEqual({
      id: 'mission-1',
      title: 'Mission 1',
      rewardSeconds: 900,
      status: 'active',
      verificationKind: 'evidence',
    });

    await store.saveSubmission(pendingSubmission);
    await expect(store.getSubmission('submission-1')).resolves.toEqual(pendingSubmission);
    await expect(store.listUserSubmissions('user-1')).resolves.toEqual([pendingSubmission]);
  });

  it('allows concurrent approval attempts but applies the mission reward exactly once', async () => {
    await store.saveSubmission(pendingSubmission);

    const leftClient = new Client({ connectionString });
    const rightClient = new Client({ connectionString });
    await Promise.all([leftClient.connect(), rightClient.connect()]);

    const leftService = createMissionService({
      store: new PostgresMissionStore(new PgDatabase(leftClient)),
      now: () => new Date('2026-10-09T12:00:00.000Z'),
    });
    const rightService = createMissionService({
      store: new PostgresMissionStore(new PgDatabase(rightClient)),
      now: () => new Date('2026-10-09T12:00:00.000Z'),
    });

    try {
      const results = await Promise.all([
        leftService.reviewSubmission('admin-1', 'submission-1', { decision: 'approve' }),
        rightService.reviewSubmission('admin-1', 'submission-1', { decision: 'approve' }),
      ]);

      expect(results.filter((result) => result.rewardApplied)).toHaveLength(1);
      expect(results.filter((result) => !result.rewardApplied)).toHaveLength(1);
      expect(results.every((result) => result.status === 'approved' && result.rewardSeconds === 900)).toBe(true);

      const persisted = await client.query(
        `SELECT
           (SELECT status FROM mission_submissions WHERE id = 'submission-1') AS status,
           (SELECT count(*)::int FROM credit_ledger WHERE unique_key = 'mission:submission-1') AS reward_count,
           (SELECT COALESCE(sum(delta_seconds), 0)::int FROM credit_ledger WHERE unique_key = 'mission:submission-1') AS reward_total`,
      );
      expect(persisted.rows[0]).toEqual({ status: 'approved', reward_count: 1, reward_total: 900 });
    } finally {
      await Promise.all([leftClient.end(), rightClient.end()]);
    }
  });
});
