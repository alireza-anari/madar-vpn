import { describe, expect, it } from 'vitest';
import { createAdminAuditService } from './admin-audit';
import { createAuthService, MemoryAuthStore } from './auth';
import { createApiApp } from './index';
import { createNodeControlService, MemoryNodeControlStore } from './nodes';
import { MemorySurfaceStore } from './surfaces';

function mutationHeaders(token: string, csrfToken: string) {
  return {
    'content-type': 'application/json',
    cookie: `__Host-madar_session=${token}`,
    'x-csrf-token': csrfToken,
  };
}

describe('node enrollment audit', () => {
  it('audits enrollment-token issuance without persisting the raw token', async () => {
    const sent: string[] = [];
    let authToken = 0;
    const auth = createAuthService({
      store: new MemoryAuthStore(),
      adminEmails: ['admin@example.com'],
      randomToken: () => `node-audit-auth-${++authToken}`,
      sender: async ({ token }) => { sent.push(token); },
    });
    await auth.requestLogin('admin@example.com');
    const session = await auth.consumeLoginToken(sent[0]!);

    const nodeStore = new MemoryNodeControlStore();
    let id = 0;
    const rawEnrollmentToken = 'node-enrollment-secret-never-audit';
    const nodes = createNodeControlService({
      store: nodeStore,
      randomId: () => `node-audit-${++id}`,
      randomSecret: () => rawEnrollmentToken,
      enrollmentTtlMs: 10 * 60_000,
    });
    const surfaceStore = new MemorySurfaceStore();
    const audit = createAdminAuditService({
      store: surfaceStore,
      now: () => new Date('2026-10-08T12:00:00.000Z'),
    });

    const createWithServices = createApiApp as unknown as (...args: unknown[]) => ReturnType<typeof createApiApp>;
    const app = createWithServices(
      () => auth,
      () => null,
      () => null,
      () => null,
      () => null,
      () => null,
      () => null,
      () => nodes,
      () => audit,
    );

    const response = await app.request('/api/admin/nodes/enrollment-token', {
      method: 'POST',
      headers: mutationHeaders(session.token, session.csrfToken),
      body: JSON.stringify({ name: 'Frankfurt edge' }),
    });

    expect(response.status).toBe(201);
    const issued = await response.json() as {
      node: { id: string };
      rawToken: string;
      expiresAt: string;
    };
    expect(issued.rawToken).toBe(rawEnrollmentToken);
    expect(surfaceStore.audit).toEqual([
      expect.objectContaining({
        actorUserId: session.userId,
        action: 'node.enrollment-token.issue',
        details: {
          nodeId: issued.node.id,
          expiresAt: issued.expiresAt,
        },
      }),
    ]);
    expect(JSON.stringify(surfaceStore.audit)).not.toContain(rawEnrollmentToken);
  });
});
