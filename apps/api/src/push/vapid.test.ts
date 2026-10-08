import { describe, expect, it } from 'vitest';
import { PushError, type PushSubscriptionRecord } from './index';
import { createVapidSender } from './vapid';

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
  it('refuses to claim delivery when VAPID credentials or transport are missing', async () => {
    expect(() => createVapidSender({ publicKey: '', privateKey: '', subject: '' })).toThrowError(PushError);

    const sender = createVapidSender({
      publicKey: 'public-vapid-key',
      privateKey: 'private-vapid-key',
      subject: 'mailto:ops@example.com',
    });
    await expect(sender.send(subscription, { title: 'مدار', body: 'پیام' })).resolves.toEqual({ status: 'failed' });
  });

  it('normalizes provider expiry responses so stale subscriptions can be removed', async () => {
    const sender = createVapidSender(
      {
        publicKey: 'public-vapid-key',
        privateKey: 'private-vapid-key',
        subject: 'mailto:ops@example.com',
      },
      {
        async send() {
          return { statusCode: 410 };
        },
      },
    );

    await expect(sender.send(subscription, { title: 'مدار', body: 'پیام' })).resolves.toEqual({ status: 'expired' });
  });
});
