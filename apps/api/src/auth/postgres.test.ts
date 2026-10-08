import { describe, expect, it } from 'vitest';
import { PostgresAuthStore } from './postgres';

type QueryCall = { text: string; values?: readonly unknown[] };

class FakePgDatabase {
  readonly calls: QueryCall[] = [];
  readonly results: Array<{ rows: Record<string, unknown>[]; rowCount: number }> = [];

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number }> {
    this.calls.push(values === undefined ? { text } : { text, values });
    const result = this.results.shift() ?? { rows: [], rowCount: 0 };
    return { rows: result.rows as Row[], rowCount: result.rowCount };
  }
}

describe('PostgresAuthStore', () => {
  it('persists login-token hashes and consumes one token atomically', async () => {
    const db = new FakePgDatabase();
    const store = new PostgresAuthStore(db);

    await store.saveLoginToken({
      tokenHash: 'login-hash',
      email: 'user@example.com',
      expiresAt: '2026-10-09T00:15:00.000Z',
      usedAt: null,
    });

    db.results.push({
      rowCount: 1,
      rows: [{
        token_hash: 'login-hash',
        email: 'user@example.com',
        expires_at: new Date('2026-10-09T00:15:00.000Z'),
        used_at: new Date('2026-10-09T00:01:00.000Z'),
      }],
    });

    await expect(store.consumeLoginToken('login-hash', new Date('2026-10-09T00:01:00.000Z'))).resolves.toEqual({
      tokenHash: 'login-hash',
      email: 'user@example.com',
      expiresAt: '2026-10-09T00:15:00.000Z',
      usedAt: '2026-10-09T00:01:00.000Z',
    });

    expect(db.calls[0]).toMatchObject({
      values: ['login-hash', 'user@example.com', '2026-10-09T00:15:00.000Z', null],
    });
    expect(db.calls[0]!.text).toMatch(/INSERT\s+INTO\s+login_tokens/i);
    expect(db.calls[1]!.text).toMatch(/UPDATE\s+login_tokens/i);
    expect(db.calls[1]!.text).toMatch(/used_at\s+IS\s+NULL/i);
    expect(db.calls[1]!.text).toMatch(/expires_at\s*>/i);
    expect(db.calls[1]!.text).toMatch(/RETURNING/i);
  });

  it('uses canonical email lookup and round-trips suspension state', async () => {
    const db = new FakePgDatabase();
    const store = new PostgresAuthStore(db);

    db.results.push({
      rowCount: 1,
      rows: [{
        id: 'user-1',
        email: 'user@example.com',
        role: 'user',
        verified_at: new Date('2026-10-09T00:00:00.000Z'),
        suspended_at: null,
      }],
    });
    await expect(store.findUserByEmail('USER@EXAMPLE.COM')).resolves.toMatchObject({
      id: 'user-1',
      email: 'user@example.com',
      suspendedAt: null,
    });
    expect(db.calls[0]!.text).toMatch(/lower\(email\)\s*=\s*lower\(\$1\)/i);

    db.results.push({
      rowCount: 1,
      rows: [{
        id: 'user-1',
        email: 'user@example.com',
        role: 'user',
        verified_at: new Date('2026-10-09T00:00:00.000Z'),
        suspended_at: new Date('2026-10-09T00:05:00.000Z'),
      }],
    });
    await expect(store.setUserSuspended('user-1', true, '2026-10-09T00:05:00.000Z')).resolves.toMatchObject({
      changed: true,
      user: { suspendedAt: '2026-10-09T00:05:00.000Z' },
    });
  });

  it('round-trips hashed sessions and revokes only the selected token hash', async () => {
    const db = new FakePgDatabase();
    const store = new PostgresAuthStore(db);

    await store.saveSession({
      id: 'session-1',
      userId: 'user-1',
      tokenHash: 'session-hash',
      csrfTokenHash: 'csrf-hash',
      createdAt: '2026-10-09T00:00:00.000Z',
      expiresAt: '2026-11-08T00:00:00.000Z',
    });

    db.results.push({
      rowCount: 1,
      rows: [{
        id: 'session-1',
        user_id: 'user-1',
        token_hash: 'session-hash',
        csrf_token_hash: 'csrf-hash',
        created_at: new Date('2026-10-09T00:00:00.000Z'),
        expires_at: new Date('2026-11-08T00:00:00.000Z'),
      }],
    });
    await expect(
      store.findSessionByTokenHash('session-hash', new Date('2026-10-09T00:02:00.000Z')),
    ).resolves.toEqual({
      id: 'session-1',
      userId: 'user-1',
      tokenHash: 'session-hash',
      csrfTokenHash: 'csrf-hash',
      createdAt: '2026-10-09T00:00:00.000Z',
      expiresAt: '2026-11-08T00:00:00.000Z',
    });

    await store.revokeSessionByTokenHash('session-hash');
    const revoke = db.calls.at(-1)!;
    expect(revoke.text).toMatch(/DELETE\s+FROM\s+sessions\s+WHERE\s+token_hash\s*=\s*\$1/i);
    expect(revoke.values).toEqual(['session-hash']);
  });
});
