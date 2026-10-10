import { describe, expect, it } from 'vitest';
import { createApiApp } from './index';
import { NodeControlError, type NodeControlService } from './nodes';

function appWithNodes(nodes: NodeControlService) {
  const createWithNodes = createApiApp as unknown as (...args: unknown[]) => ReturnType<typeof createApiApp>;
  return createWithNodes(
    () => null,
    () => null,
    () => null,
    () => null,
    () => null,
    () => null,
    () => null,
    () => nodes,
  );
}

describe('node telemetry capability boundary', () => {
  it('requires node bearer authentication and advertises active-second telemetry v1', async () => {
    const nodes = {
      authenticateNode: async (rawCredential: string) => {
        if (rawCredential !== 'valid-node-credential') {
          throw new NodeControlError(401, 'NODE_CREDENTIAL_INVALID', 'Invalid node credential.');
        }
        return { nodeId: 'node-capability-1' };
      },
    } as unknown as NodeControlService;
    const app = appWithNodes(nodes);

    const anonymous = await app.request('/api/node/telemetry/capabilities');
    expect(anonymous.status).toBe(401);

    const authenticated = await app.request('/api/node/telemetry/capabilities', {
      headers: { authorization: 'Bearer valid-node-credential' },
    });
    expect(authenticated.status).toBe(200);
    expect(authenticated.headers.get('cache-control')).toBe('no-store');
    await expect(authenticated.json()).resolves.toEqual({ activeSecondsV1: true });
  });
});
