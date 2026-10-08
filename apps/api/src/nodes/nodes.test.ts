import { describe, expect, it } from 'vitest';
import {
  MemoryNodeControlStore,
  NodeControlError,
  createNodeControlService,
  hashNodeSecret,
} from './index';

const publicConfig = {
  address: '203.0.113.10',
  port: 443,
  serverName: 'edge.example.test',
  realityPublicKey: 'public-reality-key',
  realityShortId: 'a1b2c3d4',
};

function idSequence() {
  let value = 0;
  return () => `id-${++value}`;
}

function secretSequence(...values: string[]) {
  let index = 0;
  return () => values[index++] ?? `secret-${index}`;
}

describe('node control plane', () => {
  it('issues a short-lived one-time enrollment token and rejects replay or expiry', async () => {
    const store = new MemoryNodeControlStore();
    let current = new Date('2026-10-08T12:00:00.000Z');
    const service = createNodeControlService({
      store,
      now: () => current,
      randomId: idSequence(),
      randomSecret: secretSequence('enroll-token-1', 'node-credential-1', 'expired-token'),
      enrollmentTtlMs: 15 * 60_000,
    });

    const issued = await service.createEnrollmentToken('admin-1', { name: 'London edge' }, current);
    expect(issued.rawToken).toBe('enroll-token-1');
    expect(issued.expiresAt).toBe('2026-10-08T12:15:00.000Z');
    expect(store.enrollmentTokens).toHaveLength(1);
    expect(store.enrollmentTokens[0]).toMatchObject({
      nodeId: issued.node.id,
      tokenHash: await hashNodeSecret('enroll-token-1'),
      usedAt: null,
    });
    expect(JSON.stringify(store.enrollmentTokens)).not.toContain('enroll-token-1');

    const enrolled = await service.enrollNode('enroll-token-1', { agent: '1.0.0', xray: 'pending' }, publicConfig);
    expect(enrolled.node.id).toBe(issued.node.id);
    expect(enrolled.rawCredential).toBe('node-credential-1');

    await expect(service.enrollNode('enroll-token-1', {}, publicConfig)).rejects.toMatchObject({
      status: 401,
      code: 'NODE_ENROLLMENT_TOKEN_INVALID',
    });

    const expiring = await service.createEnrollmentToken('admin-1', { name: 'Expired edge' }, current);
    expect(expiring.rawToken).toBe('expired-token');
    current = new Date('2026-10-08T12:16:00.001Z');
    await expect(service.enrollNode('expired-token', {}, publicConfig)).rejects.toMatchObject({
      status: 401,
      code: 'NODE_ENROLLMENT_TOKEN_INVALID',
    });
  });

  it('stores node credentials hash-only and authenticates to a safe principal', async () => {
    const store = new MemoryNodeControlStore();
    const now = new Date('2026-10-08T12:00:00.000Z');
    const service = createNodeControlService({
      store,
      now: () => now,
      randomId: idSequence(),
      randomSecret: secretSequence('enroll-token', 'node-credential'),
    });

    const issued = await service.createEnrollmentToken('admin-1', { name: 'Hash-only edge' }, now);
    const enrolled = await service.enrollNode(issued.rawToken, { agent: '1.0.0' }, {
      ...publicConfig,
      realityPrivateKey: 'must-never-leave-the-vps',
      credential: 'must-not-be-stored',
    });

    expect(store.credentials).toHaveLength(1);
    expect(store.credentials[0]?.credentialHash).toBe(await hashNodeSecret(enrolled.rawCredential));
    expect(JSON.stringify(store.credentials)).not.toContain(enrolled.rawCredential);
    expect(JSON.stringify(store.publicConfigs)).not.toContain('must-never-leave-the-vps');
    expect(JSON.stringify(store.publicConfigs)).not.toContain('must-not-be-stored');

    await expect(service.authenticateNode(enrolled.rawCredential)).resolves.toEqual({ nodeId: issued.node.id });
    await expect(service.authenticateNode('wrong-credential')).rejects.toBeInstanceOf(NodeControlError);
    await expect(service.authenticateNode('wrong-credential')).rejects.toMatchObject({
      status: 401,
      code: 'NODE_CREDENTIAL_INVALID',
    });
  });

  it('retires a node by revoking its active credentials and marking it offline', async () => {
    const store = new MemoryNodeControlStore();
    const now = new Date('2026-10-08T12:00:00.000Z');
    const service = createNodeControlService({
      store,
      now: () => now,
      randomId: idSequence(),
      randomSecret: secretSequence('enroll-token', 'node-credential'),
    });

    const issued = await service.createEnrollmentToken('admin-1', { name: 'Retiring edge' }, now);
    const enrolled = await service.enrollNode(issued.rawToken, {}, publicConfig);
    await service.heartbeatNode(
      issued.node.id,
      { healthy: true, ready: true },
      { agent: '1.0.0', xray: '25.10.0' },
      { accepting: true, activeClients: 0, maxClients: 100 },
    );
    await expect(service.authenticateNode(enrolled.rawCredential)).resolves.toEqual({ nodeId: issued.node.id });

    await expect(service.retireNode(issued.node.id)).resolves.toEqual({
      nodeId: issued.node.id,
      status: 'offline',
    });

    expect(store.nodes.find((node) => node.id === issued.node.id)?.status).toBe('offline');
    expect(store.credentials[0]?.revokedAt).toBe(now.toISOString());
    await expect(service.authenticateNode(enrolled.rawCredential)).rejects.toMatchObject({
      status: 401,
      code: 'NODE_CREDENTIAL_INVALID',
    });
  });

  it('reports healthy capacity as ready only while the heartbeat is fresh', async () => {
    const store = new MemoryNodeControlStore();
    let current = new Date('2026-10-08T12:00:00.000Z');
    const service = createNodeControlService({
      store,
      now: () => current,
      randomId: idSequence(),
      randomSecret: secretSequence('enroll-token', 'node-credential'),
      staleAfterMs: 120_000,
    });

    const issued = await service.createEnrollmentToken('admin-1', { name: 'Heartbeat edge' }, current);
    await service.enrollNode(issued.rawToken, {}, publicConfig);
    await service.heartbeatNode(
      issued.node.id,
      { healthy: true, ready: true },
      { agent: '1.0.0', xray: '25.10.0' },
      { accepting: true, activeClients: 2, maxClients: 100 },
    );

    await expect(service.getNodeReadiness(issued.node.id, current)).resolves.toEqual({
      ready: true,
      reason: 'ready',
    });

    current = new Date('2026-10-08T12:02:00.001Z');
    await expect(service.getNodeReadiness(issued.node.id, current)).resolves.toEqual({
      ready: false,
      reason: 'stale',
    });
  });

  it('returns only newer time-limited policy and records node plus per-user ACK revisions', async () => {
    const store = new MemoryNodeControlStore();
    const now = new Date('2026-10-08T12:00:00.000Z');
    store.seedPolicy({
      nodeId: 'node-1',
      revision: 3,
      validUntil: '2026-10-08T12:05:00.000Z',
      clients: [
        { userId: 'user-1', policyRevision: 7, clientId: 'client-1', tier: 'free', speedKbps: 256 },
        { userId: 'user-2', policyRevision: 2, clientId: 'client-2', tier: 'premium', speedKbps: null },
      ],
    });
    const service = createNodeControlService({ store, now: () => now });

    await expect(service.getNodePolicy('node-1', 3)).resolves.toBeNull();
    await expect(service.getNodePolicy('node-1', 2)).resolves.toMatchObject({ revision: 3 });
    await expect(service.ackNodePolicy('node-1', 3)).resolves.toEqual({ acknowledged: true, revision: 3 });

    expect(store.policyRevisionAcks).toEqual([
      expect.objectContaining({ nodeId: 'node-1', revision: 3 }),
    ]);
    expect(store.userPolicyAcks).toEqual([
      { nodeId: 'node-1', userId: 'user-1', revision: 7, ackedAt: now.toISOString() },
      { nodeId: 'node-1', userId: 'user-2', revision: 2, ackedAt: now.toISOString() },
    ]);
  });

  it('deduplicates telemetry by node/window/sequence and drops unapproved secret fields', async () => {
    const store = new MemoryNodeControlStore();
    const service = createNodeControlService({ store });
    const report = {
      clientId: 'client-1',
      windowId: 'window-2026-10-08T12:00Z',
      sequence: 4,
      seconds: 17,
      timestamp: '2026-10-08T12:00:17.000Z',
      observedFrom: '2026-10-08T12:00:00.000Z',
      observedTo: '2026-10-08T12:00:17.000Z',
      sessionId: 'session-1',
      credential: 'raw-node-secret',
      privateKey: 'raw-reality-private-key',
    };

    await expect(service.postTelemetry('node-1', [report])).resolves.toEqual({ accepted: 1, duplicates: 0 });
    await expect(service.postTelemetry('node-1', [report])).resolves.toEqual({ accepted: 0, duplicates: 1 });
    expect(store.telemetryReports).toHaveLength(1);
    expect(JSON.stringify(store.telemetryReports)).not.toContain('raw-node-secret');
    expect(JSON.stringify(store.telemetryReports)).not.toContain('raw-reality-private-key');
  });
});
