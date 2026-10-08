import { describe, expect, it } from 'vitest';
import type { D1DatabaseLike } from '../auth/d1';
import { D1CreditStore } from './d1';

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

describe('D1CreditStore', () => {
  it('reads verification time from the authoritative users table', async () => {
    const db = new FakeD1();
    db.firstResults.push({ verified_at: '2026-10-08T00:00:00.000Z' });
    const store = new D1CreditStore(db);

    await expect(store.getVerifiedAt('user-1')).resolves.toBe('2026-10-08T00:00:00.000Z');
    expect(db.executed[0]).toMatchObject({ mode: 'first', values: ['user-1'] });
    expect(db.executed[0]!.sql).toMatch(/FROM\s+users/i);
  });

  it('inserts ledger events atomically and returns false for duplicate unique keys', async () => {
    const db = new FakeD1();
    const store = new D1CreditStore(db);
    const entry = {
      uniqueKey: 'ad:event-1',
      userId: 'user-1',
      kind: 'ad' as const,
      freeDay: '2026-10-08',
      deltaSeconds: 900,
      occurredAt: '2026-10-08T08:00:00.000Z',
    };

    db.firstResults.push({ unique_key: 'ad:event-1' }, null);
    await expect(store.insertLedgerEntry(entry)).resolves.toBe(true);
    await expect(store.insertLedgerEntry(entry)).resolves.toBe(false);

    for (const execution of db.executed) {
      expect(execution.sql).toMatch(/INSERT\s+INTO\s+credit_ledger/i);
      expect(execution.sql).toMatch(/ON\s+CONFLICT\s*\(unique_key\)\s+DO\s+NOTHING/i);
      expect(execution.sql).toMatch(/RETURNING\s+unique_key/i);
      expect(execution.values.slice(0, 6)).toEqual([
        'ad:event-1',
        'user-1',
        'ad',
        '2026-10-08',
        900,
        '2026-10-08T08:00:00.000Z',
      ]);
    }
  });

  it('sums one Tehran day, resolves session ownership, and reads premium independently', async () => {
    const db = new FakeD1();
    const store = new D1CreditStore(db);

    db.firstResults.push({ total: 1234 });
    await expect(store.sumFreeSeconds('user-1', '2026-10-08')).resolves.toBe(1234);

    db.firstResults.push({ user_id: 'user-1' });
    await expect(store.resolveUsageSession('node-1', 'session-1')).resolves.toBe('user-1');

    db.firstResults.push({ premium_until: '2026-11-08T00:00:00.000Z' });
    await expect(store.getPremiumUntil('user-1')).resolves.toBe('2026-11-08T00:00:00.000Z');

    expect(db.executed[0]!.sql).toMatch(/SUM\s*\(delta_seconds\)/i);
    expect(db.executed[0]!.values).toEqual(['user-1', '2026-10-08']);
    expect(db.executed[1]!.sql).toMatch(/FROM\s+usage_sessions/i);
    expect(db.executed[1]!.values).toEqual(['node-1', 'session-1']);
    expect(db.executed[2]!.sql).toMatch(/FROM\s+memberships/i);
    expect(db.executed[2]!.values).toEqual(['user-1']);
  });
});
