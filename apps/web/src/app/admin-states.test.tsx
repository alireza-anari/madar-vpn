import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { AdminPage, type AdminOverviewView, type AdminResourcesView } from './surfaces';

const overview: AdminOverviewView = {
  counts: { users: 0, readyNodes: 0, plans: 0, missions: 0 },
  readiness: { nodes: false, email: false, ads: false, payments: false, push: false, speedEnforcement: false },
  settings: { freeSpeedKbps: 5000, notificationsEnabled: false },
};

const emptyResources: AdminResourcesView = {
  users: [],
  plans: [],
  missions: [],
  nodes: [],
  notificationDrafts: [],
  audit: [],
};

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.pushState({}, '', '/');
});

describe('admin state handling', () => {
  it('shows an explicit loading state while admin data is unresolved', () => {
    window.history.pushState({}, '', '/admin');
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));

    render(<App />);

    expect(screen.getByText('خواندن وضعیت واقعی')).toBeInTheDocument();
  });

  it('distinguishes a server error from an intentionally unavailable admin backend', async () => {
    window.history.pushState({}, '', '/admin');
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/health') return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
      if (url === '/api/admin/overview') return new Response(JSON.stringify({ error: 'boom' }), { status: 500 });
      return new Response(JSON.stringify(emptyResources), { status: 200 });
    }));

    const { unmount } = render(<App />);
    expect(await screen.findByText('خطا در خواندن پنل مدیریت')).toBeInTheDocument();
    unmount();

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/health') return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
      return new Response(JSON.stringify({ error: 'ADMIN_UNAVAILABLE' }), { status: 503 });
    }));

    render(<App />);
    expect(await screen.findByText('پنل مدیریت فعلاً قابل خواندن نیست')).toBeInTheDocument();
  });

  it('renders explicit empty states for real admin resource collections', () => {
    render(<AdminPage overview={overview} resources={emptyResources} mutationsAvailable={false} />);

    expect(screen.getByText('هیچ کاربر ثبت‌شده‌ای وجود ندارد.')).toBeInTheDocument();
    expect(screen.getByText('هیچ پلن واقعی ثبت نشده است.')).toBeInTheDocument();
    expect(screen.getByText('هیچ ماموریت واقعی ثبت نشده است.')).toBeInTheDocument();
    expect(screen.getByText('هیچ نود ثبت‌شده‌ای وجود ندارد.')).toBeInTheDocument();
    expect(screen.getByText('هیچ پیش‌نویس اعلانی ثبت نشده است.')).toBeInTheDocument();
    expect(screen.getByText('هنوز رویداد Audit ثبت نشده است.')).toBeInTheDocument();
  });

  it('labels the configured free-speed policy separately from unverified enforcement', () => {
    render(<AdminPage overview={overview} resources={emptyResources} mutationsAvailable={false} />);

    expect(screen.getByDisplayValue('5000')).toBeInTheDocument();
    expect(screen.getByText('اعمال محدودیت سرعت: آماده نیست')).toBeInTheDocument();
  });
});
