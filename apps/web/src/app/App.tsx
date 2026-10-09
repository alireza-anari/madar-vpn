import { useEffect, useRef, useState } from 'react';
import { AppShell } from '../components/AppShell';
import { Card } from '../components/Card';
import { PageHeader } from '../components/PageHeader';
import { PwaSettingsPage } from '../pwa/PwaSettingsPage';
import { subscribeBrowserPush } from '../pwa/push-subscription';
import { AccessPage, type AccessReadiness, type IssuedAccess } from './access-surface';
import {
  type AccountCatalogView,
  MissionsCatalogPage,
  type MissionStatusView,
  type MissionSubmissionResult,
  PremiumCatalogPage,
} from './account-catalog-surface';
import {
  InteractiveLoginPage,
  MagicLinkPage,
  type LoginRequestResult,
  type MagicLinkResult,
} from './auth-surface';
import {
  AdminPage,
  DashboardPage,
  type AccountView,
  type AdminFreeCreditInput,
  type AdminFreeCreditResult,
  type AdminMissionInput,
  type AdminMissionResult,
  type AdminNodeInput,
  type AdminNodeResult,
  type AdminPlanInput,
  type AdminPlanResult,
  type AdminPremiumInput,
  type AdminPremiumResult,
  type AdminSettingsInput,
  type AdminSettingsResult,
  type AdminSuspensionInput,
  type AdminSuspensionResult,
  type AdminOverviewView,
  type AdminResourcesView,
} from './surfaces';

type Resource<T> =
  | { status: 'loading'; data: null }
  | { status: 'ready'; data: T }
  | { status: 'unavailable'; data: null }
  | { status: 'error'; data: null };

