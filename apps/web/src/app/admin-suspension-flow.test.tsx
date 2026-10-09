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
  plans: [], missions: [], nodes: [], notificationDrafts: [], audit: [],
};

afterEach(() => { vi.unstubAllGlobals(); window.history.pushState({}, '', '/'); });

describe('admin suspension mutation wiring', () => {
  it('gets a current CSRF token and submits the real suspension state to the admin API', async () => {
    window.history.pushState({}, '', '/admin');
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input); requests.push({ url, init });
      if (url === '/api/health') return Response.json({ status: 'ok' });
      if (url === '/api/admin/overview') return Response.json(overview);
      if (url === '/api/admin/resources') return Response.json(resources);
      if (url === '/api/auth/csrf') return Response.json({ csrfToken: 'admin-csrf' });
      if (url === '/api/admin/users/user-1/suspension') {
        expect(init).toMatchObject({ method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', 'x-csrf-token': 'admin-csrf' } });
        expect(JSON.parse(String(init?.body))).toEqual({ suspended: true, reason: 'بررسی سوءاستفاده' });
        return Response.json({ suspended: true });
      }
      return new Response(null, { status: 404 });
    }));
    render(<App />);
    const form = await screen.findByRole('form', { name: 'فرم تعلیق حساب' });
    const suspension = within(form);
    const button = suspension.getByRole('button', { name: 'تغییر وضعیت حساب' });
    expect(button).toBeEnabled();
    fireEvent.click(suspension.getByRole('checkbox', { name: 'حساب معلق باشد' }));
    fireEvent.change(suspension.getByLabelText('دلیل'), { target: { value: 'بررسی سوءاستفاده' } });
    fireEvent.click(button);
    expect(await suspension.findByRole('status')).toHaveTextContent('حساب معلق شد.');
    await waitFor(() => { expect(requests.map(({ url }) => url)).toContain('/api/auth/csrf'); expect(requests.map(({ url }) => url)).toContain('/api/admin/users/user-1/suspension'); });
  });
});
