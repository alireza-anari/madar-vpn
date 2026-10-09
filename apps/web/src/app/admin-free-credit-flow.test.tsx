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

describe('admin free-credit mutation wiring', () => {
  it('gets a current CSRF token and submits the real idempotent admin adjustment payload', async () => {
    window.history.pushState({}, '', '/admin');
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url === '/api/health') return Response.json({ status: 'ok' });
      if (url === '/api/admin/overview') return Response.json(overview);
      if (url === '/api/admin/resources') return Response.json(resources);
      if (url === '/api/auth/csrf') return Response.json({ csrfToken: 'admin-csrf' });
      if (url === '/api/admin/users/user-1/free-credit') {
        expect(init).toMatchObject({
          method: 'POST',
          credentials: 'include',
          headers: {
            'content-type': 'application/json',
            'x-csrf-token': 'admin-csrf',
          },
        });
        expect(JSON.parse(String(init?.body))).toEqual({
          seconds: 900,
          reason: 'جبران قطعی',
          idempotencyKey: 'support-1',
        });
        return Response.json({ applied: true, seconds: 900 });
      }
      return new Response(null, { status: 404 });
    }));

    render(<App />);

    const form = await screen.findByRole('form', { name: 'فرم اصلاح اعتبار رایگان' });
    const freeCredit = within(form);
    const button = freeCredit.getByRole('button', { name: 'اعمال اعتبار رایگان' });
    expect(button).toBeEnabled();
    expect(screen.getByRole('button', { name: 'ذخیره پیش‌نویس' })).toBeDisabled();

    fireEvent.change(freeCredit.getByLabelText('دلیل'), { target: { value: 'جبران قطعی' } });
    fireEvent.change(freeCredit.getByLabelText('کلید idempotency'), { target: { value: 'support-1' } });
    fireEvent.click(button);

    expect(await freeCredit.findByRole('status')).toHaveTextContent('اعتبار رایگان اعمال شد.');
    await waitFor(() => {
      expect(requests.map(({ url }) => url)).toContain('/api/auth/csrf');
      expect(requests.map(({ url }) => url)).toContain('/api/admin/users/user-1/free-credit');
    });
  });
});
