import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

const account = {
  identity: { id: 'user-1', email: 'user@example.com', role: 'user' as const },
  entitlement: { freeSeconds: 1800, premiumUntil: null, tier: 'free' as const },
  node: { ready: false, connectionStatus: 'disconnected' as const, configAvailable: false },
  providers: { email: true, ads: false, payments: false, push: false },
};

const catalog = {
  plans: [],
  missions: [{
    id: 'profile-proof',
    title: 'تکمیل پروفایل',
    description: 'مدرک تکمیل را ارسال کنید.',
    rewardSeconds: 900,
    verificationKind: 'evidence' as const,
  }],
};

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.pushState({}, '', '/');
});

describe('mission evidence flow', () => {
  it('submits text evidence with the current CSRF token and reports pending review', async () => {
    window.history.pushState({}, '', '/missions');
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url === '/api/health') return Response.json({ status: 'ok' });
      if (url === '/api/account') return Response.json(account);
      if (url === '/api/account/catalog') return Response.json(catalog);
      if (url === '/api/account/missions/submissions') return Response.json([]);
      if (url === '/api/auth/csrf') return Response.json({ csrfToken: 'mission-csrf' });
      if (url === '/api/account/missions/profile-proof/submissions') {
        expect(init).toMatchObject({
          method: 'POST',
          credentials: 'include',
          headers: {
            'content-type': 'application/json',
            'x-csrf-token': 'mission-csrf',
          },
        });
        expect(JSON.parse(String(init?.body))).toEqual({ kind: 'text', value: 'proof-value' });
        return Response.json({ id: 'submission-1', status: 'pending' }, { status: 201 });
      }
      return new Response(null, { status: 404 });
    }));

    render(<App />);

    const evidence = await screen.findByRole('textbox', { name: 'مدرک ماموریت تکمیل پروفایل' });
    fireEvent.change(evidence, { target: { value: 'proof-value' } });
    fireEvent.click(screen.getByRole('button', { name: 'ارسال مدرک' }));

    expect(await screen.findByRole('status')).toHaveTextContent('مدرک ثبت شد و در انتظار بررسی است.');
    await waitFor(() => {
      expect(requests.map(({ url }) => url)).toContain('/api/account/missions/profile-proof/submissions');
    });
  });
});
