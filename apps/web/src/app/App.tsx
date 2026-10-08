import { useEffect, useState } from 'react';
import { AppShell } from '../components/AppShell';
import { Card } from '../components/Card';
import { PageHeader } from '../components/PageHeader';
import {
  AdminPage,
  DashboardPage,
  LoginPage,
  MissionsPage,
  PremiumPage,
  SettingsPage,
  type AccountView,
  type AdminOverviewView,
} from './surfaces';

type Resource<T> =
  | { status: 'loading'; data: null }
  | { status: 'ready'; data: T }
  | { status: 'unavailable'; data: null };

function useApiResource<T>(url: string | null): Resource<T> {
  const [resource, setResource] = useState<Resource<T>>({ status: 'loading', data: null });

  useEffect(() => {
    if (!url) {
      setResource({ status: 'unavailable', data: null });
      return;
    }
    const controller = new AbortController();
    setResource({ status: 'loading', data: null });
    void fetch(url, { credentials: 'include', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return (await response.json()) as T;
      })
      .then((data) => setResource({ status: 'ready', data }))
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setResource({ status: 'unavailable', data: null });
      });
    return () => controller.abort();
  }, [url]);

  return resource;
}

function LoadingPanel() {
  return (
    <Card>
      <PageHeader eyebrow="در حال بررسی" title="خواندن وضعیت واقعی" description="اطلاعات حساب از API سمت سرور دریافت می‌شود." />
    </Card>
  );
}

function UnavailablePanel({ admin = false }: { admin?: boolean }) {
  return (
    <Card>
      <PageHeader
        eyebrow="در دسترس نیست"
        title={admin ? 'پنل مدیریت فعلاً قابل خواندن نیست' : 'اطلاعات حساب فعلاً قابل خواندن نیست'}
        description="هیچ داده نمونه‌ای جای وضعیت production نمایش داده نمی‌شود. بعد از اتصال backend و ورود معتبر دوباره بررسی کنید."
      />
      {!admin ? <a className="text-link" href="/login">رفتن به ورود ایمیلی</a> : null}
    </Card>
  );
}

function AccountRoute({ mode }: { mode: 'dashboard' | 'premium' | 'missions' | 'settings' }) {
  const account = useApiResource<AccountView>('/api/account');
  if (account.status === 'loading') return <LoadingPanel />;
  if (mode === 'settings') {
    return (
      <SettingsPage
        pushAvailable={account.status === 'ready' && account.data.providers.push}
        installSupported={'onbeforeinstallprompt' in window}
      />
    );
  }
  if (account.status !== 'ready') return <UnavailablePanel />;
  if (mode === 'dashboard') return <DashboardPage account={account.data} />;
  if (mode === 'premium') return <PremiumPage paymentAvailable={account.data.providers.payments} plans={[]} />;
  return <MissionsPage adsAvailable={account.data.providers.ads} missions={[]} />;
}

function AdminRoute() {
  const overview = useApiResource<AdminOverviewView>('/api/admin/overview');
  if (overview.status === 'loading') return <LoadingPanel />;
  if (overview.status !== 'ready') return <UnavailablePanel admin />;
  return <AdminPage overview={overview.data} />;
}

export function App() {
  const health = useApiResource<{ status: 'ok' }>('/api/health');
  const path = typeof window === 'undefined' ? '/' : window.location.pathname;
  const shellStatus = health.status === 'ready' ? 'ready' : health.status === 'loading' ? 'checking' : 'unavailable';
  let content;

  switch (path) {
    case '/login':
      content = <LoginPage emailAvailable={false} />;
      break;
    case '/premium':
      content = <AccountRoute mode="premium" />;
      break;
    case '/missions':
      content = <AccountRoute mode="missions" />;
      break;
    case '/settings':
      content = <AccountRoute mode="settings" />;
      break;
    case '/admin':
      content = <AdminRoute />;
      break;
    case '/access':
    case '/':
    default:
      content = <AccountRoute mode="dashboard" />;
      break;
  }

  return <AppShell serviceStatus={shellStatus}>{content}</AppShell>;
}
