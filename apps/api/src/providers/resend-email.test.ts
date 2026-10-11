import { describe, expect, it } from 'vitest';
import { MemoryAuthStore, createAuthService } from '../auth';
import { createResendMagicLinkSender } from './resend-email';

describe('Resend magic-link email provider', () => {
  it('sends an allowlisted magic link through Resend without exposing the API key in the body', async () => {
    const requests: Request[] = [];
    const sender = createResendMagicLinkSender({
      apiKey: 're_test_secret',
      from: 'Madar <onboarding@resend.dev>',
      baseUrl: 'https://madar-staging.example.workers.dev',
      allowedEmails: ['Tester@Example.com'],
      fetcher: async (input, init) => {
        requests.push(new Request(input, init));
        return new Response(JSON.stringify({ id: 'email-1' }), { status: 200 });
      },
    });

    await expect(sender({
      email: 'tester@example.com',
      token: 'magic-token_123',
      expiresAt: '2026-10-12T12:15:00.000Z',
    })).resolves.toBe('sent');

    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.url).toBe('https://api.resend.com/emails');
    expect(request.headers.get('authorization')).toBe('Bearer re_test_secret');
    const body = await request.json() as Record<string, unknown>;
    expect(body.from).toBe('Madar <onboarding@resend.dev>');
    expect(body.to).toEqual(['tester@example.com']);
    expect(String(body.html)).toContain('https://madar-staging.example.workers.dev/login#token=magic-token_123');
    expect(String(body.text)).toContain('https://madar-staging.example.workers.dev/login#token=magic-token_123');
    expect(JSON.stringify(body)).not.toContain('re_test_secret');
  });

  it('refuses recipients outside the staging allowlist without calling Resend', async () => {
    let calls = 0;
    const sender = createResendMagicLinkSender({
      apiKey: 're_test_secret',
      from: 'Madar <onboarding@resend.dev>',
      baseUrl: 'https://madar-staging.example.workers.dev',
      allowedEmails: ['tester@example.com'],
      fetcher: async () => {
        calls += 1;
        return new Response(null, { status: 200 });
      },
    });

    await expect(sender({
      email: 'other@example.com',
      token: 'magic-token',
      expiresAt: '2026-10-12T12:15:00.000Z',
    })).resolves.toBe('unavailable');
    expect(calls).toBe(0);
  });

  it('fails closed when Resend rejects or cannot complete the request', async () => {
    const rejected = createResendMagicLinkSender({
      apiKey: 're_test_secret',
      from: 'Madar <onboarding@resend.dev>',
      baseUrl: 'https://madar-staging.example.workers.dev',
      allowedEmails: ['tester@example.com'],
      fetcher: async () => new Response('no', { status: 500 }),
    });
    await expect(rejected({
      email: 'tester@example.com',
      token: 'magic-token',
      expiresAt: '2026-10-12T12:15:00.000Z',
    })).resolves.toBe('unavailable');

    const failed = createResendMagicLinkSender({
      apiKey: 're_test_secret',
      from: 'Madar <onboarding@resend.dev>',
      baseUrl: 'https://madar-staging.example.workers.dev',
      allowedEmails: ['tester@example.com'],
      fetcher: async () => { throw new Error('network down'); },
    });
    await expect(failed({
      email: 'tester@example.com',
      token: 'magic-token',
      expiresAt: '2026-10-12T12:15:00.000Z',
    })).resolves.toBe('unavailable');
  });

  it('propagates provider unavailability instead of claiming that a login email was sent', async () => {
    const auth = createAuthService({
      store: new MemoryAuthStore(),
      randomToken: () => 'magic-token',
      sender: async () => 'unavailable',
    });

    await expect(auth.requestLogin('tester@example.com')).resolves.toEqual({ status: 'unavailable' });
  });
});
