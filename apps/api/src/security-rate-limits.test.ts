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

describe('abuse-sensitive route rate limits', () => {
  it('rate-limits login requests before auth/provider work and never uses the raw email as the limiter key', async () => {
    const limiter = rejectingLimiter();
    const authFactory = vi.fn(() => null);
    const app = createApiApp(authFactory);

    const response = await app.request(
      '/api/auth/request',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'User+Sensitive@example.com' }),
      },
      { LOGIN_RATE_LIMITER: limiter.binding } as never,
    );

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('60');
    await expect(response.json()).resolves.toEqual({ error: 'RATE_LIMITED' });
    expect(authFactory).not.toHaveBeenCalled();
    expect(limiter.keys).toHaveLength(1);
    expect(limiter.keys[0]).toMatch(/^login:/);
    expect(limiter.keys[0]).not.toContain('User+Sensitive@example.com');
    expect(limiter.keys[0]).not.toContain('user+sensitive@example.com');
  });

  it('rate-limits subscription fetches before token lookup and never uses the raw bearer token as the limiter key', async () => {
    const limiter = rejectingLimiter();
    const renderForToken = vi.fn(async () => 'must-not-render');
    const subscriptionFactory = vi.fn(() => ({ renderForToken }));
    const app = createApiApp(
      undefined,
      undefined,
      undefined,
      subscriptionFactory as never,
    );
    const rawToken = 'subscription-secret-must-not-be-a-rate-limit-key';

    const response = await app.request(
      `/s/${rawToken}`,
      undefined,
      { SUBSCRIPTION_RATE_LIMITER: limiter.binding } as never,
    );

    expect(response.status).toBe(429);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('retry-after')).toBe('60');
    expect(await response.text()).toBe('Too Many Requests');
    expect(subscriptionFactory).not.toHaveBeenCalled();
    expect(renderForToken).not.toHaveBeenCalled();
    expect(limiter.keys).toHaveLength(1);
    expect(limiter.keys[0]).toMatch(/^subscription:/);
    expect(limiter.keys[0]).not.toContain(rawToken);
  });
});
