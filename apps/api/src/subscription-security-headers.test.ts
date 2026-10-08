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

function expectBearerPrivacyHeaders(response: Response) {
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow, noarchive');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
}

describe('subscription bearer privacy headers', () => {
  it('sets leak-resistant headers for valid and invalid subscription bearer URLs', async () => {
    const validApp = appWithSubscriptions({
      async renderForToken() {
        return 'vless://uuid@node.example.com:443?security=reality#Madar';
      },
    });
    const invalidApp = appWithSubscriptions({
      async renderForToken() {
        return null;
      },
    });

    const valid = await validApp.request('/s/sensitive-valid-token');
    const invalid = await invalidApp.request('/s/sensitive-invalid-token');

    expect(valid.status).toBe(200);
    expect(invalid.status).toBe(404);
    expectBearerPrivacyHeaders(valid);
    expectBearerPrivacyHeaders(invalid);
  });
});
