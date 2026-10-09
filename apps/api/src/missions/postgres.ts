import type { PgDatabase } from '../postgres/client';
import { tehranDateKey } from '../credits';
import type {
  MissionDefinition,
  MissionEvidence,
  MissionReward,
  MissionStore,
  MissionSubmission,
  MissionVerificationKind,
} from './index';

type QueryDatabase = Pick<PgDatabase, 'query'>;

type MissionRow = Record<string, unknown> & {
  id: string;
  title: string;
  reward_seconds: number;
  status: MissionDefinition['status'];
  verification_kind: MissionVerificationKind;
};

type SubmissionRow = Record<string, unknown> & {
  id: string;
  user_id: string;
  mission_id: string;
  evidence_json: unknown;
  status: MissionSubmission['status'];
  submitted_at: Date | string;
  reviewed_at: Date | string | null;
  reviewed_by: string | null;
  rejection_reason: string | null;
};

type InsertedRow = Record<string, unknown> & { unique_key: string };

type VerifiedReferralRow = Record<string, unknown> & { verified: number };

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toNullableIso(value: Date | string | null): string | null {
  return value === null ? null : toIso(value);
}

function parseEvidence(value: unknown): MissionEvidence {
  const parsed = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
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
    submittedAt: toIso(row.submitted_at),
    reviewedAt: toNullableIso(row.reviewed_at),
    reviewedBy: row.reviewed_by,
    rejectionReason: row.rejection_reason,
  };
}

export class PostgresMissionStore implements MissionStore {
  constructor(private readonly db: QueryDatabase) {}

  async getMission(id: string) {
    const result = await this.db.query<MissionRow>(
      `SELECT id, title, reward_seconds, status, verification_kind
       FROM missions
       WHERE id = $1
       LIMIT 1`,
      [id],
    );
    const row = result.rows[0];
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
    await this.db.query(
      `INSERT INTO mission_submissions (
         id, user_id, mission_id, evidence_json, status, submitted_at,
         reviewed_at, reviewed_by, rejection_reason
       ) VALUES ($1, $2, $3, $4::jsonb, $5, $6::timestamptz, $7::timestamptz, $8, $9)`,
      [
        submission.id,
        submission.userId,
        submission.missionId,
        JSON.stringify(submission.evidence),
        submission.status,
        submission.submittedAt,
        submission.reviewedAt,
        submission.reviewedBy,
        submission.rejectionReason,
      ],
    );
  }

  async getSubmission(id: string) {
    const result = await this.db.query<SubmissionRow>(
      `SELECT id, user_id, mission_id, evidence_json, status, submitted_at,
              reviewed_at, reviewed_by, rejection_reason
       FROM mission_submissions
       WHERE id = $1
       LIMIT 1`,
      [id],
    );
    const row = result.rows[0];
    return row ? mapSubmission(row) : null;
  }

  async listUserSubmissions(userId: string) {
    const result = await this.db.query<SubmissionRow>(
      `SELECT id, user_id, mission_id, evidence_json, status, submitted_at,
              reviewed_at, reviewed_by, rejection_reason
       FROM mission_submissions
       WHERE user_id = $1
       ORDER BY submitted_at DESC`,
      [userId],
    );
    return result.rows.map(mapSubmission);
  }

  async saveReviewedSubmission(submission: MissionSubmission) {
    await this.db.query(
      `UPDATE mission_submissions
       SET status = $2,
           reviewed_at = $3::timestamptz,
           reviewed_by = $4,
           rejection_reason = $5
       WHERE id = $1`,
      [
        submission.id,
        submission.status,
        submission.reviewedAt,
        submission.reviewedBy,
        submission.rejectionReason,
      ],
    );
  }

  async hasVerifiedReferral(referrerUserId: string, referredUserId: string) {
    const result = await this.db.query<VerifiedReferralRow>(
      `SELECT 1 AS verified
       FROM verified_referrals
       WHERE referrer_user_id = $1
         AND referred_user_id = $2
       LIMIT 1`,
      [referrerUserId, referredUserId],
    );
    return result.rows.length > 0;
  }

  async applyReward(reward: MissionReward) {
    const occurredAt = new Date(reward.appliedAt);
    const result = await this.db.query<InsertedRow>(
      `INSERT INTO credit_ledger (
         unique_key, user_id, kind, free_day, delta_seconds, occurred_at,
         node_id, session_id, sequence
       ) VALUES ($1, $2, 'mission', $3::date, $4, $5::timestamptz, NULL, NULL, NULL)
       ON CONFLICT (unique_key) DO NOTHING
       RETURNING unique_key`,
      [
        `mission:${reward.submissionId}`,
        reward.userId,
        tehranDateKey(occurredAt),
        reward.rewardSeconds,
        occurredAt.toISOString(),
      ],
    );
    return result.rows.length > 0;
  }
}
