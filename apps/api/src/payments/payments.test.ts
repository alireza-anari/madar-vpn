import { describe, expect, it } from 'vitest';
import { createApiApp } from '../index';
import { createPaymentProvider } from '../providers';
import { MemoryPaymentStore, createPaymentService } from './index';

const START = new Date('2026-10-08T08:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function harness(eventOverrides: Partial<{
  provider: string;
  eventId: string;
  orderId: string;
  amountMinor: number;
  currency: string;
  occurredAt: string;
}> = {}) {
  const store = new MemoryPaymentStore();
  store.seedPlan({
    id: 'monthly',
    title: 'ماهانه',
    durationDays: 30,
    priceMinor: 125000,
    currency: 'IRR',
    enabled: true,
  });
  let now = START;
  let orderNumber = 0;
  const provider = createPaymentProvider({
    provider: 'fixture-pay',
    verify: async () => true,
    parse: async () => ({
      provider: 'fixture-pay',
      eventId: 'payment-event-1',
      orderId: 'order-1',
      amountMinor: 125000,
      currency: 'IRR',
      occurredAt: now.toISOString(),
      ...eventOverrides,
    }),
  });
  const payments = createPaymentService({
    store,
    provider,
    now: () => now,
    randomId: () => `order-${++orderNumber}`,
  });
  return {
    store,
    payments,
    setNow(value: Date) { now = value; },
  };
}

describe('orders and payment settlement', () => {
  it('creates the order amount and duration from the server-side plan and a browser return URL cannot settle it', async () => {
    const { payments, store } = harness();
    const order = await payments.createOrder('user-1', 'monthly');

    expect(order).toMatchObject({
      id: 'order-1',
      userId: 'user-1',
      planId: 'monthly',
      durationDays: 30,
      amountMinor: 125000,
      currency: 'IRR',
      status: 'pending',
    });

    const app = createApiApp(() => null, () => null, () => null);
    const response = await app.request(`/api/payments/return?orderId=${order.id}`);
    expect(response.status).toBe(404);
    await expect(store.getPremiumUntil('user-1')).resolves.toBeNull();
  });

  it('settles an administrator confirmation once', async () => {
    const { payments, store } = harness();
    const order = await payments.createOrder('user-1', 'monthly');

    await expect(payments.confirmOrder(order.id, 'admin-confirm-1')).resolves.toMatchObject({
      applied: true,
      premiumUntil: new Date(START.getTime() + 30 * DAY_MS).toISOString(),
    });
    await expect(payments.confirmOrder(order.id, 'admin-confirm-2')).resolves.toMatchObject({
      applied: false,
    });
    await expect(store.getPremiumUntil('user-1')).resolves.toBe(new Date(START.getTime() + 30 * DAY_MS).toISOString());
  });

  it('rejects a verified callback whose server-created order or amount does not match', async () => {
    const amountMismatch = harness({ amountMinor: 125001 });
    await amountMismatch.payments.createOrder('user-1', 'monthly');
    await expect(amountMismatch.payments.settleProviderCallback(new Request('https://madar.test/payments/callback', { method: 'POST' })))
      .rejects.toMatchObject({ code: 'PAYMENT_ORDER_MISMATCH' });
    await expect(amountMismatch.store.getPremiumUntil('user-1')).resolves.toBeNull();

    const missingOrder = harness({ orderId: 'other-order' });
    await missingOrder.payments.createOrder('user-1', 'monthly');
    await expect(missingOrder.payments.settleProviderCallback(new Request('https://madar.test/payments/callback', { method: 'POST' })))
      .rejects.toMatchObject({ code: 'PAYMENT_ORDER_MISMATCH' });
    await expect(missingOrder.store.getPremiumUntil('user-1')).resolves.toBeNull();
  });

  it('does not extend Premium twice for a duplicate provider callback', async () => {
    const { payments, store } = harness();
    await payments.createOrder('user-1', 'monthly');
    const callback = () => new Request('https://madar.test/payments/callback', { method: 'POST' });

    await expect(payments.settleProviderCallback(callback())).resolves.toMatchObject({ applied: true });
    const firstExpiry = await store.getPremiumUntil('user-1');
    await expect(payments.settleProviderCallback(callback())).resolves.toMatchObject({ applied: false });
    await expect(store.getPremiumUntil('user-1')).resolves.toBe(firstExpiry);
  });

  it('extends a renewal from the later of now or the current Premium expiry', async () => {
    const { payments, store, setNow } = harness();
    const firstOrder = await payments.createOrder('user-1', 'monthly');
    await payments.confirmOrder(firstOrder.id, 'admin-first');
    const firstExpiry = new Date(START.getTime() + 30 * DAY_MS);

    setNow(new Date(START.getTime() + 10 * DAY_MS));
    const renewal = await payments.createOrder('user-1', 'monthly');
    await expect(payments.confirmOrder(renewal.id, 'admin-renewal')).resolves.toMatchObject({
      applied: true,
      premiumUntil: new Date(firstExpiry.getTime() + 30 * DAY_MS).toISOString(),
    });

    await expect(store.getPremiumUntil('user-1')).resolves.toBe(new Date(firstExpiry.getTime() + 30 * DAY_MS).toISOString());
  });
});
