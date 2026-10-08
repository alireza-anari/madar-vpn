import type { AuthStore, User } from './index';

export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  run(): Promise<unknown>;
  first<T>(): Promise<T | null>;
}

export interface D1DatabaseLike {
  prepare(sql: string): D1PreparedStatementLike;
}

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

type LoginTokenRow = {
  token_hash: string;
  email: string;
  expires_at: string;
  used_at: string | null;
};

type UserRow = {
  id: string;
  email: string;
  role: 'user' | 'admin';
  verified_at: string;
};

type SessionRow = {
  id: string;
  user_id: string;
  token_hash: string;
  csrf_token_hash: string;
  created_at: string;
  expires_at: string;
};

function mapLoginToken(row: LoginTokenRow | null): LoginTokenRecord | null {
  if (!row) return null;
  return {
    tokenHash: row.token_hash,
    email: row.email,
    expiresAt: row.expires_at,
    usedAt: row.used_at,
  };
}

function mapUser(row: UserRow | null): User | null {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    verifiedAt: row.verified_at,
  };
}

function mapSession(row: SessionRow | null): StoredSession | null {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    tokenHash: row.token_hash,
    csrfTokenHash: row.csrf_token_hash,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

export class D1AuthStore implements AuthStore {
  constructor(private readonly db: D1DatabaseLike) {}

  async saveLoginToken(record: LoginTokenRecord) {
    await this.db
      .prepare(
        `INSERT INTO login_tokens (token_hash, email, expires_at, used_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(token_hash) DO UPDATE SET
           email = excluded.email,
           expires_at = excluded.expires_at,
           used_at = excluded.used_at`,
      )
      .bind(record.tokenHash, record.email, record.expiresAt, record.usedAt)
      .run();
  }

  async consumeLoginToken(tokenHash: string, now: Date) {
    const timestamp = now.toISOString();
    const row = await this.db
      .prepare(
        `UPDATE login_tokens
         SET used_at = ?
         WHERE token_hash = ?
           AND used_at IS NULL
           AND expires_at > ?
         RETURNING token_hash, email, expires_at, used_at`,
      )
      .bind(timestamp, tokenHash, timestamp)
      .first<LoginTokenRow>();
    return mapLoginToken(row);
  }

  async findUserByEmail(email: string) {
    const row = await this.db
      .prepare('SELECT id, email, role, verified_at FROM users WHERE email = ? COLLATE NOCASE LIMIT 1')
      .bind(email)
      .first<UserRow>();
    return mapUser(row);
  }

  async findUserById(id: string) {
    const row = await this.db
      .prepare('SELECT id, email, role, verified_at FROM users WHERE id = ? LIMIT 1')
      .bind(id)
      .first<UserRow>();
    return mapUser(row);
  }

  async saveUser(user: User) {
    await this.db
      .prepare(
        `INSERT INTO users (id, email, role, verified_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           email = excluded.email,
           role = excluded.role,
           verified_at = excluded.verified_at`,
      )
      .bind(user.id, user.email, user.role, user.verifiedAt)
      .run();
  }

  async saveSession(session: StoredSession) {
    await this.db
      .prepare(
        `INSERT INTO sessions (id, user_id, token_hash, csrf_token_hash, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        session.id,
        session.userId,
        session.tokenHash,
        session.csrfTokenHash,
        session.createdAt,
        session.expiresAt,
      )
      .run();
  }

  async findSessionByTokenHash(tokenHash: string, now: Date) {
    const row = await this.db
      .prepare(
        `SELECT id, user_id, token_hash, csrf_token_hash, created_at, expires_at
         FROM sessions
         WHERE token_hash = ? AND expires_at > ?
         LIMIT 1`,
      )
      .bind(tokenHash, now.toISOString())
      .first<SessionRow>();
    return mapSession(row);
  }
}
