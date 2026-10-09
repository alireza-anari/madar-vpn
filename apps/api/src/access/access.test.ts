import { describe, expect, it } from 'vitest';
import { MemoryAccessStore, createAccessService } from './index';

const NOW = new Date('2026-10-08T08:00:00.000Z');

function harness() {
  const store = new MemoryAccessStore();
  let uuidNumber = 0;
  let tokenNumber = 0;
  const access = createAccessService({
    store,
    now: () => NOW,
    randomUuid: () => `00000000-0000-4000-8000-${String(++uuidNumber).padStart(12, '0')}`,
    randomToken: () => `subscription-secret-${++tokenNumber}`,
  });
  return { store, access };
}

describe('access profile persistence', () => {
  it('ensures exactly one stable access profile per user', async () => {
    const { store, access } = harness();

    const first = await access.ensureAccessProfile('user-1');
    const second = await access.ensureAccessProfile('user-1');

    expect(second).toEqual(first);
    expect(first).toMatchObject({ userId: 'user-1', policyRevision: 1 });
    expect(store.profiles).toHaveLength(1);
  });

  it('keeps one active client credential per user and unique UUIDs across users', async () => {
    const { store, access } = harness();

    const first = await access.getActiveClientCredential('user-1');
    const repeated = await access.getActiveClientCredential('user-1');
    const other = await access.getActiveClientCredential('user-2');

    expect(repeated).toEqual(first);
    expect(first.uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(other.uuid).not.toBe(first.uuid);
    expect(store.credentials.filter((record) => record.userId === 'user-1' && record.revokedAt === null)).toHaveLength(1);
    expect(store.credentials.filter((record) => record.revokedAt === null)).toHaveLength(2);
  });

  it('returns raw subscription bearer only on issuance and stores hash-only active versions', async () => {
    const { store, access } = harness();

    const first = await access.issueSubscriptionToken('user-1');
    const second = await access.issueSubscriptionToken('user-1');

    expect(first).toEqual({ rawToken: 'subscription-secret-1', version: 1 });
    expect(second).toEqual({ rawToken: 'subscription-secret-2', version: 2 });

    expect(store.subscriptionTokens).toHaveLength(2);
    expect(store.subscriptionTokens[0]).toMatchObject({ userId: 'user-1', version: 1 });
    expect(store.subscriptionTokens[0]?.revokedAt).toBe(NOW.toISOString());
    expect(store.subscriptionTokens[1]).toMatchObject({ userId: 'user-1', version: 2, revokedAt: null });
    expect(store.subscriptionTokens.every((record) => /^[a-f0-9]{64}$/.test(record.tokenHash))).toBe(true);
    expect(JSON.stringify(store.subscriptionTokens)).not.toContain('subscription-secret-');

    const active = await store.getActiveSubscriptionToken('user-1');
    expect(active).toMatchObject({ userId: 'user-1', version: 2 });
    expect(active).not.toHaveProperty('rawToken');
    expect(active).not.toHaveProperty('token');
  });

  it('rotates the subscription URL without changing the client UUID', async () => {
    const { store, access } = harness();
    const credential = await access.getActiveClientCredential('user-1');
    const first = await access.issueSubscriptionToken('user-1');
    const second = await access.rotateSubscriptionToken('user-1');

    expect(first.rawToken).not.toBe(second.rawToken);
    expect(second.version).toBe(2);
    await expect(store.findActiveSubscriptionTokenByHash(store.subscriptionTokens[0]!.tokenHash)).resolves.toBeNull();
    await expect(access.getActiveClientCredential('user-1')).resolves.toEqual(credential);
  });

  it('rotates the client UUID, revokes the old credential, and advances policy revision', async () => {
    const { store, access } = harness();
    const original = await access.getActiveClientCredential('user-1');

    const rotation = await access.rotateClientCredential('user-1');

    expect(rotation.credential.uuid).not.toBe(original.uuid);
    expect(rotation.credential.version).toBe(2);
    expect(rotation.policyRevision).toBe(2);
    expect(store.credentials.find((record) => record.id === original.id)?.revokedAt).toBe(NOW.toISOString());
    expect(store.credentials.filter((record) => record.userId === 'user-1' && record.revokedAt === null)).toEqual([
      rotation.credential,
    ]);
    expect(store.profiles.find((record) => record.userId === 'user-1')?.policyRevision).toBe(2);
  });
});
