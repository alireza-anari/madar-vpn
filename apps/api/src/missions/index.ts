export type MissionVerificationKind = 'evidence' | 'referral';

export type MissionDefinition = {
  id: string;
  title: string;
  rewardSeconds: number;
  status: 'draft' | 'active' | 'paused';
  verificationKind: MissionVerificationKind;
};

export type MissionEvidence =
  | { kind: 'text'; value: string }
  | { kind: 'referral'; referredUserId: string };

export type MissionSubmission = {
  id: string;
  userId: string;
  missionId: string;
  evidence: MissionEvidence;
  status: 'pending' | 'approved' | 'rejected';
  submittedAt: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
  rejectionReason: string | null;
};

export type MissionReward = {
  submissionId: string;
  userId: string;
  rewardSeconds: number;
  appliedAt: string;
};

export interface MissionStore {
  getMission(id: string): Promise<MissionDefinition | null>;
  saveSubmission(submission: MissionSubmission): Promise<void>;
  getSubmission(id: string): Promise<MissionSubmission | null>;
  listUserSubmissions(userId: string): Promise<MissionSubmission[]>;
  saveReviewedSubmission(submission: MissionSubmission): Promise<void>;
  hasVerifiedReferral(referrerUserId: string, referredUserId: string): Promise<boolean>;
  applyReward(reward: MissionReward): Promise<boolean>;
}

export class MissionError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'MissionError';
  }
}

export class MemoryMissionStore implements MissionStore {
  readonly missions = new Map<string, MissionDefinition>();
  readonly submissions = new Map<string, MissionSubmission>();
  readonly rewards: MissionReward[] = [];
  private readonly rewardKeys = new Set<string>();
  private readonly verifiedReferrals = new Set<string>();

  seedMission(mission: MissionDefinition) {
    this.missions.set(mission.id, { ...mission });
  }

  registerVerifiedReferral(referrerUserId: string, referredUserId: string) {
    this.verifiedReferrals.add(`${referrerUserId}:${referredUserId}`);
  }

  async getMission(id: string) {
    const mission = this.missions.get(id);
    return mission ? { ...mission } : null;
  }

  async saveSubmission(submission: MissionSubmission) {
    this.submissions.set(submission.id, structuredClone(submission));
  }

  async getSubmission(id: string) {
    const submission = this.submissions.get(id);
    return submission ? structuredClone(submission) : null;
  }

  async listUserSubmissions(userId: string) {
    return [...this.submissions.values()]
      .filter((submission) => submission.userId === userId)
      .map((submission) => structuredClone(submission));
  }

  async saveReviewedSubmission(submission: MissionSubmission) {
    this.submissions.set(submission.id, structuredClone(submission));
  }

  async hasVerifiedReferral(referrerUserId: string, referredUserId: string) {
    return this.verifiedReferrals.has(`${referrerUserId}:${referredUserId}`);
  }

  async applyReward(reward: MissionReward) {
    if (this.rewardKeys.has(reward.submissionId)) return false;
    this.rewardKeys.add(reward.submissionId);
    this.rewards.push({ ...reward });
    return true;
  }
}

function validId(value: string) {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(value);
}

function validateEvidence(userId: string, verificationKind: MissionVerificationKind, input: unknown): MissionEvidence {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new MissionError(400, 'EVIDENCE_INVALID', 'Mission evidence is invalid.');
  }
  const candidate = input as Record<string, unknown>;
  if (verificationKind === 'evidence') {
    if (candidate.kind !== 'text' || typeof candidate.value !== 'string') {
      throw new MissionError(400, 'EVIDENCE_INVALID', 'Mission evidence is invalid.');
    }
    const value = candidate.value.trim();
    if (!value || value.length > 2000) {
      throw new MissionError(400, 'EVIDENCE_INVALID', 'Mission evidence is invalid.');
    }
    return { kind: 'text', value };
  }

  if (candidate.kind !== 'referral' || typeof candidate.referredUserId !== 'string') {
    throw new MissionError(400, 'EVIDENCE_INVALID', 'Referral evidence is invalid.');
  }
  const referredUserId = candidate.referredUserId.trim();
  if (!validId(referredUserId) || referredUserId === userId) {
    throw new MissionError(400, 'EVIDENCE_INVALID', 'Referral evidence is invalid.');
  }
  return { kind: 'referral', referredUserId };
}

