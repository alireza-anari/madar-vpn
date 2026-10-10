import { describe, expect, it } from 'vitest';
import { PgDatabase, type PgQueryClient } from '../postgres/client';
import { PostgresCreditStore } from './postgres';

class FakePgClient implements PgQueryClient {
  readonly calls: Array<{ text: string; values?: readonly unknown[] }> = [];
  readonly results: Array<{ rows: Record<string, unknown>[]; rowCount: number }> = [];

  async connect() {}

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number }> {
    this.calls.push(values === undefined ? { text } : { text, values });
    if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(text.trim())) return { rows: [], rowCount: 0 };
    const result = this.results.shift() ?? { rows: [], rowCount: 0 };
    return { rows: result.rows as Row[], rowCount: result.rowCount };
  }
}

describe('PostgresCreditStore', () => {
  it('reads verification timestamps and inserts ledger rows idempotently', async () => {
    const client = new FakePgClient();
    const store = new PostgresCreditStore(new PgDatabase(client));

    client.results.push({
      rowCount: 1,
      rows: [{ verified_at: new Date('2026-10-09T00:00:00.000Z') }],
    });
    await expect(store.getVerifiedAt('user-1')).resolves.toBe('2026-10-09T00:00:00.000Z');

    const entry = {
      uniqueKey: 'ad:event-1',
      userId: 'user-1',
      kind: 'ad' as const,
      freeDay: '2026-10-09',
      deltaSeconds: 900,
      occurredAt: '2026-10-09T08:00:00.000Z',
    };
    client.results.push({ rowCount: 1, rows: [{ unique_key: entry.uniqueKey }] });
    client.results.push({ rowCount: 0, rows: [] });

    await expect(store.insertLedgerEntry(entry)).resolves.toBe(true);
    await expect(store.insertLedgerEntry(entry)).resolves.toBe(false);

    const insert = client.calls.find((call) => /INSERT\s+INTO\s+credit_ledger/i.test(call.text));
    expect(insert?.text).toMatch(/ON\s+CONFLICT\s*\(unique_key\)\s+DO\s+NOTHING/i);
    expect(insert?.text).toMatch(/RETURNING\s+unique_key/i);
    expect(insert?.values?.slice(0, 6)).toEqual([
      'ad:event-1',
      'user-1',
      'ad',
      '2026-10-09',
      900,
      '2026-10-09T08:00:00.000Z',
    ]);
  });

  it('sums one Tehran day, resolves session ownership, and reads premium expiry', async () => {
    const client = new FakePgClient();
    const store = new PostgresCreditStore(new PgDatabase(client));

    client.results.push({ rowCount: 1, rows: [{ total: '1234' }] });
    await expect(store.sumFreeSeconds('user-1', '2026-10-09')).resolves.toBe(1234);

    client.results.push({ rowCount: 1, rows: [{ user_id: 'user-1' }] });
    await expect(store.resolveUsageSession('node-1', 'session-1')).resolves.toBe('user-1');

    client.results.push({ rowCount: 1, rows: [{ premium_until: new Date('2026-11-09T00:00:00.000Z') }] });
    await expect(store.getPremiumUntil('user-1')).resolves.toBe('2026-11-09T00:00:00.000Z');

    expect(client.calls[0]!.text).toMatch(/SUM\s*\(delta_seconds\)/i);
    expect(client.calls[0]!.values).toEqual(['user-1', '2026-10-09']);
    expect(client.calls[1]!.text).toMatch(/FROM\s+usage_sessions/i);
    expect(client.calls[2]!.text).toMatch(/FROM\s+memberships/i);
  });

  it('locks the user and records premium projection plus entitlement history in one transaction', async () => {
    const client = new FakePgClient();
    const store = new PostgresCreditStore(new PgDatabase(client));

    client.results.push({ rowCount: 1, rows: [{ id: 'user-1' }] });
    client.results.push({ rowCount: 1, rows: [{ unique_key: 'premium:manual-1' }] });
    client.results.push({ rowCount: 1, rows: [] });
    client.results.push({ rowCount: 1, rows: [] });

    await expect(
      store.applyPremiumAdjustment(
        'user-1',
        'premium:manual-1',
        '2026-11-09T00:00:00.000Z',
        '2026-10-09T08:00:00.000Z',
      ),
    ).resolves.toBe(true);

    expect(client.calls.map((call) => call.text.trim().split(/\s+/)[0])).toEqual([
      'BEGIN',
      'SELECT',
      'INSERT',
      'INSERT',
      'INSERT',
      'COMMIT',
    ]);
    expect(client.calls[1]!.text).toMatch(/FROM\s+users.*FOR\s+UPDATE/is);
    expect(client.calls[2]!.text).toMatch(/INSERT\s+INTO\s+premium_adjustments/i);
    expect(client.calls[2]!.text).toMatch(/ON\s+CONFLICT\s*\(unique_key\)\s+DO\s+NOTHING/i);
    expect(client.calls[3]!.text).toMatch(/INSERT\s+INTO\s+memberships/i);
    expect(client.calls[3]!.text).toMatch(/ON\s+CONFLICT\s*\(user_id\)\s+DO\s+UPDATE/i);
    expect(client.calls[4]!.text).toMatch(/INSERT\s+INTO\s+premium_entitlement_events/i);
    expect(client.calls[4]!.values).toEqual([
      'user-1',
      'adjustment:premium:manual-1',
      '2026-10-09T08:00:00.000Z',
      '2026-11-09T00:00:00.000Z',
    ]);
  });

  it('does not rewrite membership or history when a premium idempotency key is duplicated', async () => {
    const client = new FakePgClient();
    const store = new PostgresCreditStore(new PgDatabase(client));
    client.results.push({ rowCount: 1, rows: [{ id: 'user-1' }] });
    client.results.push({ rowCount: 0, rows: [] });

    await expect(
      store.applyPremiumAdjustment(
        'user-1',
        'premium:manual-1',
        '2027-01-01T00:00:00.000Z',
        '2026-10-09T09:00:00.000Z',
      ),
    ).resolves.toBe(false);

    expect(client.calls.map((call) => call.text.trim().split(/\s+/)[0])).toEqual([
      'BEGIN',
      'SELECT',
      'INSERT',
      'COMMIT',
    ]);
    expect(client.calls.some((call) => /INSERT\s+INTO\s+memberships/i.test(call.text))).toBe(false);
    expect(client.calls.some((call) => /premium_entitlement_events/i.test(call.text))).toBe(false);
  });
});
