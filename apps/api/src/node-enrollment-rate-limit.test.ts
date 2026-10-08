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

describe('node enrollment abuse protection', () => {
  it('rate-limits one-time enrollment tokens before node service creation without exposing the raw token', async () => {
    const limiter = rejectingLimiter();
    const nodeFactory = vi.fn(() => null);
    const app = createApiApp(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      nodeFactory as never,
    );
    const rawToken = 'one-time-enrollment-secret-must-not-be-a-rate-limit-key';

    const response = await app.request(
      '/api/node/enroll',
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${rawToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ capabilities: {}, publicConfig: {} }),
      },
      { NODE_ENROLLMENT_RATE_LIMITER: limiter.binding } as never,
    );

    expect(response.status).toBe(429);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('retry-after')).toBe('60');
    await expect(response.json()).resolves.toEqual({ error: 'RATE_LIMITED' });
    expect(nodeFactory).not.toHaveBeenCalled();
    expect(limiter.keys).toHaveLength(1);
    expect(limiter.keys[0]).toMatch(/^node-enrollment:/);
    expect(limiter.keys[0]).not.toContain(rawToken);
  });
});
