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
    randomToken: () => `access-route-${++tokenNumber}`,
    sender: async ({ token }) => { sent.push(token); },
  });
  await auth.requestLogin('user@example.com');
  const session = await auth.consumeLoginToken(sent[0]!);
  return { auth, session };
}

function mutationHeaders(token: string, csrfToken: string) {
  return {
    cookie: `__Host-madar_session=${token}`,
    'x-csrf-token': csrfToken,
  };
}

describe('authenticated account access HTTP boundary', () => {
  it('reports eligibility from the subscription filter and issues a no-store bearer URL', async () => {
    const { auth, session } = await userSession();
    const accessStore = new MemoryAccessStore();
    const now = new Date();
    let uuidNumber = 0;
    let subscriptionNumber = 0;
    const access = createAccessService({
      store: accessStore,
      now: () => now,
      randomUuid: () => `access-id-${++uuidNumber}`,
      randomToken: () => `subscription-secret-${++subscriptionNumber}`,
    });
    const nodes = new MemorySubscriptionNodeStore();
    nodes.seed({
      id: 'node-1',
      name: 'تهران ۱',
      status: 'ready',
      lastSeenAt: new Date(now.getTime() - 30_000).toISOString(),
      ackedRevisionByUser: { [session.userId]: 1 },
      publicConfig: {
        address: '203.0.113.10',
        port: 443,
        serverName: 'edge.example.test',
        realityPublicKey: 'public-reality-key',
        realityShortId: 'a1b2c3d4',
      },
    });
    const subscriptions = createSubscriptionService({ accessStore, access, nodes });
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
      () => null,
      () => access,
    );

    const readiness = await app.request('/api/account/access', {
      headers: { cookie: `__Host-madar_session=${session.token}` },
    });
    expect(readiness.status).toBe(200);
    await expect(readiness.json()).resolves.toEqual({ ready: true, eligibleNodeCount: 1 });

    const issued = await app.request('/api/account/access/subscription-url', {
      method: 'POST',
      headers: mutationHeaders(session.token, session.csrfToken),
    });
    expect(issued.status).toBe(201);
    expect(issued.headers.get('cache-control')).toBe('no-store');
    expect(issued.headers.get('referrer-policy')).toBe('no-referrer');
    const body = await issued.json() as { subscriptionUrl: string; version: number };
    expect(body).toEqual({
      subscriptionUrl: 'http://localhost/s/subscription-secret-1',
      version: 1,
    });
    expect(JSON.stringify(body)).not.toContain(session.userId);
    expect(JSON.stringify(body)).not.toContain('user@example.com');

    const rendered = await app.request(new URL(body.subscriptionUrl).pathname);
    expect(rendered.status).toBe(200);
    expect(await rendered.text()).toContain('vless://');
  });

  it('requires CSRF and atomically invalidates the previous subscription URL on re-issue', async () => {
    const { auth, session } = await userSession();
    const accessStore = new MemoryAccessStore();
    const now = new Date();
    let uuidNumber = 0;
    let subscriptionNumber = 0;
    const access = createAccessService({
      store: accessStore,
      now: () => now,
      randomUuid: () => `access-id-${++uuidNumber}`,
      randomToken: () => `subscription-secret-${++subscriptionNumber}`,
    });
    const nodes = new MemorySubscriptionNodeStore();
    nodes.seed({
      id: 'node-1',
      name: 'تهران ۱',
      status: 'ready',
      lastSeenAt: new Date(now.getTime() - 30_000).toISOString(),
      ackedRevisionByUser: { [session.userId]: 1 },
      publicConfig: {
        address: '203.0.113.10',
        port: 443,
        serverName: 'edge.example.test',
        realityPublicKey: 'public-reality-key',
        realityShortId: 'a1b2c3d4',
      },
    });
    const subscriptions = createSubscriptionService({ accessStore, access, nodes });
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
      () => null,
      () => access,
    );

    const missingCsrf = await app.request('/api/account/access/subscription-url', {
      method: 'POST',
      headers: { cookie: `__Host-madar_session=${session.token}` },
    });
    expect(missingCsrf.status).toBe(403);

    const first = await app.request('/api/account/access/subscription-url', {
      method: 'POST',
      headers: mutationHeaders(session.token, session.csrfToken),
    });
    expect(first.status).toBe(201);
    const firstUrl = (await first.json() as { subscriptionUrl: string }).subscriptionUrl;

    const second = await app.request('/api/account/access/subscription-url', {
      method: 'POST',
      headers: mutationHeaders(session.token, session.csrfToken),
    });
    expect(second.status).toBe(201);
    const secondUrl = (await second.json() as { subscriptionUrl: string }).subscriptionUrl;

    expect(firstUrl).not.toBe(secondUrl);
    expect((await app.request(new URL(firstUrl).pathname)).status).toBe(404);
    expect((await app.request(new URL(secondUrl).pathname)).status).toBe(200);
  });
});
