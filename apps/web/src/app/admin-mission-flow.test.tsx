import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

const overview = {
  counts: { users: 1, readyNodes: 0, plans: 0, missions: 1 },
  readiness: { nodes: false, email: false, ads: false, payments: false, push: false, speedEnforcement: false },
  settings: { freeSpeedKbps: 5000, notificationsEnabled: false },
};

const resources = {
  users: [{ id: 'user-1', email: 'user@example.com', role: 'user' as const }],
  plans: [],
  missions: [{
    id: 'referral',
    title: 'دعوت از دوست',
    description: 'پاداش فقط پس از تأیید سمت سرور.',
    rewardSeconds: 900,
    status: 'active',
    createdAt: '2026-10-09T00:00:00.000Z',
    updatedAt: '2026-10-09T00:00:00.000Z',
  }],
  nodes: [],
  notificationDrafts: [],
  audit: [],
};

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.pushState({}, '', '/');
});

describe('admin mission mutation wiring', () => {
  it('gets a current CSRF token and edits mission definition without awarding browser-side credit', async () => {
    window.history.pushState({}, '', '/admin');
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url === '/api/health') return Response.json({ status: 'ok' });
      if (url === '/api/admin/overview') return Response.json(overview);
      if (url === '/api/admin/resources') return Response.json(resources);
      if (url === '/api/auth/csrf') return Response.json({ csrfToken: 'admin-csrf' });
      if (url === '/api/admin/missions/referral') {
        expect(init).toMatchObject({
          method: 'PUT',
          credentials: 'include',
          headers: {
            'content-type': 'application/json',
            'x-csrf-token': 'admin-csrf',
          },
        });
        expect(JSON.parse(String(init?.body))).toEqual({
          title: 'دعوت تأییدشده',
          description: 'اعتبار فقط بعد از بررسی سمت سرور اعمال می‌شود.',
          rewardSeconds: 1200,
          status: 'active',
        });
        return Response.json({
          ...resources.missions[0],
          title: 'دعوت تأییدشده',
          description: 'اعتبار فقط بعد از بررسی سمت سرور اعمال می‌شود.',
          rewardSeconds: 1200,
        });
      }
      return new Response(null, { status: 404 });
    }));

    render(<App />);

    const button = await screen.findByRole('button', { name: 'ثبت ماموریت' });
    expect(button).toBeEnabled();
    expect(screen.getByRole('button', { name: 'ذخیره پیش‌نویس' })).toBeDisabled();

    const form = screen.getByRole('form', { name: 'فرم مدیریت ماموریت' });
    const mission = within(form);
    fireEvent.change(mission.getByLabelText('عنوان ماموریت'), { target: { value: 'دعوت تأییدشده' } });
    fireEvent.change(mission.getByLabelText('توضیحات ماموریت'), { target: { value: 'اعتبار فقط بعد از بررسی سمت سرور اعمال می‌شود.' } });
    fireEvent.change(mission.getByLabelText('پاداش (ثانیه)'), { target: { value: '1200' } });
    fireEvent.change(mission.getByLabelText('وضعیت ماموریت'), { target: { value: 'active' } });
    fireEvent.click(button);

    expect(await mission.findByRole('status')).toHaveTextContent('ماموریت ذخیره شد.');
    await waitFor(() => {
      expect(requests.map(({ url }) => url)).toContain('/api/auth/csrf');
      expect(requests.map(({ url }) => url)).toContain('/api/admin/missions/referral');
    });
    expect(requests.some(({ url }) => url.includes('free-credit'))).toBe(false);
  });
});
