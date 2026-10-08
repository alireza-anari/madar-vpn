import { describe, expect, it } from 'vitest';
import { CreditError, MemoryCreditStore, createCreditService, tehranDateKey } from './index';

const BEFORE_MIDNIGHT = new Date('2026-10-07T20:29:59.000Z'); // 23:59:59 Asia/Tehran
const AFTER_MIDNIGHT = new Date('2026-10-07T20:30:01.000Z'); // 00:00:01 Asia/Tehran
const CURRENT_DAY = new Date('2026-10-08T08:00:00.000Z');

function harness(verifiedAt = CURRENT_DAY) {
  const store = new MemoryCreditStore();
  store.registerVerifiedUser('user-1', verifiedAt);
  store.registerUsageSession('node-1', 'session-1', 'user-1');
  store.registerUsageSession('node-2', 'session-2', 'user-1');
  return { store, credits: createCreditService({ store }) };
}

describe('persistent credit and membership rules', () => {
  it('computes the accounting day in Asia/Tehran', () => {
    expect(tehranDateKey(BEFORE_MIDNIGHT)).toBe('2026-10-07');
    expect(tehranDateKey(AFTER_MIDNIGHT)).toBe('2026-10-08');
  });

  it('awards 1800 free seconds exactly once to a verified account', async () => {
    const { credits, store } = harness();

    await expect(credits.getEntitlement('user-1', CURRENT_DAY)).resolves.toEqual({
      freeSeconds: 1800,
      premiumUntil: null,
      tier: 'free',
    });
    await expect(credits.getEntitlement('user-1', CURRENT_DAY)).resolves.toMatchObject({ freeSeconds: 1800 });

    expect(store.ledger.filter((entry) => entry.kind === 'initial')).toHaveLength(1);
  });

  it('awards 900 seconds for a verified ad event and deduplicates the event id', async () => {
    const { credits } = harness();
    await credits.getEntitlement('user-1', CURRENT_DAY);

    await expect(credits.awardAd('user-1', 'ad-event-1', CURRENT_DAY)).resolves.toBe(true);
    await expect(credits.awardAd('user-1', 'ad-event-1', CURRENT_DAY)).resolves.toBe(false);
    await expect(credits.getEntitlement('user-1', CURRENT_DAY)).resolves.toMatchObject({ freeSeconds: 2700 });
  });

  it('deduplicates usage reports and rejects negative usage', async () => {
    const { credits } = harness();
    await credits.getEntitlement('user-1', CURRENT_DAY);

    await expect(credits.recordUsage('node-1', 'session-1', 1, 600, CURRENT_DAY)).resolves.toBe(true);
    await expect(credits.recordUsage('node-1', 'session-1', 1, 600, CURRENT_DAY)).resolves.toBe(false);
    await expect(credits.getEntitlement('user-1', CURRENT_DAY)).resolves.toMatchObject({ freeSeconds: 1200 });

    await expect(credits.recordUsage('node-1', 'session-1', 2, -1, CURRENT_DAY)).rejects.toSatisfy(
      (error: unknown) => {
        expect(error).toBeInstanceOf(CreditError);
        expect((error as CreditError).code).toBe('USAGE_INVALID');
        return true;
      },
    );
  });

  it('records premium usage idempotently without debiting free credit', async () => {
    const { credits, store } = harness();
    store.setPremiumUntil('user-1', '2026-11-08T00:00:00.000Z');
    await credits.getEntitlement('user-1', CURRENT_DAY);

    await expect(credits.recordUsage('node-1', 'session-1', 7, 600, CURRENT_DAY)).resolves.toBe(true);
    await expect(credits.recordUsage('node-1', 'session-1', 7, 600, CURRENT_DAY)).resolves.toBe(false);
    await expect(credits.getEntitlement('user-1', CURRENT_DAY)).resolves.toMatchObject({
      freeSeconds: 1800,
      tier: 'premium',
    });

    expect(store.ledger.find((entry) => entry.uniqueKey === 'usage:node-1:session-1:7')).toMatchObject({
      kind: 'usage',
      deltaSeconds: 0,
    });
  });

  it('sums actual usage from concurrent sessions', async () => {
    const { credits } = harness();
    await credits.getEntitlement('user-1', CURRENT_DAY);

    await expect(
      Promise.all([
        credits.recordUsage('node-1', 'session-1', 1, 600, CURRENT_DAY),
        credits.recordUsage('node-2', 'session-2', 1, 700, CURRENT_DAY),
      ]),
    ).resolves.toEqual([true, true]);
    await expect(credits.getEntitlement('user-1', CURRENT_DAY)).resolves.toMatchObject({ freeSeconds: 500 });
  });

  it('does not trust an unknown or mismatched node/session pair', async () => {
    const { credits } = harness();

    await expect(credits.recordUsage('node-x', 'session-1', 1, 10, CURRENT_DAY)).resolves.toBe(false);
    await expect(credits.recordUsage('node-1', 'unknown-session', 1, 10, CURRENT_DAY)).resolves.toBe(false);
  });

  it('resets only free credit at Tehran midnight, including absent users', async () => {
    const { credits, store } = harness(BEFORE_MIDNIGHT);
    store.setPremiumUntil('user-1', '2026-11-07T20:30:00.000Z');

    await expect(credits.getEntitlement('user-1', BEFORE_MIDNIGHT)).resolves.toEqual({
      freeSeconds: 1800,
      premiumUntil: '2026-11-07T20:30:00.000Z',
      tier: 'premium',
    });
    await expect(credits.getEntitlement('user-1', AFTER_MIDNIGHT)).resolves.toEqual({
      freeSeconds: 0,
      premiumUntil: '2026-11-07T20:30:00.000Z',
      tier: 'premium',
    });
  });

  it('keeps delayed prior-day usage out of the current-day balance', async () => {
    const verifiedToday = new Date('2026-10-07T20:31:00.000Z');
    const { credits } = harness(verifiedToday);
    const priorDayUsage = new Date('2026-10-07T20:29:00.000Z');

    await expect(credits.getEntitlement('user-1', verifiedToday)).resolves.toMatchObject({ freeSeconds: 1800 });
    await expect(credits.recordUsage('node-1', 'session-1', 1, 600, priorDayUsage)).resolves.toBe(true);
    await expect(credits.getEntitlement('user-1', verifiedToday)).resolves.toMatchObject({ freeSeconds: 1800 });
  });
});
