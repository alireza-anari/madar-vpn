import { describe, expect, it } from 'vitest';
import { createAuthService, MemoryAuthStore } from './auth';
import { createCreditService, MemoryCreditStore } from './credits';
import { createApiApp } from './index';
import { createSurfaceService, MemorySurfaceStore } from './surfaces';

function cookiePair(setCookie: string) {
  return setCookie.split(';', 1)[0]!;
}

async function adminHarness() {
  const authStore = new MemoryAuthStore();
  const creditStore = new MemoryCreditStore();
  const surfaceStore = new MemorySurfaceStore();
  const sent: string[] = [];
  let tokenNumber = 0;
  const email = 'admin@example.com';
  const auth = createAuthService({
    store: authStore,
    adminEmails: [email],
    randomToken: () => `crud-secret-${++tokenNumber}`,
    sender: async ({ token }) => {
      sent.push(token);
    },
  });
  const surfaces = createSurfaceService({
    store: surfaceStore,
    credits: createCreditService({ store: creditStore }),
    providerAvailability: { email: false, ads: false, payments: false, push: false },
    now: () => new Date('2026-10-08T10:00:00.000Z'),
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
  const body = (await login.json()) as { csrfToken: string };
  const cookie = cookiePair(login.headers.get('set-cookie') ?? '');
  const identity = await auth.requireAdmin(new Request('https://madar.example', { headers: { cookie } }));
  surfaceStore.seedUser({ id: identity.id, email: identity.email, role: identity.role });

  const mutationHeaders = {
    cookie,
    'x-csrf-token': body.csrfToken,
    'content-type': 'application/json',
  };

  return { app, surfaceStore, cookie, mutationHeaders, identity };
}

describe('server-protected admin control plane', () => {
  it('lists real admin resources and audit history', async () => {
    const { app, cookie, identity } = await adminHarness();

    const response = await app.request('/api/admin/resources', { headers: { cookie } });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      users: [{ id: identity.id, email: 'admin@example.com', role: 'admin' }],
      plans: [],
      missions: [],
      nodes: [],
      notificationDrafts: [],
      audit: [],
    });
  });

  it('requires CSRF and supports plan create/update/delete with audit', async () => {
    const { app, cookie, mutationHeaders, surfaceStore } = await adminHarness();

    const denied = await app.request('/api/admin/plans/basic', {
      method: 'PUT',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'ماهانه', durationDays: 30, priceMinor: 1000, currency: 'IRR', enabled: true }),
    });
    expect(denied.status).toBe(403);

    const create = await app.request('/api/admin/plans/basic', {
      method: 'PUT',
      headers: mutationHeaders,
      body: JSON.stringify({ title: 'ماهانه', durationDays: 30, priceMinor: 1000, currency: 'IRR', enabled: true }),
    });
    expect(create.status).toBe(200);
    await expect(create.json()).resolves.toMatchObject({ id: 'basic', title: 'ماهانه', durationDays: 30 });

    const update = await app.request('/api/admin/plans/basic', {
      method: 'PUT',
      headers: mutationHeaders,
      body: JSON.stringify({ title: 'ماهانه پلاس', durationDays: 30, priceMinor: 1500, currency: 'IRR', enabled: true }),
    });
    expect(update.status).toBe(200);
    await expect(update.json()).resolves.toMatchObject({ id: 'basic', title: 'ماهانه پلاس', priceMinor: 1500 });

    const remove = await app.request('/api/admin/plans/basic', {
      method: 'DELETE',
      headers: mutationHeaders,
    });
    expect(remove.status).toBe(204);
    expect(surfaceStore.plans).toHaveLength(0);
    expect(surfaceStore.audit.map((entry) => entry.action)).toEqual([
      'plan.upsert',
      'plan.upsert',
      'plan.delete',
    ]);
  });

  it('supports mission editing without awarding credit from the browser', async () => {
    const { app, mutationHeaders, surfaceStore } = await adminHarness();

    const response = await app.request('/api/admin/missions/referral', {
      method: 'PUT',
      headers: mutationHeaders,
      body: JSON.stringify({
        title: 'دعوت از دوست',
        description: 'پاداش فقط پس از تأیید سمت سرور.',
        rewardSeconds: 900,
        status: 'active',
      }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ id: 'referral', rewardSeconds: 900, status: 'active' });
    expect(surfaceStore.audit.at(-1)?.action).toBe('mission.upsert');

    const remove = await app.request('/api/admin/missions/referral', {
      method: 'DELETE',
      headers: mutationHeaders,
    });
    expect(remove.status).toBe(204);
    expect(surfaceStore.missions).toHaveLength(0);
  });

  it('enrolls node records as enrolled only and never fabricates readiness or credentials', async () => {
    const { app, mutationHeaders, surfaceStore } = await adminHarness();

    const response = await app.request('/api/admin/nodes', {
      method: 'POST',
      headers: mutationHeaders,
      body: JSON.stringify({ name: 'تهران ۱' }),
    });
    expect(response.status).toBe(201);
    const payload = (await response.json()) as Record<string, unknown>;
    expect(payload).toMatchObject({ name: 'تهران ۱', status: 'enrolled' });
    expect(payload).not.toHaveProperty('credential');
    expect(payload).not.toHaveProperty('config');
    expect(surfaceStore.nodes[0]?.status).toBe('enrolled');
  });

  it('creates notification drafts without claiming delivery when push is unavailable', async () => {
    const { app, mutationHeaders, surfaceStore } = await adminHarness();

    const response = await app.request('/api/admin/notification-drafts', {
      method: 'POST',
      headers: mutationHeaders,
      body: JSON.stringify({ title: 'یادآوری', body: 'اعتبار امروز را بررسی کنید.', target: 'all' }),
    });
    expect(response.status).toBe(201);
    const payload = (await response.json()) as Record<string, unknown>;
    expect(payload).toMatchObject({ title: 'یادآوری', target: 'all', deliveryStatus: 'draft' });
    expect(payload).not.toHaveProperty('sent');
    expect(surfaceStore.notificationDrafts).toHaveLength(1);
  });
});
