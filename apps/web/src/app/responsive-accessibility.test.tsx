import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PwaSettingsPage } from '../pwa/PwaSettingsPage';
import { AccessPage } from './access-surface';
import { PremiumCatalogPage } from './account-catalog-surface';

const account = {
  identity: {
    id: 'user-long',
    email: `${'very-long-account-segment.'.repeat(8)}user@example.com`,
    role: 'user' as const,
  },
  entitlement: { freeSeconds: 1800, premiumUntil: null, tier: 'free' as const },
};

describe('responsive and accessibility acceptance', () => {
  it('isolates a long account email and leaves every settings control with an accessible name', () => {
    render(
      <PwaSettingsPage
        account={account}
        pushAvailable={false}
        notificationSupported={false}
      />,
    );

    const email = screen.getByText(account.identity.email);
    expect(email).toHaveAttribute('dir', 'ltr');

    for (const button of screen.getAllByRole('button')) {
      expect(button).toHaveAccessibleName();
    }
  });

  it('keeps a long bearer subscription URL readonly, LTR-isolated, and explicitly labelled', async () => {
    const longUrl = `https://app.example.test/s/${'bearer-secret-segment-'.repeat(18)}`;
    const issue = vi.fn(async () => ({ subscriptionUrl: longUrl, version: 9 }));

    render(<AccessPage readiness={{ ready: true, eligibleNodeCount: 1 }} issue={issue} />);
    fireEvent.click(screen.getByRole('button', { name: 'دریافت لینک اشتراک' }));

    const field = await screen.findByRole('textbox', { name: 'لینک اشتراک' });
    expect(field).toHaveValue(longUrl);
    expect(field).toHaveAttribute('dir', 'ltr');
    expect(field).toHaveAttribute('readonly');
    expect(screen.getByRole('img', { name: 'QR لینک اشتراک' })).toBeInTheDocument();

    for (const button of screen.getAllByRole('button')) {
      expect(button).toHaveAccessibleName();
    }
  });

  it('renders long backend plan values without replacing them with a frontend shorthand', () => {
    const longTitle = 'پلن واقعی با عنوان بسیار طولانی برای بررسی چیدمان باریک و مقدار سروری';
    const longCurrency = 'SERVER-CURRENCY-CODE-WITH-LONG-LABEL';
    render(
      <PremiumCatalogPage
        paymentAvailable={false}
        plans={[{
          id: 'long-plan',
          title: longTitle,
          durationDays: 365,
          priceMinor: 987654321,
          currency: longCurrency,
        }]}
      />,
    );

    expect(screen.getByRole('heading', { name: longTitle })).toBeInTheDocument();
    expect(screen.getByText(new RegExp(longCurrency))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'خرید' })).toBeDisabled();
  });
});
