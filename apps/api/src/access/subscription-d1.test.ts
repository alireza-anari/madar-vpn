import { describe, expect, it } from 'vitest';
import type { D1DatabaseLike } from '../auth/d1';
import { D1SubscriptionNodeStore } from './subscription-d1';

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

  async all<T>() {
    this.db.executed.push({ sql: this.sql, values: this.bound, mode: 'all' });
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

describe('D1SubscriptionNodeStore', () => {
  it('reads only client-safe node config plus per-user acknowledged revision', async () => {
    const db = new FakeD1();
    const store = new D1SubscriptionNodeStore(db);
    db.allResults.push([
      {
        id: 'node-1',
        name: 'Tehran A',
        status: 'ready',
        last_seen_at: '2026-10-08T07:59:30.000Z',
        acked_revision: 3,
        address: 'edge.example.com',
        port: 443,
        server_name: 'cdn.example.com',
        reality_public_key: 'public-key',
        reality_short_id: 'abcd1234',
      },
      {
        id: 'node-2',
        name: 'No public config',
        status: 'ready',
        last_seen_at: '2026-10-08T07:59:20.000Z',
        acked_revision: null,
        address: null,
        port: null,
        server_name: null,
        reality_public_key: null,
        reality_short_id: null,
      },
    ]);

    await expect(store.listCandidates('user-1')).resolves.toEqual([
      {
        id: 'node-1',
        name: 'Tehran A',
        status: 'ready',
        lastSeenAt: '2026-10-08T07:59:30.000Z',
        ackedRevision: 3,
        publicConfig: {
          address: 'edge.example.com',
          port: 443,
          serverName: 'cdn.example.com',
          realityPublicKey: 'public-key',
          realityShortId: 'abcd1234',
        },
      },
      {
        id: 'node-2',
        name: 'No public config',
        status: 'ready',
        lastSeenAt: '2026-10-08T07:59:20.000Z',
        ackedRevision: null,
        publicConfig: null,
      },
    ]);

    const query = db.executed[0]!;
    expect(query.mode).toBe('all');
    expect(query.values).toEqual(['user-1']);
    expect(query.sql).toMatch(/node_public_configs/i);
    expect(query.sql).toMatch(/node_policy_acks/i);
    expect(query.sql).toMatch(/a\.user_id\s*=\s*\?/i);
    expect(query.sql).not.toMatch(/private.?key|enrollment.?token|node.?credential|internal.?api/i);
  });
});
