import { describe, expect, it } from 'vitest';
import { createAuthService, MemoryAuthStore } from './auth';
import { createApiApp } from './index';
import { createAdminAuditService } from './admin-audit';
import { MemoryPushStore, createPushService } from './push';

function mutationHeaders(token: string, csrfToken: string) {
  return {
    'content-type': 'application/json',
    cookie: `__Host-madar_session=${token}`,
    'x-csrf-token': csrfToken,
  };
}

async function userSession(admin = false) {
  const sent: string[] = [];
  let tokenNumber = 0;
  const auth = createAuthService({
    store: new MemoryAuthStore(),
    adminEmails: admin ? ['user@example.com'] : [],
    randomToken: () => `push-route-${++tokenNumber}`,
    sender: async ({ token }) => { sent.push(token); },
  });
  await auth.requestLogin('user@example.com');
  const session = await auth.consumeLoginToken(sent[0]!);
  return { auth, session };
}

describe('push subscription HTTP boundary', () => {
  it('rejects anonymous storage and binds subscription CRUD to the authenticated user', async () => {
    const { auth, session } = await userSession();
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

  it('returns the configured public VAPID key only to an authenticated user', async () => {
    const { auth, session } = await userSession();
    const push = createPushService({
      store: new MemoryPushStore(),
      publicKey: 'public-vapid-key',
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

    const anonymous = await app.request('/api/account/push/vapid-public-key');
    expect(anonymous.status).toBe(401);

    const configured = await app.request('/api/account/push/vapid-public-key', {
      headers: { cookie: `__Host-madar_session=${session.token}` },
    });
    expect(configured.status).toBe(200);
    expect(configured.headers.get('cache-control')).toBe('no-store');
    await expect(configured.json()).resolves.toEqual({ publicKey: 'public-vapid-key' });

    const unavailablePush = createPushService({ store: new MemoryPushStore() });
    const unavailableApp = createWithPush(
      () => auth,
      () => null,
      () => null,
      () => null,
      () => null,
      () => null,
      () => unavailablePush,
    );
    const unavailable = await unavailableApp.request('/api/account/push/vapid-public-key', {
      headers: { cookie: `__Host-madar_session=${session.token}` },
    });
    expect(unavailable.status).toBe(503);
    await expect(unavailable.json()).resolves.toEqual({ error: 'PUSH_UNAVAILABLE' });
  });
});


describe('administrator real push send route', () => {
  it('requires admin, CSRF and origin and returns aggregate delivery counts only', async () => {
    const { auth, session } = await userSession(true);
    const store = new MemoryPushStore();
    let sends = 0;
    const push = createPushService({ store, sender: { async send() { sends += 1; return { status: 'delivered' }; } } });
    await push.saveSubscription(session.userId, { endpoint: 'https://push.example.test/device', keys: { p256dh: 'public-key-material', auth: 'auth-secret-material' } });
    const audits: Array<{ action: string; details: Record<string, unknown> }> = [];
    const audit = createAdminAuditService({ store: { async appendAudit(event) { audits.push(event); } } });
    const app = createApiApp(() => auth, () => null, () => null, () => null, () => null, () => null, () => push, () => null, () => audit);
    const path = `/api/admin/users/${session.userId}/notifications`;
    const body = JSON.stringify({ title: 'Madar', body: 'Device acceptance', url: '/settings' });
    expect((await app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body })).status).toBe(401);
    expect((await app.request(path, { method: 'POST', headers: { cookie: `__Host-madar_session=${session.token}`, 'content-type': 'application/json' }, body })).status).toBe(403);
    expect((await app.request(path, { method: 'POST', headers: { ...mutationHeaders(session.token, session.csrfToken), origin: 'https://evil.example' }, body })).status).toBe(403);
    expect(sends).toBe(0);
    const result = await app.request(path, { method: 'POST', headers: mutationHeaders(session.token, session.csrfToken), body });
    expect(result.status).toBe(200);
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect(await result.json()).toEqual({ delivered: 1, expiredRemoved: 0, failed: 0 });
    expect(sends).toBe(1);
    expect(audits).toEqual([expect.objectContaining({ action: 'push.notification.request', details: { userId: session.userId } }), expect.objectContaining({ action: 'push.notification.send', details: { userId: session.userId, delivered: 1, expiredRemoved: 0, failed: 0 } })]);
    expect((await app.request(path, { method: 'POST', headers: mutationHeaders(session.token, session.csrfToken), body: '{}' })).status).toBe(400);
    expect(sends).toBe(1);
  });

  it('denies ordinary users', async () => {
    const { auth, session } = await userSession();
    const push = createPushService({ store: new MemoryPushStore() });
    const app = createApiApp(() => auth, () => null, () => null, () => null, () => null, () => null, () => push);
    const response = await app.request(`/api/admin/users/${session.userId}/notifications`, {
      method: 'POST', headers: mutationHeaders(session.token, session.csrfToken), body: JSON.stringify({ title: 'Madar', body: 'test' }),
    });
    expect(response.status).toBe(403);
  });
});


it('does not send an administrator notification without durable audit availability', async () => {
  const { auth, session } = await userSession(true);
  const store = new MemoryPushStore();
  let sends = 0;
  const push = createPushService({ store, sender: { async send() { sends += 1; return { status: 'delivered' }; } } });
  await push.saveSubscription(session.userId, { endpoint: 'https://push.example.test/device', keys: { p256dh: 'public-key-material', auth: 'auth-secret-material' } });
  const app = createApiApp(() => auth, () => null, () => null, () => null, () => null, () => null, () => push);
  const response = await app.request(`/api/admin/users/${session.userId}/notifications`, { method: 'POST', headers: mutationHeaders(session.token, session.csrfToken), body: JSON.stringify({ title: 'Madar', body: 'test' }) });
  expect(response.status).toBe(503);
  expect(sends).toBe(0);
});

describe('authenticated device notification test', () => {
  it('serves an authenticated no-store test page without exposing subscriptions or requesting permission', async () => {
    const { auth, session } = await userSession();
    const push = createPushService({ store: new MemoryPushStore(), publicKey: 'test-public-key' });
    const app = createApiApp(() => auth, () => null, () => null, () => null, () => null, () => null, () => push);
    expect((await app.request('/api/account/push/test')).status).toBe(401);
    const response = await app.request('/api/account/push/test', { headers: { cookie: `__Host-madar_session=${session.token}` } });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    const html = await response.text();
    expect(html).toContain('ارسال اعلان آزمایشی');
    expect(html).toContain('/api/auth/csrf');
    expect(html).not.toContain('requestPermission');
    expect(html).not.toContain('test-public-key');
  });

  it('sends only to the authenticated account, requires CSRF/origin and records safe audit counts', async () => {
    const { auth, session } = await userSession();
    const store = new MemoryPushStore();
    const sentUsers: string[] = [];
    const push = createPushService({ store, publicKey: 'test-public-key', sender: { async send(subscription, payload) { sentUsers.push(subscription.userId); expect(payload.url).toBe('/settings'); return { status: 'delivered' }; } } });
    for (const user of [session.userId, 'other-user']) await push.saveSubscription(user, { endpoint: `https://push.example.test/${user}`, keys: { p256dh: 'public-key-material', auth: 'auth-secret-material' } });
    const audits: Array<{ action: string; details: Record<string, unknown> }> = [];
    const audit = createAdminAuditService({ store: { async appendAudit(event) { audits.push(event); } } });
    const app = createApiApp(() => auth, () => null, () => null, () => null, () => null, () => null, () => push, () => null, () => audit);
    const path = '/api/account/push/test';
    expect((await app.request(path, { method: 'POST' })).status).toBe(401);
    expect((await app.request(path, { method: 'POST', headers: { cookie: `__Host-madar_session=${session.token}` } })).status).toBe(403);
    expect((await app.request(path, { method: 'POST', headers: { ...mutationHeaders(session.token, session.csrfToken), origin: 'https://evil.example' } })).status).toBe(403);
    expect(sentUsers).toEqual([]);
    const response = await app.request(path, { method: 'POST', headers: mutationHeaders(session.token, session.csrfToken), body: JSON.stringify({ userId: 'other-user' }) });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ delivered: 1, expiredRemoved: 0, failed: 0 });
    expect(sentUsers).toEqual([session.userId]);
    expect(audits.map(a => a.action)).toEqual(['push.self-test.request', 'push.self-test.send']);
    expect(JSON.stringify(audits)).not.toContain('push.example.test');
    expect(JSON.stringify(audits)).not.toContain('auth-secret-material');
  });

  it('fails closed without audit or valid push readiness and honors the existing hashed rate limiter', async () => {
    const { auth, session } = await userSession();
    const push = createPushService({ store: new MemoryPushStore(), publicKey: 'test-public-key' });
    const app = createApiApp(() => auth, () => null, () => null, () => null, () => null, () => null, () => push);
    const headers = mutationHeaders(session.token, session.csrfToken);
    expect((await app.request('/api/account/push/test', { method: 'POST', headers })).status).toBe(503);
    let rateKey = '';
    const limited = await app.request('/api/account/push/test', { method: 'POST', headers }, { ADMIN_RATE_LIMITER: { async limit({ key }: { key: string }) { rateKey = key; return { success: false }; } } });
    expect(limited.status).toBe(429);
    expect(rateKey).not.toContain(session.userId);
    expect(rateKey).toMatch(/^push-self-test:[a-f0-9]{64}$/);
    const unavailable = createPushService({ store: new MemoryPushStore() });
    const unavailableApp = createApiApp(() => auth, () => null, () => null, () => null, () => null, () => null, () => unavailable);
    expect((await unavailableApp.request('/api/account/push/test', { method: 'POST', headers })).status).toBe(503);
  });
});
