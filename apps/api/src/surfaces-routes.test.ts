import { describe, expect, it } from 'vitest';
import { createAuthService, MemoryAuthStore } from './auth';
import { createCreditService, MemoryCreditStore } from './credits';
import { createApiApp } from './index';
import { createSurfaceService, MemorySurfaceStore } from './surfaces';

function cookiePair(setCookie: string) {
  return setCookie.split(';', 1)[0]!;
}

async function authenticatedHarness(role: 'user' | 'admin') {
  const authStore = new MemoryAuthStore();
  const creditStore = new MemoryCreditStore();
  const surfaceStore = new MemorySurfaceStore();
  const sent: string[] = [];
  let tokenNumber = 0;
  const email = role === 'admin' ? 'admin@example.com' : 'user@example.com';
  const auth = createAuthService({
    store: authStore,
    adminEmails: role === 'admin' ? [email] : [],
    randomToken: () => `surface-secret-${++tokenNumber}`,
    sender: async ({ token }) => {
      sent.push(token);
    },
  });
  const surfaces = createSurfaceService({
    store: surfaceStore,
    credits: createCreditService({ store: creditStore }),
    providerAvailability: { email: false, ads: false, payments: false, push: false },
  });
  const app = createApiApp(() => auth, () => surfaces);

  await app.request('/api/auth/request', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  const login = await app.request('/api/auth/consume', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: sent[0] }),
  });
  const loginPayload = (await login.json()) as { csrfToken: string };
  const cookie = cookiePair(login.headers.get('set-cookie') ?? '');
  const identity = await auth.requireUser(new Request('https://madar.example', { headers: { cookie } }));
  creditStore.registerVerifiedUser(identity.id, identity.verifiedAt);

  return { app, auth, creditStore, surfaceStore, cookie, csrfToken: loginPayload.csrfToken, identity };
}

describe('account and administration surfaces', () => {
  it('returns authenticated entitlement with honest node/provider readiness', async () => {
    const { app, cookie, identity, surfaceStore } = await authenticatedHarness('user');
    surfaceStore.setCounts({ users: 1, readyNodes: 0, plans: 0, missions: 0 });

    const response = await app.request('/api/account', { headers: { cookie } });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      identity: {
        id: identity.id,
        email: 'user@example.com',
        role: 'user',
      },
      entitlement: {
        freeSeconds: 1800,
        premiumUntil: null,
        tier: 'free',
      },
      node: {
        ready: false,
        connectionStatus: 'disconnected',
        configAvailable: false,
      },
      providers: {
        email: false,
        ads: false,
        payments: false,
        push: false,
      },
    });
  });

  it('requires admin and CSRF, validates settings, persists them, and writes audit history', async () => {
    const normal = await authenticatedHarness('user');
    const denied = await normal.app.request('/api/admin/settings', {
      method: 'POST',
      headers: {
        cookie: normal.cookie,
        'x-csrf-token': normal.csrfToken,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ freeSpeedKbps: 512, notificationsEnabled: true }),
    });
    expect(denied.status).toBe(403);

    const admin = await authenticatedHarness('admin');
    const missingCsrf = await admin.app.request('/api/admin/settings', {
      method: 'POST',
      headers: { cookie: admin.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ freeSpeedKbps: 512, notificationsEnabled: true }),
    });
    expect(missingCsrf.status).toBe(403);

    const invalid = await admin.app.request('/api/admin/settings', {
      method: 'POST',
      headers: {
        cookie: admin.cookie,
        'x-csrf-token': admin.csrfToken,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ freeSpeedKbps: 0, notificationsEnabled: 'yes' }),
    });
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toEqual({ error: 'SETTINGS_INVALID' });

    const valid = await admin.app.request('/api/admin/settings', {
      method: 'POST',
      headers: {
        cookie: admin.cookie,
        'x-csrf-token': admin.csrfToken,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ freeSpeedKbps: 512, notificationsEnabled: true }),
    });
    expect(valid.status).toBe(200);
    await expect(valid.json()).resolves.toEqual({ freeSpeedKbps: 512, notificationsEnabled: true });
    expect(admin.surfaceStore.settings).toEqual({ freeSpeedKbps: 512, notificationsEnabled: true });
    expect(admin.surfaceStore.audit).toHaveLength(1);
    expect(admin.surfaceStore.audit[0]).toMatchObject({
      actorUserId: admin.identity.id,
      action: 'settings.update',
    });
  });

  it('returns actual admin counts, the approved default speed policy, and honest readiness', async () => {
    const { app, cookie, surfaceStore } = await authenticatedHarness('admin');
    surfaceStore.setCounts({ users: 7, readyNodes: 2, plans: 3, missions: 4 });

    const response = await app.request('/api/admin/overview', { headers: { cookie } });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      counts: { users: 7, readyNodes: 2, plans: 3, missions: 4 },
      readiness: {
        nodes: true,
        email: false,
        ads: false,
        payments: false,
        push: false,
        speedEnforcement: false,
      },
      settings: { freeSpeedKbps: 5000, notificationsEnabled: false },
    });
  });
});
