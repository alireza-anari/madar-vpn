import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

const subscriptionUrl = 'https://app.example.test/s/bearer-subscription-secret';

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.pushState({}, '', '/');
});

describe('VPN access flow', () => {
  it('issues and copies only the subscription URL when an eligible node exists', async () => {
    window.history.pushState({}, '', '/access');
    const copy = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: copy },
    });
    const requested: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requested.push({ url, init });
      if (url === '/api/health') return Response.json({ status: 'ok' });
      if (url === '/api/account/access') return Response.json({ ready: true, eligibleNodeCount: 1 });
      if (url === '/api/auth/csrf') return Response.json({ csrfToken: 'access-csrf' });
      if (url === '/api/account/access/subscription-url') {
        expect(init).toMatchObject({
          method: 'POST',
          credentials: 'include',
          headers: { 'x-csrf-token': 'access-csrf' },
        });
        return Response.json({ subscriptionUrl, version: 1 }, { status: 201 });
      }
      return new Response(null, { status: 404 });
    }));

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'دسترسی VPN' })).toBeInTheDocument();
    expect(screen.getByText('۱ نود آماده')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /اتصال|connect/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'صدور لینک اشتراک' }));

    const linkField = await screen.findByRole('textbox', { name: 'لینک اشتراک' });
    expect(linkField).toHaveValue(subscriptionUrl);
    expect(linkField).toHaveAttribute('readonly');

    const qr = screen.getByRole('img', { name: 'QR لینک اشتراک' });
    expect(qr).toHaveAttribute('src', expect.stringMatching(/^data:image\/svg\+xml,/));
    expect(qr.getAttribute('src')).not.toContain(subscriptionUrl);

    fireEvent.click(screen.getByRole('button', { name: 'کپی لینک' }));
    await waitFor(() => expect(copy).toHaveBeenCalledWith(subscriptionUrl));
    expect(requested.map(({ url }) => url)).toContain('/api/account/access/subscription-url');
    expect(requested.every(({ url }) => url.startsWith('/api/'))).toBe(true);
  });

  it('keeps issuance disabled and explains unavailable access when no eligible node exists', async () => {
    window.history.pushState({}, '', '/access');
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/health') return Response.json({ status: 'ok' });
      if (url === '/api/account/access') return Response.json({ ready: false, eligibleNodeCount: 0 });
      return new Response(null, { status: 404 });
    }));

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'دسترسی VPN' })).toBeInTheDocument();
    expect(screen.getByText('فعلاً نود آماده‌ای برای صدور لینک وجود ندارد.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'صدور لینک اشتراک' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /اتصال|connect/i })).not.toBeInTheDocument();
  });
});
