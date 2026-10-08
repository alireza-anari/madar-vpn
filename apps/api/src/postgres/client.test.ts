import { describe, expect, it } from 'vitest';
import { PgDatabase, connectPostgres } from './client';

type QueryCall = { text: string; values?: readonly unknown[] };

class FakeClient {
  readonly calls: QueryCall[] = [];
  connected = false;

  async connect() {
    this.connected = true;
  }

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number }> {
    const call: QueryCall = values === undefined ? { text } : { text, values };
    this.calls.push(call);
    return { rows: [] as Row[], rowCount: 0 };
  }
}

describe('PostgreSQL request database boundary', () => {
  it('creates and connects a client only when an invocation requests a database', async () => {
    const constructed: string[] = [];
    const client = new FakeClient();
    const factory = (connectionString: string) => {
      constructed.push(connectionString);
      return client;
    };

    expect(constructed).toEqual([]);

    const database = await connectPostgres('postgresql://runtime.example/madar', factory);

    expect(constructed).toEqual(['postgresql://runtime.example/madar']);
    expect(client.connected).toBe(true);
    expect(database).toBeInstanceOf(PgDatabase);
  });

  it('commits a successful transaction on the same query client', async () => {
    const client = new FakeClient();
    const database = new PgDatabase(client);

    const result = await database.transaction(async (tx) => {
      await tx.query('INSERT INTO example(value) VALUES ($1)', ['ok']);
      return 'committed';
    });

    expect(result).toBe('committed');
    expect(client.calls).toEqual([
      { text: 'BEGIN' },
      { text: 'INSERT INTO example(value) VALUES ($1)', values: ['ok'] },
      { text: 'COMMIT' },
    ]);
  });

  it('rolls back and rethrows when a transactional callback fails', async () => {
    const client = new FakeClient();
    const database = new PgDatabase(client);
    const failure = new Error('mutation failed');

    await expect(database.transaction(async (tx) => {
      await tx.query('UPDATE example SET value = $1', ['changed']);
      throw failure;
    })).rejects.toBe(failure);

    expect(client.calls).toEqual([
      { text: 'BEGIN' },
      { text: 'UPDATE example SET value = $1', values: ['changed'] },
      { text: 'ROLLBACK' },
    ]);
  });
});
