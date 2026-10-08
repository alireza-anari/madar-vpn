import { describe, expect, it } from 'vitest';
import type { D1DatabaseLike } from '../auth/d1';
import { D1NodeControlStore } from './d1';

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

describe('D1NodeControlStore', () => {
  it('consumes an enrollment token atomically only while unused and unexpired', async () => {
    const db = new FakeD1();
    const store = new D1NodeControlStore(db);
    db.firstResults.push({
      id: 'token-1',
      node_id: 'node-1',
      token_hash: 'hash-1',
      created_by: 'admin-1',
      created_at: '2026-10-08T12:00:00.000Z',
      expires_at: '2026-10-08T12:15:00.000Z',
      used_at: '2026-10-08T12:01:00.000Z',
    });

    await expect(store.consumeEnrollmentToken('hash-1', new Date('2026-10-08T12:01:00.000Z'))).resolves.toMatchObject({
      nodeId: 'node-1',
      usedAt: '2026-10-08T12:01:00.000Z',
    });

    const entry = db.executed[0]!;
    expect(entry.sql).toMatch(/UPDATE\s+node_enrollment_tokens\s+SET\s+used_at/i);
    expect(entry.sql).toMatch(/used_at\s+IS\s+NULL/i);
    expect(entry.sql).toMatch(/expires_at\s*>\s*\?/i);
    expect(entry.sql).toMatch(/RETURNING/i);
    expect(entry.values).toEqual(['2026-10-08T12:01:00.000Z', 'hash-1', '2026-10-08T12:01:00.000Z']);
  });

  it('persists credential hashes and deduplicates telemetry with a database uniqueness boundary', async () => {
    const db = new FakeD1();
    const store = new D1NodeControlStore(db);

    await store.saveCredential({
      id: 'credential-1',
      nodeId: 'node-1',
      credentialHash: 'sha256-only',
      createdAt: '2026-10-08T12:00:00.000Z',
      revokedAt: null,
    });
    expect(db.executed[0]!.sql).toMatch(/INSERT\s+INTO\s+node_credentials/i);
    expect(db.executed[0]!.values).toContain('sha256-only');

    db.firstResults.push({ node_id: 'node-1' }, null);
    const report = {
      nodeId: 'node-1',
      clientId: 'client-1',
      windowId: 'window-1',
      sequence: 4,
      seconds: 10,
      timestamp: '2026-10-08T12:00:10.000Z',
    };
    await expect(store.insertTelemetry(report)).resolves.toBe(true);
    await expect(store.insertTelemetry(report)).resolves.toBe(false);

    for (const entry of db.executed.slice(1)) {
      expect(entry.sql).toMatch(/INSERT\s+OR\s+IGNORE\s+INTO\s+telemetry_reports/i);
      expect(entry.sql).toMatch(/RETURNING\s+node_id/i);
    }
  });
});
