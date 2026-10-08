import { describe, expect, it } from 'vitest';
import { D1AuthStore, type D1DatabaseLike } from './d1';

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

describe('D1AuthStore', () => {
  it('persists only auth hashes and consumes login tokens atomically', async () => {
    const db = new FakeD1();
    const store = new D1AuthStore(db);

    await store.saveLoginToken({
      tokenHash: 'login-hash',
      email: 'user@example.com',
      expiresAt: '2026-10-08T00:15:00.000Z',
      usedAt: null,
    });

    db.firstResults.push({
      token_hash: 'login-hash',
      email: 'user@example.com',
      expires_at: '2026-10-08T00:15:00.000Z',
      used_at: '2026-10-08T00:01:00.000Z',
    });
    await expect(store.consumeLoginToken('login-hash', new Date('2026-10-08T00:01:00.000Z'))).resolves.toEqual({
      tokenHash: 'login-hash',
      email: 'user@example.com',
      expiresAt: '2026-10-08T00:15:00.000Z',
      usedAt: '2026-10-08T00:01:00.000Z',
    });

    expect(db.executed[0]).toMatchObject({
      mode: 'run',
      values: ['login-hash', 'user@example.com', '2026-10-08T00:15:00.000Z', null],
    });
    expect(db.executed[0]!.sql).not.toMatch(/token\s+TEXT/i);
    expect(db.executed[1]).toMatchObject({
      mode: 'first',
      values: ['2026-10-08T00:01:00.000Z', 'login-hash', '2026-10-08T00:01:00.000Z'],
    });
    expect(db.executed[1]!.sql).toMatch(/UPDATE\s+login_tokens/i);
    expect(db.executed[1]!.sql).toMatch(/used_at\s+IS\s+NULL/i);
    expect(db.executed[1]!.sql).toMatch(/RETURNING/i);
  });

  it('round-trips users and unexpired sessions through prepared queries', async () => {
    const db = new FakeD1();
    const store = new D1AuthStore(db);
    const user = {
      id: 'user-1',
      email: 'user@example.com',
      role: 'admin' as const,
      verifiedAt: '2026-10-08T00:00:00.000Z',
    };

    await store.saveUser(user);
    db.firstResults.push({
      id: 'user-1',
      email: 'user@example.com',
      role: 'admin',
      verified_at: '2026-10-08T00:00:00.000Z',
    });
    await expect(store.findUserByEmail('user@example.com')).resolves.toEqual(user);

    await store.saveSession({
      id: 'session-1',
      userId: 'user-1',
      tokenHash: 'session-hash',
      csrfTokenHash: 'csrf-hash',
      createdAt: '2026-10-08T00:00:00.000Z',
      expiresAt: '2026-11-07T00:00:00.000Z',
    });
    db.firstResults.push({
      id: 'session-1',
      user_id: 'user-1',
      token_hash: 'session-hash',
      csrf_token_hash: 'csrf-hash',
      created_at: '2026-10-08T00:00:00.000Z',
      expires_at: '2026-11-07T00:00:00.000Z',
    });

    await expect(
      store.findSessionByTokenHash('session-hash', new Date('2026-10-08T00:02:00.000Z')),
    ).resolves.toEqual({
      id: 'session-1',
      userId: 'user-1',
      tokenHash: 'session-hash',
      csrfTokenHash: 'csrf-hash',
      createdAt: '2026-10-08T00:00:00.000Z',
      expiresAt: '2026-11-07T00:00:00.000Z',
    });

    expect(db.executed.every((entry) => entry.sql.includes('?'))).toBe(true);
  });
});
