import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AdminPage, type AdminOverviewView, type AdminResourcesView } from './surfaces';

const overview: AdminOverviewView = {
  counts: { users: 1, readyNodes: 0, plans: 1, missions: 1 },
  readiness: { nodes: false, email: false, ads: false, payments: false, push: false },
  settings: { freeSpeedKbps: 256, notificationsEnabled: false },
};

const resources: AdminResourcesView = {
  users: [{ id: 'admin-1', email: 'admin@example.com', role: 'admin' }],
  plans: [{
    id: 'basic',
    title: 'ماهانه',
    durationDays: 30,
    priceMinor: 1000,
    currency: 'IRR',
    enabled: true,
    createdAt: '2026-10-08T00:00:00.000Z',
    updatedAt: '2026-10-08T00:00:00.000Z',
  }],
  missions: [{
    id: 'referral',
    title: 'دعوت از دوست',
    description: 'پاداش پس از تأیید',
    rewardSeconds: 900,
    status: 'active',
    createdAt: '2026-10-08T00:00:00.000Z',
    updatedAt: '2026-10-08T00:00:00.000Z',
  }],
  nodes: [{
    id: 'node-1',
    name: 'تهران ۱',
    status: 'enrolled',
    lastSeenAt: null,
    createdAt: '2026-10-08T00:00:00.000Z',
  }],
  notificationDrafts: [{
    id: 'draft-1',
    title: 'یادآوری',
    body: 'اعتبار را بررسی کنید',
    target: 'all',
    createdBy: 'admin-1',
    createdAt: '2026-10-08T00:00:00.000Z',
    deliveryStatus: 'draft',
  }],
  audit: [{
    id: 'audit-1',
    actorUserId: 'admin-1',
    action: 'plan.upsert',
    details: { id: 'basic' },
    createdAt: '2026-10-08T00:00:00.000Z',
  }],
};

describe('admin resource console', () => {
  it('renders actual resources and keeps privileged forms disabled without the current CSRF token', () => {
    render(<AdminPage overview={overview} resources={resources} mutationsAvailable={false} />);

    expect(screen.getByText('admin@example.com')).toBeInTheDocument();
    expect(screen.getByText('ماهانه')).toBeInTheDocument();
    expect(screen.getByText('دعوت از دوست')).toBeInTheDocument();
    expect(screen.getByText('تهران ۱')).toBeInTheDocument();
    expect(screen.getByText('یادآوری')).toBeInTheDocument();
    expect(screen.getByText('plan.upsert')).toBeInTheDocument();
    expect(screen.getByText(/توکن CSRF این session/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /ذخیره پلن/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /ثبت ماموریت/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /ثبت نود/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /ذخیره پیش‌نویس/ })).toBeDisabled();
    expect(screen.queryByText(/credential|کانفیگ آماده|config ready/i)).not.toBeInTheDocument();
  });

  it('enables protected forms only when the current session has a CSRF token', () => {
    render(<AdminPage overview={overview} resources={resources} mutationsAvailable />);

    expect(screen.getByRole('button', { name: /ذخیره پلن/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: /ثبت ماموریت/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: /ثبت نود/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: /ذخیره پیش‌نویس/ })).toBeEnabled();
  });

  it('covers the full admin operating map without inventing unavailable integrations', () => {
    render(<AdminPage overview={overview} resources={resources} mutationsAvailable={false} />);

    expect(screen.getByText('اعتبار رایگان')).toBeInTheDocument();
    expect(screen.getByText('تنظیم پرمیوم')).toBeInTheDocument();
    expect(screen.getByText('تعلیق حساب')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /اعمال اعتبار رایگان/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /ثبت پرمیوم/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /تغییر وضعیت حساب/ })).toBeDisabled();

    expect(screen.getByText('پرداخت‌ها')).toBeInTheDocument();
    expect(screen.getByText('تبلیغات')).toBeInTheDocument();
    expect(screen.getByText('پاداش‌ها')).toBeInTheDocument();
    expect(screen.getByText('Push')).toBeInTheDocument();
    expect(screen.getByText('سلامت نود')).toBeInTheDocument();
    expect(screen.getByText('ظرفیت')).toBeInTheDocument();
    expect(screen.getByText('وضعیت Subscription')).toBeInTheDocument();
    expect(screen.getByText('چرخش دسترسی')).toBeInTheDocument();
    expect(screen.getAllByText(/هنوز آماده نیست|متصل نشده/).length).toBeGreaterThanOrEqual(4);
  });
});
