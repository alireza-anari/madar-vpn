import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

const account = {
  identity: { id: 'user-1', email: 'settings@example.com', role: 'user' as const },
  entitlement: { freeSeconds: 600, premiumUntil: null, tier: 'free' as const },
  node: { ready: false, connectionStatus: 'disconnected' as const, configAvailable: false },
  providers: { email: true, ads: false, payments: false, push: false },
};

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.pushState({}, '', '/');
});

function stubSettingsAccount(response: Response) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/api/health') return Response.json({ status: 'ok' });
    if (url === '/api/account') return response;
    return new Response(null, { status: 404 });
  }));
}

describe('settings account route', () => {
  it('waits for a real ready account before rendering the profile surface', async () => {
    window.history.pushState({}, '', '/settings');
    stubSettingsAccount(Response.json(account));

    render(<App />);

    expect(await screen.findByText('settings@example.com')).toHaveAttribute('dir', 'ltr');
  });

  it('preserves unavailable and error account states instead of rendering settings with fabricated identity', async () => {
    window.history.pushState({}, '', '/settings');
    stubSettingsAccount(new Response(null, { status: 503 }));
    const first = render(<App />);
    expect(await screen.findByRole('heading', { name: 'اطلاعات حساب فعلاً قابل خواندن نیست' })).toBeInTheDocument();
    first.unmount();

    stubSettingsAccount(new Response(null, { status: 500 }));
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'خطا در خواندن اطلاعات حساب' })).toBeInTheDocument();
  });
});