function useApiResource<T>(url: string | null, refreshKey = 0): Resource<T> {
  const [resource, setResource] = useState<Resource<T>>({ status: 'loading', data: null });
  const previousUrl = useRef<string | null>(null);

  useEffect(() => {
    if (!url) {
      previousUrl.current = null;
      setResource({ status: 'unavailable', data: null });
      return;
    }
    const controller = new AbortController();
    const isBackgroundRefresh = previousUrl.current === url;
    previousUrl.current = url;
    if (!isBackgroundRefresh) setResource({ status: 'loading', data: null });
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
  }, [url, refreshKey]);

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

async function getCsrfToken() {
  const response = await fetch('/api/auth/csrf', { credentials: 'include' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = (await response.json()) as { csrfToken?: unknown };
  if (typeof payload.csrfToken !== 'string' || payload.csrfToken.length === 0) {
    throw new Error('Malformed CSRF response.');
  }
  return payload.csrfToken;
}

async function issueAccessSubscriptionUrl(): Promise<IssuedAccess> {
  const csrfToken = await getCsrfToken();
  const response = await fetch('/api/account/access/subscription-url', {
    method: 'POST',
    credentials: 'include',
    headers: { 'x-csrf-token': csrfToken },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = (await response.json()) as { subscriptionUrl?: unknown; version?: unknown };
  if (typeof payload.subscriptionUrl !== 'string' || typeof payload.version !== 'number') {
    throw new Error('Malformed access response.');
  }
  return { subscriptionUrl: payload.subscriptionUrl, version: payload.version };
}

async function submitMissionEvidence(missionId: string, evidence: string): Promise<MissionSubmissionResult> {
  const csrfToken = await getCsrfToken();
  const response = await fetch(`/api/account/missions/${encodeURIComponent(missionId)}/submissions`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      'x-csrf-token': csrfToken,
    },
    body: JSON.stringify({ kind: 'text', value: evidence }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = (await response.json()) as { id?: unknown; status?: unknown };
  if (typeof payload.id !== 'string' || payload.status !== 'pending') {
    throw new Error('Malformed mission submission response.');
  }
  return { id: payload.id, status: 'pending' };
}

async function adjustAdminFreeCredit(
  userId: string,
  input: AdminFreeCreditInput,
): Promise<AdminFreeCreditResult> {
  const csrfToken = await getCsrfToken();
  const response = await fetch(`/api/admin/users/${encodeURIComponent(userId)}/free-credit`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      'x-csrf-token': csrfToken,
    },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = (await response.json()) as { applied?: unknown; seconds?: unknown };
  if (typeof payload.applied !== 'boolean' || typeof payload.seconds !== 'number') {
    throw new Error('Malformed free-credit adjustment response.');
  }
  return { applied: payload.applied, seconds: payload.seconds };
}

async function adjustAdminPremium(
  userId: string,
  input: AdminPremiumInput,
): Promise<AdminPremiumResult> {
  const csrfToken = await getCsrfToken();
  const response = await fetch(`/api/admin/users/${encodeURIComponent(userId)}/premium`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      'x-csrf-token': csrfToken,
    },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = (await response.json()) as { applied?: unknown; premiumUntil?: unknown };
  if (typeof payload.applied !== 'boolean' || typeof payload.premiumUntil !== 'string') {
    throw new Error('Malformed premium adjustment response.');
  }
  return { applied: payload.applied, premiumUntil: payload.premiumUntil };
}

async function adjustAdminSuspension(
  userId: string,
  input: AdminSuspensionInput,
): Promise<AdminSuspensionResult> {
  const csrfToken = await getCsrfToken();
  const response = await fetch(`/api/admin/users/${encodeURIComponent(userId)}/suspension`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      'x-csrf-token': csrfToken,
    },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = (await response.json()) as { suspended?: unknown };
  if (typeof payload.suspended !== 'boolean') {
    throw new Error('Malformed suspension response.');
  }
  return { suspended: payload.suspended };
}

async function saveAdminSettings(input: AdminSettingsInput): Promise<AdminSettingsResult> {
  const csrfToken = await getCsrfToken();
  const response = await fetch('/api/admin/settings', {
    method: 'POST',
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      'x-csrf-token': csrfToken,
    },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = (await response.json()) as {
    freeSpeedKbps?: unknown;
    notificationsEnabled?: unknown;
  };
  if (
    typeof payload.freeSpeedKbps !== 'number' ||
    typeof payload.notificationsEnabled !== 'boolean'
  ) {
    throw new Error('Malformed settings response.');
  }
  return {
    freeSpeedKbps: payload.freeSpeedKbps,
    notificationsEnabled: payload.notificationsEnabled,
  };
}

async function saveAdminPlan(planId: string, input: AdminPlanInput): Promise<AdminPlanResult> {
  const csrfToken = await getCsrfToken();
  const response = await fetch(`/api/admin/plans/${encodeURIComponent(planId)}`, {
    method: 'PUT',
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      'x-csrf-token': csrfToken,
    },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = (await response.json()) as Partial<AdminPlanResult>;
  if (
    typeof payload.id !== 'string' ||
    typeof payload.title !== 'string' ||
    typeof payload.durationDays !== 'number' ||
    typeof payload.priceMinor !== 'number' ||
    typeof payload.currency !== 'string' ||
    typeof payload.enabled !== 'boolean' ||
    typeof payload.createdAt !== 'string' ||
    typeof payload.updatedAt !== 'string'
  ) {
    throw new Error('Malformed plan response.');
  }
  return payload as AdminPlanResult;
}

async function saveAdminMission(missionId: string, input: AdminMissionInput): Promise<AdminMissionResult> {
  const csrfToken = await getCsrfToken();
  const response = await fetch(`/api/admin/missions/${encodeURIComponent(missionId)}`, {
    method: 'PUT',
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      'x-csrf-token': csrfToken,
    },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = (await response.json()) as Partial<AdminMissionResult>;
  if (
    typeof payload.id !== 'string' ||
    typeof payload.title !== 'string' ||
    typeof payload.description !== 'string' ||
    typeof payload.rewardSeconds !== 'number' ||
    typeof payload.status !== 'string' ||
    typeof payload.createdAt !== 'string' ||
    typeof payload.updatedAt !== 'string'
  ) {
    throw new Error('Malformed mission response.');
  }
  return payload as AdminMissionResult;
}

async function enrollAdminNode(input: AdminNodeInput): Promise<AdminNodeResult> {
  const csrfToken = await getCsrfToken();
  const response = await fetch('/api/admin/nodes', {
    method: 'POST',
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      'x-csrf-token': csrfToken,
    },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = (await response.json()) as Record<string, unknown>;
  if ('credential' in payload || 'config' in payload) {
    throw new Error('Unsafe node enrollment response.');
  }
  if (
    typeof payload.id !== 'string' ||
    typeof payload.name !== 'string' ||
    payload.status !== 'enrolled' ||
    (payload.lastSeenAt !== null && typeof payload.lastSeenAt !== 'string') ||
    typeof payload.createdAt !== 'string'
  ) {
    throw new Error('Malformed node enrollment response.');
  }
  return {
    id: payload.id,
    name: payload.name,
    status: 'enrolled',
    lastSeenAt: payload.lastSeenAt,
    createdAt: payload.createdAt,
  };
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

function AccessRoute() {
  const access = useApiResource<AccessReadiness>('/api/account/access');
  if (access.status === 'loading') return <LoadingPanel />;
  if (access.status === 'error') return <ErrorPanel />;
  if (access.status !== 'ready') return <UnavailablePanel />;
  return <AccessPage readiness={access.data} issue={issueAccessSubscriptionUrl} />;
}

function AccountRoute({ mode }: { mode: 'dashboard' | 'premium' | 'missions' | 'settings' }) {
  const [missionStatusRefresh, setMissionStatusRefresh] = useState(0);
  const account = useApiResource<AccountView>('/api/account');
  const needsCatalog = mode === 'premium' || mode === 'missions';
  const catalog = useApiResource<AccountCatalogView>(needsCatalog ? '/api/account/catalog' : null);
  const missionStatuses = useApiResource<MissionStatusView[]>(
    mode === 'missions' ? '/api/account/missions/submissions' : null,
    missionStatusRefresh,
  );

  if (account.status === 'loading') return <LoadingPanel />;
  if (mode === 'settings') {
    const pushAvailable = account.status === 'ready' && account.data.providers.push;
    if (!pushAvailable) return <PwaSettingsPage pushAvailable={false} />;
    return <PwaSettingsPage pushAvailable subscribe={() => subscribeBrowserPush()} />;
  }
  if (account.status === 'error') return <ErrorPanel />;
  if (account.status !== 'ready') return <UnavailablePanel />;
  if (mode === 'dashboard') return <DashboardPage account={account.data} />;

  if (catalog.status === 'loading') return <LoadingPanel />;
  if (catalog.status === 'error') return <ErrorPanel />;
  if (catalog.status !== 'ready') return <UnavailablePanel />;

  if (mode === 'premium') {
    return <PremiumCatalogPage paymentAvailable={account.data.providers.payments} plans={catalog.data.plans} />;
  }

  if (missionStatuses.status === 'loading') return <LoadingPanel />;
  if (missionStatuses.status === 'error') return <ErrorPanel />;
  if (missionStatuses.status !== 'ready') return <UnavailablePanel />;
  return (
    <MissionsCatalogPage
      adsAvailable={account.data.providers.ads}
      missions={catalog.data.missions}
      statuses={missionStatuses.data}
      submitEvidence={async (missionId, evidence) => {
        const result = await submitMissionEvidence(missionId, evidence);
        setMissionStatusRefresh((revision) => revision + 1);
        return result;
      }}
    />
  );
}

function AdminRoute() {
  const overview = useApiResource<AdminOverviewView>('/api/admin/overview');
  const resources = useApiResource<AdminResourcesView>('/api/admin/resources');
  if (overview.status === 'loading' || resources.status === 'loading') return <LoadingPanel />;
  if (overview.status === 'error' || resources.status === 'error') return <ErrorPanel admin />;
  if (overview.status !== 'ready' || resources.status !== 'ready') return <UnavailablePanel admin />;
  return (
    <AdminPage
      overview={overview.data}
      resources={resources.data}
      adjustFreeCredit={adjustAdminFreeCredit}
      adjustPremium={adjustAdminPremium}
      adjustSuspension={adjustAdminSuspension}
      saveSettings={saveAdminSettings}
      savePlan={saveAdminPlan}
      saveMission={saveAdminMission}
      enrollNode={enrollAdminNode}
    />
  );
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
    case '/access':
      content = <AccessRoute />;
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
    case '/':
    default:
      content = <AccountRoute mode="dashboard" />;
      break;
  }

  return <AppShell serviceStatus={shellStatus}>{content}</AppShell>;
}
