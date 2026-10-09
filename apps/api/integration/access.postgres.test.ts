import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { PgDatabase } from '../src/postgres/client';
import { createAccessService } from '../src/access';
import { PostgresAccessStore } from '../src/access/postgres';
import { PostgresSubscriptionNodeStore } from '../src/access/subscription-postgres';
import { createSubscriptionService } from '../src/access/subscription';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error('TEST_DATABASE_URL is required for PostgreSQL integration tests.');

const client = new Client({ connectionString });
const database = new PgDatabase(client);
const accessStore = new PostgresAccessStore(database);
const nodeStore = new PostgresSubscriptionNodeStore(database);

beforeAll(async () => {
  await client.connect();
});

beforeEach(async () => {
  await client.query(
    'TRUNCATE TABLE node_policy_acks, node_public_configs, nodes, subscription_tokens, client_credentials, access_profiles, users CASCADE',
  );
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

describe('PostgresAccessStore integration', () => {
  it('keeps one stable access profile and one active client credential per user', async () => {
    const firstProfile = await accessStore.ensureProfile({
      id: 'profile-1',
      userId: 'user-1',
      policyRevision: 1,
      createdAt: '2026-10-09T00:01:00.000Z',
    });
    const repeatedProfile = await accessStore.ensureProfile({
      id: 'profile-ignored',
      userId: 'user-1',
      policyRevision: 1,
      createdAt: '2026-10-09T00:02:00.000Z',
    });

    expect(repeatedProfile).toEqual(firstProfile);

    const firstCredential = await accessStore.ensureActiveClientCredential({
      id: 'credential-1',
      userId: 'user-1',
      uuid: '00000000-0000-4000-8000-000000000001',
      version: 1,
      createdAt: '2026-10-09T00:01:00.000Z',
      revokedAt: null,
    });
    const repeatedCredential = await accessStore.ensureActiveClientCredential({
      id: 'credential-ignored',
      userId: 'user-1',
      uuid: '00000000-0000-4000-8000-000000000002',
      version: 1,
      createdAt: '2026-10-09T00:02:00.000Z',
      revokedAt: null,
    });

    expect(repeatedCredential).toEqual(firstCredential);
    await expect(accessStore.getProfile('user-1')).resolves.toEqual(firstProfile);
    await expect(accessStore.getActiveClientCredential('user-1')).resolves.toEqual(firstCredential);

    const persisted = await client.query(
      `SELECT
         (SELECT count(*)::int FROM access_profiles WHERE user_id = 'user-1') AS profile_count,
         (SELECT count(*)::int FROM client_credentials WHERE user_id = 'user-1' AND revoked_at IS NULL) AS active_credential_count`,
    );
    expect(persisted.rows[0]).toEqual({ profile_count: 1, active_credential_count: 1 });
  });

  it('rotates subscription bearer hashes immediately and advances the version', async () => {
    const first = await accessStore.issueSubscriptionToken({
      id: 'subscription-1',
      userId: 'user-1',
      tokenHash: 'hash-1',
      createdAt: '2026-10-09T00:01:00.000Z',
    });
    const second = await accessStore.issueSubscriptionToken({
      id: 'subscription-2',
      userId: 'user-1',
      tokenHash: 'hash-2',
      createdAt: '2026-10-09T00:02:00.000Z',
    });

    expect(first).toMatchObject({ version: 1, revokedAt: null });
    expect(second).toMatchObject({ version: 2, revokedAt: null });
    await expect(accessStore.findActiveSubscriptionTokenByHash('hash-1')).resolves.toBeNull();
    await expect(accessStore.findActiveSubscriptionTokenByHash('hash-2')).resolves.toMatchObject({
      id: 'subscription-2',
      userId: 'user-1',
      version: 2,
    });
    await expect(accessStore.getActiveSubscriptionToken('user-1')).resolves.toMatchObject({
      tokenHash: 'hash-2',
      version: 2,
    });

    const rows = await client.query(
      `SELECT id, version, revoked_at
       FROM subscription_tokens
       WHERE user_id = 'user-1'
       ORDER BY version`,
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0]?.revoked_at).not.toBeNull();
    expect(rows.rows[1]?.revoked_at).toBeNull();
  });

  it('rotates the client credential atomically and withholds nodes until the new policy revision is acknowledged', async () => {
    await accessStore.ensureProfile({
      id: 'profile-1',
      userId: 'user-1',
      policyRevision: 1,
      createdAt: '2026-10-09T00:01:00.000Z',
    });
    await accessStore.ensureActiveClientCredential({
      id: 'credential-1',
      userId: 'user-1',
      uuid: '00000000-0000-4000-8000-000000000001',
      version: 1,
      createdAt: '2026-10-09T00:01:00.000Z',
      revokedAt: null,
    });
    await client.query(
      `INSERT INTO nodes (id, name, status, last_seen_at, created_at)
       VALUES ('node-ready', 'Germany 1', 'ready', '2026-10-09T00:05:00.000Z', '2026-10-09T00:00:00.000Z')`,
    );
    await client.query(
      `INSERT INTO node_public_configs (
         node_id, address, port, server_name, reality_public_key, reality_short_id, updated_at
       ) VALUES (
         'node-ready', 'vpn.example.com', 443, 'cdn.example.com', 'public-key', 'a1b2c3d4', '2026-10-09T00:05:00.000Z'
       )`,
    );
    await client.query(
      `INSERT INTO node_policy_acks (node_id, user_id, revision, acked_at)
       VALUES ('node-ready', 'user-1', 1, '2026-10-09T00:05:00.000Z')`,
    );

    const access = createAccessService({ store: accessStore });
    const subscriptions = createSubscriptionService({ accessStore, access, nodes: nodeStore });
    await expect(subscriptions.listEligibleNodes('user-1', new Date('2026-10-09T00:05:30.000Z'))).resolves.toHaveLength(1);

    const rotation = await accessStore.rotateClientCredential({
      id: 'credential-2',
      userId: 'user-1',
      uuid: '00000000-0000-4000-8000-000000000002',
      createdAt: '2026-10-09T00:06:00.000Z',
    });

    expect(rotation).toMatchObject({
      policyRevision: 2,
      credential: {
        id: 'credential-2',
        userId: 'user-1',
        uuid: '00000000-0000-4000-8000-000000000002',
        version: 2,
        revokedAt: null,
      },
    });
    await expect(accessStore.getActiveClientCredential('user-1')).resolves.toMatchObject({ id: 'credential-2' });
    const oldCredential = await client.query(
      `SELECT revoked_at FROM client_credentials WHERE id = 'credential-1'`,
    );
    expect(oldCredential.rows[0]?.revoked_at).not.toBeNull();
    await expect(subscriptions.listEligibleNodes('user-1', new Date('2026-10-09T00:06:30.000Z'))).resolves.toEqual([]);

    await client.query(
      `UPDATE node_policy_acks
       SET revision = 2, acked_at = '2026-10-09T00:06:45.000Z'
       WHERE node_id = 'node-ready' AND user_id = 'user-1'`,
    );
    await expect(subscriptions.listEligibleNodes('user-1', new Date('2026-10-09T00:07:00.000Z'))).resolves.toHaveLength(1);
  });
});

describe('PostgresSubscriptionNodeStore integration', () => {
  it('returns public node configuration and the selected user policy acknowledgement only', async () => {
    await client.query(
      `INSERT INTO nodes (id, name, status, last_seen_at, created_at)
       VALUES
         ('node-ready', 'Germany 1', 'ready', '2026-10-09T00:05:00.000Z', '2026-10-09T00:00:00.000Z'),
         ('node-offline', 'Germany 2', 'offline', NULL, '2026-10-09T00:01:00.000Z')`,
    );
    await client.query(
      `INSERT INTO node_public_configs (
         node_id, address, port, server_name, reality_public_key, reality_short_id, updated_at
       ) VALUES (
         'node-ready', 'vpn.example.com', 443, 'cdn.example.com', 'public-key', 'a1b2c3d4', '2026-10-09T00:05:00.000Z'
       )`,
    );
    await client.query(
      `INSERT INTO node_policy_acks (node_id, user_id, revision, acked_at)
       VALUES ('node-ready', 'user-1', 7, '2026-10-09T00:05:00.000Z')`,
    );

    const candidates = await nodeStore.listCandidates('user-1');

    expect(candidates).toEqual([
      {
        id: 'node-ready',
        name: 'Germany 1',
        status: 'ready',
        lastSeenAt: '2026-10-09T00:05:00.000Z',
        ackedRevision: 7,
        publicConfig: {
          address: 'vpn.example.com',
          port: 443,
          serverName: 'cdn.example.com',
          realityPublicKey: 'public-key',
          realityShortId: 'a1b2c3d4',
        },
      },
      {
        id: 'node-offline',
        name: 'Germany 2',
        status: 'offline',
        lastSeenAt: null,
        ackedRevision: null,
        publicConfig: null,
      },
    ]);
    expect(JSON.stringify(candidates)).not.toContain('private');
    expect(JSON.stringify(candidates)).not.toContain('credential');
  });
});
