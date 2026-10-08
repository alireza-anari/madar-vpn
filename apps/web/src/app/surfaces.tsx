import type { ReactNode } from 'react';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { PageHeader } from '../components/PageHeader';
import { TimeRing } from '../components/TimeRing';

export type AccountView = {
  identity: { id: string; email: string; role: 'user' | 'admin' };
  entitlement: { freeSeconds: number; premiumUntil: string | null; tier: 'free' | 'premium' };
  node: { ready: boolean; connectionStatus: 'connected' | 'disconnected'; configAvailable: boolean };
  providers: { email: boolean; ads: boolean; payments: boolean; push: boolean };
};

export type AdminOverviewView = {
  counts: { users: number; readyNodes: number; plans: number; missions: number };
  readiness: { nodes: boolean; email: boolean; ads: boolean; payments: boolean; push: boolean };
  settings: { freeSpeedKbps: number; notificationsEnabled: boolean };
};

export type AdminResourcesView = {
  users: Array<{ id: string; email: string; role: 'user' | 'admin' }>;
  plans: Array<{
    id: string;
    title: string;
    durationDays: number;
    priceMinor: number;
    currency: string;
    enabled: boolean;
    createdAt: string;
    updatedAt: string;
  }>;
  missions: Array<{
    id: string;
    title: string;
    description: string;
    rewardSeconds: number;
    status: string;
    createdAt: string;
    updatedAt: string;
  }>;
  nodes: Array<{
    id: string;
    name: string;
    status: string;
    lastSeenAt: string | null;
    createdAt: string;
  }>;
  notificationDrafts: Array<{
    id: string;
    title: string;
    body: string;
    target: string;
    createdBy: string;
    createdAt: string;
    deliveryStatus: string;
  }>;
  audit: Array<{
    id: string;
    actorUserId: string;
    action: string;
    details: Record<string, unknown>;
    createdAt: string;
  }>;
};

export type PlanView = {
  id: string;
  title: string;
  durationDays: number;
  priceLabel: string;
  sample?: boolean;
};

export type MissionView = {
  id: string;
  title: string;
  rewardMinutes: number;
  status: 'active' | 'pending' | 'done';
  sample?: boolean;
};

const faNumber = new Intl.NumberFormat('fa-IR');
const emptyAdminResources: AdminResourcesView = {
  users: [],
  plans: [],
  missions: [],
  nodes: [],
  notificationDrafts: [],
  audit: [],
};

function formatMinutes(seconds: number) {
  return `${faNumber.format(Math.floor(seconds / 60))} دقیقه`;
}

function Availability({ label, ready }: { label: string; ready: boolean }) {
  return (
    <span className={ready ? 'readiness readiness--ready' : 'readiness'}>
      {label}: {ready ? 'آماده' : 'آماده نیست'}
    </span>
  );
}

