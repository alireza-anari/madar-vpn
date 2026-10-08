import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  AdminPage,
  DashboardPage,
  LoginPage,
  MissionsPage,
  PremiumPage,
  SettingsPage,
  type AccountView,
  type AdminOverviewView,
} from './surfaces';

const account: AccountView = {
  identity: { id: 'user-1', email: 'user@example.com', role: 'user' },
  entitlement: { freeSeconds: 1800, premiumUntil: null, tier: 'free' },
  node: { ready: false, connectionStatus: 'disconnected', configAvailable: false },
  providers: { email: false, ads: false, payments: false, push: false },
};

const overview: AdminOverviewView = {
  counts: { users: 7, readyNodes: 0, plans: 0, missions: 0 },
  readiness: { nodes: false, email: false, ads: false, payments: false, push: false },
  settings: { freeSpeedKbps: 256, notificationsEnabled: false },
};

describe('approved account surfaces', () => {
  it('renders dashboard from real account state without an invented connect action or config', () => {
    render(<DashboardPage account={account} />);

    expect(screen.getByText('۳۰ دقیقه')).toBeInTheDocument();
    expect(screen.getByText('قطع')).toBeInTheDocument();
    expect(screen.getByText(/پیکربندی VPN هنوز آماده نیست/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /کپی پیکربندی/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /نمایش QR/ })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /اتصال|وصل شو|connect/i })).not.toBeInTheDocument();
  });

  it('keeps email login honest when the provider is unavailable', () => {
    render(<LoginPage emailAvailable={false} />);

    expect(screen.getByRole('textbox', { name: /ایمیل/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /ارسال لینک ورود/ })).toBeDisabled();
    expect(screen.getByText(/سرویس ایمیل هنوز متصل نشده/)).toBeInTheDocument();
  });

  it('shows unavailable purchase and mission states instead of fabricated success', () => {
    const { rerender } = render(<PremiumPage paymentAvailable={false} plans={[]} />);
    expect(screen.getByText(/پرداخت هنوز فعال نیست/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /خرید/ })).not.toBeInTheDocument();

    rerender(<MissionsPage adsAvailable={false} missions={[]} />);
    expect(screen.getByText(/ماموریت فعال واقعی وجود ندارد/)).toBeInTheDocument();
    expect(screen.getByText(/تبلیغات هنوز متصل نشده/)).toBeInTheDocument();
  });

  it('keeps installation settings usable when notifications are unavailable', () => {
    render(<SettingsPage pushAvailable={false} installSupported={false} />);

    expect(screen.getByText(/نصب روی iPhone/i)).toBeInTheDocument();
    expect(screen.getByText(/افزودن به صفحه اصلی/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /فعال‌کردن اعلان/ })).toBeDisabled();
  });

  it('renders actual admin counts and readiness with privileged settings controls', () => {
    render(<AdminPage overview={overview} />);

    expect(screen.getByText('۷')).toBeInTheDocument();
    expect(screen.getByText(/۰ نود آماده/)).toBeInTheDocument();
    expect(screen.getByLabelText(/سرعت رایگان/)).toHaveValue(256);
    expect(screen.getByRole('button', { name: /ذخیره تنظیمات/ })).toBeInTheDocument();
    expect(screen.getByText(/ایمیل: آماده نیست/)).toBeInTheDocument();
    expect(screen.getByText(/پرداخت: آماده نیست/)).toBeInTheDocument();
  });
});
