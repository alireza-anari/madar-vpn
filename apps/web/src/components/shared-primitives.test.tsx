import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Button } from './Button';
import { Card } from './Card';
import { PageHeader } from './PageHeader';
import { StatusBadge } from './StatusBadge';

describe('shared presentation primitives remain backward compatible', () => {
  it('preserves Button variants and native button semantics', () => {
    const { rerender } = render(<Button disabled>ادامه</Button>);
    const primary = screen.getByRole('button', { name: 'ادامه' });
    expect(primary).toHaveClass('button', 'button--primary');
    expect(primary).toBeDisabled();
    expect(primary).toHaveAttribute('type', 'button');

    rerender(<Button variant="quiet" type="submit">ذخیره</Button>);
    const quiet = screen.getByRole('button', { name: 'ذخیره' });
    expect(quiet).toHaveClass('button', 'button--quiet');
    expect(quiet).toHaveAttribute('type', 'submit');
  });

  it('preserves Card children/custom classes and PageHeader labels', () => {
    render(
      <Card className="admin-compatible-card">
        <PageHeader eyebrow="وضعیت" title="عنوان واقعی" description="توضیح واقعی" />
        <span>محتوا</span>
      </Card>,
    );

    expect(screen.getByText('محتوا').closest('section')).toHaveClass('card', 'admin-compatible-card');
    expect(screen.getByText('وضعیت')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'عنوان واقعی' })).toBeInTheDocument();
    expect(screen.getByText('توضیح واقعی')).toBeInTheDocument();
  });

  it('keeps every existing StatusBadge tone available', () => {
    const { container } = render(
      <>
        <StatusBadge>خنثی</StatusBadge>
        <StatusBadge tone="ready">آماده</StatusBadge>
        <StatusBadge tone="checking">در حال بررسی</StatusBadge>
        <StatusBadge tone="unavailable">ناموجود</StatusBadge>
      </>,
    );

    expect(container.querySelector('.status-badge--neutral')).toHaveTextContent('خنثی');
    expect(container.querySelector('.status-badge--ready')).toHaveTextContent('آماده');
    expect(container.querySelector('.status-badge--checking')).toHaveTextContent('در حال بررسی');
    expect(container.querySelector('.status-badge--unavailable')).toHaveTextContent('ناموجود');
  });
});
