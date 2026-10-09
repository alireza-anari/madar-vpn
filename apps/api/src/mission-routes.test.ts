import { describe, expect, it } from 'vitest';
import { createAuthService, MemoryAuthStore, type Session } from './auth';
import { createApiApp } from './index';
import { MemoryMissionStore, createMissionService } from './missions';

async function missionHarness() {
  const sent: string[] = [];
  let tokenNumber = 0;
  const auth = createAuthService({
    store: new MemoryAuthStore(),
    adminEmails: ['admin@example.com'],
    randomToken: () => `mission-route-${++tokenNumber}`,
    sender: async ({ token }) => { sent.push(token); },
  });

  async function login(email: string): Promise<Session> {
    await auth.requestLogin(email);
    return auth.consumeLoginToken(sent.shift()!);
  }

  const user = await login('user@example.com');
  const admin = await login('admin@example.com');
  const store = new MemoryMissionStore();
  store.seedMission({
    id: 'proof-task',
    title: 'مدرک دستی',
    rewardSeconds: 600,
    status: 'active',
    verificationKind: 'evidence',
  });
  const missions = createMissionService({
    store,
    now: () => new Date('2026-10-08T09:00:00.000Z'),
    randomId: () => 'submission-1',
  });

  const createWithMissions = createApiApp as unknown as (...args: unknown[]) => ReturnType<typeof createApiApp>;
  const app = createWithMissions(
    () => auth,
    () => null,
    () => null,
    () => null,
    () => null,
    () => missions,
  );
  return { app, user, admin, store };
}

function mutationHeaders(session: Session) {
  return {
    'content-type': 'application/json',
    cookie: `__Host-madar_session=${session.token}`,
    'x-csrf-token': session.csrfToken,
  };
}

describe('mission HTTP boundary', () => {
  it('lets an authenticated user submit evidence and reads only a safe user-facing mission status DTO', async () => {
    const { app, user } = await missionHarness();

    const submit = await app.request('/api/account/missions/proof-task/submissions', {
      method: 'POST',
      headers: mutationHeaders(user),
      body: JSON.stringify({ kind: 'text', value: 'proof-value' }),
    });
    expect(submit.status).toBe(201);
    await expect(submit.json()).resolves.toMatchObject({ id: 'submission-1', status: 'pending' });

    const status = await app.request('/api/account/missions/submissions', {
      headers: { cookie: `__Host-madar_session=${user.token}` },
    });
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toEqual([
      {
        id: 'submission-1',
        missionId: 'proof-task',
        status: 'pending',
        submittedAt: '2026-10-08T09:00:00.000Z',
        reviewedAt: null,
        rejectionReason: null,
      },
    ]);
  });

  it('keeps review admin-only and an approved submission awards once', async () => {
    const { app, user, admin, store } = await missionHarness();
    await app.request('/api/account/missions/proof-task/submissions', {
      method: 'POST',
      headers: mutationHeaders(user),
      body: JSON.stringify({ kind: 'text', value: 'proof-value' }),
    });

    const forbidden = await app.request('/api/admin/mission-submissions/submission-1/review', {
      method: 'POST',
      headers: mutationHeaders(user),
      body: JSON.stringify({ decision: 'approve' }),
    });
    expect(forbidden.status).toBe(403);

    const approved = await app.request('/api/admin/mission-submissions/submission-1/review', {
      method: 'POST',
      headers: mutationHeaders(admin),
      body: JSON.stringify({ decision: 'approve' }),
    });
    expect(approved.status).toBe(200);
    await expect(approved.json()).resolves.toMatchObject({ status: 'approved', rewardApplied: true, rewardSeconds: 600 });

    const duplicate = await app.request('/api/admin/mission-submissions/submission-1/review', {
      method: 'POST',
      headers: mutationHeaders(admin),
      body: JSON.stringify({ decision: 'approve' }),
    });
    await expect(duplicate.json()).resolves.toMatchObject({ status: 'approved', rewardApplied: false });
    expect(store.rewards).toHaveLength(1);
  });
});
