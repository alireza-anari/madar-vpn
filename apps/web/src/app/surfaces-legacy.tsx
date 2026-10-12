import { type FormEvent, type ReactNode, useState } from 'react';
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
  readiness: { nodes: boolean; email: boolean; ads: boolean; payments: boolean; push: boolean; speedEnforcement: boolean };
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

export type AdminFreeCreditInput = {
  seconds: number;
  reason: string;
  idempotencyKey: string;
};

export type AdminFreeCreditResult = {
  applied: boolean;
  seconds: number;
};

export type AdminPremiumInput = {
  premiumUntil: string;
  reason: string;
  idempotencyKey: string;
};

export type AdminPremiumResult = {
  applied: boolean;
  premiumUntil: string;
};

export type AdminSuspensionInput = {
  suspended: boolean;
  reason: string;
};

export type AdminSuspensionResult = {
  suspended: boolean;
};

export type AdminSettingsInput = {
  freeSpeedKbps: number;
  notificationsEnabled: boolean;
};

export type AdminSettingsResult = AdminSettingsInput;

export type AdminPlanInput = {
  title: string;
  durationDays: number;
  priceMinor: number;
  currency: string;
  enabled: boolean;
};

export type AdminPlanResult = AdminResourcesView['plans'][number];

export type AdminMissionInput = {
  title: string;
  description: string;
  rewardSeconds: number;
  status: string;
};

export type AdminMissionResult = AdminResourcesView['missions'][number];

export type AdminNodeInput = {
  name: string;
};

export type AdminNodeResult = AdminResourcesView['nodes'][number];

export type AdminNotificationDraftInput = {
  title: string;
  body: string;
  target: string;
};

export type AdminNotificationDraftResult = AdminResourcesView['notificationDrafts'][number];

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
          <p className="metric-value">{account.node.connectionStatus === 'connected' ? 'متصل' : 'قطع'}</p>
          <p className="muted-copy">{account.node.ready ? 'حداقل یک نود آماده است.' : 'نود آماده‌ای گزارش نشده است.'}</p>
        </Card>

        <Card>
          <PageHeader
            eyebrow="پیکربندی"
            title="دسترسی VPN"
            description={account.node.configAvailable
              ? 'پیکربندی تأییدشده حساب از سرور آماده است.'
              : 'پیکربندی VPN هنوز آماده نیست؛ تا آماده‌شدن نود، مقدار نمونه تولید نمی‌شود.'}
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