export function createMissionService(options: {
  store: MissionStore;
  now?: () => Date;
  randomId?: () => string;
}) {
  const now = options.now ?? (() => new Date());
  const randomId = options.randomId ?? (() => crypto.randomUUID());

  return {
    async submitEvidence(userId: string, missionId: string, evidenceInput: unknown) {
      if (!validId(userId) || !validId(missionId)) {
        throw new MissionError(400, 'EVIDENCE_INVALID', 'Mission submission identifiers are invalid.');
      }
      const mission = await options.store.getMission(missionId);
      if (!mission || mission.status !== 'active') {
        throw new MissionError(404, 'MISSION_NOT_AVAILABLE', 'Mission is not available.');
      }
      const evidence = validateEvidence(userId, mission.verificationKind, evidenceInput);
      const submission: MissionSubmission = {
        id: randomId(),
        userId,
        missionId,
        evidence,
        status: 'pending',
        submittedAt: now().toISOString(),
        reviewedAt: null,
        reviewedBy: null,
        rejectionReason: null,
      };
      await options.store.saveSubmission(submission);
      return structuredClone(submission);
    },

    async getUserStatus(userId: string) {
      if (!validId(userId)) throw new MissionError(400, 'USER_INVALID', 'User id is invalid.');
      return options.store.listUserSubmissions(userId);
    },

    async reviewSubmission(
      adminUserId: string,
      submissionId: string,
      input: { decision: 'approve' | 'reject'; reason?: string },
    ) {
      if (!validId(adminUserId) || !validId(submissionId) || !input || !['approve', 'reject'].includes(input.decision)) {
        throw new MissionError(400, 'REVIEW_INVALID', 'Mission review is invalid.');
      }
      const submission = await options.store.getSubmission(submissionId);
      if (!submission) throw new MissionError(404, 'SUBMISSION_NOT_FOUND', 'Mission submission was not found.');
      const mission = await options.store.getMission(submission.missionId);
      if (!mission) throw new MissionError(404, 'MISSION_NOT_AVAILABLE', 'Mission is not available.');

      if (submission.status !== 'pending') {
        return {
          status: submission.status,
          rewardApplied: false,
          rewardSeconds: mission.rewardSeconds,
        };
      }

      const reviewedAt = now().toISOString();
      if (input.decision === 'reject') {
        const reason = input.reason?.trim() ?? '';
        if (!reason || reason.length > 500) {
          throw new MissionError(400, 'REVIEW_INVALID', 'A rejection reason is required.');
        }
        await options.store.saveReviewedSubmission({
          ...submission,
          status: 'rejected',
          reviewedAt,
          reviewedBy: adminUserId,
          rejectionReason: reason,
        });
        return { status: 'rejected' as const, rewardApplied: false, rewardSeconds: mission.rewardSeconds };
      }

      if (mission.verificationKind === 'referral') {
        if (submission.evidence.kind !== 'referral') {
          throw new MissionError(400, 'EVIDENCE_INVALID', 'Referral evidence is invalid.');
        }
        const verified = await options.store.hasVerifiedReferral(submission.userId, submission.evidence.referredUserId);
        if (!verified) {
          throw new MissionError(409, 'REFERRAL_NOT_VERIFIED', 'Referral relationship is not verified.');
        }
      }

      const rewardApplied = await options.store.applyReward({
        submissionId: submission.id,
        userId: submission.userId,
        rewardSeconds: mission.rewardSeconds,
        appliedAt: reviewedAt,
      });
      await options.store.saveReviewedSubmission({
        ...submission,
        status: 'approved',
        reviewedAt,
        reviewedBy: adminUserId,
        rejectionReason: null,
      });
      return { status: 'approved' as const, rewardApplied, rewardSeconds: mission.rewardSeconds };
    },
  };
}
