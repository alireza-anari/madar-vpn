import { StatusOrb } from '../components/StatusOrb';
import type { AccountView } from './surfaces-legacy';

const faDate = new Intl.DateTimeFormat('fa-IR-u-ca-gregory', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
});
const faNumber = new Intl.NumberFormat('fa-IR');

function formatMinutes(seconds: number) {
  return `${faNumber.format(Math.floor(seconds / 60))} دقیقه`;
}

function formatPremiumExpiry(value: string | null) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return faDate.format(date);
}

function ReadinessChip({ label, ready }: { label: string; ready: boolean }) {
  return (
    <span className={ready ? 'dashboard-readiness dashboard-readiness--ready' : 'dashboard-readiness'}>
      {label}: {ready ? 'آماده' : 'آماده نیست'}
    </span>
  );
}

export function DashboardPage({ account }: { account: AccountView }) {
  const accessReady = account.node.ready && account.node.configAvailable;
  const connectionLabel = account.node.connectionStatus === 'connected' ? 'متصل' : 'قطع';
  const isPremium = account.entitlement.tier === 'premium';

  return (
    <div className="surface-stack dashboard-screen">
      <section className="dashboard-hero" aria-label="خلاصه حساب">
        <div className="dashboard-hero__identity">
          <span>حساب تأییدشده</span>
          <bdi dir="ltr">{account.identity.email}</bdi>
        </div>
        <StatusOrb
          label="وضعیت دسترسی"
          value={accessReady ? 'آماده' : 'آماده نیست'}
          tone={accessReady ? 'positive' : 'unavailable'}
          supportingText={`اتصال گزارش‌شده: ${connectionLabel}`}
        />
      </section>

      <section className={isPremium ? 'entitlement-card entitlement-card--premium' : 'entitlement-card'}>
        <div className="entitlement-card__heading">
          <span aria-hidden="true" className="entitlement-card__icon">♕</span>
          <div>
            <span className="entitlement-card__eyebrow">اشتراک فعلی</span>
            <h2>{isPremium ? 'اشتراک پرمیوم' : 'اعتبار رایگان'}</h2>
          </div>
        </div>
        <div className="entitlement-card__value">
          {isPremium ? (
            <>
              <strong>{formatPremiumExpiry(account.entitlement.premiumUntil)}</strong>
              <span>تاریخ پایان</span>
            </>
          ) : (
            <>
              <strong>{formatMinutes(account.entitlement.freeSeconds)}</strong>
              <span>اعتبار باقی‌مانده امروز</span>
            </>
          )}
        </div>
      </section>

      <section className="dashboard-quick-actions" aria-label="دسترسی‌های سریع">
        <a className="quick-action" href="/access">
          <span aria-hidden="true" className="quick-action__icon">⌁</span>
          <strong>دریافت کانفیگ</strong>
          <small>{account.node.configAvailable ? 'آماده صدور' : 'وضعیت را بررسی کنید'}</small>
        </a>
        <a className="quick-action" href="/premium">
          <span aria-hidden="true" className="quick-action__icon">♕</span>
          <strong>اشتراک‌ها</strong>
          <small>{isPremium ? 'مدیریت و تمدید' : 'مشاهده پلن‌ها'}</small>
        </a>
      </section>

      <section className="dashboard-access-card">
        <div>
          <span className="dashboard-access-card__eyebrow">دسترسی VPN</span>
          <h2>{account.node.configAvailable ? 'کانفیگ شما آماده است' : 'کانفیگ هنوز آماده نیست'}</h2>
          <p>
            {account.node.configAvailable
              ? 'پیکربندی تأییدشده حساب از سرور آماده است؛ برای دریافت امن آن وارد صفحه دسترسی شوید.'
              : 'پیکربندی VPN هنوز آماده نیست؛ تا آماده‌شدن نود، مقدار نمونه تولید نمی‌شود.'}
          </p>
        </div>
        <a className="dashboard-access-card__link" href="/access">بررسی دسترسی</a>
      </section>

      <section className="dashboard-readiness-card" aria-label="آمادگی سرویس‌ها">
        <div className="dashboard-readiness-card__copy">
          <span>آمادگی امکانات</span>
          <p>این نشان‌ها فقط readiness واقعی providerهای سمت سرور را بازتاب می‌دهند.</p>
        </div>
        <div className="dashboard-readiness-list">
          <ReadinessChip label="ایمیل" ready={account.providers.email} />
          <ReadinessChip label="تبلیغات" ready={account.providers.ads} />
          <ReadinessChip label="پرداخت" ready={account.providers.payments} />
          <ReadinessChip label="اعلان" ready={account.providers.push} />
        </div>
      </section>
    </div>
  );
}
