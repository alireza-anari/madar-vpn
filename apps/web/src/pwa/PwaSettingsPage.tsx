import { useState } from 'react';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { PageHeader } from '../components/PageHeader';

type PermissionRequester = () => Promise<NotificationPermission>;
type SubscribeAction = () => Promise<boolean>;
type InstallPrompt = () => Promise<void>;

type Props = {
  pushAvailable: boolean;
  notificationSupported?: boolean;
  requestPermission?: PermissionRequester;
  subscribe?: SubscribeAction;
  installPrompt?: InstallPrompt;
};

type NotificationState = 'idle' | 'enabled' | 'denied' | 'failed';

function defaultNotificationSupported() {
  return typeof window !== 'undefined' && 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window;
}

async function defaultRequestPermission(): Promise<NotificationPermission> {
  if (typeof Notification === 'undefined') return 'denied';
  return Notification.requestPermission();
}

async function unavailableSubscribe() {
  return false;
}

export function PwaSettingsPage({
  pushAvailable,
  notificationSupported = defaultNotificationSupported(),
  requestPermission = defaultRequestPermission,
  subscribe = unavailableSubscribe,
  installPrompt,
}: Props) {
  const [notificationState, setNotificationState] = useState<NotificationState>('idle');
  const [busy, setBusy] = useState(false);

  async function enableNotifications() {
    if (!pushAvailable || !notificationSupported || busy) return;
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

  return (
    <div className="surface-stack">
      <Card>
        <PageHeader
          eyebrow="نصب"
          title="نصب مدار روی دستگاه"
          description="نصب برنامه مستقل از اعلان‌هاست؛ ردکردن مجوز اعلان هیچ بخشی از برنامه را قفل نمی‌کند."
        />
        <div className="instruction-grid">
          <section>
            <h2 className="section-title">نصب روی iPhone</h2>
            <p className="muted-copy">در Safari منوی Share را باز کنید و «افزودن به صفحه اصلی» را انتخاب کنید.</p>
          </section>
          <section>
            <h2 className="section-title">نصب روی Android</h2>
            {installPrompt ? (
              <Button type="button" onClick={() => { void installPrompt(); }}>نصب برنامه</Button>
            ) : (
              <p className="muted-copy">اگر گزینه نصب مرورگر نمایش داده نشد، از «افزودن به صفحه اصلی» استفاده کنید.</p>
            )}
          </section>
        </div>
      </Card>

      <Card>
        <PageHeader
          eyebrow="اعلان‌ها"
          title="اطلاع‌رسانی"
          description="مرورگر فقط پس از فشردن دکمه زیر مجوز اعلان را درخواست می‌کند."
        />
        <Button
          type="button"
          disabled={!pushAvailable || !notificationSupported || busy}
          onClick={() => { void enableNotifications(); }}
        >
          {busy ? 'در حال فعال‌سازی…' : 'فعال‌کردن اعلان'}
        </Button>

        {!pushAvailable ? <p className="inline-notice">ارسال Web Push هنوز پیکربندی نشده است.</p> : null}
        {pushAvailable && !notificationSupported ? <p className="inline-notice">اعلان در این مرورگر پشتیبانی نمی‌شود.</p> : null}
        {notificationState === 'denied' ? <p className="inline-notice">مجوز اعلان داده نشد؛ برنامه بدون اعلان قابل استفاده است.</p> : null}
        {notificationState === 'enabled' ? <p className="inline-notice" role="status">اعلان‌ها برای این دستگاه فعال شد.</p> : null}
        {notificationState === 'failed' ? <p className="inline-notice">فعال‌سازی اعلان کامل نشد؛ برنامه بدون اعلان قابل استفاده است.</p> : null}
      </Card>
    </div>
  );
}
