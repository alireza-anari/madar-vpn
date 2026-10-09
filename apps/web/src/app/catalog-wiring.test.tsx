import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

const account = {
  identity: { id: 'user-1', email: 'user@example.com', role: 'user' as const },
  entitlement: { freeSeconds: 1800, premiumUntil: null, tier: 'free' as const },
  node: { ready: false, connectionStatus: 'disconnected' as const, configAvailable: false },
  providers: { email: true, ads: true, payments: true, push: false },
};

const catalog = {
  plans: [{ id: 'monthly', title: 'یک‌ماهه', durationDays: 30, priceMinor: 250000, currency: 'IRR' }],
  missions: [{
    id: 'profile-proof',
    title: 'تکمیل پروفایل',
    description: 'مدرک تکمیل را ارسال کنید.',
    rewardSeconds: 900,
    verificationKind: 'evidence' as const,
  }],
};

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.pushState({}, '', '/');
});

function stubCatalogApi() {
  const requested: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    requested.push(url);
    if (url === '/api/health') return Response.json({ status: 'ok' });
    if (url === '/api/account') return Response.json(account);
    if (url === '/api/account/catalog') return Response.json(catalog);
    if (url === '/api/account/missions/submissions') return Response.json([]);
    return new Response(null, { status: 404 });
  }));
  return requested;
}

describe('user catalog wiring', () => {
  it('renders enabled premium plans from the authenticated catalog without enabling an unwired purchase action', async () => {
    window.history.pushState({}, '', '/premium');
    const requested = stubCatalogApi();

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'بسته‌های پرمیوم' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'یک‌ماهه' })).toBeInTheDocument();
    expect(screen.getByText('۳۰ روز')).toBeInTheDocument();
    expect(screen.getByText(/۲۵۰[٬,]?۰۰۰/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'خرید' })).toBeDisabled();
    expect(requested).toContain('/api/account/catalog');
  });

  it('renders active missions from the authenticated catalog without exposing a fake start action', async () => {
    window.history.pushState({}, '', '/missions');
    const requested = stubCatalogApi();

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'اعتبار قابل دریافت' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'تکمیل پروفایل' })).toBeInTheDocument();
    expect(screen.getByText('مدرک تکمیل را ارسال کنید.')).toBeInTheDocument();
    expect(screen.getByText('پاداش: ۱۵ دقیقه')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'شروع ماموریت' })).toBeDisabled();
    expect(requested).toContain('/api/account/catalog');
    expect(requested).toContain('/api/account/missions/submissions');
  });
});
