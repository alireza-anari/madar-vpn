import { describe, expect, it, vi } from 'vitest';
import {
  ProviderUnavailableError,
  ProviderVerificationError,
  createPaymentProvider,
  createRewardedAdProvider,
  createUnavailableEmailProvider,
  createUnavailablePushProvider,
} from './index';

describe('provider verification contracts', () => {
  it('keeps unconfigured providers explicitly unavailable', async () => {
    const email = createUnavailableEmailProvider();
    const ads = createRewardedAdProvider();
    const payments = createPaymentProvider();
    const push = createUnavailablePushProvider();

    await expect(email.sendMagicLink({
      email: 'user@example.com',
      token: 'opaque-token',
      expiresAt: '2026-10-08T08:00:00.000Z',
    })).resolves.toBe('unavailable');

    await expect(ads.verifyCallback(new Request('https://madar.test/providers/ads/callback', { method: 'POST' })))
      .rejects.toBeInstanceOf(ProviderUnavailableError);
    await expect(payments.verifyCallback(new Request('https://madar.test/providers/payments/callback', { method: 'POST' })))
      .rejects.toBeInstanceOf(ProviderUnavailableError);
    await expect(push.send({ endpoint: 'https://push.test/subscription' }, { title: 'مدار', body: 'پیام' }))
      .resolves.toEqual({ status: 'unavailable' });
  });

  it('rejects a forged callback before provider payload parsing', async () => {
    const parse = vi.fn(async () => ({
      provider: 'fixture-ad',
      eventId: 'event-1',
      userId: 'user-1',
      occurredAt: '2026-10-08T07:00:00.000Z',
    }));
    const provider = createRewardedAdProvider({
      provider: 'fixture-ad',
      verify: async () => false,
      parse,
    });

    await expect(provider.verifyCallback(new Request('https://madar.test/callback', { method: 'POST', body: '{}' })))
      .rejects.toBeInstanceOf(ProviderVerificationError);
    expect(parse).not.toHaveBeenCalled();
  });

  it('returns verified events without receiving or invoking ledger settlement', async () => {
    const settleCredit = vi.fn();
    const ads = createRewardedAdProvider({
      provider: 'fixture-ad',
      verify: async () => true,
      parse: async () => ({
        provider: 'fixture-ad',
        eventId: 'event-2',
        userId: 'user-2',
        occurredAt: '2026-10-08T07:30:00.000Z',
      }),
    });
    const payments = createPaymentProvider({
      provider: 'fixture-pay',
      verify: async () => true,
      parse: async () => ({
        provider: 'fixture-pay',
        eventId: 'payment-1',
        orderId: 'order-1',
        amountMinor: 125000,
        currency: 'IRR',
        occurredAt: '2026-10-08T07:31:00.000Z',
      }),
    });

    await expect(ads.verifyCallback(new Request('https://madar.test/ad', { method: 'POST' }))).resolves.toMatchObject({
      eventId: 'event-2',
      userId: 'user-2',
    });
    await expect(payments.verifyCallback(new Request('https://madar.test/pay', { method: 'POST' }))).resolves.toMatchObject({
      eventId: 'payment-1',
      orderId: 'order-1',
    });
    expect(settleCredit).not.toHaveBeenCalled();
  });
});
