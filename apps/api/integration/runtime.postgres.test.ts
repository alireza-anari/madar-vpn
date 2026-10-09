import { describe, expect, it } from 'vitest';
import { createDefaultApiApp } from '../src/index';
import type { PgClientFactory, PgQueryClient } from '../src/postgres/client';

class FakePgClient implements PgQueryClient {
  connectCalls = 0;
  readonly queries: Array<{ text: string; values: readonly unknown[] | undefined }> = [];

  async connect() {
    this.connectCalls += 1;
  }

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number | null }> {
    this.queries.push({ text, values });

    if (/FROM\s+sessions/i.test(text)) {
      return {
        rows: [{
          id: 'session-1',
          user_id: 'user-1',
          token_hash: 'session-hash',
          csrf_token_hash: 'csrf-hash',
          created_at: '2026-10-09T00:00:00.000Z',
          expires_at: '2099-10-09T00:00:00.000Z',
        } as unknown as Row],
        rowCount: 1,
      };
    }

    if (/SELECT\s+verified_at\s+FROM\s+users/i.test(text)) {
      return {
        rows: [{ verified_at: '2026-10-09T00:00:00.000Z' } as unknown as Row],
        rowCount: 1,
      };
    }

    if (/FROM\s+users/i.test(text)) {
      return {
        rows: [{
          id: 'user-1',
          email: 'user@example.com',
          role: 'user',
          verified_at: '2026-10-09T00:00:00.000Z',
          suspended_at: null,
        } as unknown as Row],
        rowCount: 1,
      };
    }

    if (/INSERT\s+INTO\s+credit_ledger/i.test(text)) {
      return { rows: [{ unique_key: 'initial:user-1' } as unknown as Row], rowCount: 1 };
    }

    if (/SUM\(delta_seconds\)/i.test(text)) {
      return { rows: [{ total: 1800 } as unknown as Row], rowCount: 1 };
    }

    if (/FROM\s+memberships/i.test(text)) {
      return { rows: [], rowCount: 0 };
    }

    if (/EXISTS\(SELECT 1 FROM nodes/i.test(text)) {
      return { rows: [{ ready: false, connected: false } as unknown as Row], rowCount: 1 };
    }

    return { rows: [], rowCount: 0 };
  }
}

describe('default PostgreSQL Worker runtime', () => {
  it('does not fall back to a legacy DB binding when Hyperdrive is missing', async () => {
    let createdClients = 0;
    const pgClientFactory: PgClientFactory = () => {
      createdClients += 1;
      return new FakePgClient();
    };
    const app = createDefaultApiApp({ pgClientFactory });

    const response = await app.request(
      '/api/auth/request',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'user@example.com' }),
      },
      {
        DB: {
          prepare() {
            throw new Error('Legacy D1 binding must not be used.');
          },
        },
      } as never,
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: 'AUTH_UNAVAILABLE' });
    expect(createdClients).toBe(0);
  });

  it('creates one shared PostgreSQL client per request and a fresh client for the next request', async () => {
    const clients: FakePgClient[] = [];
    const connectionStrings: string[] = [];
    const pgClientFactory: PgClientFactory = (connectionString) => {
      connectionStrings.push(connectionString);
      const client = new FakePgClient();
      clients.push(client);
      return client;
    };
    const app = createDefaultApiApp({ pgClientFactory });
    const env = {
      HYPERDRIVE: { connectionString: 'postgresql://hyperdrive.example/madar' },
    } as never;

    const first = await app.request(
      '/api/account',
      { headers: { cookie: '__Host-madar_session=test-session' } },
      env,
    );
    expect(first.status).toBe(200);
    expect(clients).toHaveLength(1);
    expect(clients[0]?.connectCalls).toBe(1);
    expect(clients[0]?.queries.some((entry) => /FROM\s+sessions/i.test(entry.text))).toBe(true);
    expect(clients[0]?.queries.some((entry) => /credit_ledger/i.test(entry.text))).toBe(true);
    expect(clients[0]?.queries.some((entry) => /EXISTS\(SELECT 1 FROM nodes/i.test(entry.text))).toBe(true);

    const second = await app.request(
      '/api/account',
      { headers: { cookie: '__Host-madar_session=test-session' } },
      env,
    );
    expect(second.status).toBe(200);
    expect(clients).toHaveLength(2);
    expect(clients[1]?.connectCalls).toBe(1);
    expect(connectionStrings).toEqual([
      'postgresql://hyperdrive.example/madar',
      'postgresql://hyperdrive.example/madar',
    ]);
  });
});
