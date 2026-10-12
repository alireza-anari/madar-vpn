import type { ReactNode } from 'react';
import { BottomNav } from './BottomNav';
import { MadarLogo } from './MadarLogo';
import { StatusBadge } from './StatusBadge';

type AppShellProps = {
  children: ReactNode;
  currentPath?: string;
  serviceStatus?: 'ready' | 'checking' | 'unavailable';
};

export function AppShell({
  children,
  currentPath = typeof window === 'undefined' ? '' : window.location.pathname,
  serviceStatus = 'checking',
}: AppShellProps) {
  const statusLabel = serviceStatus === 'ready' ? 'آنلاین' : serviceStatus === 'checking' ? 'در حال بررسی' : 'آفلاین';

  return (
    <div className="app-shell app-shell--neon" dir="rtl" lang="fa">
      <header className="app-shell__topbar app-shell__topbar--neon">
        <a className="brand brand--neon" href="/" aria-label="مدار، صفحه اصلی">
          <MadarLogo compact />
        </a>
        <StatusBadge tone={serviceStatus}>{statusLabel}</StatusBadge>
      </header>

      {serviceStatus === 'unavailable' ? (
        <p className="service-notice" role="status">
          اطلاعات آنلاین فعلاً در دسترس نیست
        </p>
      ) : null}

      <main className="app-shell__content">{children}</main>

      <BottomNav currentPath={currentPath} />
    </div>
  );
}
