import { useEffect, useState, type FormEvent } from 'react';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { PageHeader } from '../components/PageHeader';

export type LoginRequestResult = 'sent' | 'unavailable';
export type MagicLinkResult = 'success' | 'invalid' | 'error';

type LoginState = 'idle' | 'sending' | 'sent' | 'unavailable' | 'error';

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
    <Card>
      <PageHeader
        eyebrow="ورود امن"
        title="ورود با لینک یک‌بارمصرف"
        description="لینک ورود منقضی می‌شود و session فقط در کوکی HttpOnly نگهداری می‌شود."
      />
      <form className="form-stack" aria-label="فرم ورود ایمیلی" onSubmit={submit}>
        <label className="field-label" htmlFor="login-email">ایمیل</label>
        <input
          className="text-input"
          id="login-email"
          name="email"
          type="email"
          autoComplete="email"
          required
        />
        <Button disabled={!canSubmit} type="submit">
          {state === 'sending' ? 'در حال ارسال…' : 'ارسال لینک ورود'}
        </Button>
      </form>
      {unavailable ? (
        <p className="inline-notice" role="status">سرویس ایمیل هنوز متصل نشده؛ ارسال لینک ورود غیرفعال است.</p>
      ) : null}
      {state === 'sent' ? (
        <p className="inline-notice" role="status">لینک ورود ارسال شد. صندوق ورودی و پوشه هرزنامه را بررسی کنید.</p>
      ) : null}
      {state === 'error' ? (
        <p className="inline-notice" role="status">ارسال لینک ورود با خطا روبه‌رو شد؛ دوباره تلاش کنید.</p>
      ) : null}
    </Card>
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
      <Card>
        <PageHeader eyebrow="ورود امن" title="در حال تأیید لینک ورود" description="اعتبار لینک فقط در سمت سرور بررسی می‌شود." />
      </Card>
    );
  }

  if (result === 'success') {
    return (
      <Card>
        <PageHeader eyebrow="ورود امن" title="ورود با موفقیت تأیید شد" description="session امن شما در کوکی HttpOnly ایجاد شد." />
        <a className="text-link" href="/">رفتن به داشبورد</a>
      </Card>
    );
  }

  if (result === 'invalid') {
    return (
      <Card>
        <PageHeader eyebrow="لینک نامعتبر" title="لینک ورود نامعتبر یا منقضی شده است" description="برای دریافت لینک تازه به صفحه ورود برگردید." />
        <a className="text-link" href="/login">درخواست لینک تازه</a>
      </Card>
    );
  }

  return (
    <Card>
      <PageHeader eyebrow="خطا" title="تأیید لینک ورود انجام نشد" description="پاسخ سرور با خطا روبه‌رو شد؛ دوباره تلاش کنید." />
      <a className="text-link" href="/login">بازگشت به ورود</a>
    </Card>
  );
}
