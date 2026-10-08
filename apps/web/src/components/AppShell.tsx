import type { ReactNode } from 'react';
import { StatusBadge } from './StatusBadge';

type AppShellProps = {
  children: ReactNode;
  serviceStatus?: 'checking' | 'unavailable';
};

const navigationItems = [
  ['/', 'خانه'],
  ['/access', 'دسترسی VPN'],
  ['/premium', 'اشتراک'],
  ['/settings', 'تنظیمات'],
] as const;

export function AppShell({ children, serviceStatus = 'checking' }: AppShellProps) {
  return (
    <div className="app-shell" dir="rtl" lang="fa">
      <header className="app-shell__topbar">
        <a className="brand" href="/" aria-label="مدار، صفحه اصلی">
          <span aria-hidden="true" className="brand__mark">م</span>
          <h1 className="brand__name">مدار</h1>
        </a>
        <StatusBadge tone={serviceStatus}>
          {serviceStatus === 'checking' ? 'در حال بررسی' : 'آفلاین'}
        </StatusBadge>
      </header>

      {serviceStatus === 'unavailable' ? (
        <p className="service-notice" role="status">
          اطلاعات آنلاین فعلاً در دسترس نیست
        </p>
      ) : null}

      <main className="app-shell__content">{children}</main>

      <nav aria-label="ناوبری اصلی" className="app-shell__nav">
        {navigationItems.map(([href, label]) => (
          <a href={href} key={href} className="app-shell__nav-link">
            {label}
          </a>
        ))}
      </nav>
    </div>
  );
}
