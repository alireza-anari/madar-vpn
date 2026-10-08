import { describe, expect, it } from 'vitest';
import { createApiApp } from './index';
import { MemoryAuthStore, createAuthService } from './auth';
import { MemoryNodeControlStore, createNodeControlService } from './nodes';
import { MemorySurfaceStore, createSurfaceService } from './surfaces';

function ids(...values: string[]) {
  let index = 0;
  return () => values[index++] ?? `id-${index}`;
}

function secrets(...values: string[]) {
  let index = 0;
  return () => values[index++] ?? `secret-${index}`;
}

describe('admin node retirement route', () => {
  it('revokes the node credential before removing the admin surface record', async () => {
    const sent: string[] = [];
    let authToken = 0;
    const auth = createAuthService({
      store: new MemoryAuthStore(),
      adminEmails: ['admin@example.com'],
      randomToken: () => `auth-secret-${++authToken}`,
      sender: async ({ token }) => { sent.push(token); },
    });
    await auth.requestLogin('admin@example.com');
    const session = await auth.consumeLoginToken(sent[0]!);

    const surfaceStore = new MemorySurfaceStore();
    const surfaces = createSurfaceService({
      store: surfaceStore,
      credits: {
        async getEntitlement() { throw new Error('not used'); },
        async adjustManual() { return false; },
        async adjustPremium() { return false; },
      },
    });

    const nodeStore = new MemoryNodeControlStore();
    const nodes = createNodeControlService({
      store: nodeStore,
      randomId: ids('node-1', 'enrollment-record-1', 'credential-record-1'),
      randomSecret: secrets('enrollment-secret-1', 'node-credential-1'),
    });
    const issued = await nodes.createEnrollmentToken('admin-1', { name: 'Recovery edge' }, new Date());
    const enrolled = await nodes.enrollNode(issued.rawToken, {}, {
      address: '203.0.113.10',
      port: 443,
      serverName: 'edge.example.test',
      realityPublicKey: 'public-reality-key',
      realityShortId: 'a1b2c3d4',
    });
    await surfaceStore.saveNode({
      id: issued.node.id,
      name: issued.node.name,
      status: 'ready',
      lastSeenAt: new Date().toISOString(),
      createdAt: issued.node.createdAt,
    });

    await expect(nodes.authenticateNode(enrolled.rawCredential)).resolves.toEqual({ nodeId: 'node-1' });

    const app = createApiApp(
      () => auth,
      () => surfaces,
      () => null,
      () => null,
      () => null,
      () => null,
      () => null,
      () => nodes,
    );
    const response = await app.request('/api/admin/nodes/node-1', {
      method: 'DELETE',
      headers: {
        cookie: `__Host-madar_session=${encodeURIComponent(session.token)}`,
        'x-csrf-token': session.csrfToken,
      },
    });

    expect(response.status).toBe(204);
    expect(surfaceStore.nodes).toEqual([]);
    await expect(nodes.authenticateNode(enrolled.rawCredential)).rejects.toMatchObject({
      status: 401,
      code: 'NODE_CREDENTIAL_INVALID',
    });
  });
});
