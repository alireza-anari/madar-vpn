import { render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PremiumCatalogPage } from './account-catalog-surface';

const plans = [
  { id: 'one', title: 'یک‌ماهه واقعی', durationDays: 30, priceMinor: 321000, currency: 'IRR' },
  { id: 'three', title: 'سه‌ماهه واقعی', durationDays: 90, priceMinor: 876000, currency: 'IRR' },
];

describe('neon premium catalog', () => {
  it('renders the premium hierarchy entirely from supplied backend plans and keeps checkout unwired', () => {
    render(<PremiumCatalogPage paymentAvailable plans={plans} />);

    expect(screen.getByRole('heading', { name: 'خرید اشتراک' })).toBeInTheDocument();
    expect(screen.getByText(/اینترنت نامحدود با محدودیت زمانی/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'یک‌ماهه واقعی' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'سه‌ماهه واقعی' })).toBeInTheDocument();
    expect(screen.getByText('۳۰ روز')).toBeInTheDocument();
    expect(screen.getByText('۹۰ روز')).toBeInTheDocument();
    expect(screen.getByText(/۳۲۱[٬,]?۰۰۰ ریال/)).toBeInTheDocument();
    expect(screen.getByText(/۸۷۶[٬,]?۰۰۰ ریال/)).toBeInTheDocument();

    for (const button of screen.getAllByRole('button', { name: 'خرید' })) {
      expect(button).toBeDisabled();
    }
    expect(screen.getByText(/checkout واقعی هنوز به این صفحه متصل نشده/)).toBeInTheDocument();
  });

  it('shows real empty/provider-unavailable states and carries no authoritative screenshot price constants', () => {
    const { rerender } = render(<PremiumCatalogPage paymentAvailable={false} plans={plans} />);
    expect(screen.getByText(/پرداخت هنوز فعال نیست/)).toBeInTheDocument();

    rerender(<PremiumCatalogPage paymentAvailable={false} plans={[]} />);
    expect(screen.getByText(/هیچ بسته فعال واقعی برای خرید ثبت نشده است/)).toBeInTheDocument();

    const source = readFileSync(new URL('./account-catalog-surface.tsx', import.meta.url), 'utf8');
    expect(source).not.toMatch(/349000|199000|499000|1690000/);
  });
});
