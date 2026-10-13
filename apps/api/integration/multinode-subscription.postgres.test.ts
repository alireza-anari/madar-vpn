import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { createAccessService } from '../src/access';
import { PostgresAccessStore } from '../src/access/postgres';
import { PostgresSubscriptionNodeStore } from '../src/access/subscription-postgres';
import { createSubscriptionService } from '../src/access/subscription';
import { createNodeControlService, type NodeRecord } from '../src/nodes';
import { PostgresNodeControlStore } from '../src/nodes/postgres';
import { PgDatabase } from '../src/postgres/client';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error('TEST_DATABASE_URL is required for PostgreSQL integration tests.');

const client = new Client({ connectionString });
const database = new PgDatabase(client);
const accessStore = new PostgresAccessStore(database);
const subscriptionNodeStore = new PostgresSubscriptionNodeStore(database);
const nodeControlStore = new PostgresNodeControlStore(database);

let clock = new Date('2026-10-11T10:00:00.000Z');
const nodeControl = createNodeControlService({
  store: nodeControlStore,
  now: () => clock,
});

const publicConfigs = {
  'node-a': { address: 'a.example.test', port: 443, serverName: 'cdn-a.example.test', realityPublicKey: 'public-a', realityShortId: 'a1' },
  'node-b': { address: 'b.example.test', port: 443, serverName: 'cdn-b.example.test', realityPublicKey: 'public-b', realityShortId: 'b1' },
  'node-stale': { address: 'stale.example.test', port: 443, serverName: 'cdn-stale.example.test', realityPublicKey: 'public-stale', realityShortId: 'c1' },
  'node-unhealthy': { address: 'unhealthy.example.test', port: 443, serverName: 'cdn-unhealthy.example.test', realityPublicKey: 'public-unhealthy', realityShortId: 'd1' },
  'node-capacity': { address: 'capacity.example.test', port: 443, serverName: 'cdn-capacity.example.test', realityPublicKey: 'public-capacity', realityShortId: 'e1' },
  'node-unacked': { address: 'unacked.example.test', port: 443, serverName: 'cdn-unacked.example.test', realityPublicKey: 'public-unacked', realityShortId: 'f1' },
} as const;

beforeAll(async () => {
  await client.connect();
});

