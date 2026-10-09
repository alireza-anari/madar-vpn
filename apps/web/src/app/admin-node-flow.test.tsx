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

describe('admin node enrollment wiring', () => {
  it('gets a current CSRF token and creates only an enrolled node record without fabricating credentials or readiness', async () => {
    window.history.pushState({}, '', '/admin');
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url === '/api/health') return Response.json({ status: 'ok' });
      if (url === '/api/admin/overview') return Response.json(overview);
      if (url === '/api/admin/resources') return Response.json(resources);
      if (url === '/api/auth/csrf') return Response.json({ csrfToken: 'admin-csrf' });
      if (url === '/api/admin/nodes') {
        expect(init).toMatchObject({
          method: 'POST',
          credentials: 'include',
          headers: {
            'content-type': 'application/json',
            'x-csrf-token': 'admin-csrf',
          },
        });
        expect(JSON.parse(String(init?.body))).toEqual({ name: 'تهران ۱' });
        return Response.json({
          id: 'node-1',
          name: 'تهران ۱',
          status: 'enrolled',
          lastSeenAt: null,
          createdAt: '2026-10-09T00:00:00.000Z',
        }, { status: 201 });
      }
      return new Response(null, { status: 404 });
    }));

    render(<App />);

    const button = await screen.findByRole('button', { name: 'ثبت نود' });
    expect(button).toBeEnabled();

    const form = screen.getByRole('form', { name: 'فرم ثبت نود' });
    const node = within(form);
    fireEvent.change(node.getByLabelText('نام نود'), { target: { value: 'تهران ۱' } });
    fireEvent.click(button);

    expect(await node.findByRole('status')).toHaveTextContent('نود ثبت شد و در وضعیت enrolled باقی می‌ماند.');
    expect(screen.getByText('نود: آماده نیست')).toBeInTheDocument();
    await waitFor(() => {
      expect(requests.map(({ url }) => url)).toContain('/api/auth/csrf');
      expect(requests.map(({ url }) => url)).toContain('/api/admin/nodes');
    });
    expect(requests.some(({ init }) => String(init?.body ?? '').includes('credential'))).toBe(false);
    expect(requests.some(({ init }) => String(init?.body ?? '').includes('config'))).toBe(false);
  });
});
