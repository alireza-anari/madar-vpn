import { describe, expect, it, vi } from 'vitest';
import { createApiApp } from './index';

function rejectingLimiter() {
  const keys: string[] = [];
  return {
    keys,
    binding: {
      async limit({ key }: { key: string }) {
        keys.push(key);
        return { success: false };
      },
    },
  };
}

describe('provider callback abuse protection', () => {
  it.each([
    {
      path: '/api/providers/ads/callback',
      scope: 'provider-ad:',
      factory: 'ads' as const,
    },
    {
      path: '/api/providers/payments/callback',
      scope: 'provider-payment:',
      factory: 'payments' as const,
    },
  ])('rate-limits $factory callbacks before provider verification/settlement', async ({ path, scope, factory }) => {
    const limiter = rejectingLimiter();
    const rewardedAdFactory = vi.fn(() => null);
    const paymentFactory = vi.fn(() => null);
    const app = createApiApp(
      undefined,
      undefined,
      rewardedAdFactory as never,
      undefined,
      paymentFactory as never,
    );
    const edgeSourceIp = '203.0.113.42';

    const response = await app.request(
      path,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'cf-connecting-ip': edgeSourceIp,
        },
        body: JSON.stringify({ eventId: 'attacker-controlled-payload' }),
      },
      { PROVIDER_CALLBACK_RATE_LIMITER: limiter.binding } as never,
    );

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('60');
    await expect(response.json()).resolves.toEqual({ error: 'RATE_LIMITED' });
    expect(rewardedAdFactory).not.toHaveBeenCalled();
    expect(paymentFactory).not.toHaveBeenCalled();
    expect(limiter.keys).toHaveLength(1);
    expect(limiter.keys[0]).toMatch(new RegExp(`^${scope}`));
    expect(limiter.keys[0]).not.toContain(edgeSourceIp);
    expect(limiter.keys[0]).not.toContain('attacker-controlled-payload');
    expect(factory === 'ads' || factory === 'payments').toBe(true);
  });
});
