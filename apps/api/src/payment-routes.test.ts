import { describe, expect, it } from 'vitest';
import { createAuthService, MemoryAuthStore, type Session } from './auth';
import { createApiApp } from './index';
import { MemoryPaymentStore, createPaymentService } from './payments';
import { createPaymentProvider } from './providers';

async function authenticatedPaymentsHarness() {
  const sent: string[] = [];
  let tokenNumber = 0;
  const auth = createAuthService({
    store: new MemoryAuthStore(),
    adminEmails: ['admin@example.com'],
    randomToken: () => `payment-route-${++tokenNumber}`,
    sender: async ({ token }) => { sent.push(token); },
  });

  async function login(email: string): Promise<Session> {
    await auth.requestLogin(email);
    return auth.consumeLoginToken(sent.shift()!);
  }

  const user = await login('user@example.com');
  const admin = await login('admin@example.com');
  const store = new MemoryPaymentStore();
  store.seedPlan({
    id: 'monthly',
    title: 'ماهانه',
    durationDays: 30,
    priceMinor: 125000,
    currency: 'IRR',
    enabled: true,
  });
  const provider = createPaymentProvider({
    provider: 'fixture-pay',
    verify: async () => true,
    parse: async () => ({
      provider: 'fixture-pay',
      eventId: 'event-1',
      orderId: 'order-1',
      amountMinor: 125000,
      currency: 'IRR',
      occurredAt: '2026-10-08T08:00:00.000Z',
    }),
  });
  const payments = createPaymentService({
    store,
    provider,
    now: () => new Date('2026-10-08T08:00:00.000Z'),
    randomId: () => 'order-1',
  });

  const createWithPayments = createApiApp as unknown as (...args: unknown[]) => ReturnType<typeof createApiApp>;
  const app = createWithPayments(
    () => auth,
    () => null,
    () => null,
    () => null,
    () => payments,
  );

  return { app, user, admin, store };
}

function mutationHeaders(session: Session) {
  return {
    'content-type': 'application/json',
    cookie: `__Host-madar_session=${session.token}`,
    'x-csrf-token': session.csrfToken,
  };
}

describe('payment HTTP boundary', () => {
  it('creates a server-priced order for an authenticated user and manual confirmation is admin-only', async () => {
    const { app, user, admin, store } = await authenticatedPaymentsHarness();

    const create = await app.request('/api/account/orders', {
      method: 'POST',
      headers: mutationHeaders(user),
      body: JSON.stringify({ planId: 'monthly', amountMinor: 1, durationDays: 9999 }),
    });
    expect(create.status).toBe(201);
    await expect(create.json()).resolves.toMatchObject({
      id: 'order-1',
      amountMinor: 125000,
      durationDays: 30,
      status: 'pending',
    });

    const forbidden = await app.request('/api/admin/orders/order-1/confirm', {
      method: 'POST',
      headers: mutationHeaders(user),
      body: JSON.stringify({ confirmationId: 'manual-1' }),
    });
    expect(forbidden.status).toBe(403);

    const confirmed = await app.request('/api/admin/orders/order-1/confirm', {
      method: 'POST',
      headers: mutationHeaders(admin),
      body: JSON.stringify({ confirmationId: 'manual-1' }),
    });
    expect(confirmed.status).toBe(200);
    await expect(confirmed.json()).resolves.toMatchObject({ applied: true });
    await expect(store.getPremiumUntil(user.userId)).resolves.not.toBeNull();
  });

  it('settles only through the verified provider callback, never a browser return URL', async () => {
    const { app, user, store } = await authenticatedPaymentsHarness();
    await app.request('/api/account/orders', {
      method: 'POST',
      headers: mutationHeaders(user),
      body: JSON.stringify({ planId: 'monthly' }),
    });

    const browserReturn = await app.request('/api/payments/return?orderId=order-1');
    expect(browserReturn.status).toBe(404);
    await expect(store.getPremiumUntil(user.userId)).resolves.toBeNull();

    const callback = await app.request('/api/providers/payments/callback', { method: 'POST', body: '{}' });
    expect(callback.status).toBe(200);
    await expect(callback.json()).resolves.toMatchObject({ applied: true });
    await expect(store.getPremiumUntil(user.userId)).resolves.not.toBeNull();
  });
});