export function DashboardPage({ account }: { account: AccountView }) {
  const maxFreeSeconds = 1800;
  const progress = account.entitlement.tier === 'premium'
    ? 1
    : Math.min(1, account.entitlement.freeSeconds / maxFreeSeconds);

  return (
    <div className="surface-stack">
      <Card>
        <PageHeader
          eyebrow="حساب تأییدشده"
          title="داشبورد مدار"
          description={`وضعیت این صفحه از داده سمت سرور برای ${account.identity.email} خوانده شده است.`}
        />
        <TimeRing
          label={account.entitlement.tier === 'premium' ? 'اشتراک پرمیوم' : 'اعتبار رایگان امروز'}
          progress={progress}
          value={account.entitlement.tier === 'premium' ? 'پرمیوم' : formatMinutes(account.entitlement.freeSeconds)}
          supportingText={
            account.entitlement.tier === 'premium'
              ? `اعتبار پرمیوم تا ${account.entitlement.premiumUntil ?? '—'} مستقل از ریست روزانه است.`
              : 'مصرف فقط از زمان اتصال واقعی گزارش‌شده توسط نود کم می‌شود.'
          }
        />
      </Card>

      <div className="surface-grid surface-grid--two">
        <Card>
          <PageHeader
            eyebrow="تله‌متری نود"
            title="وضعیت اتصال"
            description="این وضعیت از session ثبت‌شده نود می‌آید؛ دکمه اتصال ساختگی در مرورگر وجود ندارد."
          />
          <p className="metric-value">
            {account.node.connectionStatus === 'connected' ? 'متصل' : 'قطع'}
          </p>
          <p className="muted-copy">{account.node.ready ? 'حداقل یک نود آماده است.' : 'نود آماده‌ای گزارش نشده است.'}</p>
        </Card>

        <Card>
          <PageHeader
            eyebrow="پیکربندی"
            title="دسترسی VPN"
            description={
              account.node.configAvailable
                ? 'پیکربندی تأییدشده حساب از سرور آماده است.'
                : 'پیکربندی VPN هنوز آماده نیست؛ تا آماده‌شدن نود، مقدار نمونه تولید نمی‌شود.'
            }
          />
          <div className="dashboard-actions dashboard-actions--start">
            <Button disabled={!account.node.configAvailable}>کپی پیکربندی</Button>
            <Button disabled={!account.node.configAvailable} variant="quiet">نمایش QR</Button>
          </div>
        </Card>
      </div>

      <Card>
        <PageHeader
          eyebrow="اتصال سرویس‌ها"
          title="آمادگی امکانات"
          description="هر قابلیت تا زمان اتصال provider واقعی غیرفعال می‌ماند."
        />
        <div className="readiness-list" aria-label="آمادگی سرویس‌ها">
          <Availability label="ایمیل" ready={account.providers.email} />
          <Availability label="تبلیغات" ready={account.providers.ads} />
          <Availability label="پرداخت" ready={account.providers.payments} />
          <Availability label="اعلان" ready={account.providers.push} />
        </div>
      </Card>
    </div>
  );
}

export function LoginPage({ emailAvailable }: { emailAvailable: boolean }) {
  return (
    <Card>
      <PageHeader
        eyebrow="ورود امن"
        title="ورود با لینک یک‌بارمصرف"
        description="لینک ورود منقضی می‌شود و session فقط در کوکی HttpOnly نگهداری می‌شود."
      />
      <form className="form-stack" aria-label="فرم ورود ایمیلی">
        <label className="field-label" htmlFor="login-email">ایمیل</label>
        <input className="text-input" id="login-email" name="email" type="email" autoComplete="email" />
        <Button disabled={!emailAvailable} type="submit">ارسال لینک ورود</Button>
      </form>
      {!emailAvailable ? (
        <p className="inline-notice" role="status">سرویس ایمیل هنوز متصل نشده؛ ارسال لینک ورود در این preview غیرفعال است.</p>
      ) : null}
    </Card>
  );
}

