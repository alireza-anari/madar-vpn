import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

const overview = {
  counts: { users: 1, readyNodes: 0, plans: 0, missions: 0 },
  readiness: { nodes: false, email: false, ads: false, payments: false, push: false, speedEnforcement: false },
  settings: { freeSpeedKbps: 5000, notificationsEnabled: false },
};

const resources = {
  users: [{ id: 'user-1', email: 'user@example.com', role: 'user' as const }],
  plans: [],
  missions: [],
  nodes: [],
  notificationDrafts: [],
  audit: [],
};

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.pushState({}, '', '/');
});

describe('admin premium mutation wiring', () => {
  it('gets a current CSRF token and submits an idempotent premium expiry mutation', async () => {
    window.history.pushState({}, '', '/admin');
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url === '/api/health') return Response.json({ status: 'ok' });
      if (url === '/api/admin/overview') return Response.json(overview);
      if (url === '/api/admin/resources') return Response.json(resources);
      if (url === '/api/auth/csrf') return Response.json({ csrfToken: 'admin-csrf' });
      if (url === '/api/admin/users/user-1/premium') {
        expect(init).toMatchObject({
          method: 'POST',
          credentials: 'include',
          headers: {
            'content-type': 'application/json',
            'x-csrf-token': 'admin-csrf',
          },
        });
        const body = JSON.parse(String(init?.body));
        expect(body).toMatchObject({
          reason: 'تمدید پشتیبانی',
          idempotencyKey: 'premium-support-1',
        });
        expect(body.premiumUntil).toBe(new Date('2026-10-20T12:30').toISOString());
        return Response.json({ applied: true, premiumUntil: body.premiumUntil });
      }
      return new Response(null, { status: 404 });
    }));

    render(<App />);

    const form = await screen.findByRole('form', { name: 'فرم تنظیم پرمیوم' });
    const premium = within(form);
    const button = premium.getByRole('button', { name: 'ثبت پرمیوم' });
    expect(button).toBeEnabled();
    expect(screen.getByRole('button', { name: 'ثبت ماموریت' })).toBeDisabled();

    fireEvent.change(premium.getByLabelText('پایان پرمیوم'), { target: { value: '2026-10-20T12:30' } });
    fireEvent.change(premium.getByLabelText('دلیل'), { target: { value: 'تمدید پشتیبانی' } });
    fireEvent.change(premium.getByLabelText('کلید idempotency'), { target: { value: 'premium-support-1' } });
    fireEvent.click(button);

    expect(await premium.findByRole('status')).toHaveTextContent('پرمیوم ثبت شد.');
    await waitFor(() => {
      expect(requests.map(({ url }) => url)).toContain('/api/auth/csrf');
      expect(requests.map(({ url }) => url)).toContain('/api/admin/users/user-1/premium');
    });
  });
});
