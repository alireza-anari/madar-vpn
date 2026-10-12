import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MissionsCatalogPage } from './account-catalog-surface';

const submitEvidence = vi.fn(async () => ({ id: 'submission-2', status: 'pending' as const }));

const missions = [
  {
    id: 'evidence-1',
    title: 'ماموریت واقعی مدرک',
    description: 'مدرک معتبر را برای بررسی ارسال کنید.',
    rewardSeconds: 900,
    verificationKind: 'evidence' as const,
  },
  {
    id: 'referral-1',
    title: 'ماموریت واقعی ارجاع',
    description: 'ارجاع فقط پس از تأیید سرور معتبر است.',
    rewardSeconds: 1800,
    verificationKind: 'referral' as const,
  },
];

describe('neon missions catalog', () => {
  it('renders a mission-led hero and truthful real mission cards without fake provider actions', () => {
    render(
      <MissionsCatalogPage
        adsAvailable={false}
        missions={missions}
        statuses={[{
          id: 'submission-1',
          missionId: 'evidence-1',
          status: 'pending',
          submittedAt: '2026-10-12T10:00:00.000Z',
          reviewedAt: null,
          rejectionReason: null,
        }]}
        submitEvidence={submitEvidence}
      />,
    );

    expect(screen.getByRole('heading', { name: 'ماموریت‌ها', level: 1 })).toBeInTheDocument();
    expect(screen.getByText(/اعتبار فقط پس از تأیید سمت سرور/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'ماموریت واقعی مدرک' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'ماموریت واقعی ارجاع' })).toBeInTheDocument();
    expect(screen.getByText('پاداش: ۱۵ دقیقه')).toBeInTheDocument();
    expect(screen.getByText('پاداش: ۳۰ دقیقه')).toBeInTheDocument();
    expect(screen.getByText('وضعیت: در انتظار بررسی')).toBeInTheDocument();
    expect(screen.getByText(/تبلیغات هنوز متصل نشده/)).toBeInTheDocument();
    expect(screen.getByText(/ماموریت ارجاع فقط پس از تأیید رابطه واقعی توسط سرور/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /دیدن تبلیغ|ثبت ارجاع|دریافت فوری پاداش/ })).not.toBeInTheDocument();
  });

  it('keeps the real empty state instead of inventing missions or positive readiness', () => {
    render(
      <MissionsCatalogPage
        adsAvailable={false}
        missions={[]}
        statuses={[]}
        submitEvidence={submitEvidence}
      />,
    );

    expect(screen.getByText('ماموریت فعال واقعی وجود ندارد.')).toBeInTheDocument();
    expect(screen.queryByText(/آماده برای دریافت پاداش|ماموریت پیشنهادی|ماموریت نمونه/)).not.toBeInTheDocument();
  });
});
