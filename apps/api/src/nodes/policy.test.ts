import { describe, expect, it } from 'vitest';
import { compilePolicyClients, parsePublicationRequest } from './policy';

const now = new Date('2026-10-13T18:00:00Z');
const candidate = { userId: 'user-a', clientId: 'test-client-a', policyRevision: 3, suspended: false, revoked: false, verified: true, freeSeconds: 100, premiumUntil: null as string | null };

describe('authoritative node policy compilation', () => {
  it('derives Free speed and current client revision without accepting caller-supplied clients', () => {
    expect(compilePolicyClients([candidate], 5000, now)).toEqual([{ userId: 'user-a', clientId: 'test-client-a', policyRevision: 3, tier: 'free', speedKbps: 5000 }]);
    expect(() => parsePublicationRequest({ mode: 'current', ttlSeconds: 7200, clients: [] })).toThrow();
  });
  it('excludes suspended, revoked, unverified and exhausted Free credentials', () => {
    expect(compilePolicyClients([
      { ...candidate, suspended: true }, { ...candidate, revoked: true },
      { ...candidate, verified: false }, { ...candidate, freeSeconds: 0 },
      { ...candidate, freeSeconds: -1 },
    ], 5000, now)).toEqual([]);
  });
  it('derives Premium only while the stored entitlement remains active', () => {
    expect(compilePolicyClients([{ ...candidate, freeSeconds: 0, premiumUntil: '2026-10-13T19:00:00Z' }], 5000, now)[0]).toMatchObject({ tier: 'premium', speedKbps: null });
    expect(compilePolicyClients([{ ...candidate, freeSeconds: 0, premiumUntil: now.toISOString() }], 5000, now)).toEqual([]);
  });
  it('rejects invalid TTL, modes and speed rather than publishing an unsafe policy', () => {
    for (const ttlSeconds of [0, 59, 7201, 1.5]) expect(() => parsePublicationRequest({ mode: 'current', ttlSeconds })).toThrow();
    expect(() => parsePublicationRequest({ mode: 'arbitrary', ttlSeconds: 60 })).toThrow();
    expect(() => compilePolicyClients([candidate], 0, now)).toThrow();
    expect(parsePublicationRequest({ mode: 'empty', ttlSeconds: 7200 })).toEqual({ mode: 'empty', ttlSeconds: 7200 });
  });
});
