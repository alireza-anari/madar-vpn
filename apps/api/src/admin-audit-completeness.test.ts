import { describe, expect, it } from 'vitest';
import { createAdminAuditService } from './admin-audit';
import { createAuthService, MemoryAuthStore, type Session } from './auth';
import { createApiApp } from './index';
import { createMissionService, MemoryMissionStore } from './missions';
import { createPaymentService, MemoryPaymentStore } from './payments';
import { createSurfaceService, MemorySurfaceStore } from './surfaces';

async function auditHarness() {
  const sent: string[] = [];
  let tokenNumber = 0;
  const auth = createAuthService({
    store: new MemoryAuthStore(),
    adminEmails: ['admin@example.com'],
    randomToken: () => `audit-route-${++tokenNumber}`,
    sender: async ({ token }) => { sent.push(token); },
  });

  async function login(email: string): Promise<Session> {
    await auth.requestLogin(email);
    return auth.consumeLoginToken(sent.shift()!);
  }

  const user = await login('user@example.com');
  const admin = await login('admin@example.com');
  const surfaceStore = new MemorySurfaceStore();
  const surfaces = createSurfaceService({
    store: surfaceStore,
    credits: {
      async getEntitlement() {
        return {
          freeSeconds: 0,
          premiumUntil: null,
          tier: 'free' as const,
        };
      },
      async adjustManual() { return false; },
      async adjustPremium() { return false; },
    },
    now: () => new Date('2026-10-08T12:00:00.000Z'),
  });
  const audit = createAdminAuditService({
    store: surfaceStore,
    now: () => new Date('2026-10-08T12:00:00.000Z'),
  });

  const paymentStore = new MemoryPaymentStore();
  paymentStore.seedPlan({
    id: 'monthly',
    title: 'ماهانه',
    durationDays: 30,
    priceMinor: 125000,
    currency: 'IRR',
    enabled: true,
  });
  const payments = createPaymentService({
    store: paymentStore,
    now: () => new Date('2026-10-08T12:00:00.000Z'),
    randomId: () => 'order-audit-1',
  });

  const missionStore = new MemoryMissionStore();
  missionStore.seedMission({
    id: 'proof-task',
    title: 'مدرک دستی',
    rewardSeconds: 600,
    status: 'active',
    verificationKind: 'evidence',
  });
  const missions = createMissionService({
    store: missionStore,
    now: () => new Date('2026-10-08T12:00:00.000Z'),
    randomId: () => 'submission-audit-1',
  });

  const createWithServices = createApiApp as unknown as (...args: unknown[]) => ReturnType<typeof createApiApp>;
  const app = createWithServices(
    () => auth,
    () => surfaces,
    () => null,
    () => null,
    () => payments,
    () => missions,
    () => null,
    () => null,
    () => audit,
  );

  return { app, user, admin, surfaceStore };
}

function mutationHeaders(session: Session) {
  return {
    'content-type': 'application/json',
    cookie: `__Host-madar_session=${session.token}`,
    'x-csrf-token': session.csrfToken,
  };
}

describe('sensitive admin audit completeness', () => {
  it('audits manual payment confirmation without storing the confirmation credential', async () => {
    const { app, user, admin, surfaceStore } = await auditHarness();
    await app.request('/api/account/orders', {
      method: 'POST',
      headers: mutationHeaders(user),
      body: JSON.stringify({ planId: 'monthly' }),
    });

    const confirmationCredential = 'manual-confirmation-do-not-log';
    const response = await app.request('/api/admin/orders/order-audit-1/confirm', {
      method: 'POST',
      headers: mutationHeaders(admin),
      body: JSON.stringify({ confirmationId: confirmationCredential }),
    });

    expect(response.status).toBe(200);
    expect(surfaceStore.audit).toEqual([
      expect.objectContaining({
        actorUserId: admin.userId,
        action: 'payment.manual.confirm',
        details: { orderId: 'order-audit-1', applied: true },
      }),
    ]);
    expect(JSON.stringify(surfaceStore.audit)).not.toContain(confirmationCredential);
  });

  it('audits mission review without storing submitted evidence', async () => {
    const { app, user, admin, surfaceStore } = await auditHarness();
    const evidence = 'private-user-evidence-do-not-log';
    await app.request('/api/account/missions/proof-task/submissions', {
      method: 'POST',
      headers: mutationHeaders(user),
      body: JSON.stringify({ kind: 'text', value: evidence }),
    });

    const response = await app.request('/api/admin/mission-submissions/submission-audit-1/review', {
      method: 'POST',
      headers: mutationHeaders(admin),
      body: JSON.stringify({ decision: 'approve' }),
    });

    expect(response.status).toBe(200);
    expect(surfaceStore.audit).toEqual([
      expect.objectContaining({
        actorUserId: admin.userId,
        action: 'mission.submission.review',
        details: {
          submissionId: 'submission-audit-1',
          status: 'approved',
          rewardApplied: true,
          rewardSeconds: 600,
        },
      }),
    ]);
    expect(JSON.stringify(surfaceStore.audit)).not.toContain(evidence);
  });
});
