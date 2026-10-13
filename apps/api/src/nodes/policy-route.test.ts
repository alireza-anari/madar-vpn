import { describe, expect, it, vi } from 'vitest';
import { createAuthService, MemoryAuthStore } from '../auth';
import { createApiApp } from '../index';
import { createNodeControlService, MemoryNodeControlStore } from './index';

async function harness(email = 'admin@example.test') {
  let token = '';
  const auth = createAuthService({ store: new MemoryAuthStore(), adminEmails: ['admin@example.test'], sender: async message => { token = message.token; } });
  const publish = vi.fn(async () => ({ revision: 3, validUntil: '2026-10-13T20:00:00Z', clientCount: 1 }));
  const nodes = createNodeControlService({ store: new MemoryNodeControlStore(), policyPublisher: { publish } });
  const app = createApiApp(() => auth, undefined, undefined, undefined, undefined, undefined, undefined, () => nodes);
  await app.request('/api/auth/request', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) });
  const login = await app.request('/api/auth/consume', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
  const { csrfToken } = await login.json() as { csrfToken: string };
  const headers = { cookie: login.headers.get('set-cookie')!.split(';')[0]!, 'x-csrf-token': csrfToken, 'content-type': 'application/json' };
  return { app, publish, headers };
}
describe('administrator policy publication route', () => {
  it('authenticates the administrator and returns only safe metadata with no-store', async () => {
    const { app, publish, headers } = await harness();
    const response = await app.request('/api/admin/nodes/node-test/policy', { method: 'POST', headers, body: JSON.stringify({ mode: 'current', ttlSeconds: 7200 }) });
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ revision: 3, validUntil: '2026-10-13T20:00:00Z', clientCount: 1 });
    expect(publish).toHaveBeenCalledOnce();
  });
  it('rejects anonymous, non-admin, missing CSRF and foreign Origin before publication', async () => {
    const admin = await harness();
    for (const headers of [{}, { cookie: admin.headers.cookie }, { ...admin.headers, origin: 'https://foreign.example.test' }]) {
      const response = await admin.app.request('/api/admin/nodes/node-test/policy', { method: 'POST', headers, body: JSON.stringify({ mode: 'empty', ttlSeconds: 60 }) });
      expect([401, 403]).toContain(response.status);
    }
    expect(admin.publish).not.toHaveBeenCalled();
    const user = await harness('ordinary@example.test');
    expect((await user.app.request('/api/admin/nodes/node-test/policy', { method: 'POST', headers: user.headers, body: JSON.stringify({ mode: 'current', ttlSeconds: 60 }) })).status).toBe(403);
    expect(user.publish).not.toHaveBeenCalled();
  });
});
