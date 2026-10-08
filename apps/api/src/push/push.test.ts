import { describe, expect, it } from 'vitest';
import { MemoryPushStore, createPushService } from './index';

const subscriptionInput = {
  endpoint: 'https://push.example.test/subscriptions/device-1',
  keys: {
    p256dh: 'public-key-material',
    auth: 'auth-secret-material',
  },
  expirationTime: null,
};

describe('push subscriptions', () => {
  it('binds a saved subscription to the authenticated user rather than client-supplied ownership', async () => {
    const store = new MemoryPushStore();
    const push = createPushService({
      store,
      now: () => new Date('2026-10-08T09:30:00.000Z'),
      randomId: () => 'push-sub-1',
    });

    const saved = await push.saveSubscription('user-1', {
      ...subscriptionInput,
      userId: 'attacker-chosen-user',
    });

    expect(saved).toMatchObject({ id: 'push-sub-1', userId: 'user-1' });
    expect(store.subscriptions).toHaveLength(1);
    expect(store.subscriptions[0]?.userId).toBe('user-1');
    await expect(push.listSubscriptions('user-1')).resolves.toEqual([
      expect.objectContaining({ id: 'push-sub-1', endpoint: subscriptionInput.endpoint }),
    ]);
    await expect(push.listSubscriptions('attacker-chosen-user')).resolves.toEqual([]);
  });

  it('removes a subscription when the push provider reports it expired', async () => {
    const store = new MemoryPushStore();
    const push = createPushService({
      store,
      sender: {
        async send() {
          return { status: 'expired' as const };
        },
      },
      now: () => new Date('2026-10-08T09:30:00.000Z'),
      randomId: () => 'push-sub-1',
    });

    await push.saveSubscription('user-1', subscriptionInput);
    await expect(push.sendNotification('user-1', { title: 'مدار', body: 'پیام آزمایشی' })).resolves.toEqual({
      delivered: 0,
      expiredRemoved: 1,
      failed: 0,
    });
    expect(store.subscriptions).toEqual([]);
  });
});
