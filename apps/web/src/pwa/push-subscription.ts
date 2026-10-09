type SubscribeBrowserPushOptions = {
  fetcher?: typeof fetch;
  serviceWorker?: ServiceWorkerContainer;
};

function base64UrlToUint8Array(value: string) {
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const base64 = `${value}${padding}`.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}

async function jsonOrNull<T>(response: Response): Promise<T | null> {
  if (!response.ok) return null;
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

export async function subscribeBrowserPush(options: SubscribeBrowserPushOptions = {}): Promise<boolean> {
  const fetcher = options.fetcher ?? fetch;
  const serviceWorker = options.serviceWorker ?? navigator.serviceWorker;

  try {
    const csrfResponse = await fetcher('/api/auth/csrf', {
      credentials: 'include',
      headers: { accept: 'application/json' },
    });
    const csrf = await jsonOrNull<{ csrfToken?: unknown }>(csrfResponse);
    if (typeof csrf?.csrfToken !== 'string' || csrf.csrfToken.length === 0) return false;

    const keyResponse = await fetcher('/api/account/push/vapid-public-key', {
      credentials: 'include',
      headers: { accept: 'application/json' },
    });
    const config = await jsonOrNull<{ publicKey?: unknown }>(keyResponse);
    if (typeof config?.publicKey !== 'string' || config.publicKey.length === 0) return false;

    const registration = await serviceWorker.ready;
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: base64UrlToUint8Array(config.publicKey),
    });

    const persisted = await fetcher('/api/account/push-subscriptions', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': csrf.csrfToken,
      },
      body: JSON.stringify(subscription.toJSON()),
    });

    if (!persisted.ok) {
      await subscription.unsubscribe().catch(() => false);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}
