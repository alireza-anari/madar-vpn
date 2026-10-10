import { describe, expect, it } from 'vitest';
import { createAccessService, MemoryAccessStore } from './access';
import { createSubscriptionService, MemorySubscriptionNodeStore } from './access/subscription';
import { createAuthService, MemoryAuthStore } from './auth';
import { createApiApp } from './index';

async function userSession() {
  const sent: string[] = [];
  let tokenNumber = 0;
  const auth = createAuthService({
    store: new MemoryAuthStore(),
    randomToken: () => `rotation-route-${++tokenNumber}`,
    sender: async ({ token }) => { sent.push(token); },
  });
  await auth.requestLogin('rotation@example.com');
  const session = await auth.consumeLoginToken(sent[0]!);
  return { auth, session };
}

function mutationHeaders(token: string, csrfToken: string) {
  return {
    cookie: `__Host-madar_session=${token}`,
    'x-csrf-token': csrfToken,
  };
}

describe('client credential rotation HTTP boundary', () => {
  it('keeps the subscription URL stable and withholds the rotated credential until the node ACKs the new policy', async () => {
    const { auth, session } = await userSession();
    const accessStore = new MemoryAccessStore();
    const now = new Date();
    let uuidNumber = 0;
    let subscriptionNumber = 0;
    const access = createAccessService({
      store: accessStore,
      now: () => now,
      randomUuid: () => `00000000-0000-4000-8000-${String(++uuidNumber).padStart(12, '0')}`,
      randomToken: () => `subscription-secret-${++subscriptionNumber}`,
    });
    const originalCredential = await access.getActiveClientCredential(session.userId);

    const nodes = new MemorySubscriptionNodeStore();
    const seedNode = (revision: number) => nodes.seed({
      id: 'node-1',
      name: 'تهران ۱',
      status: 'ready',
      lastSeenAt: new Date(now.getTime() - 30_000).toISOString(),
      ackedRevisionByUser: { [session.userId]: revision },
      publicConfig: {
        address: '203.0.113.10',
        port: 443,
        serverName: 'edge.example.test',
        realityPublicKey: 'public-reality-key',
        realityShortId: 'a1b2c3d4',
      },
    });
    seedNode(1);

    const subscriptions = createSubscriptionService({ accessStore, access, nodes });
    const auditEvents: Array<{ action: string; details: Record<string, unknown> }> = [];
    const audit = {
      record: async (_actor: unknown, action: string, details: Record<string, unknown>) => {
        auditEvents.push({ action, details: { ...details } });
      },
    };
    const createWithAccess = createApiApp as unknown as (...args: unknown[]) => ReturnType<typeof createApiApp>;
    const app = createWithAccess(
      () => auth,
      () => null,
      () => null,
      () => subscriptions,
      () => null,
      () => null,
      () => null,
      () => null,
      () => audit,
      () => access,
    );

    const issued = await app.request('/api/account/access/subscription-url', {
      method: 'POST',
      headers: mutationHeaders(session.token, session.csrfToken),
    });
    expect(issued.status).toBe(201);
    const subscriptionUrl = (await issued.json() as { subscriptionUrl: string }).subscriptionUrl;
    const subscriptionPath = new URL(subscriptionUrl).pathname;
    const beforeRotation = await app.request(subscriptionPath);
    expect(beforeRotation.status).toBe(200);
    expect(await beforeRotation.text()).toContain(originalCredential.uuid);

    const rotated = await app.request('/api/account/access/client-id/rotate', {
      method: 'POST',
      headers: mutationHeaders(session.token, session.csrfToken),
    });
    expect(rotated.status).toBe(201);
    expect(rotated.headers.get('cache-control')).toBe('no-store');
    const responseBody = await rotated.json() as { policyRevision: number; version: number };
    expect(responseBody).toEqual({ policyRevision: 2, version: 2 });
    expect(JSON.stringify(responseBody)).not.toContain(originalCredential.uuid);

    const activeCredential = await access.getActiveClientCredential(session.userId);
    expect(activeCredential.uuid).not.toBe(originalCredential.uuid);

    const beforeAck = await app.request(subscriptionPath);
    expect(beforeAck.status).toBe(200);
    expect(await beforeAck.text()).toBe('');

    seedNode(2);
    const afterAck = await app.request(subscriptionPath);
    expect(afterAck.status).toBe(200);
    const afterAckBody = await afterAck.text();
    expect(afterAckBody).toContain(activeCredential.uuid);
    expect(afterAckBody).not.toContain(originalCredential.uuid);

    expect(auditEvents).toEqual([{
      action: 'access.client-credential.rotate',
      details: { policyRevision: 2, version: 2 },
    }]);
    expect(JSON.stringify(auditEvents)).not.toContain(originalCredential.uuid);
    expect(JSON.stringify(auditEvents)).not.toContain(activeCredential.uuid);
  });
});
