import { describe, expect, it } from 'vitest';
import { createAuthService, MemoryAuthStore } from './auth';
import { createCreditService, MemoryCreditStore } from './credits';
import { createApiApp } from './index';
import { createSurfaceService, MemorySurfaceStore } from './surfaces';

function cookiePair(setCookie: string) {
  return setCookie.split(';', 1)[0]!;
}

async function authenticatedHarness() {
  const authStore = new MemoryAuthStore();
  const creditStore = new MemoryCreditStore();
  const surfaceStore = new MemorySurfaceStore();
  const sent: string[] = [];
  const auth = createAuthService({
    store: authStore,
    randomToken: () => `catalog-secret-${sent.length + 1}`,
    sender: async ({ token }) => {
      sent.push(token);
    },
  });
  const surfaces = createSurfaceService({
    store: surfaceStore,
    credits: createCreditService({ store: creditStore }),
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

  return { app, surfaceStore, cookie: cookiePair(login.headers.get('set-cookie') ?? '') };
}

describe('authenticated account catalog', () => {
  it('returns only enabled plans and active missions with user-safe fields', async () => {
    const { app, surfaceStore, cookie } = await authenticatedHarness();
    await surfaceStore.savePlan({
      id: 'monthly',
      title: 'یک‌ماهه',
      durationDays: 30,
      priceMinor: 250000,
      currency: 'IRR',
      enabled: true,
      createdAt: '2026-10-09T00:00:00.000Z',
      updatedAt: '2026-10-09T00:00:00.000Z',
    });
    await surfaceStore.savePlan({
      id: 'hidden',
      title: 'مخفی',
      durationDays: 90,
      priceMinor: 600000,
      currency: 'IRR',
      enabled: false,
      createdAt: '2026-10-09T00:00:00.000Z',
      updatedAt: '2026-10-09T00:00:00.000Z',
    });
    await surfaceStore.saveMission({
      id: 'profile-proof',
      title: 'تکمیل پروفایل',
      description: 'مدرک تکمیل را ارسال کنید.',
      rewardSeconds: 900,
      status: 'active',
      verificationKind: 'evidence',
      createdAt: '2026-10-09T00:00:00.000Z',
      updatedAt: '2026-10-09T00:00:00.000Z',
    });
    await surfaceStore.saveMission({
      id: 'draft-only',
      title: 'پیش‌نویس',
      description: 'نباید به کاربر نمایش داده شود.',
      rewardSeconds: 900,
      status: 'draft',
      verificationKind: 'evidence',
      createdAt: '2026-10-09T00:00:00.000Z',
      updatedAt: '2026-10-09T00:00:00.000Z',
    });

    const response = await app.request('/api/account/catalog', { headers: { cookie } });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      plans: [{
        id: 'monthly',
        title: 'یک‌ماهه',
        durationDays: 30,
        priceMinor: 250000,
        currency: 'IRR',
      }],
      missions: [{
        id: 'profile-proof',
        title: 'تکمیل پروفایل',
        description: 'مدرک تکمیل را ارسال کنید.',
        rewardSeconds: 900,
        verificationKind: 'evidence',
      }],
    });
  });

  it('requires an authenticated user', async () => {
    const { app } = await authenticatedHarness();
    const response = await app.request('/api/account/catalog');
    expect(response.status).toBe(401);
  });
});
