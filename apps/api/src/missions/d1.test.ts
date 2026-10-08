import { describe, expect, it } from 'vitest';
import type { D1DatabaseLike } from '../auth/d1';
import type { MissionSubmission } from './index';
import { D1MissionStore } from './d1';

class FakeStatement {
  bound: unknown[] = [];

  constructor(readonly sql: string, private readonly db: FakeD1) {}

  bind(...values: unknown[]) {
    this.bound = values;
    return this;
  }

  async run() {
    this.db.executed.push({ sql: this.sql, values: this.bound, mode: 'run' as const });
    return { success: true };
  }

  async first<T>() {
    this.db.executed.push({ sql: this.sql, values: this.bound, mode: 'first' as const });
    return (this.db.firstResults.shift() ?? null) as T | null;
  }

  async all<T>() {
    this.db.executed.push({ sql: this.sql, values: this.bound, mode: 'all' as const });
    return { results: (this.db.allResults.shift() ?? []) as T[] };
  }
}

class FakeD1 implements D1DatabaseLike {
  readonly executed: Array<{ sql: string; values: unknown[]; mode: 'run' | 'first' | 'all' }> = [];
  readonly firstResults: unknown[] = [];
  readonly allResults: unknown[][] = [];

  prepare(sql: string) {
    return new FakeStatement(sql, this);
  }
}

const submission: MissionSubmission = {
  id: 'submission-1',
  userId: 'user-1',
  missionId: 'referral',
  evidence: { kind: 'referral', referredUserId: 'user-2' },
  status: 'pending',
  submittedAt: '2026-10-08T09:00:00.000Z',
  reviewedAt: null,
  reviewedBy: null,
  rejectionReason: null,
};

describe('D1MissionStore', () => {
  it('reads admin-defined verification metadata and persists user submission/status', async () => {
    const db = new FakeD1();
    const store = new D1MissionStore(db);
    db.firstResults.push({
      id: 'referral',
      title: 'دعوت تأییدشده',
      reward_seconds: 900,
      status: 'active',
      verification_kind: 'referral',
    });

    await expect(store.getMission('referral')).resolves.toEqual({
      id: 'referral',
      title: 'دعوت تأییدشده',
      rewardSeconds: 900,
      status: 'active',
      verificationKind: 'referral',
    });
    await store.saveSubmission(submission);

    db.allResults.push([{
      id: 'submission-1',
      user_id: 'user-1',
      mission_id: 'referral',
      evidence_json: JSON.stringify(submission.evidence),
      status: 'pending',
      submitted_at: '2026-10-08T09:00:00.000Z',
      reviewed_at: null,
      reviewed_by: null,
      rejection_reason: null,
    }]);
    await expect(store.listUserSubmissions('user-1')).resolves.toEqual([submission]);

    expect(db.executed[0]!.sql).toMatch(/FROM\s+missions/i);
    expect(db.executed[0]!.sql).toMatch(/verification_kind/i);
    expect(db.executed[1]!.sql).toMatch(/INSERT\s+INTO\s+mission_submissions/i);
    expect(db.executed[2]!.sql).toMatch(/FROM\s+mission_submissions/i);
    expect(db.executed[2]!.values).toEqual(['user-1']);
  });

  it('requires a verified referral row and settles reward idempotently into the shared credit ledger', async () => {
    const db = new FakeD1();
    const store = new D1MissionStore(db);
    db.firstResults.push({ verified: 1 }, { unique_key: 'mission:submission-1' }, null);

    await expect(store.hasVerifiedReferral('user-1', 'user-2')).resolves.toBe(true);
    await expect(store.applyReward({
      submissionId: 'submission-1',
      userId: 'user-1',
      rewardSeconds: 900,
      appliedAt: '2026-10-08T09:00:00.000Z',
    })).resolves.toBe(true);
    await expect(store.applyReward({
      submissionId: 'submission-1',
      userId: 'user-1',
      rewardSeconds: 900,
      appliedAt: '2026-10-08T09:00:00.000Z',
    })).resolves.toBe(false);

    expect(db.executed[0]!.sql).toMatch(/FROM\s+verified_referrals/i);
    expect(db.executed[0]!.values).toEqual(['user-1', 'user-2']);
    const rewards = db.executed.filter((entry) => /INSERT\s+INTO\s+credit_ledger/i.test(entry.sql));
    expect(rewards).toHaveLength(2);
    for (const reward of rewards) {
      expect(reward.sql).toMatch(/ON\s+CONFLICT\s*\(unique_key\)\s+DO\s+NOTHING/i);
      expect(reward.sql).toMatch(/RETURNING\s+unique_key/i);
      expect(reward.values.slice(0, 6)).toEqual([
        'mission:submission-1',
        'user-1',
        'mission',
        '2026-10-08',
        900,
        '2026-10-08T09:00:00.000Z',
      ]);
    }
  });
});
