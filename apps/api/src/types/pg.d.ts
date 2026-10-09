declare module 'pg' {
  export class Client {
    constructor(config?: { connectionString?: string });
    connect(): Promise<void>;
    query<Row extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      values?: readonly unknown[],
    ): Promise<{ rows: Row[]; rowCount: number | null }>;
  }
}
