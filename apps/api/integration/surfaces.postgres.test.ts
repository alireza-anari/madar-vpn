import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { PgDatabase } from '../src/postgres/client';
import { PostgresSurfaceStore } from '../src/surfaces/postgres';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error('TEST_DATABASE_URL is required for PostgreSQL integration tests.');

const client = new Client({ connectionString });
const database = new PgDatabase(client);
const store = new PostgresSurfaceStore(database);

beforeAll(async () => {
  await client.connect();
});

beforeEach(async () => {
  await client.query(
    'TRUNCATE TABLE audit_log, notification_drafts, missions, plans, nodes, usage_sessions, app_settings, users CASCADE',
  );
  await client.query(
    `INSERT INTO users (id, email, role, verified_at, suspended_at)
     VALUES
       ('admin-1', 'admin@example.com', 'admin', '2026-10-09T00:02:00.000Z', NULL),
       ('user-1', 'user1@example.com', 'user', '2026-10-09T00:01:00.000Z', NULL)`,
  );
  await client.query(
    `INSERT INTO app_settings (id, free_speed_kbps, notifications_enabled, updated_at)
     VALUES (1, 5000, false, '2026-10-09T00:00:00.000Z')`,
  );
});

afterAll(async () => {
  await client.end();
});

describe('PostgresSurfaceStore integration', () => {
  it('persists settings and reports authoritative counts and node state', async () => {
    await expect(store.getSettings()).resolves.toEqual({
      freeSpeedKbps: 5000,
      notificationsEnabled: false,
    });
    await store.saveSettings({ freeSpeedKbps: 7500, notificationsEnabled: true });
    await expect(store.getSettings()).resolves.toEqual({
      freeSpeedKbps: 7500,
      notificationsEnabled: true,
    });

    await store.savePlan({
      id: 'plan-1',
      title: 'ماهانه',
      durationDays: 30,
      priceMinor: 125000,
      currency: 'IRR',
      enabled: true,
      createdAt: '2026-10-09T01:00:00.000Z',
      updatedAt: '2026-10-09T01:00:00.000Z',
    });
    await store.saveMission({
      id: 'mission-1',
      title: 'ماموریت',
      description: 'Fixture mission',
      rewardSeconds: 900,
      status: 'active',
      verificationKind: 'evidence',
      createdAt: '2026-10-09T01:00:00.000Z',
      updatedAt: '2026-10-09T01:00:00.000Z',
    });
    await store.saveNode({
      id: 'node-ready',
      name: 'Germany 1',
      status: 'ready',
      lastSeenAt: '2026-10-09T01:05:00.000Z',
      createdAt: '2026-10-09T01:00:00.000Z',
    });
    await client.query(
      `INSERT INTO usage_sessions (node_id, session_id, user_id, started_at, ended_at)
       VALUES ('node-ready', 'session-1', 'user-1', '2026-10-09T01:06:00.000Z', NULL)`,
    );

    await expect(store.getCounts()).resolves.toEqual({ users: 2, readyNodes: 1, plans: 1, missions: 1 });
    await expect(store.getNodeState('user-1')).resolves.toEqual({
      ready: true,
      connectionStatus: 'connected',
      configAvailable: false,
    });
    await expect(store.listUsers()).resolves.toEqual([
      { id: 'admin-1', email: 'admin@example.com', role: 'admin' },
      { id: 'user-1', email: 'user1@example.com', role: 'user' },
    ]);
  });

  it('upserts admin resources while preserving immutable creation metadata', async () => {
    const firstPlan = {
      id: 'plan-1',
      title: 'First plan',
      durationDays: 30,
      priceMinor: 100,
      currency: 'IRR',
      enabled: true,
      createdAt: '2026-10-09T01:00:00.000Z',
      updatedAt: '2026-10-09T01:00:00.000Z',
    };
    await store.savePlan(firstPlan);
    await store.savePlan({
      ...firstPlan,
      title: 'Updated plan',
      priceMinor: 200,
      createdAt: '2026-10-09T02:00:00.000Z',
      updatedAt: '2026-10-09T02:00:00.000Z',
    });
    await expect(store.listPlans()).resolves.toEqual([
      {
        ...firstPlan,
        title: 'Updated plan',
        priceMinor: 200,
        updatedAt: '2026-10-09T02:00:00.000Z',
      },
    ]);

    const firstMission = {
      id: 'mission-1',
      title: 'First mission',
      description: 'First description',
      rewardSeconds: 300,
      status: 'draft' as const,
      verificationKind: 'evidence' as const,
      createdAt: '2026-10-09T01:00:00.000Z',
      updatedAt: '2026-10-09T01:00:00.000Z',
    };
    await store.saveMission(firstMission);
    await store.saveMission({
      ...firstMission,
      title: 'Updated mission',
      status: 'active',
      createdAt: '2026-10-09T02:00:00.000Z',
      updatedAt: '2026-10-09T02:00:00.000Z',
    });
    await expect(store.listMissions()).resolves.toEqual([
      {
        ...firstMission,
        title: 'Updated mission',
        status: 'active',
        updatedAt: '2026-10-09T02:00:00.000Z',
      },
    ]);

    await store.saveNode({
      id: 'node-1',
      name: 'Node 1',
      status: 'enrolled',
      lastSeenAt: null,
      createdAt: '2026-10-09T01:00:00.000Z',
    });
    await store.saveNode({
      id: 'node-1',
      name: 'Node 1 updated',
      status: 'ready',
      lastSeenAt: '2026-10-09T02:00:00.000Z',
      createdAt: '2026-10-09T02:00:00.000Z',
    });
    await expect(store.listNodes()).resolves.toEqual([
      {
        id: 'node-1',
        name: 'Node 1 updated',
        status: 'ready',
        lastSeenAt: '2026-10-09T02:00:00.000Z',
        createdAt: '2026-10-09T01:00:00.000Z',
      },
    ]);

    await store.saveNotificationDraft({
      id: 'draft-1',
      title: 'First title',
      body: 'First body',
      target: 'all',
      createdBy: 'admin-1',
      createdAt: '2026-10-09T01:00:00.000Z',
      deliveryStatus: 'draft',
    });
    await store.saveNotificationDraft({
      id: 'draft-1',
      title: 'Updated title',
      body: 'Updated body',
      target: 'premium',
      createdBy: 'user-1',
      createdAt: '2026-10-09T02:00:00.000Z',
      deliveryStatus: 'draft',
    });
    await expect(store.listNotificationDrafts()).resolves.toEqual([
      {
        id: 'draft-1',
        title: 'Updated title',
        body: 'Updated body',
        target: 'premium',
        createdBy: 'admin-1',
        createdAt: '2026-10-09T01:00:00.000Z',
        deliveryStatus: 'draft',
      },
    ]);

    await store.deletePlan('plan-1');
    await store.deleteMission('mission-1');
    await store.deleteNode('node-1');
    await store.deleteNotificationDraft('draft-1');
    await expect(store.listPlans()).resolves.toEqual([]);
    await expect(store.listMissions()).resolves.toEqual([]);
    await expect(store.listNodes()).resolves.toEqual([]);
    await expect(store.listNotificationDrafts()).resolves.toEqual([]);
  });

  it('keeps audit entries append-only and round-trips structured safe metadata', async () => {
    const entry = {
      id: 'audit-1',
      actorUserId: 'admin-1',
      action: 'plan.upsert',
      details: { id: 'plan-1', enabled: true },
      createdAt: '2026-10-09T03:00:00.000Z',
    };

    await store.appendAudit(entry);
    await expect(store.listAudit()).resolves.toEqual([entry]);

    await expect(
      store.appendAudit({
        ...entry,
        details: { id: 'plan-1', enabled: false, overwritten: true },
        createdAt: '2026-10-09T04:00:00.000Z',
      }),
    ).rejects.toThrow();

    await expect(store.listAudit()).resolves.toEqual([entry]);
  });
});
