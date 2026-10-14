import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Button } from '../components/Button';
import { MadarLogo } from '../components/MadarLogo';

export type LoginRequestResult = 'sent' | 'unavailable';
export type MagicLinkResult = 'success' | 'invalid' | 'error';

type LoginState = 'idle' | 'sending' | 'sent' | 'unavailable' | 'error';

function AuthOrbit() {
  return (
    <div aria-hidden="true" className="auth-orbit">
      <span className="auth-orbit__planet" />
      <span className="auth-orbit__line auth-orbit__line--one" />
      <span className="auth-orbit__line auth-orbit__line--two" />
      <span className="auth-orbit__spark auth-orbit__spark--one" />
      <span className="auth-orbit__spark auth-orbit__spark--two" />
    </div>
  );
}

function AuthFrame({ children, compact = false }: { children: ReactNode; compact?: boolean }) {
  return (
    <section className={compact ? 'auth-screen auth-screen--compact' : 'auth-screen'}>
      <div className="auth-brand">
        <MadarLogo />
        <p className="auth-brand__tagline">اتصال آزادتر، زندگی بزرگ‌تر</p>
      </div>
      <AuthOrbit />
      {children}
    </section>
  );
}

export function InteractiveLoginPage({
  emailAvailable,
  requestLogin,
}: {
  emailAvailable: boolean;
  requestLogin?: (email: string) => Promise<LoginRequestResult>;
}) {
  const [state, setState] = useState<LoginState>('idle');
  const canSubmit = emailAvailable && Boolean(requestLogin) && state !== 'sending';

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit || !requestLogin) return;
    const form = new FormData(event.currentTarget);
    const email = form.get('email');
    if (typeof email !== 'string' || email.trim().length === 0) return;

    setState('sending');
    try {
      const result = await requestLogin(email.trim());
      setState(result === 'sent' ? 'sent' : 'unavailable');
    } catch {
      setState('error');
    }
  }

  const unavailable = !emailAvailable || state === 'unavailable';

  return (
    <AuthFrame>
      <div className="auth-panel">
        <header className="auth-copy">
          <p className="auth-copy__eyebrow">ورود امن</p>
          <h2 className="auth-copy__title">ورود <span>امن</span> و ساده</h2>
          <p className="auth-copy__description">ایمیل خود را وارد کنید تا لینک ورود جادویی برای شما ارسال شود.</p>
        </header>

        <form className="auth-form" aria-label="فرم ورود ایمیلی" onSubmit={submit}>
          <label className="auth-field" htmlFor="login-email">
            <span className="auth-field__label">ایمیل شما</span>
            <span aria-hidden="true" className="auth-field__icon">✉</span>
            <input
              aria-label="ایمیل"
              autoComplete="email"
              className="auth-email-input"
              dir="ltr"
              id="login-email"
              name="email"
              placeholder="name@example.com"
              required
              type="email"
            />
          </label>
          <Button disabled={!canSubmit} type="submit">
            {state === 'sending' ? 'در حال ارسال…' : 'ارسال لینک ورود'}
          </Button>
        </form>

        {unavailable ? (
          <p className="inline-notice auth-notice" role="status">سرویس ایمیل هنوز متصل نشده؛ ارسال لینک ورود غیرفعال است.</p>
        ) : null}
        {state === 'sent' ? (
          <p className="inline-notice auth-notice auth-notice--success" role="status">لینک ورود ارسال شد. صندوق ورودی و پوشه هرزنامه را بررسی کنید.</p>
        ) : null}
        {state === 'error' ? (
          <p className="inline-notice auth-notice" role="status">ارسال لینک ورود با خطا روبه‌رو شد؛ دوباره تلاش کنید.</p>
        ) : null}

        <aside className="auth-security-note">
          <span aria-hidden="true" className="auth-security-note__icon">⌾</span>
          <div>
            <strong>لینک ورود یک‌بار مصرف است</strong>
            <p>این لینک به دلایل امنیتی فقط برای مدت کوتاهی معتبر خواهد بود.</p>
          </div>
        </aside>
      </div>
    </AuthFrame>
  );
}

function MagicLinkResultCard({
  eyebrow,
  title,
  description,
  linkHref,
  linkLabel,
  tone = 'neutral',
}: {
  eyebrow: string;
  title: string;
  description: string;
  linkHref?: string;
  linkLabel?: string;
  tone?: 'neutral' | 'success' | 'danger';
}) {
  return (
    <AuthFrame compact>
      <div className={`auth-result auth-result--${tone}`}>
        <span aria-hidden="true" className="auth-result__mark">{tone === 'success' ? '✓' : tone === 'danger' ? '!' : '…'}</span>
        <p className="auth-copy__eyebrow">{eyebrow}</p>
        <h2 className="auth-result__title">{title}</h2>
        <p className="auth-result__description">{description}</p>
        {linkHref && linkLabel ? <a className="auth-result__link" href={linkHref}>{linkLabel}</a> : null}
      </div>
    </AuthFrame>
  );
}

export function MagicLinkPage({
  token,
  consume,
}: {
  token: string;
  consume: (token: string) => Promise<MagicLinkResult>;
}) {
  const [result, setResult] = useState<MagicLinkResult | 'checking'>('checking');

  useEffect(() => {
    let active = true;
    window.history.replaceState({}, '', '/login');
    void consume(token)
      .then((next) => {
        if (active) setResult(next);
      })
      .catch(() => {
        if (active) setResult('error');
      });
    return () => {
      active = false;
    };
  }, [consume, token]);

  if (result === 'checking') {
    return (
      <MagicLinkResultCard
        eyebrow="ورود امن"
        title="در حال تأیید لینک ورود"
        description="اعتبار لینک فقط در سمت سرور بررسی می‌شود."
      />
    );
  }

  if (result === 'success') {
    return (
      <MagicLinkResultCard
        description="session امن شما در کوکی HttpOnly ایجاد شد."
        eyebrow="ورود امن"
        linkHref="/"
        linkLabel="رفتن به داشبورد"
        title="ورود با موفقیت تأیید شد"
        tone="success"
      />
    );
  }

  if (result === 'invalid') {
    return (
      <MagicLinkResultCard
        description="برای دریافت لینک تازه به صفحه ورود برگردید."
        eyebrow="لینک نامعتبر"
        linkHref="/login"
        linkLabel="درخواست لینک تازه"
        title="لینک ورود نامعتبر یا منقضی شده است"
        tone="danger"
      />
    );
  }

  return (
    <MagicLinkResultCard
      description="پاسخ سرور با خطا روبه‌رو شد؛ دوباره تلاش کنید."
      eyebrow="خطا"
      linkHref="/login"
      linkLabel="بازگشت به ورود"
      title="تأیید لینک ورود انجام نشد"
      tone="danger"
    />
  );
}
