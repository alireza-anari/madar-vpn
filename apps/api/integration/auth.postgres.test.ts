import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { PostgresAuthStore } from '../src/auth/postgres';
import { PgDatabase } from '../src/postgres/client';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error('TEST_DATABASE_URL is required for PostgreSQL integration tests.');

const client = new Client({ connectionString });
const database = new PgDatabase(client);
const store = new PostgresAuthStore(database);

beforeAll(async () => {
  await client.connect();
});

beforeEach(async () => {
  await client.query('TRUNCATE TABLE login_tokens, sessions, users CASCADE');
});

afterAll(async () => {
  await client.end();
});

describe('PostgresAuthStore integration', () => {
  it('stores a login-token hash and permits exactly one atomic consume', async () => {
    await store.saveLoginToken({
      tokenHash: 'integration-login-hash',
      email: 'user@example.com',
      expiresAt: '2026-10-09T00:15:00.000Z',
      usedAt: null,
    });

    const persisted = await client.query(
      'SELECT token_hash, email, expires_at, used_at FROM login_tokens WHERE token_hash = $1',
      ['integration-login-hash'],
    );
    expect(persisted.rows).toHaveLength(1);
    expect(persisted.rows[0]?.token_hash).toBe('integration-login-hash');
    expect(persisted.rows[0]).not.toHaveProperty('token');

    const now = new Date('2026-10-09T00:01:00.000Z');
    const attempts = await Promise.all([
      store.consumeLoginToken('integration-login-hash', now),
      store.consumeLoginToken('integration-login-hash', now),
    ]);

    expect(attempts.filter((attempt) => attempt !== null)).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt === null)).toHaveLength(1);
  });

  it('rejects an expired token and resolves canonical email lookup', async () => {
    await store.saveLoginToken({
      tokenHash: 'expired-login-hash',
      email: 'user@example.com',
      expiresAt: '2026-10-09T00:01:00.000Z',
      usedAt: null,
    });
    await expect(
      store.consumeLoginToken('expired-login-hash', new Date('2026-10-09T00:02:00.000Z')),
    ).resolves.toBeNull();

    await store.saveUser({
      id: 'user-1',
      email: 'Mixed.User@Example.COM',
      role: 'user',
      verifiedAt: '2026-10-09T00:00:00.000Z',
      suspendedAt: null,
    });

    await expect(store.findUserByEmail('mixed.user@example.com')).resolves.toMatchObject({
      id: 'user-1',
      email: 'Mixed.User@Example.COM',
      suspendedAt: null,
    });
  });

  it('round-trips suspension and reports repeated state as unchanged', async () => {
    await store.saveUser({
      id: 'user-suspended',
      email: 'suspended@example.com',
      role: 'user',
      verifiedAt: '2026-10-09T00:00:00.000Z',
      suspendedAt: null,
    });

    await expect(
      store.setUserSuspended('user-suspended', true, '2026-10-09T00:05:00.000Z'),
    ).resolves.toMatchObject({ changed: true, user: { suspendedAt: '2026-10-09T00:05:00.000Z' } });

    await expect(
      store.setUserSuspended('user-suspended', true, '2026-10-09T00:06:00.000Z'),
    ).resolves.toMatchObject({ changed: false, user: { suspendedAt: '2026-10-09T00:05:00.000Z' } });
  });

  it('stores only session hashes and revokes the selected session', async () => {
    await store.saveUser({
      id: 'user-session',
      email: 'session@example.com',
      role: 'user',
      verifiedAt: '2026-10-09T00:00:00.000Z',
      suspendedAt: null,
    });
    await store.saveSession({
      id: 'session-1',
      userId: 'user-session',
      tokenHash: 'session-token-hash',
      csrfTokenHash: 'csrf-token-hash',
      createdAt: '2026-10-09T00:00:00.000Z',
      expiresAt: '2026-11-08T00:00:00.000Z',
    });

    const persisted = await client.query(
      'SELECT token_hash, csrf_token_hash FROM sessions WHERE id = $1',
      ['session-1'],
    );
    expect(persisted.rows).toEqual([
      { token_hash: 'session-token-hash', csrf_token_hash: 'csrf-token-hash' },
    ]);

    await expect(
      store.findSessionByTokenHash('session-token-hash', new Date('2026-10-09T00:01:00.000Z')),
    ).resolves.toMatchObject({ id: 'session-1', userId: 'user-session' });

    await store.revokeSessionByTokenHash('session-token-hash');
    await expect(
      store.findSessionByTokenHash('session-token-hash', new Date('2026-10-09T00:01:00.000Z')),
    ).resolves.toBeNull();
  });
});
