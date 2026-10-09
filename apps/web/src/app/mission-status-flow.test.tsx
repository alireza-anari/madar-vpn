import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

const account = {
  identity: { id: 'user-1', email: 'user@example.com', role: 'user' as const },
  entitlement: { freeSeconds: 1800, premiumUntil: null, tier: 'free' as const },
  node: { ready: false, connectionStatus: 'disconnected' as const, configAvailable: false },
  providers: { email: true, ads: false, payments: false, push: false },
};

const catalog = {
  plans: [],
  missions: [
    {
      id: 'profile-proof',
      title: 'تکمیل پروفایل',
      description: 'مدرک تکمیل را ارسال کنید.',
      rewardSeconds: 900,
      verificationKind: 'evidence' as const,
    },
    {
      id: 'photo-proof',
      title: 'تأیید تصویر',
      description: 'تصویر معتبر ارسال کنید.',
      rewardSeconds: 600,
      verificationKind: 'evidence' as const,
    },
    {
      id: 'invite-friend',
      title: 'دعوت دوست',
      description: 'ارجاع واقعی باید توسط سرور تأیید شود.',
      rewardSeconds: 1200,
      verificationKind: 'referral' as const,
    },
  ],
};

const statuses = [
  {
    id: 'submission-approved',
    missionId: 'profile-proof',
    status: 'approved' as const,
    submittedAt: '2026-10-08T09:00:00.000Z',
    reviewedAt: '2026-10-08T09:15:00.000Z',
    rejectionReason: null,
  },
  {
    id: 'submission-rejected',
    missionId: 'photo-proof',
    status: 'rejected' as const,
    submittedAt: '2026-10-08T10:00:00.000Z',
    reviewedAt: '2026-10-08T10:10:00.000Z',
    rejectionReason: 'مدرک کافی نیست.',
  },
  {
    id: 'submission-pending',
    missionId: 'invite-friend',
    status: 'pending' as const,
    submittedAt: '2026-10-08T11:00:00.000Z',
    reviewedAt: null,
    rejectionReason: null,
  },
];

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.pushState({}, '', '/');
});

describe('mission server status wiring', () => {
  it('renders authoritative pending, approved, and rejected submission states without browser-side reward claims', async () => {
    window.history.pushState({}, '', '/missions');
    const requested: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      if (url === '/api/health') return Response.json({ status: 'ok' });
      if (url === '/api/account') return Response.json(account);
      if (url === '/api/account/catalog') return Response.json(catalog);
      if (url === '/api/account/missions/submissions') return Response.json(statuses);
      return new Response(null, { status: 404 });
    }));

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'تکمیل پروفایل' })).toBeInTheDocument();
    expect(await screen.findByText('وضعیت: تأیید شد')).toBeInTheDocument();
    expect(screen.getByText('وضعیت: رد شد')).toBeInTheDocument();
    expect(screen.getByText('دلیل رد: مدرک کافی نیست.')).toBeInTheDocument();
    expect(screen.getByText('وضعیت: در انتظار بررسی')).toBeInTheDocument();
    expect(requested).toContain('/api/account/missions/submissions');
    expect(screen.queryByText(/پاداش اعمال شد/)).not.toBeInTheDocument();
  });
});