export function PremiumPage({ paymentAvailable, plans }: { paymentAvailable: boolean; plans: PlanView[] }) {
  return (
    <div className="surface-stack">
      <Card>
        <PageHeader
          eyebrow="اشتراک"
          title="بسته‌های پرمیوم"
          description="خرید فقط بعد از تأیید callback پرداخت سمت سرور اعمال می‌شود."
        />
        {!paymentAvailable ? <p className="inline-notice">پرداخت هنوز فعال نیست؛ خرید واقعی در دسترس نیست.</p> : null}
      </Card>
      {plans.length === 0 ? (
        <Card><p className="empty-state">هیچ بسته فعال واقعی برای خرید ثبت نشده است.</p></Card>
      ) : (
        <div className="surface-grid surface-grid--three">
          {plans.map((plan) => (
            <Card key={plan.id}>
              {plan.sample ? <span className="sample-label">نمونه</span> : null}
              <h2 className="section-title">{plan.title}</h2>
              <p className="metric-value">{plan.priceLabel}</p>
              <p className="muted-copy">{faNumber.format(plan.durationDays)} روز</p>
              <Button disabled={!paymentAvailable || plan.sample}>خرید</Button>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

export function MissionsPage({ adsAvailable, missions }: { adsAvailable: boolean; missions: MissionView[] }) {
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
          {mission.sample ? <span className="sample-label">نمونه</span> : null}
          <h2 className="section-title">{mission.title}</h2>
          <p className="muted-copy">پاداش: {faNumber.format(mission.rewardMinutes)} دقیقه</p>
          <Button disabled={mission.sample || mission.status !== 'active'}>شروع ماموریت</Button>
        </Card>
      ))}
    </div>
  );
}

export function SettingsPage({ pushAvailable, installSupported }: { pushAvailable: boolean; installSupported: boolean }) {
  return (
    <div className="surface-stack">
      <Card>
        <PageHeader
          eyebrow="نصب"
          title="نصب مدار روی دستگاه"
          description="وب‌اپ بدون اعلان هم قابل استفاده است و ردکردن مجوز چیزی را قفل نمی‌کند."
        />
        <div className="instruction-grid">
          <section>
            <h2 className="section-title">نصب روی iPhone</h2>
            <p className="muted-copy">در Safari منوی Share را باز کنید و «افزودن به صفحه اصلی» را انتخاب کنید.</p>
          </section>
          <section>
            <h2 className="section-title">نصب روی Android</h2>
            <p className="muted-copy">
              {installSupported ? 'از گزینه نصب مرورگر استفاده کنید.' : 'اگر گزینه نصب نمایش داده نشد، از «افزودن به صفحه اصلی» استفاده کنید.'}
            </p>
          </section>
        </div>
      </Card>
      <Card>
        <PageHeader
          eyebrow="اعلان‌ها"
          title="اطلاع‌رسانی"
          description="درخواست مجوز فقط با اقدام مستقیم شما انجام می‌شود."
        />
        <Button disabled={!pushAvailable}>فعال‌کردن اعلان</Button>
        {!pushAvailable ? <p className="inline-notice">ارسال Web Push هنوز پیکربندی نشده است.</p> : null}
      </Card>
    </div>
  );
}

function ResourceList({ children, label }: { children: ReactNode; label: string }) {
  return <div className="admin-module-list" aria-label={label}>{children}</div>;
}

function ResourceValue({ primary, secondary }: { primary: string; secondary?: string }) {
  return (
    <span>
      <strong>{primary}</strong>
      {secondary ? <small>{secondary}</small> : null}
    </span>
  );
}

function UnavailableAdminModule({
  eyebrow,
  title,
  message,
}: {
  eyebrow: string;
  title: string;
  message: string;
}) {
  return (
    <Card>
      <PageHeader
        eyebrow={eyebrow}
        title={title}
        description="این بخش فقط وضعیت واقعی backend و integration را نشان می‌دهد."
      />
      <p className="inline-notice">{message}</p>
    </Card>
  );
}

export function AdminPage({
  overview,
  resources = emptyAdminResources,
  mutationsAvailable = false,
}: {
  overview: AdminOverviewView;
  resources?: AdminResourcesView;
  mutationsAvailable?: boolean;
}) {
  const defaultUserId = resources.users[0]?.id ?? '';

  return (
    <div className="surface-stack">
      <Card>
        <PageHeader
          eyebrow="مدیریت"
          title="نمای کلی واقعی"
          description="آمار این بخش از دیتابیس خوانده می‌شود و داده نمونه به‌عنوان آمار واقعی نمایش داده نمی‌شود."
        />
        <div className="metric-grid">
          <div><strong>{faNumber.format(overview.counts.users)}</strong><span>کاربر</span></div>
          <div><strong>{faNumber.format(overview.counts.plans)}</strong><span>پلن</span></div>
          <div><strong>{faNumber.format(overview.counts.missions)}</strong><span>ماموریت</span></div>
          <div><strong>{faNumber.format(overview.counts.readyNodes)}</strong><span>نود آماده</span></div>
        </div>
        <p className="muted-copy">{faNumber.format(overview.counts.readyNodes)} نود آماده</p>
      </Card>

      {!mutationsAvailable ? (
        <p className="inline-notice" role="status">توکن CSRF این session در دسترس نیست؛ عملیات ممتاز فقط خواندنی است.</p>
      ) : null}

      <div className="surface-grid surface-grid--two">
        <Card>
          <PageHeader eyebrow="Policy" title="تنظیمات رایگان" description="تغییرات نهایی فقط با session ادمین و CSRF ذخیره می‌شود." />
          <form className="form-stack">
            <label className="field-label" htmlFor="free-speed">سرعت رایگان (Kbps)</label>
            <input className="text-input" id="free-speed" type="number" min="64" max="1000000" defaultValue={overview.settings.freeSpeedKbps} />
            <label className="check-row">
              <input type="checkbox" defaultChecked={overview.settings.notificationsEnabled} />
              اعلان‌های مدیریتی فعال باشد
            </label>
            <Button disabled={!mutationsAvailable} type="submit">ذخیره تنظیمات</Button>
          </form>
        </Card>
        <Card>
          <PageHeader eyebrow="Readiness" title="آمادگی زیرساخت" description="آماده‌بودن provider از موفقیت واقعی سرویس جداست." />
          <div className="readiness-list">
            <Availability label="نود" ready={overview.readiness.nodes} />
            <Availability label="ایمیل" ready={overview.readiness.email} />
            <Availability label="تبلیغات" ready={overview.readiness.ads} />
            <Availability label="پرداخت" ready={overview.readiness.payments} />
            <Availability label="اعلان" ready={overview.readiness.push} />
          </div>
        </Card>
      </div>

      <Card>
        <PageHeader eyebrow="کاربران" title="حساب‌های ثبت‌شده" description="فهرست واقعی کاربران قابل مشاهده است؛ اطلاعات حساس ورود در این صفحه نمایش داده نمی‌شود." />
        <ResourceList label="کاربران ثبت‌شده">
          {resources.users.map((user) => <ResourceValue key={user.id} primary={user.email} secondary={user.role} />)}
        </ResourceList>
      </Card>

      <div className="surface-grid surface-grid--three">
        <Card>
          <PageHeader eyebrow="Free Credit" title="اعتبار رایگان" description="اصلاح دستی فقط از API ادمین، با کلید idempotency و Audit سمت سرور اعمال می‌شود." />
          <form className="form-stack" aria-label="فرم اصلاح اعتبار رایگان">
            <label className="field-label" htmlFor="admin-free-user">شناسه کاربر</label>
            <input className="text-input" id="admin-free-user" defaultValue={defaultUserId} />
            <label className="field-label" htmlFor="admin-free-seconds">ثانیه</label>
            <input className="text-input" id="admin-free-seconds" type="number" defaultValue="900" />
            <label className="field-label" htmlFor="admin-free-reason">دلیل</label>
            <input className="text-input" id="admin-free-reason" defaultValue="" />
            <label className="field-label" htmlFor="admin-free-key">کلید idempotency</label>
            <input className="text-input" id="admin-free-key" defaultValue="" />
            <Button disabled={!mutationsAvailable} type="submit">اعمال اعتبار رایگان</Button>
          </form>
        </Card>

        <Card>
          <PageHeader eyebrow="Premium" title="تنظیم پرمیوم" description="تاریخ پایان فقط با mutation محافظت‌شده و ثبت Audit تغییر می‌کند." />
          <form className="form-stack" aria-label="فرم تنظیم پرمیوم">
            <label className="field-label" htmlFor="admin-premium-user">شناسه کاربر</label>
            <input className="text-input" id="admin-premium-user" defaultValue={defaultUserId} />
            <label className="field-label" htmlFor="admin-premium-until">پایان پرمیوم</label>
            <input className="text-input" id="admin-premium-until" type="datetime-local" />
            <label className="field-label" htmlFor="admin-premium-reason">دلیل</label>
            <input className="text-input" id="admin-premium-reason" defaultValue="" />
            <label className="field-label" htmlFor="admin-premium-key">کلید idempotency</label>
            <input className="text-input" id="admin-premium-key" defaultValue="" />
            <Button disabled={!mutationsAvailable} type="submit">ثبت پرمیوم</Button>
          </form>
        </Card>

        <Card>
          <PageHeader eyebrow="User State" title="تعلیق حساب" description="تعلیق در مرز احراز هویت enforce می‌شود و session موجود را هم فوراً محدود می‌کند." />
          <form className="form-stack" aria-label="فرم تعلیق حساب">
            <label className="field-label" htmlFor="admin-suspension-user">شناسه کاربر</label>
            <input className="text-input" id="admin-suspension-user" defaultValue={defaultUserId} />
            <label className="check-row">
              <input type="checkbox" />
              حساب معلق باشد
            </label>
            <label className="field-label" htmlFor="admin-suspension-reason">دلیل</label>
            <input className="text-input" id="admin-suspension-reason" defaultValue="" />
            <Button disabled={!mutationsAvailable} type="submit">تغییر وضعیت حساب</Button>
          </form>
        </Card>
      </div>

      <div className="surface-grid surface-grid--two">
        <Card>
          <PageHeader eyebrow="پلن‌ها" title="مدیریت پلن" description="ذخیره پلن فقط با CSRF معتبر فعال می‌شود." />
          <ResourceList label="پلن‌های واقعی">
            {resources.plans.map((plan) => <span key={plan.id}>{plan.title}</span>)}
          </ResourceList>
          <form className="form-stack">
            <label className="field-label" htmlFor="admin-plan-title">عنوان پلن</label>
            <input className="text-input" id="admin-plan-title" defaultValue={resources.plans[0]?.title ?? ''} />
            <Button disabled={!mutationsAvailable} type="submit">ذخیره پلن</Button>
          </form>
        </Card>

        <Card>
          <PageHeader eyebrow="ماموریت‌ها" title="ویرایش ماموریت" description="ثبت ماموریت اعتبار کاربر را مستقیم افزایش نمی‌دهد؛ پاداش فقط با تأیید سمت سرور اعمال می‌شود." />
          <ResourceList label="ماموریت‌های واقعی">
            {resources.missions.map((mission) => <span key={mission.id}>{mission.title}</span>)}
          </ResourceList>
          <form className="form-stack">
            <label className="field-label" htmlFor="admin-mission-title">عنوان ماموریت</label>
            <input className="text-input" id="admin-mission-title" defaultValue={resources.missions[0]?.title ?? ''} />
            <Button disabled={!mutationsAvailable} type="submit">ثبت ماموریت</Button>
          </form>
        </Card>
      </div>

      <div className="surface-grid surface-grid--two">
        <Card>
          <PageHeader eyebrow="نودها" title="ثبت نود" description="ثبت نود فقط رکورد enrolled ایجاد می‌کند؛ مواد دسترسی تنها پس از آماده‌شدن واقعی زیرساخت مدیریت می‌شوند." />
          <ResourceList label="نودهای واقعی">
            {resources.nodes.map((node) => <ResourceValue key={node.id} primary={node.name} secondary={node.status} />)}
          </ResourceList>
          <form className="form-stack">
            <label className="field-label" htmlFor="admin-node-name">نام نود</label>
            <input className="text-input" id="admin-node-name" defaultValue="" />
            <Button disabled={!mutationsAvailable} type="submit">ثبت نود</Button>
          </form>
        </Card>

        <Card>
          <PageHeader eyebrow="اعلان‌ها" title="پیش‌نویس اعلان" description="ذخیره پیش‌نویس به معنی تحویل اعلان نیست و وضعیت delivery جداگانه باقی می‌ماند." />
          <ResourceList label="پیش‌نویس‌های اعلان">
            {resources.notificationDrafts.map((draft) => <ResourceValue key={draft.id} primary={draft.title} secondary={draft.deliveryStatus} />)}
          </ResourceList>
          <form className="form-stack">
            <label className="field-label" htmlFor="admin-draft-title">عنوان اعلان</label>
            <input className="text-input" id="admin-draft-title" defaultValue={resources.notificationDrafts[0]?.title ?? ''} />
            <Button disabled={!mutationsAvailable} type="submit">ذخیره پیش‌نویس</Button>
          </form>
        </Card>
      </div>

      <div className="surface-grid surface-grid--two">
        <UnavailableAdminModule
          eyebrow="Payments"
          title="پرداخت‌ها"
          message={overview.readiness.payments ? 'Provider پرداخت متصل است؛ settlement واقعی در فاز provider تکمیل می‌شود.' : 'Provider پرداخت هنوز متصل نشده؛ settlement و تأیید سفارش در دسترس نیست.'}
        />
        <UnavailableAdminModule
          eyebrow="Ads"
          title="تبلیغات"
          message={overview.readiness.ads ? 'Provider تبلیغ آماده گزارش شده، اما settlement پاداش هنوز در این فاز فعال نیست.' : 'Provider تبلیغات هنوز متصل نشده؛ پاداش تبلیغاتی واقعی در دسترس نیست.'}
        />
        <UnavailableAdminModule
          eyebrow="Rewards"
          title="پاداش‌ها"
          message="گردش بررسی و settlement پاداش هنوز آماده نیست؛ هیچ پاداش نمونه‌ای اعمال نمی‌شود."
        />
        <UnavailableAdminModule
          eyebrow="Notifications"
          title="Push"
          message={overview.readiness.push ? 'Provider Push آماده گزارش شده، اما ارسال واقعی دستگاه هنوز در این فاز تأیید نشده است.' : 'Provider Push هنوز متصل نشده؛ ارسال واقعی غیرفعال است.'}
        />
        <UnavailableAdminModule
          eyebrow="Health"
          title="سلامت نود"
          message={overview.readiness.nodes ? 'حداقل یک نود ready گزارش شده؛ تله‌متری سلامت کامل هنوز آماده نیست.' : 'تله‌متری سلامت نود هنوز آماده نیست؛ ready ساختگی نمایش داده نمی‌شود.'}
        />
        <UnavailableAdminModule
          eyebrow="Capacity"
          title="ظرفیت"
          message="گزارش ظرفیت و headroom نودها هنوز آماده نیست و مقدار نمونه نمایش داده نمی‌شود."
        />
        <UnavailableAdminModule
          eyebrow="Access"
          title="وضعیت Subscription"
          message="چرخه Subscription و eligibility نود هنوز آماده نیست؛ URL یا وضعیت ساختگی تولید نمی‌شود."
        />
        <UnavailableAdminModule
          eyebrow="Rotation"
          title="چرخش دسترسی"
          message="چرخش Client ID و Subscription هنوز آماده نیست؛ تا تکمیل state machine هیچ action ساختگی ارائه نمی‌شود."
        />
      </div>

      <Card>
        <PageHeader eyebrow="Audit" title="تاریخچه عملیات" description="رویدادهای ممتاز ثبت‌شده سمت سرور برای بازبینی نمایش داده می‌شوند." />
        <ResourceList label="تاریخچه Audit">
          {resources.audit.map((entry) => <span key={entry.id}>{entry.action}</span>)}
        </ResourceList>
      </Card>
    </div>
  );
}
