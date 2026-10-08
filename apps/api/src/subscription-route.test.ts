import { describe, expect, it } from 'vitest';
import { createApiApp } from './index';

type FakeSubscriptionService = {
  renderForToken(rawToken: string, now: Date): Promise<string | null>;
};

function appWithSubscriptions(service: FakeSubscriptionService) {
  return createApiApp(
    () => null,
    () => null,
    () => null,
    () => service,
  );
}

describe('subscription bearer route', () => {
  it('returns client-safe VLESS text with no-store for a valid active token', async () => {
    const app = appWithSubscriptions({
      async renderForToken(rawToken) {
        expect(rawToken).toBe('active-token');
        return [
          'vless://uuid@a.example.com:443?security=reality#A',
          'vless://uuid@b.example.com:443?security=reality#B',
        ].join('\n');
      },
    });

    const response = await app.request('/s/active-token');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-type')).toContain('text/plain');
    const body = await response.text();
    expect(body.split('\n')).toHaveLength(2);
    expect(body).toContain('a.example.com');
    expect(body).toContain('b.example.com');
    expect(body).not.toMatch(/private.?key|enrollment|internal.?api|node.?credential/i);
  });

  it('makes invalid and revoked bearer tokens indistinguishable and non-cacheable', async () => {
    const app = appWithSubscriptions({
      async renderForToken() {
        return null;
      },
    });

    const invalid = await app.request('/s/invalid-token');
    const revoked = await app.request('/s/revoked-token');

    expect(invalid.status).toBe(404);
    expect(revoked.status).toBe(404);
    expect(invalid.headers.get('cache-control')).toBe('no-store');
    expect(revoked.headers.get('cache-control')).toBe('no-store');
    expect(await invalid.text()).toBe(await revoked.text());
    expect(await app.request('/s/another-invalid-token').then((response) => response.text())).not.toMatch(/revoked|expired|user|version/i);
  });
});
