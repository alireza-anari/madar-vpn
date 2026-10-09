import type { PgDatabase } from '../postgres/client';
import type { AccessProfile, AccessStore, ClientCredential, SubscriptionTokenRecord } from './index';

type QueryDatabase = Pick<PgDatabase, 'query' | 'transaction'>;

type AccessProfileRow = Record<string, unknown> & {
  id: string;
  user_id: string;
  policy_revision: number;
  created_at: Date | string;
};

type ClientCredentialRow = Record<string, unknown> & {
  id: string;
  user_id: string;
  uuid: string;
  version: number;
  created_at: Date | string;
  revoked_at: Date | string | null;
};

type SubscriptionTokenRow = Record<string, unknown> & {
  id: string;
  user_id: string;
  token_hash: string;
  version: number;
  created_at: Date | string;
  revoked_at: Date | string | null;
};

type VersionRow = Record<string, unknown> & { next_version: number };

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toNullableIso(value: Date | string | null): string | null {
  return value === null ? null : toIso(value);
}

function mapProfile(row: AccessProfileRow | undefined): AccessProfile | null {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    policyRevision: row.policy_revision,
    createdAt: toIso(row.created_at),
  };
}

function mapCredential(row: ClientCredentialRow | undefined): ClientCredential | null {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    uuid: row.uuid,
    version: row.version,
    createdAt: toIso(row.created_at),
    revokedAt: toNullableIso(row.revoked_at),
  };
}

function mapSubscriptionToken(row: SubscriptionTokenRow | undefined): SubscriptionTokenRecord | null {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    tokenHash: row.token_hash,
    version: row.version,
    createdAt: toIso(row.created_at),
    revokedAt: toNullableIso(row.revoked_at),
  };
}

export class PostgresAccessStore implements AccessStore {
  constructor(private readonly db: QueryDatabase) {}

  async ensureProfile(candidate: AccessProfile) {
    const result = await this.db.query<AccessProfileRow>(
      `INSERT INTO access_profiles (id, user_id, policy_revision, created_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id
       RETURNING id, user_id, policy_revision, created_at`,
      [candidate.id, candidate.userId, candidate.policyRevision, candidate.createdAt],
    );
    const profile = mapProfile(result.rows[0]);
    if (!profile) throw new Error('Access profile could not be ensured.');
    return profile;
  }

  async getProfile(userId: string) {
    const result = await this.db.query<AccessProfileRow>(
      `SELECT id, user_id, policy_revision, created_at
       FROM access_profiles
       WHERE user_id = $1
       LIMIT 1`,
      [userId],
    );
    return mapProfile(result.rows[0]);
  }

  async ensureActiveClientCredential(candidate: ClientCredential) {
    const result = await this.db.query<ClientCredentialRow>(
      `INSERT INTO client_credentials (
         id, user_id, uuid, version, created_at, revoked_at
       ) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id) WHERE revoked_at IS NULL
       DO UPDATE SET user_id = EXCLUDED.user_id
       RETURNING id, user_id, uuid, version, created_at, revoked_at`,
      [
        candidate.id,
        candidate.userId,
        candidate.uuid,
        candidate.version,
        candidate.createdAt,
        candidate.revokedAt,
      ],
    );
    const credential = mapCredential(result.rows[0]);
    if (!credential) throw new Error('Active client credential could not be ensured.');
    return credential;
  }

  async getActiveClientCredential(userId: string) {
    const result = await this.db.query<ClientCredentialRow>(
      `SELECT id, user_id, uuid, version, created_at, revoked_at
       FROM client_credentials
       WHERE user_id = $1 AND revoked_at IS NULL
       LIMIT 1`,
      [userId],
    );
    return mapCredential(result.rows[0]);
  }

  async issueSubscriptionToken(candidate: Omit<SubscriptionTokenRecord, 'version' | 'revokedAt'>) {
    return this.db.transaction(async (transaction) => {
      const lock = await transaction.query<Record<string, unknown> & { id: string }>(
        'SELECT id FROM users WHERE id = $1 FOR UPDATE',
        [candidate.userId],
      );
      if (!lock.rows[0]) throw new Error('Subscription user does not exist.');

      const versionResult = await transaction.query<VersionRow>(
        `SELECT COALESCE(MAX(version), 0) + 1 AS next_version
         FROM subscription_tokens
         WHERE user_id = $1`,
        [candidate.userId],
      );
      const nextVersion = versionResult.rows[0]?.next_version;
      if (typeof nextVersion !== 'number') throw new Error('Subscription token version could not be allocated.');

      await transaction.query(
        `UPDATE subscription_tokens
         SET revoked_at = $2
         WHERE user_id = $1 AND revoked_at IS NULL`,
        [candidate.userId, candidate.createdAt],
      );

      const result = await transaction.query<SubscriptionTokenRow>(
        `INSERT INTO subscription_tokens (
           id, user_id, token_hash, version, created_at, revoked_at
         ) VALUES ($1, $2, $3, $4, $5, NULL)
         RETURNING id, user_id, token_hash, version, created_at, revoked_at`,
        [candidate.id, candidate.userId, candidate.tokenHash, nextVersion, candidate.createdAt],
      );
      const token = mapSubscriptionToken(result.rows[0]);
      if (!token) throw new Error('Subscription token could not be issued.');
      return token;
    });
  }

  async getActiveSubscriptionToken(userId: string) {
    const result = await this.db.query<SubscriptionTokenRow>(
      `SELECT id, user_id, token_hash, version, created_at, revoked_at
       FROM subscription_tokens
       WHERE user_id = $1 AND revoked_at IS NULL
       LIMIT 1`,
      [userId],
    );
    return mapSubscriptionToken(result.rows[0]);
  }

  async findActiveSubscriptionTokenByHash(tokenHash: string) {
    const result = await this.db.query<SubscriptionTokenRow>(
      `SELECT id, user_id, token_hash, version, created_at, revoked_at
       FROM subscription_tokens
       WHERE token_hash = $1 AND revoked_at IS NULL
       LIMIT 1`,
      [tokenHash],
    );
    return mapSubscriptionToken(result.rows[0]);
  }
}
