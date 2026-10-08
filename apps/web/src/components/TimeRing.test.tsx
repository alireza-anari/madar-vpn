import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TimeRing } from './TimeRing';

function setReducedMotion(matches: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)' ? matches : false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

describe('TimeRing', () => {
  it('exposes progress and value accessibly', () => {
    setReducedMotion(false);
    render(
      <TimeRing
        label="اعتبار باقی‌مانده"
        value="۳۰ دقیقه"
        progress={0.5}
      />,
    );

    const ring = screen.getByRole('progressbar', { name: 'اعتبار باقی‌مانده' });
    expect(ring).toHaveAttribute('aria-valuemin', '0');
    expect(ring).toHaveAttribute('aria-valuemax', '100');
    expect(ring).toHaveAttribute('aria-valuenow', '50');
    expect(screen.getByText('۳۰ دقیقه')).toBeInTheDocument();
  });

  it('marks non-essential motion as reduced when the device requests it', () => {
    setReducedMotion(true);
    render(
      <TimeRing
        label="اعتبار باقی‌مانده"
        value="۳۰ دقیقه"
        progress={0.5}
      />,
    );

    expect(screen.getByRole('progressbar', { name: 'اعتبار باقی‌مانده' })).toHaveAttribute(
      'data-motion',
      'reduced',
    );
  });
});
