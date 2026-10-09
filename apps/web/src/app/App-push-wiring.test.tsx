import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

vi.mock('../pwa/PwaSettingsPage', () => ({
  PwaSettingsPage: ({ pushAvailable, subscribe }: { pushAvailable: boolean; subscribe?: () => Promise<boolean> }) => (
    <button type="button" disabled={!pushAvailable || !subscribe}>فعال‌کردن اعلان</button>
  ),
}));

const pushReadyAccount = {
  identity: { id: 'user-1', email: 'user@example.com', role: 'user' },
  entitlement: { freeSeconds: 900, premiumUntil: null, tier: 'free' },
  node: { ready: false, connectionStatus: 'disconnected', configAvailable: false },
  providers: { email: false, ads: false, payments: false, push: true },
};

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.pushState({}, '', '/');
});

describe('Madar push wiring', () => {
  it('provides a real subscription action when authenticated push readiness is true', async () => {
    window.history.pushState({}, '', '/settings');
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/health') return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
      if (url === '/api/account') return new Response(JSON.stringify(pushReadyAccount), { status: 200 });
      return new Response(null, { status: 404 });
    }));

    render(<App />);

    expect(await screen.findByRole('button', { name: /فعال‌کردن اعلان/ })).toBeEnabled();
  });
});
