import { AppShell } from '../components/AppShell';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { PageHeader } from '../components/PageHeader';
import { TimeRing } from '../components/TimeRing';

export function App() {
  return (
    <AppShell serviceStatus="unavailable">
      <Card>
        <PageHeader
          eyebrow="دسترسی امن، بدون وضعیت ساختگی"
          title="همه‌چیز از وضعیت واقعی حساب شروع می‌شود"
          description="برای نمایش اعتبار، نود و دسترسی VPN واقعی، ورود و اتصال سرویس‌های سمت سرور لازم است."
        />
        <TimeRing
          label="اعتبار باقی‌مانده"
          progress={0}
          value="—"
          supportingText="داده واقعی حساب هنوز در دسترس نیست."
        />
        <div className="dashboard-actions">
          <Button>ورود با ایمیل</Button>
          <Button variant="quiet">راهنمای نصب</Button>
        </div>
      </Card>
    </AppShell>
  );
}
