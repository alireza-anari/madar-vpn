import { describe, expect, it } from 'vitest';
import { createAccessService, MemoryAccessStore } from './access';
import { createSubscriptionService, MemorySubscriptionNodeStore } from './access/subscription';
import { createAuthService, MemoryAuthStore } from './auth';
import { createApiApp } from './index';

async function freshAccount() {
  let delivered = '';
  const auth = createAuthService({ store: new MemoryAuthStore(), sender: async ({ token }) => { delivered = token; } });
  await auth.requestLogin('fresh@example.test');
  const session = await auth.consumeLoginToken(delivered);
  const store = new MemoryAccessStore();
  const access = createAccessService({ store });
  const subscriptions = createSubscriptionService({ accessStore: store, access, nodes: new MemorySubscriptionNodeStore() });
  const app = createApiApp(() => auth, () => null, () => null, () => subscriptions,
    () => null, () => null, () => null, () => null, () => null, () => access);
  const headers = { cookie: `__Host-madar_session=${session.token}`, 'x-csrf-token': session.csrfToken };
  return { app, store, session, headers };
}

describe('fresh-account access bootstrap', () => {
  it('prepares one stable credential before any node ACK without falsely reporting readiness', async () => {
    const { app, store, headers } = await freshAccount();
    const responses = await Promise.all([1, 2, 3].map(() => app.request('/api/account/access', { headers })));
    for (const response of responses) {
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ready: false, eligibleNodeCount: 0 });
    }
    expect(store.profiles).toHaveLength(1);
    expect(store.credentials.filter(c => c.revokedAt === null)).toHaveLength(1);
    expect(store.profiles[0]?.policyRevision).toBe(1);
    expect(store.credentials[0]?.version).toBe(1);
  });

  it('rotates safely even when it is the first authenticated access action', async () => {
    const { app, store, headers } = await freshAccount();
    const response = await app.request('/api/account/access/client-id/rotate', { method: 'POST', headers });
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ policyRevision: 2, version: 2 });
    expect(store.credentials.filter(c => c.revokedAt === null)).toHaveLength(1);
    expect(store.credentials.filter(c => c.revokedAt !== null)).toHaveLength(1);
  });

  it('does not provision credentials for an unauthenticated readiness request', async () => {
    const { app, store } = await freshAccount();
    expect((await app.request('/api/account/access')).status).toBe(401);
    expect(store.profiles).toHaveLength(0);
    expect(store.credentials).toHaveLength(0);
  });
});
