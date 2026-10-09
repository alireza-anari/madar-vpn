import { useState } from 'react';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { PageHeader } from '../components/PageHeader';
import { createQrSvgDataUri } from './qr';

export type AccessReadiness = {
  ready: boolean;
  eligibleNodeCount: number;
};

export type IssuedAccess = {
  subscriptionUrl: string;
  version: number;
};

type AccessPageProps = {
  readiness: AccessReadiness;
  issue: () => Promise<IssuedAccess>;
};

function createSubscriptionQr(subscriptionUrl: string) {
  try {
    return createQrSvgDataUri(subscriptionUrl);
  } catch {
    return null;
  }
}

export function AccessPage({ readiness, issue }: AccessPageProps) {
  const [issued, setIssued] = useState<IssuedAccess | null>(null);
  const [issuing, setIssuing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const qrDataUri = issued ? createSubscriptionQr(issued.subscriptionUrl) : null;

  async function issueSubscription() {
    setIssuing(true);
    setNotice(null);
    try {
      setIssued(await issue());
    } catch {
      setNotice('صدور لینک انجام نشد. وضعیت دسترسی را دوباره بررسی کنید.');
    } finally {
      setIssuing(false);
    }
  }

  async function copySubscriptionUrl() {
    if (!issued) return;
    try {
      await navigator.clipboard.writeText(issued.subscriptionUrl);
      setNotice('لینک اشتراک کپی شد.');
    } catch {
      setNotice('کپی خودکار در این مرورگر در دسترس نیست.');
    }
  }

  return (
    <div className="surface-stack">
      <Card>
        <PageHeader
          eyebrow="VPN"
          title="دسترسی VPN"
          description="لینک اشتراک را فقط برای واردکردن در کلاینت سازگار استفاده کنید. این صفحه وضعیت اتصال واقعی را جعل نمی‌کند."
        />
        <p className={readiness.ready ? 'readiness readiness--ready' : 'inline-notice'}>
          {readiness.ready
            ? `${new Intl.NumberFormat('fa-IR').format(readiness.eligibleNodeCount)} نود آماده`
            : 'فعلاً نود آماده‌ای برای صدور لینک وجود ندارد.'}
        </p>
        <div className="dashboard-actions dashboard-actions--start">
          <Button disabled={!readiness.ready || issuing} onClick={() => { void issueSubscription(); }}>
            {issuing ? 'در حال صدور…' : 'صدور لینک اشتراک'}
          </Button>
        </div>
      </Card>

      {issued ? (
        <Card>
          <h3 className="section-title">لینک اشتراک</h3>
          {qrDataUri ? (
            <img
              alt="QR لینک اشتراک"
              height={260}
              src={qrDataUri}
              width={260}
            />
          ) : (
            <p className="muted-copy">نمایش QR برای این لینک در دسترس نیست؛ از کپی لینک استفاده کنید.</p>
          )}
          <div className="form-stack">
            <label className="field-label" htmlFor="subscription-url">لینک اشتراک</label>
            <input
              aria-label="لینک اشتراک"
              className="text-input"
              dir="ltr"
              id="subscription-url"
              readOnly
              value={issued.subscriptionUrl}
            />
            <Button variant="quiet" onClick={() => { void copySubscriptionUrl(); }}>کپی لینک</Button>
          </div>
          <p className="muted-copy">نسخه لینک: {new Intl.NumberFormat('fa-IR').format(issued.version)}</p>
        </Card>
      ) : null}

      {notice ? <p className="inline-notice" role="status">{notice}</p> : null}
    </div>
  );
}
