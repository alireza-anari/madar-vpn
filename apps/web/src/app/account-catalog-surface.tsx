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

const faNumber = new Intl.NumberFormat('fa-IR');

function formatPrice(priceMinor: number, currency: string) {
  const amount = faNumber.format(priceMinor);
  return currency === 'IRR' ? `${amount} ریال` : `${amount} ${currency}`;
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
}: {
  adsAvailable: boolean;
  missions: AccountCatalogView['missions'];
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
          <p className="muted-copy">ارسال مدرک از این صفحه هنوز متصل نشده است.</p>
        </Card>
      ))}
    </div>
  );
}
