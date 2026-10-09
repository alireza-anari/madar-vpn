import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { PgDatabase } from '../src/postgres/client';
import { hashNodeSecret, type NodePolicyClient, type TelemetryReport } from '../src/nodes';
import { PostgresNodeControlStore } from '../src/nodes/postgres';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error('TEST_DATABASE_URL is required for PostgreSQL integration tests.');

const client = new Client({ connectionString });
const database = new PgDatabase(client);
const store = new PostgresNodeControlStore(database);

const node = {
  id: 'node-1',
  name: 'Germany 1',
  status: 'enrolled' as const,
  lastSeenAt: null,
  createdAt: '2026-10-09T06:00:00.000Z',
};

beforeAll(async () => {
  await client.connect();
});

beforeEach(async () => {
  await client.query(
    `TRUNCATE TABLE
       telemetry_reports,
       node_policy_acks,
       node_policy_revisions,
       node_health_samples,
       node_capabilities,
       node_credentials,
       node_enrollment_tokens,
       node_public_configs,
       nodes,
       users
     CASCADE`,
  );
  await client.query(
    `INSERT INTO users (id, email, role, verified_at, suspended_at)
     VALUES
       ('admin-1', 'admin@example.com', 'admin', '2026-10-09T00:00:00.000Z', NULL),
       ('user-1', 'user1@example.com', 'user', '2026-10-09T00:00:00.000Z', NULL),
       ('user-2', 'user2@example.com', 'user', '2026-10-09T00:00:00.000Z', NULL)`,
  );
});

afterAll(async () => {
  await client.end();
});

