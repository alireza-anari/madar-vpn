import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MadarLogo } from './MadarLogo';
import { StatusOrb } from './StatusOrb';

describe('Madar neon primitives', () => {
  it('renders an accessible brand lockup with decorative geometry hidden', () => {
    const { container } = render(<MadarLogo />);

    expect(screen.getByText('مدار')).toBeInTheDocument();
    expect(container.querySelector('[data-testid="madar-logo-ring"]')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('renders status content without pretending to be an interactive control', () => {
    render(
      <StatusOrb
        label="وضعیت دسترسی"
        value="آماده"
        tone="positive"
        supportingText="دسترسی واقعی از داده سرور خوانده شده است."
      />,
    );

    expect(screen.getByText('وضعیت دسترسی')).toBeInTheDocument();
    expect(screen.getByText('آماده')).toBeInTheDocument();
    expect(screen.getByText('دسترسی واقعی از داده سرور خوانده شده است.')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
