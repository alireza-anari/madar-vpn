import { describe, expect, it } from 'vitest';
import {
  billableMaskForMinute,
  formatActiveSecondsHex,
  parseActiveSecondsHex,
  parseTrafficWindowId,
  popcount60,
} from './index';

describe('active-second telemetry contract', () => {
  it('parses and formats low and high valid active-second bits without number precision loss', () => {
    expect(parseActiveSecondsHex('0000000000000001')).toBe(1n);
    expect(parseActiveSecondsHex('0800000000000000')).toBe(1n << 59n);
    expect(formatActiveSecondsHex(1n)).toBe('0000000000000001');
    expect(formatActiveSecondsHex(1n << 59n)).toBe('0800000000000000');
    expect(popcount60(parseActiveSecondsHex('0000000000000003'))).toBe(2);
  });

  it.each([
    '0000000000000000',
    '000000000000001',
    '00000000000000001',
    '000000000000000A',
    '1000000000000000',
    'ffffffffffffffff',
  ])('rejects non-canonical active-second bitmap %s', (value) => {
    expect(() => parseActiveSecondsHex(value)).toThrow(/active-second bitmap/i);
  });

  it('rejects masks outside the low 60-bit range when formatting or counting', () => {
    expect(() => formatActiveSecondsHex(0n)).toThrow(/active-second bitmap/i);
    expect(() => formatActiveSecondsHex(1n << 60n)).toThrow(/active-second bitmap/i);
    expect(() => popcount60(1n << 60n)).toThrow(/active-second bitmap/i);
  });

  it('accepts only exact canonical UTC-minute Xray traffic windows', () => {
    expect(parseTrafficWindowId('xray-traffic:2026-10-10T08:09Z').toISOString())
      .toBe('2026-10-10T08:09:00.000Z');

    for (const value of [
      'window-1',
      'xray-traffic:2026-10-10T08:09:00Z',
      'xray-traffic:2026-10-10T8:09Z',
      'xray-traffic:2026-02-30T08:09Z',
      'xray-traffic:2026-10-10T24:00Z',
    ]) {
      expect(() => parseTrafficWindowId(value)).toThrow(/traffic window/i);
    }
  });
});

describe('observed-time Premium billability', () => {
  const minuteStart = new Date('2026-10-10T08:00:00.000Z');
  const epoch = new Date('2026-10-10T07:00:00.000Z');

  it('bills a free bucket and suppresses a bucket that is Premium at its start', () => {
    expect(billableMaskForMinute({
      minuteStart,
      candidateMask: 1n,
      accountingEpoch: epoch,
      entitlementEvents: [],
    })).toBe(1n);

    expect(billableMaskForMinute({
      minuteStart,
      candidateMask: 1n,
      accountingEpoch: epoch,
      entitlementEvents: [{
        eventOrder: 1n,
        effectiveAt: new Date('2026-10-10T07:59:00.000Z'),
        premiumUntil: '2026-10-10T09:00:00.000Z',
      }],
    })).toBe(0n);
  });

  it('conservatively suppresses a bucket when Premium starts or expires midway through the second', () => {
    const startsMidway = billableMaskForMinute({
      minuteStart,
      candidateMask: 1n,
      accountingEpoch: epoch,
      entitlementEvents: [{
        eventOrder: 1n,
        effectiveAt: new Date('2026-10-10T08:00:00.500Z'),
        premiumUntil: '2026-10-10T09:00:00.000Z',
      }],
    });
    expect(startsMidway).toBe(0n);

    const expiresMidway = billableMaskForMinute({
      minuteStart,
      candidateMask: 1n,
      accountingEpoch: epoch,
      entitlementEvents: [{
        eventOrder: 1n,
        effectiveAt: new Date('2026-10-10T07:59:00.000Z'),
        premiumUntil: '2026-10-10T08:00:00.500Z',
      }],
    });
    expect(expiresMidway).toBe(0n);
  });

  it('does not bill a bucket that starts before the active-second accounting epoch', () => {
    expect(billableMaskForMinute({
      minuteStart,
      candidateMask: 1n,
      accountingEpoch: new Date('2026-10-10T08:00:00.500Z'),
      entitlementEvents: [],
    })).toBe(0n);
  });

  it('resolves equal-time entitlement events by event_order without inventing an intermediate state', () => {
    const events = [
      {
        eventOrder: 10n,
        effectiveAt: new Date('2026-10-10T08:00:00.000Z'),
        premiumUntil: '2026-10-10T09:00:00.000Z',
      },
      {
        eventOrder: 11n,
        effectiveAt: new Date('2026-10-10T08:00:00.000Z'),
        premiumUntil: null,
      },
    ];
    expect(billableMaskForMinute({
      minuteStart,
      candidateMask: 1n,
      accountingEpoch: epoch,
      entitlementEvents: events,
    })).toBe(1n);
  });
});
