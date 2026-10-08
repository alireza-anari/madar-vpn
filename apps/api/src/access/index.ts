export type AccessProfile = {
  id: string;
  userId: string;
  policyRevision: number;
  createdAt: string;
};

export type ClientCredential = {
  id: string;
  userId: string;
  uuid: string;
  version: number;
  createdAt: string;
  revokedAt: string | null;
};

export type SubscriptionTokenRecord = {
  id: string;
  userId: string;
  tokenHash: string;
  version: number;
  createdAt: string;
  revokedAt: string | null;
};

export interface AccessStore {
  ensureProfile(candidate: AccessProfile): Promise<AccessProfile>;
  ensureActiveClientCredential(candidate: ClientCredential): Promise<ClientCredential>;
  issueSubscriptionToken(candidate: Omit<SubscriptionTokenRecord, 'version' | 'revokedAt'>): Promise<SubscriptionTokenRecord>;
  getActiveSubscriptionToken(userId: string): Promise<SubscriptionTokenRecord | null>;
}

export class MemoryAccessStore implements AccessStore {
  readonly profiles: AccessProfile[] = [];
  readonly credentials: ClientCredential[] = [];
  readonly subscriptionTokens: SubscriptionTokenRecord[] = [];

  async ensureProfile(candidate: AccessProfile) {
    const existing = this.profiles.find((profile) => profile.userId === candidate.userId);
    if (existing) return { ...existing };
    this.profiles.push({ ...candidate });
    return { ...candidate };
  }

  async ensureActiveClientCredential(candidate: ClientCredential) {
    const existing = this.credentials.find(
      (credential) => credential.userId === candidate.userId && credential.revokedAt === null,
    );
    if (existing) return { ...existing };
    if (this.credentials.some((credential) => credential.uuid === candidate.uuid)) {
      throw new Error('Client UUID already exists.');
    }
    this.credentials.push({ ...candidate });
    return { ...candidate };
  }

  async issueSubscriptionToken(candidate: Omit<SubscriptionTokenRecord, 'version' | 'revokedAt'>) {
    const active = this.subscriptionTokens.find(
      (record) => record.userId === candidate.userId && record.revokedAt === null,
    );
    if (active) active.revokedAt = candidate.createdAt;
    const version = this.subscriptionTokens
      .filter((record) => record.userId === candidate.userId)
      .reduce((highest, record) => Math.max(highest, record.version), 0) + 1;
    const record: SubscriptionTokenRecord = { ...candidate, version, revokedAt: null };
    this.subscriptionTokens.push(record);
    return { ...record };
  }

  async getActiveSubscriptionToken(userId: string) {
    const record = this.subscriptionTokens.find(
      (candidate) => candidate.userId === userId && candidate.revokedAt === null,
    );
    return record ? { ...record } : null;
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

export function createAccessService(options: {
  store: AccessStore;
  now?: () => Date;
  randomUuid?: () => string;
  randomToken?: () => string;
}) {
  const now = options.now ?? (() => new Date());
  const randomUuid = options.randomUuid ?? (() => crypto.randomUUID());
  const randomToken = options.randomToken ?? secureRandomToken;

  async function ensureAccessProfile(userId: string): Promise<AccessProfile> {
    const createdAt = now().toISOString();
    return options.store.ensureProfile({
      id: randomUuid(),
      userId,
      policyRevision: 1,
      createdAt,
    });
  }

  return {
    ensureAccessProfile,

    async getActiveClientCredential(userId: string): Promise<ClientCredential> {
      await ensureAccessProfile(userId);
      const createdAt = now().toISOString();
      return options.store.ensureActiveClientCredential({
        id: randomUuid(),
        userId,
        uuid: randomUuid(),
        version: 1,
        createdAt,
        revokedAt: null,
      });
    },

    async issueSubscriptionToken(userId: string): Promise<{ rawToken: string; version: number }> {
      await ensureAccessProfile(userId);
      const rawToken = randomToken();
      const record = await options.store.issueSubscriptionToken({
        id: randomUuid(),
        userId,
        tokenHash: await hashSecret(rawToken),
        createdAt: now().toISOString(),
      });
      return { rawToken, version: record.version };
    },
  };
}
