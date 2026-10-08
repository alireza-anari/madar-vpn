import { describe, expect, it } from 'vitest';
import { createAuthService, MemoryAuthStore } from './auth';
import { createCreditService, MemoryCreditStore } from './credits';
import { createApiApp } from './index';
import { createSurfaceService, MemorySurfaceStore } from './surfaces';

function cookiePair(setCookie: string) {
  return setCookie.split(';', 1)[0]!;
}

describe('admin user suspension', () => {
  it('blocks an existing user session immediately and audits only actual state changes', async () => {
    const authStore = new MemoryAuthStore();
    const surfaceStore = new MemorySurfaceStore();
    const creditStore = new MemoryCreditStore();
    const sent = new Map<string, string>();
    let tokenNumber = 0;
    const auth = createAuthService({
      store: authStore,
      adminEmails: ['admin@example.com'],
      randomToken: () => `suspension-secret-${++tokenNumber}`,
      sender: async ({ email, token }) => {
        sent.set(email, token);
      },
      onUserSuspension: async (event) => {
        await surfaceStore.appendAudit({
          id: crypto.randomUUID(),
          actorUserId: event.actorUserId,
          action: 'user.suspension.update',
          details: {
            userId: event.targetUserId,
            suspended: event.suspended,
            reason: event.reason,
          },
          createdAt: event.changedAt,
        });
      },
    });
    const surfaces = createSurfaceService({
      store: surfaceStore,
      credits: createCreditService({ store: creditStore }),
      providerAvailability: { email: false, ads: false, payments: false, push: false },
      now: () => new Date('2026-10-08T10:00:00.000Z'),
    });
    const app = createApiApp(() => auth, () => surfaces);

    async function login(email: string) {
      await app.request('/api/auth/request', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const response = await app.request('/api/auth/consume', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: sent.get(email) }),
      });
      return {
        cookie: cookiePair(response.headers.get('set-cookie') ?? ''),
        body: (await response.json()) as { csrfToken: string },
      };
    }

    const userLogin = await login('user@example.com');
    const target = await auth.requireUser(new Request('https://madar.example', { headers: { cookie: userLogin.cookie } }));
    surfaceStore.seedUser({ id: target.id, email: target.email, role: target.role });
    creditStore.registerVerifiedUser(target.id, target.verifiedAt);

    const adminLogin = await login('admin@example.com');
    const admin = await auth.requireAdmin(new Request('https://madar.example', { headers: { cookie: adminLogin.cookie } }));
    surfaceStore.seedUser({ id: admin.id, email: admin.email, role: admin.role });

    const suspend = () => app.request(`/api/admin/users/${target.id}/suspension`, {
      method: 'POST',
      headers: {
        cookie: adminLogin.cookie,
        'x-csrf-token': adminLogin.body.csrfToken,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ suspended: true, reason: 'abuse review' }),
    });

    const first = await suspend();
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toEqual({ suspended: true });

    const denied = await app.request('/api/account/identity', { headers: { cookie: userLogin.cookie } });
    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toEqual({ error: 'ACCOUNT_SUSPENDED' });

    const duplicate = await suspend();
    expect(duplicate.status).toBe(200);
    await expect(duplicate.json()).resolves.toEqual({ suspended: true });
    expect(surfaceStore.audit.filter((entry) => entry.action === 'user.suspension.update')).toHaveLength(1);

    const resume = await app.request(`/api/admin/users/${target.id}/suspension`, {
      method: 'POST',
      headers: {
        cookie: adminLogin.cookie,
        'x-csrf-token': adminLogin.body.csrfToken,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ suspended: false, reason: 'review complete' }),
    });
    expect(resume.status).toBe(200);
    await expect(resume.json()).resolves.toEqual({ suspended: false });
    expect(surfaceStore.audit.filter((entry) => entry.action === 'user.suspension.update')).toHaveLength(2);

    const restored = await app.request('/api/account/identity', { headers: { cookie: userLogin.cookie } });
    expect(restored.status).toBe(200);
  });
});
