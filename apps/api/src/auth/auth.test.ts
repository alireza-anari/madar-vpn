import { describe, expect, it } from 'vitest';
import {
  AuthError,
  MemoryAuthStore,
  createAuthService,
  serializeSessionCookie,
} from './index';

function createHarness(options: { adminEmails?: string[]; withSender?: boolean } = {}) {
  let now = new Date('2026-10-08T00:00:00.000Z');
  let tokenNumber = 0;
  const sent: Array<{ email: string; token: string; expiresAt: string }> = [];
  const store = new MemoryAuthStore();
  const service = createAuthService({
    store,
    adminEmails: options.adminEmails ?? [],
    now: () => now,
    randomToken: () => `test-secret-${++tokenNumber}`,
    sender:
      options.withSender === false
        ? undefined
        : async (message) => {
            sent.push(message);
          },
  });

  return {
    service,
    store,
    sent,
    setNow(value: string) {
      now = new Date(value);
    },
  };
}

function expectAuthError(error: unknown, status: number, code: string) {
  expect(error).toBeInstanceOf(AuthError);
  expect((error as AuthError).status).toBe(status);
  expect((error as AuthError).code).toBe(code);
}

describe('email identity and sessions', () => {
  it('reports unavailable when the email sender is not configured', async () => {
    const { service, store } = createHarness({ withSender: false });

    await expect(service.requestLogin('user@example.com')).resolves.toEqual({ status: 'unavailable' });
    expect(store.loginTokens.size).toBe(0);
  });

  it('stores a hash of the one-time login token and normalizes email', async () => {
    const { service, store, sent } = createHarness();

    await expect(service.requestLogin('  User@Example.COM ')).resolves.toEqual({ status: 'sent' });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.email).toBe('user@example.com');
    expect(sent[0]?.token).toBe('test-secret-1');
    expect(store.loginTokens.has('test-secret-1')).toBe(false);
    expect([...store.loginTokens.keys()][0]).toMatch(/^[a-f0-9]{64}$/);
  });

  it('consumes a login token once, creates a secure session, and rejects replay', async () => {
    const { service, sent } = createHarness();
    await service.requestLogin('user@example.com');

    const session = await service.consumeLoginToken(sent[0]!.token);
    expect(session.userId).toBeTruthy();
    expect(session.token).toBe('test-secret-2');
    expect(session.csrfToken).toBe('test-secret-3');

    const request = new Request('https://madar.example/api/account', {
      headers: { cookie: `__Host-madar_session=${session.token}` },
    });
    await expect(service.requireUser(request)).resolves.toMatchObject({
      id: session.userId,
      email: 'user@example.com',
      role: 'user',
    });

    await expect(service.consumeLoginToken(sent[0]!.token)).rejects.toSatisfy((error: unknown) => {
      expectAuthError(error, 401, 'TOKEN_INVALID');
      return true;
    });
  });

  it('rejects an expired login token', async () => {
    const { service, sent, setNow } = createHarness();
    await service.requestLogin('user@example.com');
    setNow('2026-10-08T00:16:00.000Z');

    await expect(service.consumeLoginToken(sent[0]!.token)).rejects.toSatisfy((error: unknown) => {
      expectAuthError(error, 401, 'TOKEN_INVALID');
      return true;
    });
  });

  it('rejects anonymous API access', async () => {
    const { service } = createHarness();

    await expect(service.requireUser(new Request('https://madar.example/api/account'))).rejects.toSatisfy(
      (error: unknown) => {
        expectAuthError(error, 401, 'AUTH_REQUIRED');
        return true;
      },
    );
  });

  it('denies administration to a normal user', async () => {
    const { service, sent } = createHarness();
    await service.requestLogin('user@example.com');
    const session = await service.consumeLoginToken(sent[0]!.token);
    const request = new Request('https://madar.example/api/admin/overview', {
      headers: { cookie: `__Host-madar_session=${session.token}` },
    });

    await expect(service.requireAdmin(request)).rejects.toSatisfy((error: unknown) => {
      expectAuthError(error, 403, 'ADMIN_REQUIRED');
      return true;
    });
  });

  it('provisions administrator role only from the server allowlist', async () => {
    const { service, sent } = createHarness({ adminEmails: ['ADMIN@example.com'] });
    await service.requestLogin('admin@example.com');
    const session = await service.consumeLoginToken(sent[0]!.token);
    const request = new Request('https://madar.example/api/admin/overview', {
      headers: { cookie: `__Host-madar_session=${session.token}` },
    });

    await expect(service.requireAdmin(request)).resolves.toMatchObject({
      email: 'admin@example.com',
      role: 'admin',
    });
  });

  it('serializes the session cookie with host-only secure attributes', async () => {
    const cookie = serializeSessionCookie('session-secret', new Date('2026-11-07T00:00:00.000Z'));

    expect(cookie).toContain('__Host-madar_session=session-secret');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).not.toMatch(/Domain=/i);
  });

  it('requires the session CSRF token for protected mutations', async () => {
    const { service, sent } = createHarness();
    await service.requestLogin('user@example.com');
    const session = await service.consumeLoginToken(sent[0]!.token);

    const withoutCsrf = new Request('https://madar.example/api/account', {
      method: 'POST',
      headers: { cookie: `__Host-madar_session=${session.token}` },
    });
    await expect(service.requireMutationUser(withoutCsrf)).rejects.toSatisfy((error: unknown) => {
      expectAuthError(error, 403, 'CSRF_INVALID');
      return true;
    });

    const withCsrf = new Request('https://madar.example/api/account', {
      method: 'POST',
      headers: {
        cookie: `__Host-madar_session=${session.token}`,
        'x-csrf-token': session.csrfToken,
      },
    });
    await expect(service.requireMutationUser(withCsrf)).resolves.toMatchObject({ email: 'user@example.com' });
  });
});
