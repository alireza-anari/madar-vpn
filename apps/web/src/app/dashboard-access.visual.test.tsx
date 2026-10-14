import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DashboardPage, type AccountView } from './surfaces';
import { AccessPage } from './access-surface';

const premiumAccount: AccountView = {
  identity: { id: 'user-1', email: 'user@example.com', role: 'user' },
  entitlement: { freeSeconds: 0, premiumUntil: '2026-11-12T12:00:00.000Z', tier: 'premium' },
  node: { ready: true, connectionStatus: 'connected', configAvailable: true },
  providers: { email: true, ads: false, payments: true, push: true },
};

describe('neon dashboard and access surfaces', () => {
  it('renders a status-led dashboard from real fields without fake connect, throughput, or location data', () => {
    render(<DashboardPage account={premiumAccount} />);

    expect(screen.getByRole('group', { name: /وضعیت دسترسی: آماده/ })).toBeInTheDocument();
    expect(screen.getByText(/اتصال گزارش‌شده: متصل/)).toBeInTheDocument();
    expect(screen.getByText(/اشتراک پرمیوم/)).toBeInTheDocument();
    expect(screen.getByText(/۲۰۲۶/)).toBeInTheDocument();

    const accessLink = screen.getByRole('link', { name: /دریافت کانفیگ/ });
    expect(accessLink).toHaveAttribute('href', '/access');
    expect(screen.getByRole('link', { name: /اشتراک‌ها/ })).toHaveAttribute('href', '/premium');

    expect(screen.queryByRole('button', { name: /اتصال|قطع اتصال|وصل شو|connect/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/مگابیت|آپلود|دانلود/)).not.toBeInTheDocument();
    expect(screen.queryByText(/آلمان|فرانکفورت|Germany|Frankfurt/i)).not.toBeInTheDocument();
  });

  it('keeps the sensitive subscription URL behind the real issue action and exposes QR/copy only afterward', async () => {
    const issue = vi.fn(async () => ({
      subscriptionUrl: 'https://example.com/s/secret-token',
      version: 4,
    }));

    render(<AccessPage readiness={{ ready: true, eligibleNodeCount: 2 }} issue={issue} />);

    expect(screen.getByText(/۲ نود آماده/)).toBeInTheDocument();
    expect(screen.queryByLabelText('لینک اشتراک')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /کپی لینک/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /دریافت لینک اشتراک/ }));

    expect(await screen.findByLabelText('لینک اشتراک')).toHaveValue('https://example.com/s/secret-token');
    expect(screen.getByRole('img', { name: /QR لینک اشتراک/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /کپی لینک/ })).toBeInTheDocument();
    expect(issue).toHaveBeenCalledTimes(1);
  });
});
