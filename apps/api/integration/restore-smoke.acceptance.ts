import { Client } from 'pg';
import { describe, expect, it } from 'vitest';
import { createDefaultApiApp } from '../src/worker';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error('TEST_DATABASE_URL is required for restore smoke acceptance.');

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

describe('restored PostgreSQL Worker smoke', () => {
  it('serves an authenticated account request from the restored database', async () => {
    const setupClient = new Client({ connectionString });
    const runtimeClients: Client[] = [];
    const sessionId = 'restore-smoke-session';
    const sessionToken = 'restore-smoke-session-token';

    await setupClient.connect();
    try {
      const witness = await setupClient.query<{ email: string; credit_seconds: string }>(
        `SELECT u.email,
                COALESCE(SUM(l.delta_seconds), 0)::text AS credit_seconds
           FROM users u
           LEFT JOIN credit_ledger l ON l.user_id = u.id
          WHERE u.id = $1
          GROUP BY u.email`,
        ['schema-user-1'],
      );
      expect(witness.rows).toEqual([{ email: 'User@Example.COM', credit_seconds: '1800' }]);

      await setupClient.query(
        `INSERT INTO sessions (id, user_id, token_hash, csrf_token_hash, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz)`,
        [
          sessionId,
          'schema-user-1',
          await sha256Hex(sessionToken),
          await sha256Hex('restore-smoke-csrf'),
          '2026-10-09T00:00:00.000Z',
          '2099-01-01T00:00:00.000Z',
        ],
      );

      const app = createDefaultApiApp({
        pgClientFactory: (runtimeConnectionString) => {
          const client = new Client({ connectionString: runtimeConnectionString });
          runtimeClients.push(client);
          return client;
        },
      });

      const response = await app.request(
        '/api/account',
        { headers: { cookie: `__Host-madar_session=${sessionToken}` } },
        { HYPERDRIVE: { connectionString } } as never,
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        identity: {
          id: 'schema-user-1',
          email: 'User@Example.COM',
          role: 'user',
        },
      });
    } finally {
      await Promise.all(
        runtimeClients.map((client) =>
          (client as unknown as { end(): Promise<void> }).end(),
        ),
      );
      await setupClient.query('DELETE FROM sessions WHERE id = $1', [sessionId]);
      await (setupClient as unknown as { end(): Promise<void> }).end();
    }
  });
});
