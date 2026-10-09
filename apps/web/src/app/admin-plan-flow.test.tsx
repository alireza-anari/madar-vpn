import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

const overview = {
  counts: { users: 1, readyNodes: 0, plans: 1, missions: 0 },
  readiness: { nodes: false, email: false, ads: false, payments: false, push: false, speedEnforcement: false },
  settings: { freeSpeedKbps: 5000, notificationsEnabled: false },
};

const resources = {
  users: [{ id: 'user-1', email: 'user@example.com', role: 'user' as const }],
  plans: [{ id: 'basic', title: 'ماهانه', durationDays: 30, priceMinor: 1000, currency: 'IRR', enabled: true, createdAt: '2026-10-09T00:00:00.000Z', updatedAt: '2026-10-09T00:00:00.000Z' }],
  missions: [], nodes: [], notificationDrafts: [], audit: [],
};

afterEach(() => { vi.unstubAllGlobals(); window.history.pushState({}, '', '/'); });

describe('admin plan mutation wiring', () => {
  it('gets a current CSRF token and submits the complete plan contract', async () => {
    window.history.pushState({}, '', '/admin');
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input); requests.push({ url, init });
      if (url === '/api/health') return Response.json({ status: 'ok' });
      if (url === '/api/admin/overview') return Response.json(overview);
      if (url === '/api/admin/resources') return Response.json(resources);
      if (url === '/api/auth/csrf') return Response.json({ csrfToken: 'admin-csrf' });
      if (url === '/api/admin/plans/basic') {
        expect(init).toMatchObject({ method: 'PUT', credentials: 'include', headers: { 'content-type': 'application/json', 'x-csrf-token': 'admin-csrf' } });
        expect(JSON.parse(String(init?.body))).toEqual({ title: 'ماهانه پلاس', durationDays: 45, priceMinor: 1500, currency: 'IRR', enabled: true });
        return Response.json({ ...resources.plans[0], title: 'ماهانه پلاس', durationDays: 45, priceMinor: 1500 });
      }
      return new Response(null, { status: 404 });
    }));
    render(<App />);
    const button = await screen.findByRole('button', { name: 'ذخیره پلن' });
    expect(button).toBeEnabled();
    expect(screen.getByRole('button', { name: 'ذخیره پیش‌نویس' })).toBeDisabled();
    const plan = within(screen.getByRole('form', { name: 'فرم مدیریت پلن' }));
    fireEvent.change(plan.getByLabelText('عنوان پلن'), { target: { value: 'ماهانه پلاس' } });
    fireEvent.change(plan.getByLabelText('مدت (روز)'), { target: { value: '45' } });
    fireEvent.change(plan.getByLabelText('قیمت (واحد خرد)'), { target: { value: '1500' } });
    fireEvent.change(plan.getByLabelText('ارز'), { target: { value: 'IRR' } });
    fireEvent.click(button);
    expect(await plan.findByRole('status')).toHaveTextContent('پلن ذخیره شد.');
    await waitFor(() => { expect(requests.map(({ url }) => url)).toContain('/api/auth/csrf'); expect(requests.map(({ url }) => url)).toContain('/api/admin/plans/basic'); });
  });
});
