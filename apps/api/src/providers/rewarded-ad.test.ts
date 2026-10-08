import { describe, expect, it } from 'vitest';
import { createCreditService, MemoryCreditStore } from '../credits';
import { createApiApp } from '../index';
import { createRewardedAdProvider } from './index';
import {
  MemoryRewardedAdBindingStore,
  createRewardedAdSettlement,
} from './rewarded-ad';

function rewardedAdHarness(eventUserId = 'user-1') {
  const creditStore = new MemoryCreditStore();
  creditStore.registerVerifiedUser('user-1', '2026-10-08T06:00:00.000Z');
  creditStore.registerVerifiedUser('user-2', '2026-10-08T06:00:00.000Z');
  const credits = createCreditService({ store: creditStore });
  const bindings = new MemoryRewardedAdBindingStore();
  const provider = createRewardedAdProvider({
    provider: 'fixture-ad',
    verify: async () => true,
    parse: async () => ({
      provider: 'fixture-ad',
      eventId: 'event-1',
      userId: eventUserId,
      occurredAt: '2026-10-08T07:00:00.000Z',
    }),
  });
  const settlement = createRewardedAdSettlement({ provider, credits, bindings });
  const app = createApiApp(() => null, () => null, () => settlement);
  return { app, creditStore, credits, bindings };
}

describe('rewarded-ad settlement', () => {
  it('grants exactly 900 seconds once for a server-verified bound callback', async () => {
    const { app, credits, bindings } = rewardedAdHarness();
    bindings.bind('fixture-ad', 'event-1', 'user-1');

    const first = await app.request('/api/providers/ads/callback', { method: 'POST', body: '{}' });
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toEqual({ creditedSeconds: 900, duplicate: false });

    const duplicate = await app.request('/api/providers/ads/callback', { method: 'POST', body: '{}' });
    expect(duplicate.status).toBe(200);
    await expect(duplicate.json()).resolves.toEqual({ creditedSeconds: 0, duplicate: true });

    await expect(credits.getEntitlement('user-1', new Date('2026-10-08T07:10:00.000Z'))).resolves.toMatchObject({
      freeSeconds: 2700,
    });
  });

  it('has no client completion endpoint that can grant rewarded-ad credit', async () => {
    const { app, creditStore } = rewardedAdHarness();

    const response = await app.request('/api/account/rewarded-ad/complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ countdownComplete: true, eventId: 'event-1' }),
    });

    expect(response.status).toBe(404);
    expect(creditStore.ledger).toHaveLength(0);
  });

  it('rejects a verified callback when the server-side user binding disagrees', async () => {
    const { app, creditStore, bindings } = rewardedAdHarness('user-1');
    bindings.bind('fixture-ad', 'event-1', 'user-2');

    const response = await app.request('/api/providers/ads/callback', { method: 'POST', body: '{}' });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: 'AD_USER_BINDING_INVALID' });
    expect(creditStore.ledger).toHaveLength(0);
  });
});
