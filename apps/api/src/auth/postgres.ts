import type { AuthStore, User } from './index';
import type { PgDatabase } from '../postgres/client';

type LoginTokenRecord = {
  tokenHash: string;
  email: string;
  expiresAt: string;
  usedAt: string | null;
};

type StoredSession = {
  id: string;
  userId: string;
  tokenHash: string;
  csrfTokenHash: string;
  expiresAt: string;
  createdAt: string;
};

type LoginTokenRow = Record<string, unknown> & {
  token_hash: string;
  email: string;
  expires_at: Date | string;
  used_at: Date | string | null;
};

type UserRow = Record<string, unknown> & {
  id: string;
  email: string;
  role: 'user' | 'admin';
  verified_at: Date | string;
  suspended_at: Date | string | null;
};

type SessionRow = Record<string, unknown> & {
  id: string;
  user_id: string;
  token_hash: string;
  csrf_token_hash: string;
  created_at: Date | string;
  expires_at: Date | string;
};

type QueryDatabase = Pick<PgDatabase, 'query'>;

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toNullableIso(value: Date | string | null): string | null {
  return value === null ? null : toIso(value);
}

function mapLoginToken(row: LoginTokenRow | undefined): LoginTokenRecord | null {
  if (!row) return null;
  return {
    tokenHash: row.token_hash,
    email: row.email,
    expiresAt: toIso(row.expires_at),
    usedAt: toNullableIso(row.used_at),
  };
}

function mapUser(row: UserRow | undefined): User | null {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    verifiedAt: toIso(row.verified_at),
    suspendedAt: toNullableIso(row.suspended_at),
  };
}

function mapSession(row: SessionRow | undefined): StoredSession | null {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    tokenHash: row.token_hash,
    csrfTokenHash: row.csrf_token_hash,
    createdAt: toIso(row.created_at),
    expiresAt: toIso(row.expires_at),
  };
}

export class PostgresAuthStore implements AuthStore {
  constructor(private readonly db: QueryDatabase) {}

  async saveLoginToken(record: LoginTokenRecord) {
    await this.db.query(
      `INSERT INTO login_tokens (token_hash, email, expires_at, used_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (token_hash) DO UPDATE SET
         email = EXCLUDED.email,
         expires_at = EXCLUDED.expires_at,
         used_at = EXCLUDED.used_at`,
      [record.tokenHash, record.email, record.expiresAt, record.usedAt],
    );
  }

  async consumeLoginToken(tokenHash: string, now: Date) {
    const timestamp = now.toISOString();
    const result = await this.db.query<LoginTokenRow>(
      `UPDATE login_tokens
       SET used_at = $2
       WHERE token_hash = $1
         AND used_at IS NULL
         AND expires_at > $2
       RETURNING token_hash, email, expires_at, used_at`,
      [tokenHash, timestamp],
    );
    return mapLoginToken(result.rows[0]);
  }

  async findUserByEmail(email: string) {
    const result = await this.db.query<UserRow>(
      `SELECT id, email, role, verified_at, suspended_at
       FROM users
       WHERE lower(email) = lower($1)
       LIMIT 1`,
      [email],
    );
    return mapUser(result.rows[0]);
  }

  async findUserById(id: string) {
    const result = await this.db.query<UserRow>(
      `SELECT id, email, role, verified_at, suspended_at
       FROM users
       WHERE id = $1
       LIMIT 1`,
      [id],
    );
    return mapUser(result.rows[0]);
  }

  async saveUser(user: User) {
    await this.db.query(
      `INSERT INTO users (id, email, role, verified_at, suspended_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET
         email = EXCLUDED.email,
         role = EXCLUDED.role,
         verified_at = EXCLUDED.verified_at,
         suspended_at = EXCLUDED.suspended_at`,
      [user.id, user.email, user.role, user.verifiedAt, user.suspendedAt ?? null],
    );
  }

  async setUserSuspended(userId: string, suspended: boolean, changedAt: string) {
    const result = await this.db.query<UserRow>(
      `UPDATE users
       SET suspended_at = CASE WHEN $1 THEN $2::timestamptz ELSE NULL END
       WHERE id = $3
         AND (($1 = true AND suspended_at IS NULL)
           OR ($1 = false AND suspended_at IS NOT NULL))
       RETURNING id, email, role, verified_at, suspended_at`,
      [suspended, changedAt, userId],
    );
    const changedUser = mapUser(result.rows[0]);
    if (changedUser) return { user: changedUser, changed: true };
    const existing = await this.findUserById(userId);
    return existing ? { user: existing, changed: false } : null;
  }

  async saveSession(session: StoredSession) {
    await this.db.query(
      `INSERT INTO sessions (id, user_id, token_hash, csrf_token_hash, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        session.id,
        session.userId,
        session.tokenHash,
        session.csrfTokenHash,
        session.createdAt,
        session.expiresAt,
      ],
    );
  }

  async findSessionByTokenHash(tokenHash: string, now: Date) {
    const result = await this.db.query<SessionRow>(
      `SELECT id, user_id, token_hash, csrf_token_hash, created_at, expires_at
       FROM sessions
       WHERE token_hash = $1
         AND expires_at > $2
       LIMIT 1`,
      [tokenHash, now.toISOString()],
    );
    return mapSession(result.rows[0]);
  }

  async replaceSessionCsrfHash(tokenHash: string, csrfTokenHash: string) {
    await this.db.query(
      `UPDATE sessions
       SET csrf_token_hash = $2
       WHERE token_hash = $1`,
      [tokenHash, csrfTokenHash],
    );
  }

  async revokeSessionByTokenHash(tokenHash: string) {
    await this.db.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
  }
}