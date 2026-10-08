import { describe, expect, it } from 'vitest';
import type { D1DatabaseLike } from '../auth/d1';
import { D1AccessStore } from './d1';

class FakeStatement {
  bound: unknown[] = [];

  constructor(
    readonly sql: string,
    private readonly db: FakeD1,
  ) {}

  bind(...values: unknown[]) {
    this.bound = values;
    return this;
  }

  async run() {
    this.db.executed.push({ sql: this.sql, values: this.bound, mode: 'run' });
    return { success: true };
  }

  async first<T>() {
    this.db.executed.push({ sql: this.sql, values: this.bound, mode: 'first' });
    return (this.db.firstResults.shift() ?? null) as T | null;
  }
}

class FakeD1 implements D1DatabaseLike {
  readonly executed: Array<{ sql: string; values: unknown[]; mode: 'run' | 'first' }> = [];
  readonly firstResults: unknown[] = [];

  prepare(sql: string) {
    return new FakeStatement(sql, this);
  }
}

const profile = {
  id: 'profile-1',
  userId: 'user-1',
  policyRevision: 1,
  createdAt: '2026-10-08T08:00:00.000Z',
};

const credential = {
  id: 'credential-1',
  userId: 'user-1',
  uuid: '00000000-0000-4000-8000-000000000001',
  version: 1,
  createdAt: '2026-10-08T08:00:00.000Z',
  revokedAt: null,
};

describe('D1AccessStore', () => {
  it('ensures one profile and one active credential through conflict-safe queries', async () => {
    const db = new FakeD1();
    const store = new D1AccessStore(db);

    db.firstResults.push({
      id: profile.id,
      user_id: profile.userId,
      policy_revision: profile.policyRevision,
      created_at: profile.createdAt,
    });
    await expect(store.ensureProfile(profile)).resolves.toEqual(profile);

    db.firstResults.push({
      id: credential.id,
      user_id: credential.userId,
      uuid: credential.uuid,
      version: credential.version,
      created_at: credential.createdAt,
      revoked_at: credential.revokedAt,
    });
    await expect(store.ensureActiveClientCredential(credential)).resolves.toEqual(credential);

    expect(db.executed[0]!.sql).toMatch(/INSERT\s+INTO\s+access_profiles/i);
    expect(db.executed[0]!.sql).toMatch(/ON\s+CONFLICT\s*\(user_id\)/i);
    expect(db.executed[1]!.sql).toMatch(/INSERT\s+INTO\s+client_credentials/i);
    expect(db.executed[1]!.sql).toMatch(/revoked_at\s+IS\s+NULL/i);
  });

  it('issues a versioned subscription using only token_hash and returns hash-only reads', async () => {
    const db = new FakeD1();
    const store = new D1AccessStore(db);
    const tokenHash = 'a'.repeat(64);

    db.firstResults.push({
      id: 'subscription-1',
      user_id: 'user-1',
      token_hash: tokenHash,
      version: 2,
      created_at: '2026-10-08T08:00:00.000Z',
      revoked_at: null,
    });
    await expect(store.issueSubscriptionToken({
      id: 'subscription-1',
      userId: 'user-1',
      tokenHash,
      createdAt: '2026-10-08T08:00:00.000Z',
    })).resolves.toMatchObject({ tokenHash, version: 2, revokedAt: null });

    db.firstResults.push({
      id: 'subscription-1',
      user_id: 'user-1',
      token_hash: tokenHash,
      version: 2,
      created_at: '2026-10-08T08:00:00.000Z',
      revoked_at: null,
    });
    const active = await store.getActiveSubscriptionToken('user-1');
    expect(active).toMatchObject({ tokenHash, version: 2 });
    expect(active).not.toHaveProperty('rawToken');
    expect(active).not.toHaveProperty('token');

    const issueQuery = db.executed[0]!;
    expect(issueQuery.sql).toMatch(/token_hash/i);
    expect(issueQuery.sql).not.toMatch(/raw_token|bearer|\btoken\s+TEXT\b/i);
    expect(issueQuery.values).toContain(tokenHash);
    expect(issueQuery.values.some((value) => typeof value === 'string' && value.includes('subscription-secret'))).toBe(false);
    expect(db.executed[1]!.sql).toMatch(/WHERE\s+user_id\s*=\s*\?\s+AND\s+revoked_at\s+IS\s+NULL/i);
  });
});
