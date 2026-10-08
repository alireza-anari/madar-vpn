export interface PgQueryClient {
  connect(): Promise<void>;
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number | null }>;
}

export type PgClientFactory = (connectionString: string) => PgQueryClient;

export class PgDatabase {
  constructor(private readonly client: Pick<PgQueryClient, 'query'>) {}

  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ) {
    return this.client.query<Row>(text, values);
  }

  async transaction<T>(callback: (transaction: PgDatabase) => Promise<T>): Promise<T> {
    await this.client.query('BEGIN');
    try {
      const result = await callback(this);
      await this.client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await this.client.query('ROLLBACK');
      } catch {
        // Preserve the original transactional error. A rollback failure must not
        // hide the mutation failure that caused the transaction to abort.
      }
      throw error;
    }
  }
}

export async function connectPostgres(connectionString: string, factory: PgClientFactory) {
  if (!connectionString.trim()) throw new Error('PostgreSQL connection string is required.');
  const client = factory(connectionString);
  await client.connect();
  return new PgDatabase(client);
}