function UnavailableAdminModule({ eyebrow, title, message }: { eyebrow: string; title: string; message: string }) {
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
  adjustFreeCredit,
  adjustPremium,
  adjustSuspension,
  saveSettings,
  savePlan,
  saveMission,
  enrollNode,
  saveNotificationDraft,
}: {
  overview: AdminOverviewView;
  resources?: AdminResourcesView;
  mutationsAvailable?: boolean;
  adjustFreeCredit?: (userId: string, input: AdminFreeCreditInput) => Promise<AdminFreeCreditResult>;
  adjustPremium?: (userId: string, input: AdminPremiumInput) => Promise<AdminPremiumResult>;
  adjustSuspension?: (userId: string, input: AdminSuspensionInput) => Promise<AdminSuspensionResult>;
  saveSettings?: (input: AdminSettingsInput) => Promise<AdminSettingsResult>;
  savePlan?: (planId: string, input: AdminPlanInput) => Promise<AdminPlanResult>;
  saveMission?: (missionId: string, input: AdminMissionInput) => Promise<AdminMissionResult>;
  enrollNode?: (input: AdminNodeInput) => Promise<AdminNodeResult>;
  saveNotificationDraft?: (input: AdminNotificationDraftInput) => Promise<AdminNotificationDraftResult>;
}) {
  const defaultUserId = resources.users[0]?.id ?? '';
  const defaultPlan = resources.plans[0];
  const defaultMission = resources.missions[0];
  const defaultDraft = resources.notificationDrafts[0];
  const [freeCreditPending, setFreeCreditPending] = useState(false);
  const [freeCreditNotice, setFreeCreditNotice] = useState<string | null>(null);
  const [premiumPending, setPremiumPending] = useState(false);
  const [premiumNotice, setPremiumNotice] = useState<string | null>(null);
  const [suspensionPending, setSuspensionPending] = useState(false);
  const [suspensionNotice, setSuspensionNotice] = useState<string | null>(null);
  const [settingsPending, setSettingsPending] = useState(false);
  const [settingsNotice, setSettingsNotice] = useState<string | null>(null);
  const [planPending, setPlanPending] = useState(false);
  const [planNotice, setPlanNotice] = useState<string | null>(null);
  const [missionPending, setMissionPending] = useState(false);
  const [missionNotice, setMissionNotice] = useState<string | null>(null);
  const [nodePending, setNodePending] = useState(false);
  const [nodeNotice, setNodeNotice] = useState<string | null>(null);
  const [draftPending, setDraftPending] = useState(false);
  const [draftNotice, setDraftNotice] = useState<string | null>(null);
  const freeCreditAvailable = mutationsAvailable || adjustFreeCredit !== undefined;
  const premiumAvailable = mutationsAvailable || adjustPremium !== undefined;
  const suspensionAvailable = mutationsAvailable || adjustSuspension !== undefined;
  const settingsAvailable = mutationsAvailable || saveSettings !== undefined;
  const planAvailable = mutationsAvailable || savePlan !== undefined;
  const missionAvailable = mutationsAvailable || saveMission !== undefined;
  const nodeAvailable = mutationsAvailable || enrollNode !== undefined;
  const draftAvailable = mutationsAvailable || saveNotificationDraft !== undefined;

  async function submitFreeCredit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!adjustFreeCredit || freeCreditPending) return;
    const form = new FormData(event.currentTarget);
    const userId = String(form.get('userId') ?? '').trim();
    const seconds = Number(form.get('seconds'));
    const reason = String(form.get('reason') ?? '').trim();
    const idempotencyKey = String(form.get('idempotencyKey') ?? '').trim();
    setFreeCreditPending(true);
    setFreeCreditNotice(null);
    try {
      const result = await adjustFreeCredit(userId, { seconds, reason, idempotencyKey });
      setFreeCreditNotice(result.applied ? 'اعتبار رایگان اعمال شد.' : 'این درخواست قبلاً اعمال شده است.');
    } catch {
      setFreeCreditNotice('اعمال اعتبار رایگان انجام نشد.');
    } finally {
      setFreeCreditPending(false);
    }
  }

  async function submitPremium(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!adjustPremium || premiumPending) return;
    const form = new FormData(event.currentTarget);
    const userId = String(form.get('userId') ?? '').trim();
    const premiumUntilValue = String(form.get('premiumUntil') ?? '').trim();
    const reason = String(form.get('reason') ?? '').trim();
    const idempotencyKey = String(form.get('idempotencyKey') ?? '').trim();
    const premiumUntil = new Date(premiumUntilValue);
    if (Number.isNaN(premiumUntil.getTime())) {
      setPremiumNotice('تاریخ پایان پرمیوم معتبر نیست.');
      return;
    }
    setPremiumPending(true);
    setPremiumNotice(null);
    try {
      const result = await adjustPremium(userId, {
        premiumUntil: premiumUntil.toISOString(),
        reason,
        idempotencyKey,
      });
      setPremiumNotice(result.applied ? 'پرمیوم ثبت شد.' : 'این درخواست قبلاً اعمال شده است.');
    } catch {
      setPremiumNotice('ثبت پرمیوم انجام نشد.');
    } finally {
      setPremiumPending(false);
    }
  }

  async function submitSuspension(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!adjustSuspension || suspensionPending) return;
    const form = new FormData(event.currentTarget);
    const userId = String(form.get('userId') ?? '').trim();
    const suspended = form.get('suspended') === 'on';
    const reason = String(form.get('reason') ?? '').trim();
    setSuspensionPending(true);
    setSuspensionNotice(null);
    try {
      const result = await adjustSuspension(userId, { suspended, reason });
      setSuspensionNotice(result.suspended ? 'حساب معلق شد.' : 'تعلیق حساب برداشته شد.');
    } catch {
      setSuspensionNotice('تغییر وضعیت حساب انجام نشد.');
    } finally {
      setSuspensionPending(false);
    }
  }

  async function submitSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!saveSettings || settingsPending) return;
    const form = new FormData(event.currentTarget);
    const freeSpeedKbps = Number(form.get('freeSpeedKbps'));
    const notificationsEnabled = form.get('notificationsEnabled') === 'on';
    setSettingsPending(true);
    setSettingsNotice(null);
    try {
      await saveSettings({ freeSpeedKbps, notificationsEnabled });
      setSettingsNotice('تنظیمات ذخیره شد.');
    } catch {
      setSettingsNotice('ذخیره تنظیمات انجام نشد.');
    } finally {
      setSettingsPending(false);
    }
  }

  async function submitPlan(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!savePlan || planPending) return;
    const form = new FormData(event.currentTarget);
    const planId = String(form.get('planId') ?? '').trim();
    const title = String(form.get('title') ?? '').trim();
    const durationDays = Number(form.get('durationDays'));
    const priceMinor = Number(form.get('priceMinor'));
    const currency = String(form.get('currency') ?? '').trim();
    const enabled = form.get('enabled') === 'on';
    setPlanPending(true);
    setPlanNotice(null);
    try {
      await savePlan(planId, { title, durationDays, priceMinor, currency, enabled });
      setPlanNotice('پلن ذخیره شد.');
    } catch {
      setPlanNotice('ذخیره پلن انجام نشد.');
    } finally {
      setPlanPending(false);
    }
  }

  async function submitMission(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!saveMission || missionPending) return;
    const form = new FormData(event.currentTarget);
    const missionId = String(form.get('missionId') ?? '').trim();
    const title = String(form.get('title') ?? '').trim();
    const description = String(form.get('description') ?? '').trim();
    const rewardSeconds = Number(form.get('rewardSeconds'));
    const status = String(form.get('status') ?? '').trim();
    setMissionPending(true);
    setMissionNotice(null);
    try {
      await saveMission(missionId, { title, description, rewardSeconds, status });
      setMissionNotice('ماموریت ذخیره شد.');
    } catch {
      setMissionNotice('ذخیره ماموریت انجام نشد.');
    } finally {
      setMissionPending(false);
    }
  }

  async function submitNode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!enrollNode || nodePending) return;
    const form = new FormData(event.currentTarget);
    const name = String(form.get('name') ?? '').trim();
    setNodePending(true);
    setNodeNotice(null);
    try {
      const result = await enrollNode({ name });
      setNodeNotice(
        result.status === 'enrolled'
          ? 'نود ثبت شد و در وضعیت enrolled باقی می‌ماند.'
          : 'پاسخ وضعیت نود معتبر نیست.',
      );
    } catch {
      setNodeNotice('ثبت نود انجام نشد.');
    } finally {
      setNodePending(false);
    }
  }

  async function submitNotificationDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!saveNotificationDraft || draftPending) return;
    const form = new FormData(event.currentTarget);
    const title = String(form.get('title') ?? '').trim();
    const body = String(form.get('body') ?? '').trim();
    const target = String(form.get('target') ?? '').trim();
    setDraftPending(true);
    setDraftNotice(null);
    try {
      const result = await saveNotificationDraft({ title, body, target });
      setDraftNotice(
        result.deliveryStatus === 'draft'
          ? 'پیش‌نویس ذخیره شد. ارسال هنوز انجام نشده است.'
          : 'وضعیت پیش‌نویس معتبر نیست.',
      );
    } catch {
      setDraftNotice('ذخیره پیش‌نویس انجام نشد.');
    } finally {
      setDraftPending(false);
    }
  }

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

      {!mutationsAvailable && !adjustFreeCredit && !adjustPremium && !adjustSuspension && !saveSettings && !savePlan && !saveMission && !enrollNode && !saveNotificationDraft ? (
        <p className="inline-notice" role="status">توکن CSRF این session در دسترس نیست؛ عملیات ممتاز فقط خواندنی است.</p>
      ) : !mutationsAvailable ? (
        <p className="inline-notice">توکن CSRF هنگام عملیات متصل دریافت می‌شود؛ سایر فرم‌های ممتاز تا wiring امن فقط خواندنی‌اند.</p>
      ) : null}

      <div className="surface-grid surface-grid--two">
        <Card>
          <PageHeader eyebrow="Policy" title="تنظیمات رایگان" description="تغییرات نهایی فقط با session ادمین و CSRF ذخیره می‌شود." />
          <form className="form-stack" onSubmit={submitSettings}>
            <label className="field-label" htmlFor="free-speed">سرعت رایگان (Kbps)</label>
            <input className="text-input" id="free-speed" name="freeSpeedKbps" type="number" min="64" max="1000000" defaultValue={overview.settings.freeSpeedKbps} />
            {!overview.readiness.speedEnforcement ? (
              <p className="inline-notice">این مقدار policy هدف است؛ اعمال per-client آن تا تأیید throughput روی VPS واقعی آماده نیست.</p>
            ) : null}
            <label className="check-row">
              <input type="checkbox" name="notificationsEnabled" defaultChecked={overview.settings.notificationsEnabled} />
              اعلان‌های مدیریتی فعال باشد
            </label>
            <Button disabled={!settingsAvailable || settingsPending} type="submit">
              {settingsPending ? 'در حال ذخیره…' : 'ذخیره تنظیمات'}
            </Button>
            {settingsNotice ? <p className="inline-notice" role="status">{settingsNotice}</p> : null}
          </form>
        </Card>
        <Card>
          <PageHeader eyebrow="Readiness" title="آمادگی زیرساخت" description="آمادگی integration از تنظیم policy یا موفقیت ظاهری جداست." />
          <div className="readiness-list">
            <Availability label="نود" ready={overview.readiness.nodes} />
            <Availability label="ایمیل" ready={overview.readiness.email} />
            <Availability label="تبلیغات" ready={overview.readiness.ads} />
            <Availability label="پرداخت" ready={overview.readiness.payments} />
            <Availability label="اعلان" ready={overview.readiness.push} />
            <Availability label="اعمال محدودیت سرعت" ready={overview.readiness.speedEnforcement} />
          </div>
        </Card>
      </div>

      <Card>
        <PageHeader eyebrow="کاربران" title="حساب‌های ثبت‌شده" description="فهرست واقعی کاربران قابل مشاهده است؛ اطلاعات حساس ورود در این صفحه نمایش داده نمی‌شود." />
        <ResourceList label="کاربران ثبت‌شده">
          {resources.users.length === 0
            ? <span className="empty-state">هیچ کاربر ثبت‌شده‌ای وجود ندارد.</span>
            : resources.users.map((user) => <ResourceValue key={user.id} primary={user.email} secondary={user.role} />)}
        </ResourceList>
      </Card>

      <div className="surface-grid surface-grid--three">
        <Card>
          <PageHeader eyebrow="Free Credit" title="اعتبار رایگان" description="اصلاح دستی فقط از API ادمین، با کلید idempotency و Audit سمت سرور اعمال می‌شود." />
          <form className="form-stack" aria-label="فرم اصلاح اعتبار رایگان" onSubmit={submitFreeCredit}>
            <label className="field-label" htmlFor="admin-free-user">شناسه کاربر</label>
            <input className="text-input" id="admin-free-user" name="userId" defaultValue={defaultUserId} />
            <label className="field-label" htmlFor="admin-free-seconds">ثانیه</label>
            <input className="text-input" id="admin-free-seconds" name="seconds" type="number" defaultValue="900" />
            <label className="field-label" htmlFor="admin-free-reason">دلیل</label>
            <input className="text-input" id="admin-free-reason" name="reason" defaultValue="" />
            <label className="field-label" htmlFor="admin-free-key">کلید idempotency</label>
            <input className="text-input" id="admin-free-key" name="idempotencyKey" defaultValue="" />
            <Button disabled={!freeCreditAvailable || freeCreditPending} type="submit">
              {freeCreditPending ? 'در حال اعمال…' : 'اعمال اعتبار رایگان'}
            </Button>
            {freeCreditNotice ? <p className="inline-notice" role="status">{freeCreditNotice}</p> : null}
          </form>
        </Card>

        <Card>
          <PageHeader eyebrow="Premium" title="تنظیم پرمیوم" description="تاریخ پایان فقط با mutation محافظت‌شده و ثبت Audit تغییر می‌کند." />
          <form className="form-stack" aria-label="فرم تنظیم پرمیوم" onSubmit={submitPremium}>
            <label className="field-label" htmlFor="admin-premium-user">شناسه کاربر</label>
            <input className="text-input" id="admin-premium-user" name="userId" defaultValue={defaultUserId} />
            <label className="field-label" htmlFor="admin-premium-until">پایان پرمیوم</label>
            <input className="text-input" id="admin-premium-until" name="premiumUntil" type="datetime-local" />
            <label className="field-label" htmlFor="admin-premium-reason">دلیل</label>
            <input className="text-input" id="admin-premium-reason" name="reason" defaultValue="" />
            <label className="field-label" htmlFor="admin-premium-key">کلید idempotency</label>
            <input className="text-input" id="admin-premium-key" name="idempotencyKey" defaultValue="" />
            <Button disabled={!premiumAvailable || premiumPending} type="submit">
              {premiumPending ? 'در حال ثبت…' : 'ثبت پرمیوم'}
            </Button>
            {premiumNotice ? <p className="inline-notice" role="status">{premiumNotice}</p> : null}
          </form>
        </Card>

        <Card>
          <PageHeader eyebrow="User State" title="تعلیق حساب" description="تعلیق در مرز احراز هویت enforce می‌شود و session موجود را هم فوراً محدود می‌کند." />
          <form className="form-stack" aria-label="فرم تعلیق حساب" onSubmit={submitSuspension}>
            <label className="field-label" htmlFor="admin-suspension-user">شناسه کاربر</label>
            <input className="text-input" id="admin-suspension-user" name="userId" defaultValue={defaultUserId} />
            <label className="check-row">
              <input type="checkbox" name="suspended" />
              حساب معلق باشد
            </label>
            <label className="field-label" htmlFor="admin-suspension-reason">دلیل</label>
            <input className="text-input" id="admin-suspension-reason" name="reason" defaultValue="" />
            <Button disabled={!suspensionAvailable || suspensionPending} type="submit">
              {suspensionPending ? 'در حال تغییر…' : 'تغییر وضعیت حساب'}
            </Button>
            {suspensionNotice ? <p className="inline-notice" role="status">{suspensionNotice}</p> : null}
          </form>
        </Card>
      </div>

      <div className="surface-grid surface-grid--two">
        <Card>
          <PageHeader eyebrow="پلن‌ها" title="مدیریت پلن" description="ذخیره پلن فقط با CSRF معتبر فعال می‌شود." />
          <ResourceList label="پلن‌های واقعی">
            {resources.plans.length === 0
              ? <span className="empty-state">هیچ پلن واقعی ثبت نشده است.</span>
              : resources.plans.map((plan) => <span key={plan.id}>{plan.title}</span>)}
          </ResourceList>
          <form className="form-stack" aria-label="فرم مدیریت پلن" onSubmit={submitPlan}>
            <label className="field-label" htmlFor="admin-plan-id">شناسه پلن</label>
            <input className="text-input" id="admin-plan-id" name="planId" defaultValue={defaultPlan?.id ?? ''} />
            <label className="field-label" htmlFor="admin-plan-title">عنوان پلن</label>
            <input className="text-input" id="admin-plan-title" name="title" defaultValue={defaultPlan?.title ?? ''} />
            <label className="field-label" htmlFor="admin-plan-duration">مدت (روز)</label>
            <input className="text-input" id="admin-plan-duration" name="durationDays" type="number" min="1" defaultValue={defaultPlan?.durationDays ?? 30} />
            <label className="field-label" htmlFor="admin-plan-price">قیمت (واحد خرد)</label>
            <input className="text-input" id="admin-plan-price" name="priceMinor" type="number" min="0" defaultValue={defaultPlan?.priceMinor ?? 0} />
            <label className="field-label" htmlFor="admin-plan-currency">ارز</label>
            <input className="text-input" id="admin-plan-currency" name="currency" defaultValue={defaultPlan?.currency ?? 'IRR'} />
            <label className="check-row">
              <input type="checkbox" name="enabled" defaultChecked={defaultPlan?.enabled ?? true} />
              پلن فعال باشد
            </label>
            <Button disabled={!planAvailable || planPending} type="submit">
              {planPending ? 'در حال ذخیره…' : 'ذخیره پلن'}
            </Button>
            {planNotice ? <p className="inline-notice" role="status">{planNotice}</p> : null}
          </form>
        </Card>

        <Card>
          <PageHeader eyebrow="ماموریت‌ها" title="ویرایش ماموریت" description="ثبت ماموریت اعتبار کاربر را مستقیم افزایش نمی‌دهد؛ پاداش فقط با تأیید سمت سرور اعمال می‌شود." />
          <ResourceList label="ماموریت‌های واقعی">
            {resources.missions.length === 0
              ? <span className="empty-state">هیچ ماموریت واقعی ثبت نشده است.</span>
              : resources.missions.map((mission) => <span key={mission.id}>{mission.title}</span>)}
          </ResourceList>
          <form className="form-stack" aria-label="فرم مدیریت ماموریت" onSubmit={submitMission}>
            <label className="field-label" htmlFor="admin-mission-id">شناسه ماموریت</label>
            <input className="text-input" id="admin-mission-id" name="missionId" defaultValue={defaultMission?.id ?? ''} />
            <label className="field-label" htmlFor="admin-mission-title">عنوان ماموریت</label>
            <input className="text-input" id="admin-mission-title" name="title" defaultValue={defaultMission?.title ?? ''} />
            <label className="field-label" htmlFor="admin-mission-description">توضیحات ماموریت</label>
            <input className="text-input" id="admin-mission-description" name="description" defaultValue={defaultMission?.description ?? ''} />
            <label className="field-label" htmlFor="admin-mission-reward">پاداش (ثانیه)</label>
            <input className="text-input" id="admin-mission-reward" name="rewardSeconds" type="number" min="0" defaultValue={defaultMission?.rewardSeconds ?? 0} />
            <label className="field-label" htmlFor="admin-mission-status">وضعیت ماموریت</label>
            <input className="text-input" id="admin-mission-status" name="status" defaultValue={defaultMission?.status ?? 'active'} />
            <Button disabled={!missionAvailable || missionPending} type="submit">
              {missionPending ? 'در حال ذخیره…' : 'ثبت ماموریت'}
            </Button>
            {missionNotice ? <p className="inline-notice" role="status">{missionNotice}</p> : null}
          </form>
        </Card>
      </div>

      <div className="surface-grid surface-grid--two">
        <Card>
          <PageHeader eyebrow="نودها" title="ثبت نود" description="ثبت نود فقط رکورد enrolled ایجاد می‌کند؛ مواد دسترسی تنها پس از آماده‌شدن واقعی زیرساخت مدیریت می‌شوند." />
          <ResourceList label="نودهای واقعی">
            {resources.nodes.length === 0
              ? <span className="empty-state">هیچ نود ثبت‌شده‌ای وجود ندارد.</span>
              : resources.nodes.map((node) => <ResourceValue key={node.id} primary={node.name} secondary={node.status} />)}
          </ResourceList>
          <form className="form-stack" aria-label="فرم ثبت نود" onSubmit={submitNode}>
            <label className="field-label" htmlFor="admin-node-name">نام نود</label>
            <input className="text-input" id="admin-node-name" name="name" defaultValue="" />
            <Button disabled={!nodeAvailable || nodePending} type="submit">
              {nodePending ? 'در حال ثبت…' : 'ثبت نود'}
            </Button>
            {nodeNotice ? <p className="inline-notice" role="status">{nodeNotice}</p> : null}
          </form>
        </Card>

        <Card>
          <PageHeader eyebrow="اعلان‌ها" title="پیش‌نویس اعلان" description="ذخیره پیش‌نویس به معنی تحویل اعلان نیست و وضعیت delivery جداگانه باقی می‌ماند." />
          <ResourceList label="پیش‌نویس‌های اعلان">
            {resources.notificationDrafts.length === 0
              ? <span className="empty-state">هیچ پیش‌نویس اعلانی ثبت نشده است.</span>
              : resources.notificationDrafts.map((draft) => <ResourceValue key={draft.id} primary={draft.title} secondary={draft.deliveryStatus} />)}
          </ResourceList>
          <form className="form-stack" aria-label="فرم پیش‌نویس اعلان" onSubmit={submitNotificationDraft}>
            <label className="field-label" htmlFor="admin-draft-title">عنوان اعلان</label>
            <input className="text-input" id="admin-draft-title" name="title" defaultValue={defaultDraft?.title ?? ''} />
            <label className="field-label" htmlFor="admin-draft-body">متن اعلان</label>
            <textarea className="text-input" id="admin-draft-body" name="body" defaultValue={defaultDraft?.body ?? ''} />
            <label className="field-label" htmlFor="admin-draft-target">مخاطب</label>
            <input className="text-input" id="admin-draft-target" name="target" defaultValue={defaultDraft?.target ?? 'all'} />
            <Button disabled={!draftAvailable || draftPending} type="submit">
              {draftPending ? 'در حال ذخیره…' : 'ذخیره پیش‌نویس'}
            </Button>
            {draftNotice ? <p className="inline-notice" role="status">{draftNotice}</p> : null}
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
          {resources.audit.length === 0
            ? <span className="empty-state">هنوز رویداد Audit ثبت نشده است.</span>
            : resources.audit.map((entry) => <span key={entry.id}>{entry.action}</span>)}
        </ResourceList>
      </Card>
    </div>
  );
}
