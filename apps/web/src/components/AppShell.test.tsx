import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AppShell } from './AppShell';

afterEach(() => cleanup());

describe('AppShell', () => {
  it('renders RTL Persian shell with every real user destination and marks only the current route', () => {
    const { container } = render(
      <AppShell currentPath="/premium" serviceStatus="ready">
        <p>محتوا</p>
      </AppShell>,
    );

    expect(container.firstElementChild).toHaveAttribute('dir', 'rtl');
    expect(container.firstElementChild).toHaveAttribute('lang', 'fa');
    expect(screen.getByRole('link', { name: /مدار/ })).toHaveAttribute('href', '/');

    const destinations = ['/', '/access', '/premium', '/missions', '/settings'];
    for (const href of destinations) {
      expect(container.querySelector(`nav a[href="${href}"]`)).not.toBeNull();
    }

    const current = container.querySelector('nav a[aria-current="page"]');
    expect(current).toHaveAttribute('href', '/premium');
    expect(container.querySelectorAll('nav a[aria-current="page"]')).toHaveLength(1);
  });

  it.each(['/login', '/admin', '/does-not-exist'])('does not fake a selected user destination on %s', (currentPath) => {
    const { container } = render(
      <AppShell currentPath={currentPath} serviceStatus="ready">
        <p>محتوا</p>
      </AppShell>,
    );

    expect(container.querySelector('nav a[aria-current="page"]')).toBeNull();
  });

  it('keeps primary actions usable and exposes an explicit notice when service data is unavailable', () => {
    render(
      <AppShell currentPath="/" serviceStatus="unavailable">
        <button type="button">عمل اصلی</button>
      </AppShell>,
    );

    expect(screen.getByRole('navigation', { name: 'ناوبری اصلی' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('اطلاعات آنلاین فعلاً در دسترس نیست');
    expect(screen.getByRole('button', { name: 'عمل اصلی' })).toBeEnabled();
  });
});
