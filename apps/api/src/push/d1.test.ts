import { describe, expect, it } from 'vitest';
import type { D1DatabaseLike } from '../auth/d1';
import { D1PushStore } from './d1';

class FakeStatement {
  bound: unknown[] = [];

  constructor(readonly sql: string, private readonly db: FakeD1) {}

  bind(...values: unknown[]) {
    this.bound = values;
    return this;
  }

  async run() {
    this.db.executed.push({ sql: this.sql, values: this.bound, mode: 'run' as const });
    return { success: true };
  }

  async first<T>() {
    this.db.executed.push({ sql: this.sql, values: this.bound, mode: 'first' as const });
    return (this.db.firstResults.shift() ?? null) as T | null;
  }

  async all<T>() {
    this.db.executed.push({ sql: this.sql, values: this.bound, mode: 'all' as const });
    return { results: (this.db.allResults.shift() ?? []) as T[] };
  }
}

class FakeD1 implements D1DatabaseLike {
  readonly executed: Array<{ sql: string; values: unknown[]; mode: 'run' | 'first' | 'all' }> = [];
  readonly firstResults: unknown[] = [];
  readonly allResults: unknown[][] = [];

  prepare(sql: string) {
    return new FakeStatement(sql, this);
  }
}

describe('D1PushStore', () => {
  it('upserts by endpoint under the authenticated owner and lists only that owner', async () => {
    const db = new FakeD1();
    const store = new D1PushStore(db);
    db.firstResults.push({
      id: 'push-1',
      user_id: 'user-1',
      endpoint: 'https://push.example.test/device-1',
      p256dh: 'public-key-material',
      auth: 'auth-secret-material',
      expiration_time: null,
      created_at: '2026-10-08T09:30:00.000Z',
      updated_at: '2026-10-08T09:30:00.000Z',
    });

    await store.saveSubscription({
      id: 'push-1',
      userId: 'user-1',
      endpoint: 'https://push.example.test/device-1',
      p256dh: 'public-key-material',
      auth: 'auth-secret-material',
      expirationTime: null,
      createdAt: '2026-10-08T09:30:00.000Z',
      updatedAt: '2026-10-08T09:30:00.000Z',
    });

    db.allResults.push([{
      id: 'push-1',
      user_id: 'user-1',
      endpoint: 'https://push.example.test/device-1',
      p256dh: 'public-key-material',
      auth: 'auth-secret-material',
      expiration_time: null,
      created_at: '2026-10-08T09:30:00.000Z',
      updated_at: '2026-10-08T09:30:00.000Z',
    }]);
    await expect(store.listUserSubscriptions('user-1')).resolves.toHaveLength(1);

    expect(db.executed[0]!.sql).toMatch(/INSERT\s+INTO\s+push_subscriptions/i);
    expect(db.executed[0]!.sql).toMatch(/ON\s+CONFLICT\s*\(endpoint\)/i);
    expect(db.executed[1]!.sql).toMatch(/WHERE\s+user_id\s*=\s*\?/i);
    expect(db.executed[1]!.values).toEqual(['user-1']);
  });

  it('deletes only a subscription owned by the current user', async () => {
    const db = new FakeD1();
    const store = new D1PushStore(db);
    db.firstResults.push({ id: 'push-1' }, null);

    await expect(store.deleteUserSubscription('user-1', 'push-1')).resolves.toBe(true);
    await expect(store.deleteUserSubscription('user-2', 'push-1')).resolves.toBe(false);

    for (const entry of db.executed) {
      expect(entry.sql).toMatch(/DELETE\s+FROM\s+push_subscriptions/i);
      expect(entry.sql).toMatch(/user_id\s*=\s*\?/i);
      expect(entry.values).toContain('push-1');
    }
  });
});
