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

export type ClientCredentialRotationInput = Omit<ClientCredential, 'version' | 'revokedAt'>;
export type ClientCredentialRotation = {
  credential: ClientCredential;
  policyRevision: number;
};

export interface AccessStore {
  ensureProfile(candidate: AccessProfile): Promise<AccessProfile>;
  getProfile(userId: string): Promise<AccessProfile | null>;
  ensureActiveClientCredential(candidate: ClientCredential): Promise<ClientCredential>;
  getActiveClientCredential(userId: string): Promise<ClientCredential | null>;
  rotateClientCredential?(candidate: ClientCredentialRotationInput): Promise<ClientCredentialRotation>;
  issueSubscriptionToken(candidate: Omit<SubscriptionTokenRecord, 'version' | 'revokedAt'>): Promise<SubscriptionTokenRecord>;
  getActiveSubscriptionToken(userId: string): Promise<SubscriptionTokenRecord | null>;
  findActiveSubscriptionTokenByHash(tokenHash: string): Promise<SubscriptionTokenRecord | null>;
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

  async getProfile(userId: string) {
    const profile = this.profiles.find((candidate) => candidate.userId === userId);
    return profile ? { ...profile } : null;
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

  async getActiveClientCredential(userId: string) {
    const credential = this.credentials.find(
      (candidate) => candidate.userId === userId && candidate.revokedAt === null,
    );
    return credential ? { ...credential } : null;
  }

  async rotateClientCredential(candidate: ClientCredentialRotationInput) {
    const profile = this.profiles.find((record) => record.userId === candidate.userId);
    if (!profile) throw new Error('Access profile does not exist.');
    const active = this.credentials.find(
      (credential) => credential.userId === candidate.userId && credential.revokedAt === null,
    );
    if (!active) throw new Error('Active client credential does not exist.');
    if (this.credentials.some((credential) => credential.uuid === candidate.uuid)) {
      throw new Error('Client UUID already exists.');
    }

    const version = this.credentials
      .filter((credential) => credential.userId === candidate.userId)
      .reduce((highest, credential) => Math.max(highest, credential.version), 0) + 1;
    active.revokedAt = candidate.createdAt;
    profile.policyRevision += 1;
    const credential: ClientCredential = { ...candidate, version, revokedAt: null };
    this.credentials.push(credential);
    return { credential: { ...credential }, policyRevision: profile.policyRevision };
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

  async findActiveSubscriptionTokenByHash(tokenHash: string) {
    const record = this.subscriptionTokens.find(
      (candidate) => candidate.tokenHash === tokenHash && candidate.revokedAt === null,
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

export async function hashAccessSecret(secret: string) {
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

  async function issueSubscriptionToken(userId: string): Promise<{ rawToken: string; version: number }> {
    await ensureAccessProfile(userId);
    const rawToken = randomToken();
    const record = await options.store.issueSubscriptionToken({
      id: randomUuid(),
      userId,
      tokenHash: await hashAccessSecret(rawToken),
      createdAt: now().toISOString(),
    });
    return { rawToken, version: record.version };
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

    async rotateClientCredential(userId: string): Promise<ClientCredentialRotation> {
      await ensureAccessProfile(userId);
      if (!options.store.rotateClientCredential) {
        throw new Error('Client credential rotation is unavailable for this persistence adapter.');
      }
      const createdAt = now().toISOString();
      return options.store.rotateClientCredential({
        id: randomUuid(),
        userId,
        uuid: randomUuid(),
        createdAt,
      });
    },

    issueSubscriptionToken,

    async rotateSubscriptionToken(userId: string): Promise<{ rawToken: string; version: number }> {
      return issueSubscriptionToken(userId);
    },
  };
}
