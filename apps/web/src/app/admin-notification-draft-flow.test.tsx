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

describe('admin notification draft wiring', () => {
  it('gets a current CSRF token and saves only a draft without claiming delivery', async () => {
    window.history.pushState({}, '', '/admin');
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url === '/api/health') return Response.json({ status: 'ok' });
      if (url === '/api/admin/overview') return Response.json(overview);
      if (url === '/api/admin/resources') return Response.json(resources);
      if (url === '/api/auth/csrf') return Response.json({ csrfToken: 'admin-csrf' });
      if (url === '/api/admin/notification-drafts') {
        expect(init).toMatchObject({
          method: 'POST',
          credentials: 'include',
          headers: {
            'content-type': 'application/json',
            'x-csrf-token': 'admin-csrf',
          },
        });
        expect(JSON.parse(String(init?.body))).toEqual({
          title: 'اطلاعیه نگهداری',
          body: 'امشب سرویس برای نگهداری کوتاه‌مدت در دسترس نخواهد بود.',
          target: 'all',
        });
        return Response.json({
          id: 'draft-1',
          title: 'اطلاعیه نگهداری',
          body: 'امشب سرویس برای نگهداری کوتاه‌مدت در دسترس نخواهد بود.',
          target: 'all',
          createdBy: 'admin-1',
          createdAt: '2026-10-09T00:00:00.000Z',
          deliveryStatus: 'draft',
        }, { status: 201 });
      }
      return new Response(null, { status: 404 });
    }));

    render(<App />);

    const button = await screen.findByRole('button', { name: 'ذخیره پیش‌نویس' });
    expect(button).toBeEnabled();

    const form = screen.getByRole('form', { name: 'فرم پیش‌نویس اعلان' });
    const draft = within(form);
    fireEvent.change(draft.getByLabelText('عنوان اعلان'), { target: { value: 'اطلاعیه نگهداری' } });
    fireEvent.change(draft.getByLabelText('متن اعلان'), { target: { value: 'امشب سرویس برای نگهداری کوتاه‌مدت در دسترس نخواهد بود.' } });
    fireEvent.change(draft.getByLabelText('مخاطب'), { target: { value: 'all' } });
    fireEvent.click(button);

    expect(await draft.findByRole('status')).toHaveTextContent('پیش‌نویس ذخیره شد. ارسال هنوز انجام نشده است.');
    await waitFor(() => {
      expect(requests.map(({ url }) => url)).toContain('/api/auth/csrf');
      expect(requests.map(({ url }) => url)).toContain('/api/admin/notification-drafts');
    });
    expect(requests.some(({ url }) => /send|deliver|dispatch/i.test(url))).toBe(false);
  });
});
