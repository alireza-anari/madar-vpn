import { describe, expect, it } from 'vitest';
import { createAuthService, MemoryAuthStore } from './auth';
import { createApiApp } from './index';

function cookiePair(setCookie: string) {
  return setCookie.split(';', 1)[0]!;
}

describe('auth HTTP boundary', () => {
  it('reports login as unavailable when no email provider is configured', async () => {
    const auth = createAuthService({ store: new MemoryAuthStore() });
    const app = createApiApp(() => auth);

    const response = await app.request('/api/auth/request', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'user@example.com' }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'unavailable' });
  });

  it('sets the secure session cookie without exposing its token in JSON', async () => {
    const sent: string[] = [];
    let number = 0;
    const auth = createAuthService({
      store: new MemoryAuthStore(),
      randomToken: () => `route-secret-${++number}`,
      sender: async ({ token }) => {
        sent.push(token);
      },
    });
    const app = createApiApp(() => auth);

    const requestResponse = await app.request('/api/auth/request', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'user@example.com' }),
    });
    expect(requestResponse.status).toBe(200);

    const consumeResponse = await app.request('/api/auth/consume', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: sent[0] }),
    });
    const payload = (await consumeResponse.json()) as Record<string, unknown>;
    const setCookie = consumeResponse.headers.get('set-cookie') ?? '';

    expect(consumeResponse.status).toBe(200);
    expect(setCookie).toContain('__Host-madar_session=route-secret-2');
    expect(setCookie).toContain('HttpOnly');
    expect(payload).toEqual({
      csrfToken: 'route-secret-3',
      expiresAt: expect.any(String),
    });
    expect(JSON.stringify(payload)).not.toContain('route-secret-2');

    const accountResponse = await app.request('/api/account/identity', {
      headers: { cookie: cookiePair(setCookie) },
    });
    expect(accountResponse.status).toBe(200);
    await expect(accountResponse.json()).resolves.toMatchObject({
      email: 'user@example.com',
      role: 'user',
    });
  });

  it('maps anonymous and non-admin authorization failures to HTTP status codes', async () => {
    const sent: string[] = [];
    const auth = createAuthService({
      store: new MemoryAuthStore(),
      sender: async ({ token }) => {
        sent.push(token);
      },
    });
    const app = createApiApp(() => auth);

    const anonymous = await app.request('/api/account/identity');
    expect(anonymous.status).toBe(401);
    await expect(anonymous.json()).resolves.toEqual({ error: 'AUTH_REQUIRED' });

    await app.request('/api/auth/request', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'user@example.com' }),
    });
    const consume = await app.request('/api/auth/consume', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: sent[0] }),
    });
    const userCookie = cookiePair(consume.headers.get('set-cookie') ?? '');

    const admin = await app.request('/api/admin/identity', {
      headers: { cookie: userCookie },
    });
    expect(admin.status).toBe(403);
    await expect(admin.json()).resolves.toEqual({ error: 'ADMIN_REQUIRED' });
  });
});
