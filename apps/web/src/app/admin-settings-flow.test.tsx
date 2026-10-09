import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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

describe('admin settings mutation wiring', () => {
  it('gets a current CSRF token and saves the configured policy without claiming speed enforcement', async () => {
    window.history.pushState({}, '', '/admin');
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input); requests.push({ url, init });
      if (url === '/api/health') return Response.json({ status: 'ok' });
      if (url === '/api/admin/overview') return Response.json(overview);
      if (url === '/api/admin/resources') return Response.json(resources);
      if (url === '/api/auth/csrf') return Response.json({ csrfToken: 'admin-csrf' });
      if (url === '/api/admin/settings') {
        expect(init).toMatchObject({ method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', 'x-csrf-token': 'admin-csrf' } });
        expect(JSON.parse(String(init?.body))).toEqual({ freeSpeedKbps: 7000, notificationsEnabled: true });
        return Response.json({ freeSpeedKbps: 7000, notificationsEnabled: true });
      }
      return new Response(null, { status: 404 });
    }));
    render(<App />);
    const button = await screen.findByRole('button', { name: 'ذخیره تنظیمات' });
    expect(button).toBeEnabled();
    expect(screen.getByText('اعمال محدودیت سرعت: آماده نیست')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('سرعت رایگان (Kbps)'), { target: { value: '7000' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'اعلان‌های مدیریتی فعال باشد' }));
    fireEvent.click(button);
    expect(await screen.findByRole('status')).toHaveTextContent('تنظیمات ذخیره شد.');
    await waitFor(() => { expect(requests.map(({ url }) => url)).toContain('/api/auth/csrf'); expect(requests.map(({ url }) => url)).toContain('/api/admin/settings'); });
  });
});