beforeEach(async () => {
  clock = new Date('2026-10-11T10:00:00.000Z');
  await client.query(`TRUNCATE TABLE
    node_policy_acks, node_health_samples, node_public_configs, nodes,
    subscription_tokens, client_credentials, access_profiles, users
    CASCADE`);
  await client.query(
    `INSERT INTO users (id, email, role, verified_at, suspended_at)
     VALUES ('user-1', 'multinode@example.com', 'user', '2026-10-11T00:00:00.000Z', NULL)`,
  );

  await accessStore.ensureProfile({
    id: 'profile-1',
    userId: 'user-1',
    policyRevision: 2,
    createdAt: '2026-10-11T09:00:00.000Z',
  });
  await accessStore.ensureActiveClientCredential({
    id: 'credential-1',
    userId: 'user-1',
    uuid: '11111111-2222-4333-8444-555555555555',
    version: 1,
    createdAt: '2026-10-11T09:00:00.000Z',
    revokedAt: null,
  });

  for (const [id, config] of Object.entries(publicConfigs)) {
    const node: NodeRecord = {
      id,
      name: id,
      status: 'enrolled',
      lastSeenAt: null,
      createdAt: '2026-10-11T09:00:00.000Z',
    };
    await nodeControlStore.saveNode(node);
    await nodeControlStore.savePublicConfig(id, config, '2026-10-11T09:00:00.000Z');
  }

  clock = new Date('2026-10-11T09:55:00.000Z');
  await nodeControl.heartbeatNode(
    'node-stale',
    { healthy: true, ready: true },
    { agent: '1.0.0', xray: '26.3.27' },
    { accepting: true, activeClients: 0, maxClients: 10 },
  );

  clock = new Date('2026-10-11T10:00:00.000Z');
  await nodeControl.heartbeatNode(
    'node-a',
    { healthy: true, ready: true },
    { agent: '1.0.0', xray: '26.3.27' },
    { accepting: true, activeClients: 0, maxClients: 10 },
  );
  await nodeControl.heartbeatNode(
    'node-b',
    { healthy: true, ready: true },
    { agent: '1.0.0', xray: '26.3.27' },
    { accepting: true, activeClients: 1, maxClients: 10 },
  );
  await nodeControl.heartbeatNode(
    'node-unhealthy',
    { healthy: false, ready: false },
    { agent: '1.0.0', xray: '26.3.27' },
    { accepting: true, activeClients: 0, maxClients: 10 },
  );
  await nodeControl.heartbeatNode(
    'node-capacity',
    { healthy: true, ready: true },
    { agent: '1.0.0', xray: '26.3.27' },
    { accepting: true, activeClients: 10, maxClients: 10 },
  );
  await nodeControl.heartbeatNode(
    'node-unacked',
    { healthy: true, ready: true },
    { agent: '1.0.0', xray: '26.3.27' },
    { accepting: true, activeClients: 0, maxClients: 10 },
  );

  await client.query(`INSERT INTO node_policy_revisions(node_id,revision,valid_until,policy_json,created_at,acked_at) SELECT id,1,clock_timestamp()+interval '1 hour','{"clients":[]}'::jsonb,clock_timestamp(),clock_timestamp() FROM nodes`);
  await client.query(
    `INSERT INTO node_policy_acks (node_id, user_id, revision, acked_at)
     VALUES
       ('node-a', 'user-1', 2, '2026-10-11T10:00:00.000Z'),
       ('node-b', 'user-1', 2, '2026-10-11T10:00:00.000Z'),
       ('node-stale', 'user-1', 2, '2026-10-11T09:55:00.000Z'),
       ('node-unhealthy', 'user-1', 2, '2026-10-11T10:00:00.000Z'),
       ('node-capacity', 'user-1', 2, '2026-10-11T10:00:00.000Z'),
       ('node-unacked', 'user-1', 1, '2026-10-11T10:00:00.000Z')`,
  );
});

afterAll(async () => {
  await client.end();
});

describe('multi-node subscription eligibility', () => {
  it('advertises only fresh healthy capacity-eligible ACKed nodes and gates each node independently after rotation', async () => {
    const access = createAccessService({ store: accessStore });
    const subscriptions = createSubscriptionService({
      accessStore,
      access,
      nodes: subscriptionNodeStore,
      staleAfterMs: 120_000,
    });

    const beforeRotation = await subscriptions.listEligibleNodes('user-1', clock);
    expect(beforeRotation.map((node) => node.id)).toEqual(['node-a', 'node-b']);

    const statuses = await client.query(
      `SELECT id, status FROM nodes
       WHERE id IN ('node-unhealthy', 'node-capacity')
       ORDER BY id`,
    );
    expect(statuses.rows).toEqual([
      { id: 'node-capacity', status: 'offline' },
      { id: 'node-unhealthy', status: 'error' },
    ]);

    const rotation = await accessStore.rotateClientCredential({
      id: 'credential-2',
      userId: 'user-1',
      uuid: '66666666-7777-4888-8999-aaaaaaaaaaaa',
      createdAt: '2026-10-11T10:01:00.000Z',
    });
    expect(rotation.policyRevision).toBe(3);
    await expect(subscriptions.listEligibleNodes('user-1', clock)).resolves.toEqual([]);

    await client.query(
      `UPDATE node_policy_acks SET revision = 3, acked_at = '2026-10-11T10:01:10.000Z'
       WHERE node_id = 'node-a' AND user_id = 'user-1'`,
    );
    await expect(subscriptions.listEligibleNodes('user-1', clock)).resolves.toMatchObject([
      { id: 'node-a' },
    ]);

    await client.query(
      `UPDATE node_policy_acks SET revision = 3, acked_at = '2026-10-11T10:01:20.000Z'
       WHERE node_id = 'node-b' AND user_id = 'user-1'`,
    );
    await expect(subscriptions.listEligibleNodes('user-1', clock)).resolves.toMatchObject([
      { id: 'node-a' },
      { id: 'node-b' },
    ]);
  });
});
