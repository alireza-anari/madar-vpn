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

describe('admin abuse protection', () => {
  it('rate-limits admin routes before auth or database work without exposing the source IP in the limiter key', async () => {
    const limiter = rejectingLimiter();
    const authFactory = vi.fn(() => null);
    const surfaceFactory = vi.fn(() => null);
    const app = createApiApp(authFactory, surfaceFactory);
    const edgeSourceIp = '203.0.113.77';

    const response = await app.request(
      '/api/admin/overview',
      {
        headers: {
          'cf-connecting-ip': edgeSourceIp,
        },
      },
      { ADMIN_RATE_LIMITER: limiter.binding } as never,
    );

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('60');
    await expect(response.json()).resolves.toEqual({ error: 'RATE_LIMITED' });
    expect(authFactory).not.toHaveBeenCalled();
    expect(surfaceFactory).not.toHaveBeenCalled();
    expect(limiter.keys).toHaveLength(1);
    expect(limiter.keys[0]).toMatch(/^admin:/);
    expect(limiter.keys[0]).not.toContain(edgeSourceIp);
  });
});
