import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.pushState({}, '', '/');
});

describe('Madar login flow', () => {
  it('enables login only from real email readiness and sends the entered address to the auth API', async () => {
    window.history.pushState({}, '', '/login');
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/health') return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
      if (url === '/api/auth/readiness') {
        return new Response(JSON.stringify({ email: true }), { status: 200 });
      }
      if (url === '/api/auth/request') {
        expect(init).toMatchObject({
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
        });
        expect(JSON.parse(String(init?.body))).toEqual({ email: 'user@example.com' });
        return new Response(JSON.stringify({ status: 'sent' }), { status: 200 });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal('fetch', fetcher);

    render(<App />);

    const email = await screen.findByRole('textbox', { name: /ایمیل/ });
    const submit = screen.getByRole('button', { name: /ارسال لینک ورود/ });
    expect(submit).toBeEnabled();
    fireEvent.change(email, { target: { value: 'user@example.com' } });
    fireEvent.click(submit);

    expect(await screen.findByText(/لینک ورود ارسال شد/)).toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledWith('/api/auth/request', expect.any(Object));
  });

  it('keeps login disabled when backend readiness reports no email provider', async () => {
    window.history.pushState({}, '', '/login');
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/health') return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
      if (url === '/api/auth/readiness') return new Response(JSON.stringify({ email: false }), { status: 200 });
      return new Response(null, { status: 404 });
    }));

    render(<App />);

    expect(await screen.findByRole('button', { name: /ارسال لینک ورود/ })).toBeDisabled();
    expect(screen.getByText(/سرویس ایمیل هنوز متصل نشده/)).toBeInTheDocument();
  });

  it('consumes a magic-link token, clears it from the URL, and shows an authenticated handoff', async () => {
    window.history.pushState({}, '', '/login?token=magic-secret-value');
    const replaceSpy = vi.spyOn(window.history, 'replaceState');
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/health') return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
      if (url === '/api/auth/consume') {
        expect(init).toMatchObject({
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
        });
        expect(JSON.parse(String(init?.body))).toEqual({ token: 'magic-secret-value' });
        return new Response(JSON.stringify({ csrfToken: 'csrf', expiresAt: '2026-11-08T00:00:00.000Z' }), { status: 200 });
      }
      return new Response(null, { status: 404 });
    }));

    render(<App />);

    expect(await screen.findByText(/ورود با موفقیت تأیید شد/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /رفتن به داشبورد/ })).toHaveAttribute('href', '/');
    await waitFor(() => expect(replaceSpy).toHaveBeenCalledWith({}, '', '/login'));
  });

  it('shows an expired/invalid state without leaking the magic token', async () => {
    window.history.pushState({}, '', '/login?token=expired-secret-value');
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/health') return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
      if (url === '/api/auth/consume') return new Response(JSON.stringify({ error: 'TOKEN_INVALID' }), { status: 401 });
      return new Response(null, { status: 404 });
    }));

    render(<App />);

    expect(await screen.findByText(/لینک ورود نامعتبر یا منقضی شده است/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('expired-secret-value');
  });
});
