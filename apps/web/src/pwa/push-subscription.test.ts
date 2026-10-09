import { describe, expect, it, vi } from 'vitest';
import { subscribeBrowserPush } from './push-subscription';

describe('browser push subscription bridge', () => {
  it('bootstraps CSRF and VAPID config, subscribes the service worker, and persists the device', async () => {
    const subscriptionJson = {
      endpoint: 'https://push.example.test/device-1',
      expirationTime: null,
      keys: {
        p256dh: 'public-key-material',
        auth: 'auth-secret-material',
      },
    };
    const subscribe = vi.fn(async () => ({
      toJSON: () => subscriptionJson,
      unsubscribe: vi.fn(async () => true),
    }));
    const serviceWorker = {
      ready: Promise.resolve({ pushManager: { subscribe } }),
    } as unknown as ServiceWorkerContainer;

    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/auth/csrf') {
        expect(init).toMatchObject({ credentials: 'include' });
        return new Response(JSON.stringify({ csrfToken: 'csrf-bootstrap-token' }), { status: 200 });
      }
      if (url === '/api/account/push-config') {
        expect(init).toMatchObject({ credentials: 'include' });
        return new Response(JSON.stringify({ publicKey: 'AQIDBA' }), { status: 200 });
      }
      if (url === '/api/account/push-subscriptions') {
        expect(init).toMatchObject({
          method: 'POST',
          credentials: 'include',
          headers: {
            'content-type': 'application/json',
            'x-csrf-token': 'csrf-bootstrap-token',
          },
        });
        expect(JSON.parse(String(init?.body))).toEqual(subscriptionJson);
        return new Response(JSON.stringify({ id: 'push-sub-1' }), { status: 201 });
      }
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;

    await expect(subscribeBrowserPush({ fetcher, serviceWorker })).resolves.toBe(true);
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: new Uint8Array([1, 2, 3, 4]),
    });
  });

  it('removes a newly-created browser subscription if server persistence fails', async () => {
    const unsubscribe = vi.fn(async () => true);
    const subscribe = vi.fn(async () => ({
      toJSON: () => ({
        endpoint: 'https://push.example.test/device-2',
        expirationTime: null,
        keys: { p256dh: 'public-key-material', auth: 'auth-secret-material' },
      }),
      unsubscribe,
    }));
    const serviceWorker = {
      ready: Promise.resolve({ pushManager: { subscribe } }),
    } as unknown as ServiceWorkerContainer;

    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/auth/csrf') return new Response(JSON.stringify({ csrfToken: 'csrf-token' }), { status: 200 });
      if (url === '/api/account/push-config') return new Response(JSON.stringify({ publicKey: 'AQIDBA' }), { status: 200 });
      return new Response(JSON.stringify({ error: 'failed' }), { status: 500 });
    }) as unknown as typeof fetch;

    await expect(subscribeBrowserPush({ fetcher, serviceWorker })).resolves.toBe(false);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
