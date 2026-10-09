import { useEffect, useState } from 'react';
import { AppShell } from '../components/AppShell';
import { Card } from '../components/Card';
import { PageHeader } from '../components/PageHeader';
import { PwaSettingsPage } from '../pwa/PwaSettingsPage';
import { subscribeBrowserPush } from '../pwa/push-subscription';
import {
  InteractiveLoginPage,
  MagicLinkPage,
  type LoginRequestResult,
  type MagicLinkResult,
} from './auth-surface';
import {
  AdminPage,
  DashboardPage,
  MissionsPage,
  PremiumPage,
  type AccountView,
  type AdminOverviewView,
  type AdminResourcesView,
} from './surfaces';

type Resource<T> =
  | { status: 'loading'; data: null }
  | { status: 'ready'; data: T }
  | { status: 'unavailable'; data: null }
  | { status: 'error'; data: null };

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
        if (response.status === 503) {
          setResource({ status: 'unavailable', data: null });
          return null;
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return (await response.json()) as T;
      })
      .then((data) => {
        if (data !== null) setResource({ status: 'ready', data });
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setResource({ status: 'error', data: null });
      });
    return () => controller.abort();
  }, [url]);

  return resource;
}

async function requestLogin(email: string): Promise<LoginRequestResult> {
  const response = await fetch('/api/auth/request', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = (await response.json()) as { status?: unknown };
  if (payload.status === 'sent' || payload.status === 'unavailable') return payload.status;
  throw new Error('Malformed auth response.');
}

async function consumeMagicLink(token: string): Promise<MagicLinkResult> {
  try {
    const response = await fetch('/api/auth/consume', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    if (response.ok) return 'success';
    if (response.status === 401) return 'invalid';
    return 'error';
  } catch {
    return 'error';
  }
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

function ErrorPanel({ admin = false }: { admin?: boolean }) {
  return (
    <Card>
      <PageHeader
        eyebrow="خطا"
        title={admin ? 'خطا در خواندن پنل مدیریت' : 'خطا در خواندن اطلاعات حساب'}
        description="پاسخ backend با خطا روبه‌رو شد؛ داده نمونه جایگزین نمی‌شود. پس از رفع خطا دوباره تلاش کنید."
      />
    </Card>
  );
}

function LoginRoute() {
  const [token] = useState(() => (
    typeof window === 'undefined'
      ? null
      : new URLSearchParams(window.location.hash.replace(/^#/, '')).get('token')?.trim() || null
  ));
  const readiness = useApiResource<{ email: boolean }>(token ? null : '/api/auth/readiness');

  if (token) return <MagicLinkPage token={token} consume={consumeMagicLink} />;
  if (readiness.status === 'loading') return <LoadingPanel />;
  if (readiness.status === 'ready' && readiness.data.email) {
    return <InteractiveLoginPage emailAvailable requestLogin={requestLogin} />;
  }
  return <InteractiveLoginPage emailAvailable={false} />;
}

function AccountRoute({ mode }: { mode: 'dashboard' | 'premium' | 'missions' | 'settings' }) {
  const account = useApiResource<AccountView>('/api/account');
  if (account.status === 'loading') return <LoadingPanel />;
  if (mode === 'settings') {
    const pushAvailable = account.status === 'ready' && account.data.providers.push;
    if (!pushAvailable) return <PwaSettingsPage pushAvailable={false} />;
    return <PwaSettingsPage pushAvailable subscribe={() => subscribeBrowserPush()} />;
  }
  if (account.status === 'error') return <ErrorPanel />;
  if (account.status !== 'ready') return <UnavailablePanel />;
  if (mode === 'dashboard') return <DashboardPage account={account.data} />;
  if (mode === 'premium') return <PremiumPage paymentAvailable={account.data.providers.payments} plans={[]} />;
  return <MissionsPage adsAvailable={account.data.providers.ads} missions={[]} />;
}

function AdminRoute() {
  const overview = useApiResource<AdminOverviewView>('/api/admin/overview');
  const resources = useApiResource<AdminResourcesView>('/api/admin/resources');
  if (overview.status === 'loading' || resources.status === 'loading') return <LoadingPanel />;
  if (overview.status === 'error' || resources.status === 'error') return <ErrorPanel admin />;
  if (overview.status !== 'ready' || resources.status !== 'ready') return <UnavailablePanel admin />;
  return <AdminPage overview={overview.data} resources={resources.data} />;
}

export function App() {
  const health = useApiResource<{ status: 'ok' }>('/api/health');
  const path = typeof window === 'undefined' ? '/' : window.location.pathname;
  const shellStatus = health.status === 'ready' ? 'ready' : health.status === 'loading' ? 'checking' : 'unavailable';
  let content;

  switch (path) {
    case '/login':
      content = <LoginRoute />;
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
