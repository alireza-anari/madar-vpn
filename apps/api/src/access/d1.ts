import type { D1DatabaseLike } from '../auth/d1';
import type { AccessProfile, AccessStore, ClientCredential, SubscriptionTokenRecord } from './index';

type AccessProfileRow = {
  id: string;
  user_id: string;
  policy_revision: number;
  created_at: string;
};

type ClientCredentialRow = {
  id: string;
  user_id: string;
  uuid: string;
  version: number;
  created_at: string;
  revoked_at: string | null;
};

type SubscriptionTokenRow = {
  id: string;
  user_id: string;
  token_hash: string;
  version: number;
  created_at: string;
  revoked_at: string | null;
};

function mapProfile(row: AccessProfileRow | null): AccessProfile | null {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    policyRevision: row.policy_revision,
    createdAt: row.created_at,
  };
}

function mapCredential(row: ClientCredentialRow | null): ClientCredential | null {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    uuid: row.uuid,
    version: row.version,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}

function mapSubscriptionToken(row: SubscriptionTokenRow | null): SubscriptionTokenRecord | null {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    tokenHash: row.token_hash,
    version: row.version,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}

export class D1AccessStore implements AccessStore {
  constructor(private readonly db: D1DatabaseLike) {}

  async ensureProfile(candidate: AccessProfile) {
    const row = await this.db
      .prepare(
        `INSERT INTO access_profiles (id, user_id, policy_revision, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET user_id = excluded.user_id
         RETURNING id, user_id, policy_revision, created_at`,
      )
      .bind(candidate.id, candidate.userId, candidate.policyRevision, candidate.createdAt)
      .first<AccessProfileRow>();
    const profile = mapProfile(row);
    if (!profile) throw new Error('Access profile could not be ensured.');
    return profile;
  }

  async getProfile(userId: string) {
    const row = await this.db
      .prepare(
        `SELECT id, user_id, policy_revision, created_at
         FROM access_profiles
         WHERE user_id = ?
         LIMIT 1`,
      )
      .bind(userId)
      .first<AccessProfileRow>();
    return mapProfile(row);
  }

  async ensureActiveClientCredential(candidate: ClientCredential) {
    const row = await this.db
      .prepare(
        `INSERT INTO client_credentials (
           id, user_id, uuid, version, created_at, revoked_at
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id) WHERE revoked_at IS NULL
         DO UPDATE SET user_id = excluded.user_id
         RETURNING id, user_id, uuid, version, created_at, revoked_at`,
      )
      .bind(
        candidate.id,
        candidate.userId,
        candidate.uuid,
        candidate.version,
        candidate.createdAt,
        candidate.revokedAt,
      )
      .first<ClientCredentialRow>();
    const credential = mapCredential(row);
    if (!credential) throw new Error('Active client credential could not be ensured.');
    return credential;
  }

  async getActiveClientCredential(userId: string) {
    const row = await this.db
      .prepare(
        `SELECT id, user_id, uuid, version, created_at, revoked_at
         FROM client_credentials
         WHERE user_id = ? AND revoked_at IS NULL
         LIMIT 1`,
      )
      .bind(userId)
      .first<ClientCredentialRow>();
    return mapCredential(row);
  }

  async issueSubscriptionToken(candidate: Omit<SubscriptionTokenRecord, 'version' | 'revokedAt'>) {
    const row = await this.db
      .prepare(
        `INSERT INTO subscription_tokens (
           id, user_id, token_hash, version, created_at, revoked_at
         ) VALUES (
           ?, ?, ?,
           (SELECT COALESCE(MAX(version), 0) + 1 FROM subscription_tokens WHERE user_id = ?),
           ?, NULL
         )
         RETURNING id, user_id, token_hash, version, created_at, revoked_at`,
      )
      .bind(candidate.id, candidate.userId, candidate.tokenHash, candidate.userId, candidate.createdAt)
      .first<SubscriptionTokenRow>();
    const token = mapSubscriptionToken(row);
    if (!token) throw new Error('Subscription token could not be issued.');
    return token;
  }

  async getActiveSubscriptionToken(userId: string) {
    const row = await this.db
      .prepare(
        `SELECT id, user_id, token_hash, version, created_at, revoked_at
         FROM subscription_tokens
         WHERE user_id = ? AND revoked_at IS NULL
         LIMIT 1`,
      )
      .bind(userId)
      .first<SubscriptionTokenRow>();
    return mapSubscriptionToken(row);
  }

  async findActiveSubscriptionTokenByHash(tokenHash: string) {
    const row = await this.db
      .prepare(
        `SELECT id, user_id, token_hash, version, created_at, revoked_at
         FROM subscription_tokens
         WHERE token_hash = ? AND revoked_at IS NULL
         LIMIT 1`,
      )
      .bind(tokenHash)
      .first<SubscriptionTokenRow>();
    return mapSubscriptionToken(row);
  }
}
