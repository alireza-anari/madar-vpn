import { describe, expect, it } from 'vitest';
import { createAuthService, MemoryAuthStore } from './auth';
import { createCreditService, MemoryCreditStore } from './credits';
import { createApiApp } from './index';
import { createSurfaceService, MemorySurfaceStore } from './surfaces';

function cookiePair(setCookie: string) {
  return setCookie.split(';', 1)[0]!;
}

async function harness() {
  const authStore = new MemoryAuthStore();
  const creditStore = new MemoryCreditStore();
  const surfaceStore = new MemorySurfaceStore();
  const sent: string[] = [];
  let tokenNumber = 0;
  const auth = createAuthService({
    store: authStore,
    adminEmails: ['admin@example.com'],
    randomToken: () => `premium-secret-${++tokenNumber}`,
    sender: async ({ token }) => sent.push(token),
  });
  const credits = createCreditService({ store: creditStore });
  const surfaces = createSurfaceService({
    store: surfaceStore,
    credits,
    providerAvailability: { email: false, ads: false, payments: false, push: false },
    now: () => new Date('2026-10-08T10:00:00.000Z'),
  });
  const app = createApiApp(() => auth, () => surfaces);

  await app.request('/api/auth/request', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@example.com' }),
  });
  const login = await app.request('/api/auth/consume', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: sent[0] }),
  });
  const loginBody = (await login.json()) as { csrfToken: string };
  const cookie = cookiePair(login.headers.get('set-cookie') ?? '');
  const identity = await auth.requireAdmin(new Request('https://madar.example', { headers: { cookie } }));
  surfaceStore.seedUser({ id: identity.id, email: identity.email, role: identity.role });

  const targetUserId = 'premium-target';
  surfaceStore.seedUser({ id: targetUserId, email: 'premium@example.com', role: 'user' });
  creditStore.registerVerifiedUser(targetUserId, '2026-10-08T09:00:00.000Z');

  return {
    app,
    credits,
    surfaceStore,
    targetUserId,
    mutationHeaders: {
      cookie,
      'x-csrf-token': loginBody.csrfToken,
      'content-type': 'application/json',
    },
  };
}

describe('admin premium adjustment', () => {
  it('applies an absolute premium expiry once and audits only the successful settlement', async () => {
    const { app, credits, surfaceStore, targetUserId, mutationHeaders } = await harness();
    const premiumUntil = '2026-11-08T10:00:00.000Z';
    const request = () => app.request(`/api/admin/users/${targetUserId}/premium`, {
      method: 'POST',
      headers: mutationHeaders,
      body: JSON.stringify({
        premiumUntil,
        idempotencyKey: 'premium-support-17',
        reason: 'manual support grant',
      }),
    });

    const first = await request();
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toEqual({ applied: true, premiumUntil });

    const duplicate = await request();
    expect(duplicate.status).toBe(200);
    await expect(duplicate.json()).resolves.toEqual({ applied: false, premiumUntil });

    await expect(credits.getEntitlement(targetUserId, new Date('2026-10-08T10:00:00.000Z'))).resolves.toMatchObject({
      premiumUntil,
      tier: 'premium',
    });
    expect(surfaceStore.audit.filter((entry) => entry.action === 'user.premium.adjust')).toHaveLength(1);
    expect(surfaceStore.audit.at(-1)?.details).toMatchObject({
      userId: targetUserId,
      premiumUntil,
      idempotencyKey: 'premium-support-17',
    });
  });
});
