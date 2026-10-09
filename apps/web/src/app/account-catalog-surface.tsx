import { useState } from 'react';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { PageHeader } from '../components/PageHeader';

export type AccountCatalogView = {
  plans: Array<{
    id: string;
    title: string;
    durationDays: number;
    priceMinor: number;
    currency: string;
  }>;
  missions: Array<{
    id: string;
    title: string;
    description: string;
    rewardSeconds: number;
    verificationKind: 'evidence' | 'referral';
  }>;
};

export type MissionSubmissionResult = {
  id: string;
  status: 'pending';
};

const faNumber = new Intl.NumberFormat('fa-IR');

function formatPrice(priceMinor: number, currency: string) {
  const amount = faNumber.format(priceMinor);
  return currency === 'IRR' ? `${amount} ریال` : `${amount} ${currency}`;
}

function EvidenceMissionForm({
  mission,
  submitEvidence,
}: {
  mission: AccountCatalogView['missions'][number];
  submitEvidence: (missionId: string, evidence: string) => Promise<MissionSubmissionResult>;
}) {
  const [evidence, setEvidence] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function submit() {
    const value = evidence.trim();
    if (!value || submitting) return;
    setSubmitting(true);
    setNotice(null);
    try {
      const result = await submitEvidence(mission.id, value);
      if (result.status !== 'pending') throw new Error('Unexpected mission submission state.');
      setEvidence('');
      setNotice('مدرک ثبت شد و در انتظار بررسی است.');
    } catch {
      setNotice('ارسال مدرک انجام نشد. دوباره تلاش کنید.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="form-stack">
      <label className="field-label" htmlFor={`mission-evidence-${mission.id}`}>
        مدرک ماموریت {mission.title}
      </label>
      <textarea
        aria-label={`مدرک ماموریت ${mission.title}`}
        className="text-input"
        id={`mission-evidence-${mission.id}`}
        maxLength={2000}
        onChange={(event) => setEvidence(event.target.value)}
        rows={4}
        value={evidence}
      />
      <Button disabled={!evidence.trim() || submitting} onClick={() => { void submit(); }}>
        {submitting ? 'در حال ارسال…' : 'ارسال مدرک'}
      </Button>
      {notice ? <p className="inline-notice" role="status">{notice}</p> : null}
    </div>
  );
}

export function PremiumCatalogPage({
  paymentAvailable,
  plans,
}: {
  paymentAvailable: boolean;
  plans: AccountCatalogView['plans'];
}) {
  return (
    <div className="surface-stack">
      <Card>
        <PageHeader
          eyebrow="اشتراک"
          title="بسته‌های پرمیوم"
          description="خرید فقط بعد از تأیید callback پرداخت سمت سرور اعمال می‌شود."
        />
        {!paymentAvailable ? (
          <p className="inline-notice">پرداخت هنوز فعال نیست؛ خرید واقعی در دسترس نیست.</p>
        ) : (
          <p className="inline-notice">checkout واقعی هنوز به این صفحه متصل نشده؛ دکمه خرید تا تکمیل مسیر پرداخت غیرفعال می‌ماند.</p>
        )}
      </Card>

      {plans.length === 0 ? (
        <Card><p className="empty-state">هیچ بسته فعال واقعی برای خرید ثبت نشده است.</p></Card>
      ) : (
        <div className="surface-grid surface-grid--three">
          {plans.map((plan) => (
            <Card key={plan.id}>
              <h2 className="section-title">{plan.title}</h2>
              <p className="metric-value">{formatPrice(plan.priceMinor, plan.currency)}</p>
              <p className="muted-copy">{faNumber.format(plan.durationDays)} روز</p>
              <Button disabled>خرید</Button>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

export function MissionsCatalogPage({
  adsAvailable,
  missions,
  submitEvidence,
}: {
  adsAvailable: boolean;
  missions: AccountCatalogView['missions'];
  submitEvidence: (missionId: string, evidence: string) => Promise<MissionSubmissionResult>;
}) {
  return (
    <div className="surface-stack">
      <Card>
        <PageHeader
          eyebrow="ماموریت‌ها"
          title="اعتبار قابل دریافت"
          description="پاداش تنها پس از مدرک یا callback معتبر سمت سرور ثبت می‌شود."
        />
        {!adsAvailable ? <p className="inline-notice">تبلیغات هنوز متصل نشده؛ پاداش تبلیغاتی غیرفعال است.</p> : null}
      </Card>

      {missions.length === 0 ? (
        <Card><p className="empty-state">ماموریت فعال واقعی وجود ندارد.</p></Card>
      ) : missions.map((mission) => (
        <Card key={mission.id}>
          <h2 className="section-title">{mission.title}</h2>
          <p className="muted-copy">{mission.description}</p>
          <p className="muted-copy">پاداش: {faNumber.format(Math.floor(mission.rewardSeconds / 60))} دقیقه</p>
          <Button disabled>شروع ماموریت</Button>
          {mission.verificationKind === 'evidence' ? (
            <EvidenceMissionForm mission={mission} submitEvidence={submitEvidence} />
          ) : (
            <p className="muted-copy">ماموریت ارجاع فقط پس از تأیید رابطه واقعی توسط سرور قابل پاداش است.</p>
          )}
        </Card>
      ))}
    </div>
  );
}
