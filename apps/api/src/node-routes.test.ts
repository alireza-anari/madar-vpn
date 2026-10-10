import { describe, expect, it } from 'vitest';
import { createAuthService, MemoryAuthStore } from './auth';
import { createApiApp } from './index';
import { MemoryNodeControlStore, createNodeControlService } from './nodes';

function mutationHeaders(token: string, csrfToken: string) {
  return {
    'content-type': 'application/json',
    cookie: `__Host-madar_session=${token}`,
    'x-csrf-token': csrfToken,
  };
}

function bearer(token: string) {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

describe('node control HTTP boundary', () => {
  it('uses admin+CSRF for enrollment issuance and node bearer auth for heartbeat, policy, and telemetry', async () => {
    const sent: string[] = [];
    let authToken = 0;
    const auth = createAuthService({
      store: new MemoryAuthStore(),
      adminEmails: ['admin@example.com'],
      randomToken: () => `node-route-auth-${++authToken}`,
      sender: async ({ token }) => { sent.push(token); },
    });
    await auth.requestLogin('admin@example.com');
    const session = await auth.consumeLoginToken(sent[0]!);

    const store = new MemoryNodeControlStore();
    let id = 0;
    let secret = 0;
    const nodes = createNodeControlService({
      store,
      now: () => new Date('2026-10-08T12:30:00.000Z'),
      randomId: () => `node-route-${++id}`,
      randomSecret: () => `node-route-secret-${++secret}`,
    });
    const createWithNodes = createApiApp as unknown as (...args: unknown[]) => ReturnType<typeof createApiApp>;
    const app = createWithNodes(
      () => auth,
      () => null,
      () => null,
      () => null,
      () => null,
      () => null,
      () => null,
      () => nodes,
    );

    const issuedResponse = await app.request('/api/admin/nodes/enrollment-token', {
      method: 'POST',
      headers: mutationHeaders(session.token, session.csrfToken),
      body: JSON.stringify({ name: 'London edge' }),
    });
    expect(issuedResponse.status).toBe(201);
    expect(issuedResponse.headers.get('cache-control')).toBe('no-store');
    const issued = await issuedResponse.json() as { node: { id: string }; rawToken: string };
    expect(issued.rawToken).toBe('node-route-secret-1');

    const anonymousHeartbeat = await app.request('/api/node/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        health: { healthy: true, ready: true },
        versions: { agent: '1.0.0', xray: '25.10.0' },
        capacity: { accepting: false, activeClients: 0, maxClients: 100 },
      }),
    });
    expect(anonymousHeartbeat.status).toBe(401);

    const enrollResponse = await app.request('/api/node/enroll', {
      method: 'POST',
      headers: bearer(issued.rawToken),
      body: JSON.stringify({
        capabilities: { agent: '1.0.0', xray: 'pending' },
        publicConfig: {
          address: '203.0.113.10',
          port: 443,
          serverName: 'edge.example.test',
          realityPublicKey: 'public-reality-key',
          realityShortId: 'a1b2c3d4',
          realityPrivateKey: 'never-return-this',
        },
      }),
    });
    expect(enrollResponse.status).toBe(201);
    expect(enrollResponse.headers.get('cache-control')).toBe('no-store');
    const enrolledText = await enrollResponse.text();
    expect(enrolledText).not.toContain('never-return-this');
    const enrolled = JSON.parse(enrolledText) as { rawCredential: string };
    expect(enrolled.rawCredential).toBe('node-route-secret-2');

    const heartbeat = await app.request('/api/node/heartbeat', {
      method: 'POST',
      headers: bearer(enrolled.rawCredential),
      body: JSON.stringify({
        nodeId: 'attacker-selected-node',
        health: { healthy: true, ready: true },
        versions: { agent: '1.0.0', xray: '25.10.0' },
        capacity: { accepting: true, activeClients: 1, maxClients: 100 },
      }),
    });
    expect(heartbeat.status).toBe(200);
    await expect(heartbeat.json()).resolves.toMatchObject({ id: issued.node.id, status: 'ready' });

    store.seedPolicy({
      nodeId: issued.node.id,
      revision: 4,
      validUntil: '2026-10-08T12:35:00.000Z',
      clients: [{ userId: 'user-1', policyRevision: 2, clientId: 'client-1', tier: 'free', speedKbps: 256 }],
    });
    const policy = await app.request('/api/node/policy?knownRevision=0', {
      headers: { authorization: `Bearer ${enrolled.rawCredential}` },
    });
    expect(policy.status).toBe(200);
    await expect(policy.json()).resolves.toMatchObject({ revision: 4 });

    const ack = await app.request('/api/node/policy/ack', {
      method: 'POST',
      headers: bearer(enrolled.rawCredential),
      body: JSON.stringify({ revision: 4 }),
    });
    expect(ack.status).toBe(200);
    expect(store.userPolicyAcks).toEqual([
      expect.objectContaining({ nodeId: issued.node.id, userId: 'user-1', revision: 2 }),
    ]);

    const report = {
      clientId: 'client-1',
      windowId: 'window-1',
      sequence: 1,
      seconds: 12,
      timestamp: '2026-10-08T12:30:12.000Z',
      credential: 'never-store-this',
    };
    const telemetry = await app.request('/api/node/telemetry', {
      method: 'POST',
      headers: bearer(enrolled.rawCredential),
      body: JSON.stringify({ reports: [report] }),
    });
    expect(telemetry.status).toBe(200);
    await expect(telemetry.json()).resolves.toEqual({ accepted: 1, duplicates: 0 });

    const replay = await app.request('/api/node/telemetry', {
      method: 'POST',
      headers: bearer(enrolled.rawCredential),
      body: JSON.stringify({ reports: [report] }),
    });
    await expect(replay.json()).resolves.toEqual({ accepted: 0, duplicates: 1 });

    const masked = {
      clientId: 'client-1',
      windowId: 'xray-traffic:2026-10-08T12:31Z',
      sequence: 2,
      seconds: 2,
      timestamp: '2026-10-08T12:31:02.000Z',
      activeSecondsHex: '0000000000000003',
    };
    const maskedResponse = await app.request('/api/node/telemetry', {
      method: 'POST',
      headers: bearer(enrolled.rawCredential),
      body: JSON.stringify({ reports: [masked] }),
    });
    expect(maskedResponse.status).toBe(200);
    await expect(maskedResponse.json()).resolves.toEqual({ accepted: 1, duplicates: 0 });
    expect(store.telemetryReports.at(-1)).toMatchObject({
      windowId: masked.windowId,
      seconds: 2,
      activeSecondsHex: '0000000000000003',
    });

    const mismatched = await app.request('/api/node/telemetry', {
      method: 'POST',
      headers: bearer(enrolled.rawCredential),
      body: JSON.stringify({ reports: [{ ...masked, sequence: 3, seconds: 1 }] }),
    });
    expect(mismatched.status).toBe(400);
    await expect(mismatched.json()).resolves.toEqual({ error: 'TELEMETRY_INVALID' });

    expect(JSON.stringify(store.telemetryReports)).not.toContain('never-store-this');
  });
});
