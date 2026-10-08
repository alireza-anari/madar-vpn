export type UserRole = 'user' | 'admin';

export type User = {
  id: string;
  email: string;
  role: UserRole;
  verifiedAt: string;
};

export type Session = {
  id: string;
  userId: string;
  expiresAt: string;
  token: string;
  csrfToken: string;
};

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

export interface AuthStore {
  saveLoginToken(record: LoginTokenRecord): Promise<void>;
  consumeLoginToken(tokenHash: string, now: Date): Promise<LoginTokenRecord | null>;
  findUserByEmail(email: string): Promise<User | null>;
  findUserById(id: string): Promise<User | null>;
  saveUser(user: User): Promise<void>;
  saveSession(session: StoredSession): Promise<void>;
  findSessionByTokenHash(tokenHash: string, now: Date): Promise<StoredSession | null>;
}

export class MemoryAuthStore implements AuthStore {
  readonly loginTokens = new Map<string, LoginTokenRecord>();
  readonly sessions = new Map<string, StoredSession>();
  readonly users = new Map<string, User>();

  async saveLoginToken(record: LoginTokenRecord) {
    this.loginTokens.set(record.tokenHash, { ...record });
  }

  async consumeLoginToken(tokenHash: string, now: Date) {
    const record = this.loginTokens.get(tokenHash);
    if (!record || record.usedAt !== null || new Date(record.expiresAt).getTime() <= now.getTime()) {
      return null;
    }

    const consumed = { ...record, usedAt: now.toISOString() };
    this.loginTokens.set(tokenHash, consumed);
    return { ...consumed };
  }

  async findUserByEmail(email: string) {
    return [...this.users.values()].find((user) => user.email === email) ?? null;
  }

  async findUserById(id: string) {
    return this.users.get(id) ?? null;
  }

  async saveUser(user: User) {
    this.users.set(user.id, { ...user });
  }

  async saveSession(session: StoredSession) {
    this.sessions.set(session.tokenHash, { ...session });
  }

  async findSessionByTokenHash(tokenHash: string, now: Date) {
    const session = this.sessions.get(tokenHash);
    if (!session || new Date(session.expiresAt).getTime() <= now.getTime()) {
      return null;
    }
    return { ...session };
  }
}

type LoginMessage = {
  email: string;
  token: string;
  expiresAt: string;
};

type AuthOptions = {
  store: AuthStore;
  sender?: ((message: LoginMessage) => Promise<void>) | undefined;
  adminEmails?: string[] | undefined;
  now?: (() => Date) | undefined;
  randomToken?: (() => string) | undefined;
  loginTokenTtlMs?: number | undefined;
  sessionTtlMs?: number | undefined;
};

export class AuthError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

const SESSION_COOKIE = '__Host-madar_session';
const LOGIN_TTL_MS = 15 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function validateEmail(email: string) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new AuthError(400, 'EMAIL_INVALID', 'Email address is invalid.');
  }
}

function secureRandomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function hashSecret(secret: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function constantTimeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function parseCookies(request: Request) {
  const values = new Map<string, string>();
  for (const pair of (request.headers.get('cookie') ?? '').split(';')) {
    const separator = pair.indexOf('=');
    if (separator < 1) continue;
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    try {
      values.set(name, decodeURIComponent(value));
    } catch {
      // Invalid cookie encoding is treated as an absent credential.
    }
  }
  return values;
}

export function serializeSessionCookie(token: string, expiresAt: Date) {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; Expires=${expiresAt.toUTCString()}; HttpOnly; Secure; SameSite=Strict`;
}

export function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}

export function createAuthService(options: AuthOptions) {
  const now = options.now ?? (() => new Date());
  const randomToken = options.randomToken ?? secureRandomToken;
  const adminEmails = new Set((options.adminEmails ?? []).map(normalizeEmail));
  const loginTokenTtlMs = options.loginTokenTtlMs ?? LOGIN_TTL_MS;
  const sessionTtlMs = options.sessionTtlMs ?? SESSION_TTL_MS;

  async function authenticate(request: Request) {
    const rawToken = parseCookies(request).get(SESSION_COOKIE);
    if (!rawToken) {
      throw new AuthError(401, 'AUTH_REQUIRED', 'Authentication is required.');
    }

    const tokenHash = await hashSecret(rawToken);
    const session = await options.store.findSessionByTokenHash(tokenHash, now());
    if (!session) {
      throw new AuthError(401, 'AUTH_REQUIRED', 'Session is missing or expired.');
    }

    const user = await options.store.findUserById(session.userId);
    if (!user) {
      throw new AuthError(401, 'AUTH_REQUIRED', 'Session user no longer exists.');
    }

    return { user, session };
  }

  return {
    async requestLogin(emailInput: string): Promise<{ status: 'sent' | 'unavailable' }> {
      if (!options.sender) return { status: 'unavailable' };

      const email = normalizeEmail(emailInput);
      validateEmail(email);
      const token = randomToken();
      const issuedAt = now();
      const expiresAt = new Date(issuedAt.getTime() + loginTokenTtlMs);
      const tokenHash = await hashSecret(token);

      await options.store.saveLoginToken({
        tokenHash,
        email,
        expiresAt: expiresAt.toISOString(),
        usedAt: null,
      });
      await options.sender({ email, token, expiresAt: expiresAt.toISOString() });
      return { status: 'sent' };
    },

    async consumeLoginToken(token: string): Promise<Session> {
      const consumedAt = now();
      const tokenHash = await hashSecret(token);
      const loginToken = await options.store.consumeLoginToken(tokenHash, consumedAt);
      if (!loginToken) {
        throw new AuthError(401, 'TOKEN_INVALID', 'Login token is invalid, expired, or already used.');
      }

      let user = await options.store.findUserByEmail(loginToken.email);
      if (!user) {
        user = {
          id: crypto.randomUUID(),
          email: loginToken.email,
          role: adminEmails.has(loginToken.email) ? 'admin' : 'user',
          verifiedAt: consumedAt.toISOString(),
        };
        await options.store.saveUser(user);
      } else if (adminEmails.has(loginToken.email) && user.role !== 'admin') {
        user = { ...user, role: 'admin' };
        await options.store.saveUser(user);
      }

      const rawSessionToken = randomToken();
      const csrfToken = randomToken();
      const expiresAt = new Date(consumedAt.getTime() + sessionTtlMs);
      const session: StoredSession = {
        id: crypto.randomUUID(),
        userId: user.id,
        tokenHash: await hashSecret(rawSessionToken),
        csrfTokenHash: await hashSecret(csrfToken),
        expiresAt: expiresAt.toISOString(),
        createdAt: consumedAt.toISOString(),
      };
      await options.store.saveSession(session);

      return {
        id: session.id,
        userId: session.userId,
        expiresAt: session.expiresAt,
        token: rawSessionToken,
        csrfToken,
      };
    },

    async requireUser(request: Request): Promise<User> {
      return (await authenticate(request)).user;
    },

    async requireAdmin(request: Request): Promise<User> {
      const user = (await authenticate(request)).user;
      if (user.role !== 'admin') {
        throw new AuthError(403, 'ADMIN_REQUIRED', 'Administrator role is required.');
      }
      return user;
    },

    async requireMutationUser(request: Request): Promise<User> {
      const { user, session } = await authenticate(request);
      const csrfToken = request.headers.get('x-csrf-token');
      if (!csrfToken) {
        throw new AuthError(403, 'CSRF_INVALID', 'CSRF token is required.');
      }
      const csrfHash = await hashSecret(csrfToken);
      if (!constantTimeEqual(csrfHash, session.csrfTokenHash)) {
        throw new AuthError(403, 'CSRF_INVALID', 'CSRF token is invalid.');
      }
      return user;
    },
  };
}
