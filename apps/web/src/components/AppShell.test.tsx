import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AppShell } from './AppShell';

describe('AppShell', () => {
  it('keeps primary actions usable when online account data is unavailable', () => {
    render(
      <AppShell serviceStatus="unavailable">
        <button type="button">عمل اصلی</button>
      </AppShell>,
    );

    expect(screen.getByRole('heading', { name: 'مدار' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'ناوبری اصلی' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('اطلاعات آنلاین فعلاً در دسترس نیست');
    expect(screen.getByRole('button', { name: 'عمل اصلی' })).toBeEnabled();
  });
});
