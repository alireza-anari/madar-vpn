import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

const overview = {
  counts: { users: 1, readyNodes: 0, plans: 1, missions: 1 },
  readiness: { nodes: false, email: false, ads: false, payments: false, push: false },
  settings: { freeSpeedKbps: 256, notificationsEnabled: false },
};

const account = {
  identity: { id: 'user-1', email: 'user@example.com', role: 'user' },
  entitlement: { freeSeconds: 900, premiumUntil: null, tier: 'free' },
  node: { ready: false, connectionStatus: 'disconnected', configAvailable: false },
  providers: { email: false, ads: false, payments: false, push: false },
};

const resources = {
  users: [{ id: 'user-1', email: 'admin@example.com', role: 'admin' }],
  plans: [{
    id: 'plan-1',
    title: 'ماهانه',
    durationDays: 30,
    priceMinor: 100000,
    currency: 'IRR',
    enabled: true,
    createdAt: '2026-10-08T00:00:00.000Z',
    updatedAt: '2026-10-08T00:00:00.000Z',
  }],
  missions: [],
  nodes: [],
  notificationDrafts: [],
  audit: [],
};

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.pushState({}, '', '/');
});

describe('Madar web bootstrap', () => {
  it('renders the Persian product identity in an RTL root', () => {
    const { container } = render(<App />);
    expect(screen.getByText('مدار')).toBeInTheDocument();
    expect(container.firstElementChild).toHaveAttribute('dir', 'rtl');
  });

  it('loads both the admin overview and real admin resources for /admin', async () => {
    window.history.pushState({}, '', '/admin');
    const requested: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      if (url === '/api/health') return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
      if (url === '/api/admin/overview') return new Response(JSON.stringify(overview), { status: 200 });
      if (url === '/api/admin/resources') return new Response(JSON.stringify(resources), { status: 200 });
      return new Response(null, { status: 404 });
    }));

    render(<App />);

    expect(await screen.findByText('ماهانه')).toBeInTheDocument();
    expect(requested).toContain('/api/admin/overview');
    expect(requested).toContain('/api/admin/resources');
  });

  it('routes /settings through the user-gesture PWA controls', async () => {
    window.history.pushState({}, '', '/settings');
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/health') return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
      if (url === '/api/account') return new Response(JSON.stringify(account), { status: 200 });
      return new Response(null, { status: 404 });
    }));

    render(<App />);

    expect(await screen.findByText('مرورگر فقط پس از فشردن دکمه زیر مجوز اعلان را درخواست می‌کند.')).toBeInTheDocument();
  });
});
