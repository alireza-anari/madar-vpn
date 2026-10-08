import { describe, expect, it } from 'vitest';
import { AuthError, MemoryAuthStore, createAuthService } from './index';

function cookie(token: string) {
  return `__Host-madar_session=${encodeURIComponent(token)}`;
}

async function authenticatedHarness() {
  const sent: string[] = [];
  let tokenNumber = 0;
  const auth = createAuthService({
    store: new MemoryAuthStore(),
    randomToken: () => `origin-secret-${++tokenNumber}`,
    sender: async ({ token }) => { sent.push(token); },
  });
  await auth.requestLogin('user@example.com');
  const session = await auth.consumeLoginToken(sent[0]!);
  return { auth, session };
}

describe('authenticated mutation origin validation', () => {
  it('rejects an explicitly cross-origin mutation even when its session and CSRF token are valid', async () => {
    const { auth, session } = await authenticatedHarness();
    const request = new Request('https://madar.example/api/account/orders', {
      method: 'POST',
      headers: {
        cookie: cookie(session.token),
        'x-csrf-token': session.csrfToken,
        origin: 'https://evil.example',
      },
    });

    await expect(auth.requireMutationUser(request)).rejects.toMatchObject<Partial<AuthError>>({
      status: 403,
      code: 'ORIGIN_INVALID',
    });
  });

  it('accepts the matching origin and preserves non-browser clients that omit Origin', async () => {
    const { auth, session } = await authenticatedHarness();
    const baseHeaders = {
      cookie: cookie(session.token),
      'x-csrf-token': session.csrfToken,
    };

    await expect(auth.requireMutationUser(new Request('https://madar.example/api/account/orders', {
      method: 'POST',
      headers: { ...baseHeaders, origin: 'https://madar.example' },
    }))).resolves.toMatchObject({ email: 'user@example.com' });

    await expect(auth.requireMutationUser(new Request('https://madar.example/api/account/orders', {
      method: 'POST',
      headers: baseHeaders,
    }))).resolves.toMatchObject({ email: 'user@example.com' });
  });
});
