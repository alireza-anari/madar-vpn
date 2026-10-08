import { describe, expect, it } from 'vitest';
import { MemoryMissionStore, createMissionService } from './index';

const NOW = new Date('2026-10-08T09:00:00.000Z');

function harness() {
  const store = new MemoryMissionStore();
  store.seedMission({
    id: 'proof-task',
    title: 'مدرک دستی',
    rewardSeconds: 600,
    status: 'active',
    verificationKind: 'evidence',
  });
  store.seedMission({
    id: 'referral',
    title: 'دعوت تأییدشده',
    rewardSeconds: 900,
    status: 'active',
    verificationKind: 'referral',
  });
  let submissionNumber = 0;
  const missions = createMissionService({
    store,
    now: () => NOW,
    randomId: () => `submission-${++submissionNumber}`,
  });
  return { store, missions };
}

describe('mission evidence and rewards', () => {
  it('stores submitted evidence as pending and exposes the user status', async () => {
    const { missions } = harness();

    await expect(missions.submitEvidence('user-1', 'proof-task', {
      kind: 'text',
      value: 'https://example.test/proof/123',
    })).resolves.toMatchObject({
      id: 'submission-1',
      userId: 'user-1',
      missionId: 'proof-task',
      status: 'pending',
    });

    await expect(missions.getUserStatus('user-1')).resolves.toEqual([
      expect.objectContaining({ id: 'submission-1', status: 'pending' }),
    ]);
  });

  it('approves an eligible submission once and settles exactly one reward', async () => {
    const { store, missions } = harness();
    const submission = await missions.submitEvidence('user-1', 'proof-task', {
      kind: 'text',
      value: 'proof-value',
    });

    await expect(missions.reviewSubmission('admin-1', submission.id, { decision: 'approve' }))
      .resolves.toMatchObject({ status: 'approved', rewardApplied: true, rewardSeconds: 600 });
    await expect(missions.reviewSubmission('admin-1', submission.id, { decision: 'approve' }))
      .resolves.toMatchObject({ status: 'approved', rewardApplied: false, rewardSeconds: 600 });

    expect(store.rewards).toEqual([
      expect.objectContaining({ submissionId: submission.id, userId: 'user-1', rewardSeconds: 600 }),
    ]);
  });

  it('rejects evidence without settling a reward', async () => {
    const { store, missions } = harness();
    const submission = await missions.submitEvidence('user-1', 'proof-task', {
      kind: 'text',
      value: 'weak-proof',
    });

    await expect(missions.reviewSubmission('admin-1', submission.id, {
      decision: 'reject',
      reason: 'مدرک کافی نیست',
    })).resolves.toMatchObject({ status: 'rejected', rewardApplied: false });

    expect(store.rewards).toHaveLength(0);
  });

  it('requires a server-verified referral relationship and never treats a share click as evidence', async () => {
    const { store, missions } = harness();

    await expect(missions.submitEvidence('user-1', 'referral', {
      kind: 'share_click',
      value: 'clicked',
    } as never)).rejects.toMatchObject({ code: 'EVIDENCE_INVALID' });

    const submission = await missions.submitEvidence('user-1', 'referral', {
      kind: 'referral',
      referredUserId: 'user-2',
    });

    await expect(missions.reviewSubmission('admin-1', submission.id, { decision: 'approve' }))
      .rejects.toMatchObject({ code: 'REFERRAL_NOT_VERIFIED' });
    expect(store.rewards).toHaveLength(0);

    store.registerVerifiedReferral('user-1', 'user-2');
    await expect(missions.reviewSubmission('admin-1', submission.id, { decision: 'approve' }))
      .resolves.toMatchObject({ status: 'approved', rewardApplied: true, rewardSeconds: 900 });
    expect(store.rewards).toHaveLength(1);
  });
});
