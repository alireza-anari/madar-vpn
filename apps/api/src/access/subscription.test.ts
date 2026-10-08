import { describe, expect, it } from 'vitest';
import { MemoryAccessStore, createAccessService } from './index';
import { MemorySubscriptionNodeStore, createSubscriptionService, renderSubscription } from './subscription';

const NOW = new Date('2026-10-08T08:00:00.000Z');

function harness() {
  const accessStore = new MemoryAccessStore();
  let uuidNumber = 0;
  let tokenNumber = 0;
  const access = createAccessService({
    store: accessStore,
    now: () => NOW,
    randomUuid: () => `00000000-0000-4000-8000-${String(++uuidNumber).padStart(12, '0')}`,
    randomToken: () => `subscription-secret-${++tokenNumber}`,
  });
  const nodes = new MemorySubscriptionNodeStore();
  const subscriptions = createSubscriptionService({
    accessStore,
    access,
    nodes,
    staleAfterMs: 120_000,
  });
  return { accessStore, access, nodes, subscriptions };
}

describe('eligible node subscription renderer', () => {
  it('excludes unhealthy, stale, and unacked nodes and preserves multiple eligible public entries', async () => {
    const { access, nodes, subscriptions } = harness();
    await access.ensureAccessProfile('user-1');

    nodes.seed({
      id: 'node-a',
      name: 'Tehran A',
      status: 'ready',
      lastSeenAt: '2026-10-08T07:59:30.000Z',
      ackedRevisionByUser: { 'user-1': 1 },
      publicConfig: {
        address: 'a.example.com',
        port: 443,
        serverName: 'cdn-a.example.com',
        realityPublicKey: 'public-key-a',
        realityShortId: 'abcd1234',
      },
    });
    nodes.seed({
      id: 'node-b',
      name: 'Tehran B',
      status: 'ready',
      lastSeenAt: '2026-10-08T07:59:20.000Z',
      ackedRevisionByUser: { 'user-1': 1 },
      publicConfig: {
        address: 'b.example.com',
        port: 8443,
        serverName: 'cdn-b.example.com',
        realityPublicKey: 'public-key-b',
        realityShortId: 'ef567890',
      },
    });
    nodes.seed({
      id: 'node-unhealthy',
      name: 'Bad',
      status: 'error',
      lastSeenAt: '2026-10-08T07:59:50.000Z',
      ackedRevisionByUser: { 'user-1': 1 },
      publicConfig: { address: 'bad.example.com', port: 443, serverName: 'bad.example.com', realityPublicKey: 'bad-public', realityShortId: 'bad1' },
    });
    nodes.seed({
      id: 'node-stale',
      name: 'Stale',
      status: 'ready',
      lastSeenAt: '2026-10-08T07:55:00.000Z',
      ackedRevisionByUser: { 'user-1': 1 },
      publicConfig: { address: 'stale.example.com', port: 443, serverName: 'stale.example.com', realityPublicKey: 'stale-public', realityShortId: 'stale1' },
    });
    nodes.seed({
      id: 'node-unacked',
      name: 'Unacked',
      status: 'ready',
      lastSeenAt: '2026-10-08T07:59:50.000Z',
      ackedRevisionByUser: { 'user-1': 0 },
      publicConfig: { address: 'unacked.example.com', port: 443, serverName: 'unacked.example.com', realityPublicKey: 'unacked-public', realityShortId: 'unacked1' },
    });

    const eligible = await subscriptions.listEligibleNodes('user-1', NOW);
    expect(eligible.map((node) => node.id)).toEqual(['node-a', 'node-b']);

    const profile = await subscriptions.getRenderProfile('user-1');
    const rendered = renderSubscription(profile, eligible);
    const lines = rendered.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines.every((line) => line.startsWith('vless://'))).toBe(true);
    expect(rendered).toContain(profile.clientUuid);
    expect(rendered).toContain('a.example.com');
    expect(rendered).toContain('b.example.com');
    expect(rendered).not.toContain('bad.example.com');
    expect(rendered).not.toContain('stale.example.com');
    expect(rendered).not.toContain('unacked.example.com');
    expect(rendered).not.toMatch(/private.?key|enrollment|internal.?api|credential/i);
  });

  it('resolves only the current active hashed subscription token', async () => {
    const { access, subscriptions } = harness();
    const first = await access.issueSubscriptionToken('user-1');
    const second = await access.issueSubscriptionToken('user-1');

    await expect(subscriptions.renderForToken(first.rawToken, NOW)).resolves.toBeNull();
    await expect(subscriptions.renderForToken('totally-invalid-token', NOW)).resolves.toBeNull();
    await expect(subscriptions.renderForToken(second.rawToken, NOW)).resolves.toBe('');
  });
});