describe('PostgresNodeControlStore integration', () => {
  it('consumes an enrollment token exactly once even under concurrent attempts', async () => {
    await store.saveNode(node);
    await store.saveEnrollmentToken({
      id: 'enroll-1',
      nodeId: node.id,
      tokenHash: 'enrollment-hash-only',
      createdBy: 'admin-1',
      createdAt: '2026-10-09T06:01:00.000Z',
      expiresAt: '2026-10-09T06:16:00.000Z',
      usedAt: null,
    });

    const leftClient = new Client({ connectionString });
    const rightClient = new Client({ connectionString });
    await Promise.all([leftClient.connect(), rightClient.connect()]);
    const left = new PostgresNodeControlStore(new PgDatabase(leftClient));
    const right = new PostgresNodeControlStore(new PgDatabase(rightClient));

    try {
      const results = await Promise.all([
        left.consumeEnrollmentToken('enrollment-hash-only', new Date('2026-10-09T06:02:00.000Z')),
        right.consumeEnrollmentToken('enrollment-hash-only', new Date('2026-10-09T06:02:00.000Z')),
      ]);

      expect(results.filter((result) => result !== null)).toHaveLength(1);
      expect(results.filter((result) => result === null)).toHaveLength(1);
      expect(results.find((result) => result !== null)).toMatchObject({
        id: 'enroll-1',
        nodeId: 'node-1',
        tokenHash: 'enrollment-hash-only',
        usedAt: '2026-10-09T06:02:00.000Z',
      });
    } finally {
      await Promise.all([leftClient.end(), rightClient.end()]);
    }

    await store.saveEnrollmentToken({
      id: 'enroll-expired',
      nodeId: node.id,
      tokenHash: 'expired-hash-only',
      createdBy: 'admin-1',
      createdAt: '2026-10-09T06:00:00.000Z',
      expiresAt: '2026-10-09T06:01:00.000Z',
      usedAt: null,
    });
    await expect(
      store.consumeEnrollmentToken('expired-hash-only', new Date('2026-10-09T06:02:00.000Z')),
    ).resolves.toBeNull();
  });

  it('persists only credential hashes, supports explicit revocation, and round-trips node state', async () => {
    await store.saveNode(node);
    await expect(store.getNode('node-1')).resolves.toEqual(node);

    const rawCredential = 'raw-node-credential-must-not-be-stored';
    const credentialHash = await hashNodeSecret(rawCredential);
    await store.saveCredential({
      id: 'credential-1',
      nodeId: 'node-1',
      credentialHash,
      createdAt: '2026-10-09T06:02:00.000Z',
      revokedAt: null,
    });

    await expect(store.findActiveCredentialByHash(credentialHash)).resolves.toMatchObject({
      id: 'credential-1',
      nodeId: 'node-1',
      credentialHash,
      revokedAt: null,
    });
    const persisted = await client.query(
      `SELECT credential_hash, revoked_at
       FROM node_credentials
       WHERE id = 'credential-1'`,
    );
    expect(persisted.rows[0]?.credential_hash).toBe(credentialHash);
    expect(JSON.stringify(persisted.rows[0])).not.toContain(rawCredential);

    await store.revokeNodeCredentials('node-1', '2026-10-09T06:03:00.000Z');
    await expect(store.findActiveCredentialByHash(credentialHash)).resolves.toBeNull();
    const revoked = await client.query(
      `SELECT revoked_at FROM node_credentials WHERE id = 'credential-1'`,
    );
    expect(revoked.rows[0]?.revoked_at.toISOString()).toBe('2026-10-09T06:03:00.000Z');
  });

  it('persists capabilities, public configuration, and returns the latest heartbeat', async () => {
    await store.saveNode(node);
    await store.saveCapabilities(
      'node-1',
      { transport: 'vless-reality', speedPolicy: true },
      '2026-10-09T06:01:00.000Z',
    );
    await store.savePublicConfig(
      'node-1',
      {
        address: 'vpn.example.test',
        port: 443,
        serverName: 'cdn.example.test',
        realityPublicKey: 'public-key',
        realityShortId: 'a1b2c3d4',
      },
      '2026-10-09T06:01:00.000Z',
    );

    await store.saveHeartbeat({
      nodeId: 'node-1',
      health: { healthy: true, ready: false },
      versions: { agent: '1.0.0', xray: '25.10.0' },
      capacity: { accepting: false, activeClients: 2, maxClients: 100 },
      recordedAt: '2026-10-09T06:02:00.000Z',
    });
    const latest = {
      nodeId: 'node-1',
      health: { healthy: true, ready: true },
      versions: { agent: '1.0.1', xray: '25.10.0' },
      capacity: { accepting: true, activeClients: 3, maxClients: 100 },
      recordedAt: '2026-10-09T06:03:00.000Z',
    };
    await store.saveHeartbeat(latest);
    await expect(store.getLatestHeartbeat('node-1')).resolves.toEqual(latest);

    const persisted = await client.query(
      `SELECT
         (SELECT capabilities_json FROM node_capabilities WHERE node_id = 'node-1') AS capabilities,
         (SELECT jsonb_build_object(
           'address', address,
           'port', port,
           'serverName', server_name,
           'realityPublicKey', reality_public_key,
           'realityShortId', reality_short_id
         ) FROM node_public_configs WHERE node_id = 'node-1') AS public_config`,
    );
    expect(persisted.rows[0]?.capabilities).toEqual({ transport: 'vless-reality', speedPolicy: true });
    expect(persisted.rows[0]?.public_config).toEqual({
      address: 'vpn.example.test',
      port: 443,
      serverName: 'cdn.example.test',
      realityPublicKey: 'public-key',
      realityShortId: 'a1b2c3d4',
    });
  });

  it('loads revisioned policy and persists node plus per-user acknowledgements', async () => {
    await store.saveNode(node);
    const clients: NodePolicyClient[] = [
      { userId: 'user-1', policyRevision: 7, clientId: 'client-1', tier: 'free', speedKbps: 5000 },
      { userId: 'user-2', policyRevision: 2, clientId: 'client-2', tier: 'premium', speedKbps: null },
    ];
    await client.query(
      `INSERT INTO node_policy_revisions (
         node_id, revision, valid_until, policy_json, created_at, acked_at
       ) VALUES ($1, 3, $2::timestamptz, $3::jsonb, $4::timestamptz, NULL)`,
      [
        'node-1',
        '2026-10-09T06:15:00.000Z',
        JSON.stringify({ clients }),
        '2026-10-09T06:00:00.000Z',
      ],
    );

    await expect(store.getPolicy('node-1')).resolves.toEqual({
      nodeId: 'node-1',
      revision: 3,
      validUntil: '2026-10-09T06:15:00.000Z',
      clients,
    });

    await store.acknowledgePolicy('node-1', 3, '2026-10-09T06:04:00.000Z', clients);
    const revision = await client.query(
      `SELECT acked_at FROM node_policy_revisions WHERE node_id = 'node-1' AND revision = 3`,
    );
    expect(revision.rows[0]?.acked_at.toISOString()).toBe('2026-10-09T06:04:00.000Z');

    const acks = await client.query(
      `SELECT user_id, revision, acked_at
       FROM node_policy_acks
       WHERE node_id = 'node-1'
       ORDER BY user_id`,
    );
    expect(acks.rows.map((row) => ({
      userId: row.user_id,
      revision: row.revision,
      ackedAt: row.acked_at.toISOString(),
    }))).toEqual([
      { userId: 'user-1', revision: 7, ackedAt: '2026-10-09T06:04:00.000Z' },
      { userId: 'user-2', revision: 2, ackedAt: '2026-10-09T06:04:00.000Z' },
    ]);
  });

  it('deduplicates telemetry by node, window, and sequence under concurrent inserts', async () => {
    await store.saveNode(node);
    const report: TelemetryReport = {
      nodeId: 'node-1',
      clientId: 'client-1',
      windowId: 'window-1',
      sequence: 4,
      seconds: 17,
      timestamp: '2026-10-09T06:05:17.000Z',
      observedFrom: '2026-10-09T06:05:00.000Z',
      observedTo: '2026-10-09T06:05:17.000Z',
      sessionId: 'session-1',
    };

    const leftClient = new Client({ connectionString });
    const rightClient = new Client({ connectionString });
    await Promise.all([leftClient.connect(), rightClient.connect()]);
    const left = new PostgresNodeControlStore(new PgDatabase(leftClient));
    const right = new PostgresNodeControlStore(new PgDatabase(rightClient));

    try {
      const results = await Promise.all([left.insertTelemetry(report), right.insertTelemetry(report)]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(results.filter((result) => !result)).toHaveLength(1);
    } finally {
      await Promise.all([leftClient.end(), rightClient.end()]);
    }

    const persisted = await client.query(
      `SELECT count(*)::int AS report_count
       FROM telemetry_reports
       WHERE node_id = 'node-1' AND window_id = 'window-1' AND sequence = 4`,
    );
    expect(persisted.rows[0]?.report_count).toBe(1);
  });
});
