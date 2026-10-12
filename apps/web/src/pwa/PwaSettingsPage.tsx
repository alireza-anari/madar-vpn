import { useEffect, useState } from 'react';
import type { AccountView } from '../app/surfaces';
import { Button } from '../components/Button';
import { SettingsRow } from '../components/SettingsRow';
import './settings.css';

type PermissionRequester = () => Promise<NotificationPermission>;
type SubscribeAction = () => Promise<boolean>;
type InstallPrompt = () => Promise<void>;
type BrowserInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice?: Promise<{ outcome: string; platform?: string }> | undefined;
};

type Props = {
  account: Pick<AccountView, 'identity' | 'entitlement'>;
  pushAvailable: boolean;
  notificationSupported?: boolean;
  requestPermission?: PermissionRequester;
  subscribe?: SubscribeAction;
  installPrompt?: InstallPrompt;
};

type NotificationState = 'idle' | 'enabled' | 'denied' | 'failed';

const faNumber = new Intl.NumberFormat('fa-IR');

function defaultNotificationSupported() {
  return typeof window !== 'undefined' && 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window;
}

async function defaultRequestPermission(): Promise<NotificationPermission> {
  if (typeof Notification === 'undefined') return 'denied';
  return Notification.requestPermission();
}

function entitlementDetail(account: Props['account']) {
  if (account.entitlement.tier === 'premium') {
    return account.entitlement.premiumUntil
      ? `پرمیوم تا ${account.entitlement.premiumUntil}`
      : 'حساب پرمیوم؛ تاریخ پایان در پاسخ حساب ثبت نشده است.';
  }
  return `${faNumber.format(Math.floor(account.entitlement.freeSeconds / 60))} دقیقه اعتبار رایگان`;
}

export function PwaSettingsPage({
  account,
  pushAvailable,
  notificationSupported = defaultNotificationSupported(),
  requestPermission = defaultRequestPermission,
  subscribe,
  installPrompt,
}: Props) {
  const [notificationState, setNotificationState] = useState<NotificationState>('idle');
  const [busy, setBusy] = useState(false);
  const [browserInstallPrompt, setBrowserInstallPrompt] = useState<InstallPrompt | null>(null);

  useEffect(() => {
    if (installPrompt || typeof window === 'undefined') return undefined;

    const handleInstallPrompt = (event: Event) => {
      const candidate = event as BrowserInstallPromptEvent;
      if (typeof candidate.prompt !== 'function') return;
      event.preventDefault();
      setBrowserInstallPrompt(() => async () => {
        await candidate.prompt();
        if (candidate.userChoice) await candidate.userChoice.catch(() => undefined);
        setBrowserInstallPrompt(null);
      });
    };

    window.addEventListener('beforeinstallprompt', handleInstallPrompt);
    return () => window.removeEventListener('beforeinstallprompt', handleInstallPrompt);
  }, [installPrompt]);

  const activeInstallPrompt = installPrompt ?? browserInstallPrompt;
  const subscriptionReady = typeof subscribe === 'function';

  async function enableNotifications() {
    if (!pushAvailable || !notificationSupported || !subscriptionReady || busy) return;
    setBusy(true);
    try {
      const permission = await requestPermission();
      if (permission !== 'granted') {
        setNotificationState('denied');
        return;
      }
      setNotificationState((await subscribe()) ? 'enabled' : 'failed');
    } catch {
      setNotificationState('failed');
    } finally {
      setBusy(false);
    }
  }

  const notificationNotice = !pushAvailable
    ? 'ارسال Web Push هنوز پیکربندی نشده است.'
    : !notificationSupported
      ? 'اعلان در این مرورگر پشتیبانی نمی‌شود.'
      : !subscriptionReady
        ? 'فعال‌سازی این دستگاه هنوز به نشست امن متصل نشده است.'
        : notificationState === 'denied'
          ? 'مجوز اعلان داده نشد؛ برنامه بدون اعلان قابل استفاده است.'
          : notificationState === 'enabled'
            ? 'اعلان‌ها برای این دستگاه فعال شد.'
            : notificationState === 'failed'
              ? 'فعال‌سازی اعلان کامل نشد؛ برنامه بدون اعلان قابل استفاده است.'
              : null;

  return (
    <div className="settings-profile">
      <section className="profile-card" aria-labelledby="profile-settings-title">
        <div className="profile-card__top">
          <span className="profile-card__avatar" aria-hidden="true">◎</span>
          <div className="profile-card__identity">
            <p className="profile-card__eyebrow">حساب مدار</p>
            <h1 className="profile-card__title" id="profile-settings-title">پروفایل و تنظیمات</h1>
            <span className="profile-card__email" dir="ltr">{account.identity.email}</span>
          </div>
        </div>
        <div className="profile-entitlement">
          <span className="profile-entitlement__badge">
            {account.entitlement.tier === 'premium' ? 'حساب پرمیوم' : 'حساب رایگان'}
          </span>
          <p className="profile-entitlement__detail">{entitlementDetail(account)}</p>
        </div>
      </section>

      <div className="settings-group" aria-label="تنظیمات دستگاه">
        <p className="settings-group__title">روی این دستگاه</p>
        <SettingsRow
          icon="↓"
          title="نصب مدار"
          description="نصب برنامه مستقل از اعلان‌هاست؛ ردکردن مجوز اعلان هیچ بخشی از برنامه را قفل نمی‌کند."
        >
          <div className="instruction-grid">
            <section>
              <h3 className="section-title">نصب روی iPhone</h3>
              <p className="muted-copy">در Safari منوی Share را باز کنید و «افزودن به صفحه اصلی» را انتخاب کنید.</p>
            </section>
            <section>
              <h3 className="section-title">نصب روی Android</h3>
              {activeInstallPrompt ? (
                <Button type="button" onClick={() => { void activeInstallPrompt(); }}>نصب برنامه</Button>
              ) : (
                <p className="muted-copy">اگر گزینه نصب مرورگر نمایش داده نشد، از «افزودن به صفحه اصلی» استفاده کنید.</p>
              )}
            </section>
          </div>
        </SettingsRow>

        <SettingsRow
          icon="◉"
          title="اعلان‌ها"
          description="مرورگر فقط پس از فشردن دکمه زیر مجوز اعلان را درخواست می‌کند."
          action={(
            <Button
              type="button"
              disabled={!pushAvailable || !notificationSupported || !subscriptionReady || busy}
              onClick={() => { void enableNotifications(); }}
            >
              {busy ? 'در حال فعال‌سازی…' : 'فعال‌کردن اعلان'}
            </Button>
          )}
        >
          {notificationNotice ? (
            <p className="inline-notice" role={notificationState === 'enabled' ? 'status' : undefined}>
              {notificationNotice}
            </p>
          ) : null}
        </SettingsRow>
      </div>

      <div className="settings-group" aria-label="امنیت و حریم خصوصی">
        <p className="settings-group__title">امنیت</p>
        <SettingsRow
          icon="◇"
          title="حریم خصوصی حساب"
          description="اطلاعات این صفحه فقط از وضعیت حساب احراز هویت‌شده خوانده می‌شود؛ داده نمونه یا اطلاعات دستگاه ساختگی نمایش داده نمی‌شود."
        />
      </div>
    </div>
  );
}
