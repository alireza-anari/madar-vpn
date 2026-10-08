import type { D1DatabaseLike, D1PreparedStatementLike } from '../auth/d1';
import { tehranDateKey } from '../credits';
import type {
  MissionDefinition,
  MissionEvidence,
  MissionReward,
  MissionStore,
  MissionSubmission,
  MissionVerificationKind,
} from './index';

type MissionRow = {
  id: string;
  title: string;
  reward_seconds: number;
  status: MissionDefinition['status'];
  verification_kind: MissionVerificationKind;
};

type SubmissionRow = {
  id: string;
  user_id: string;
  mission_id: string;
  evidence_json: string;
  status: MissionSubmission['status'];
  submitted_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
  rejection_reason: string | null;
};

type VerifiedReferralRow = { verified: number };
type InsertedRow = { unique_key: string };
type D1ListStatement = D1PreparedStatementLike & { all<T>(): Promise<{ results?: T[] }> };

async function allRows<T>(statement: D1PreparedStatementLike) {
  const result = await (statement as D1ListStatement).all<T>();
  return result.results ?? [];
}

function parseEvidence(value: string): MissionEvidence {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Stored mission evidence is invalid.');
  }
  const candidate = parsed as Record<string, unknown>;
  if (candidate.kind === 'text' && typeof candidate.value === 'string') {
    return { kind: 'text', value: candidate.value };
  }
  if (candidate.kind === 'referral' && typeof candidate.referredUserId === 'string') {
    return { kind: 'referral', referredUserId: candidate.referredUserId };
  }
  throw new Error('Stored mission evidence is invalid.');
}

function mapSubmission(row: SubmissionRow): MissionSubmission {
  return {
    id: row.id,
    userId: row.user_id,
    missionId: row.mission_id,
    evidence: parseEvidence(row.evidence_json),
    status: row.status,
    submittedAt: row.submitted_at,
    reviewedAt: row.reviewed_at,
    reviewedBy: row.reviewed_by,
    rejectionReason: row.rejection_reason,
  };
}

export class D1MissionStore implements MissionStore {
  constructor(private readonly db: D1DatabaseLike) {}

  async getMission(id: string) {
    const row = await this.db
      .prepare(
        `SELECT id, title, reward_seconds, status, verification_kind
         FROM missions
         WHERE id = ?
         LIMIT 1`,
      )
      .bind(id)
      .first<MissionRow>();
    if (!row) return null;
    return {
      id: row.id,
      title: row.title,
      rewardSeconds: row.reward_seconds,
      status: row.status,
      verificationKind: row.verification_kind,
    };
  }

  async saveSubmission(submission: MissionSubmission) {
    await this.db
      .prepare(
        `INSERT INTO mission_submissions (
           id, user_id, mission_id, evidence_json, status, submitted_at,
           reviewed_at, reviewed_by, rejection_reason
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        submission.id,
        submission.userId,
        submission.missionId,
        JSON.stringify(submission.evidence),
        submission.status,
        submission.submittedAt,
        submission.reviewedAt,
        submission.reviewedBy,
        submission.rejectionReason,
      )
      .run();
  }

  async getSubmission(id: string) {
    const row = await this.db
      .prepare(
        `SELECT id, user_id, mission_id, evidence_json, status, submitted_at,
                reviewed_at, reviewed_by, rejection_reason
         FROM mission_submissions
         WHERE id = ?
         LIMIT 1`,
      )
      .bind(id)
      .first<SubmissionRow>();
    return row ? mapSubmission(row) : null;
  }

  async listUserSubmissions(userId: string) {
    const rows = await allRows<SubmissionRow>(
      this.db
        .prepare(
          `SELECT id, user_id, mission_id, evidence_json, status, submitted_at,
                  reviewed_at, reviewed_by, rejection_reason
           FROM mission_submissions
           WHERE user_id = ?
           ORDER BY submitted_at DESC`,
        )
        .bind(userId),
    );
    return rows.map(mapSubmission);
  }

  async saveReviewedSubmission(submission: MissionSubmission) {
    await this.db
      .prepare(
        `UPDATE mission_submissions
         SET status = ?, reviewed_at = ?, reviewed_by = ?, rejection_reason = ?
         WHERE id = ?`,
      )
      .bind(
        submission.status,
        submission.reviewedAt,
        submission.reviewedBy,
        submission.rejectionReason,
        submission.id,
      )
      .run();
  }

  async hasVerifiedReferral(referrerUserId: string, referredUserId: string) {
    const row = await this.db
      .prepare(
        `SELECT 1 AS verified
         FROM verified_referrals
         WHERE referrer_user_id = ? AND referred_user_id = ?
         LIMIT 1`,
      )
      .bind(referrerUserId, referredUserId)
      .first<VerifiedReferralRow>();
    return row !== null;
  }

  async applyReward(reward: MissionReward) {
    const occurredAt = new Date(reward.appliedAt);
    const row = await this.db
      .prepare(
        `INSERT INTO credit_ledger (
           unique_key, user_id, kind, free_day, delta_seconds, occurred_at,
           node_id, session_id, sequence
         ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL)
         ON CONFLICT(unique_key) DO NOTHING
         RETURNING unique_key`,
      )
      .bind(
        `mission:${reward.submissionId}`,
        reward.userId,
        'mission',
        tehranDateKey(occurredAt),
        reward.rewardSeconds,
        occurredAt.toISOString(),
      )
      .first<InsertedRow>();
    return row !== null;
  }
}
