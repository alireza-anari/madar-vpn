import { describe, expect, it } from 'vitest';
import { createAuthService, MemoryAuthStore } from './auth';
import { createCreditService, MemoryCreditStore } from './credits';
import { createApiApp } from './index';
import { createSurfaceService, MemorySurfaceStore } from './surfaces';

function cookiePair(setCookie: string) {
  return setCookie.split(';', 1)[0]!;
}

describe('admin mutation authorization', () => {
  it('denies a normal user even when their session has a valid CSRF token', async () => {
    const authStore = new MemoryAuthStore();
    const surfaceStore = new MemorySurfaceStore();
    const sent: string[] = [];
    let tokenNumber = 0;
    const auth = createAuthService({
      store: authStore,
      randomToken: () => `authz-secret-${++tokenNumber}`,
      sender: async ({ token }) => {
        sent.push(token);
      },
    });
    const surfaces = createSurfaceService({
      store: surfaceStore,
      credits: createCreditService({ store: new MemoryCreditStore() }),
      providerAvailability: { email: false, ads: false, payments: false, push: false },
    });
    const app = createApiApp(() => auth, () => surfaces);

    await app.request('/api/auth/request', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'user@example.com' }),
    });
    const login = await app.request('/api/auth/consume', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: sent[0] }),
    });
    const body = (await login.json()) as { csrfToken: string };
    const cookie = cookiePair(login.headers.get('set-cookie') ?? '');

    const response = await app.request('/api/admin/settings', {
      method: 'POST',
      headers: {
        cookie,
        'x-csrf-token': body.csrfToken,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ freeSpeedKbps: 512, notificationsEnabled: true }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: 'ADMIN_REQUIRED' });
    expect(surfaceStore.audit).toHaveLength(0);
    expect(surfaceStore.settings).toEqual({ freeSpeedKbps: 5000, notificationsEnabled: false });
  });
});
