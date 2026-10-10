import { describe, expect, it } from 'vitest';
import { MemoryNodeControlStore, createNodeControlService } from './index';

describe('telemetry settlement delegation', () => {
  it('rejects a contradictory replay as an identity conflict instead of ACKing a duplicate', async () => {
    const store = new MemoryNodeControlStore();
    const settlement = {
      accept: async () => 'conflict' as const,
    };
    const service = createNodeControlService({
      store,
      telemetrySettlement: settlement,
    } as unknown as Parameters<typeof createNodeControlService>[0]);

    await expect(service.postTelemetry('node-1', [{
      clientId: 'client-1',
      windowId: 'xray-traffic:2026-10-08T12:31Z',
      sequence: 2,
      seconds: 2,
      timestamp: '2026-10-08T12:31:02.000Z',
      activeSecondsHex: '0000000000000003',
    }])).rejects.toMatchObject({
      status: 409,
      code: 'TELEMETRY_IDENTITY_CONFLICT',
    });

    expect(store.telemetryReports).toEqual([]);
  });
});
