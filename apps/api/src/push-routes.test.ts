import { describe, expect, it } from 'vitest';
import { createAuthService, MemoryAuthStore } from './auth';
import { createApiApp } from './index';
import { MemoryPushStore, createPushService } from './push';

function mutationHeaders(token: string, csrfToken: string) {
  return {
    'content-type': 'application/json',
    cookie: `__Host-madar_session=${token}`,
    'x-csrf-token': csrfToken,
  };
}

describe('push subscription HTTP boundary', () => {
  it('rejects anonymous storage and binds subscription CRUD to the authenticated user', async () => {
    const sent: string[] = [];
    let tokenNumber = 0;
    const auth = createAuthService({
      store: new MemoryAuthStore(),
      randomToken: () => `push-route-${++tokenNumber}`,
      sender: async ({ token }) => { sent.push(token); },
    });
    await auth.requestLogin('user@example.com');
    const session = await auth.consumeLoginToken(sent[0]!);

    const store = new MemoryPushStore();
    const push = createPushService({
      store,
      randomId: () => 'push-sub-1',
      now: () => new Date('2026-10-08T09:30:00.000Z'),
    });
    const createWithPush = createApiApp as unknown as (...args: unknown[]) => ReturnType<typeof createApiApp>;
    const app = createWithPush(
      () => auth,
      () => null,
      () => null,
      () => null,
      () => null,
      () => null,
      () => push,
    );
    const payload = {
      endpoint: 'https://push.example.test/subscriptions/device-1',
      keys: { p256dh: 'public-key-material', auth: 'auth-secret-material' },
      expirationTime: null,
      userId: 'other-user',
    };

    const anonymous = await app.request('/api/account/push-subscriptions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    expect(anonymous.status).toBe(401);
    expect(store.subscriptions).toEqual([]);

    const saved = await app.request('/api/account/push-subscriptions', {
      method: 'POST',
      headers: mutationHeaders(session.token, session.csrfToken),
      body: JSON.stringify(payload),
    });
    expect(saved.status).toBe(201);
    await expect(saved.json()).resolves.toMatchObject({ id: 'push-sub-1', userId: session.userId });

    const listed = await app.request('/api/account/push-subscriptions', {
      headers: { cookie: `__Host-madar_session=${session.token}` },
    });
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toEqual([
      expect.objectContaining({ id: 'push-sub-1', endpoint: payload.endpoint }),
    ]);

    const removed = await app.request('/api/account/push-subscriptions/push-sub-1', {
      method: 'DELETE',
      headers: mutationHeaders(session.token, session.csrfToken),
    });
    expect(removed.status).toBe(204);
    expect(store.subscriptions).toEqual([]);
  });
});
