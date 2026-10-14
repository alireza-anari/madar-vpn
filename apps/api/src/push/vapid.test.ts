import { describe, expect, it } from 'vitest';
import { PushError, type PushSubscriptionRecord } from './index';
import { createVapidSender } from './vapid';

async function config() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const bytes = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return { publicKey: btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''), privateKey: jwk.d!, subject: 'mailto:ops@example.com' };
}

const subscription: PushSubscriptionRecord = {
  id: 'push-1',
  userId: 'user-1',
  endpoint: 'https://push.example.test/device-1',
  p256dh: 'public-key-material',
  auth: 'auth-secret-material',
  expirationTime: null,
  createdAt: '2026-10-08T09:30:00.000Z',
  updatedAt: '2026-10-08T09:30:00.000Z',
};

describe('VAPID push boundary', () => {
  it('refuses to claim delivery when VAPID credentials or subscription keys are invalid', async () => {
    expect(() => createVapidSender({ publicKey: '', privateKey: '', subject: '' })).toThrowError(PushError);

    const sender = createVapidSender(await config());
    await expect(sender.send(subscription, { title: 'مدار', body: 'پیام' })).resolves.toEqual({ status: 'failed' });
  });

  it('normalizes provider expiry responses so stale subscriptions can be removed', async () => {
    const sender = createVapidSender(
      await config(),
      {
        async send() {
          return { statusCode: 410 };
        },
      },
    );

    await expect(sender.send(subscription, { title: 'مدار', body: 'پیام' })).resolves.toEqual({ status: 'expired' });
  });
});
