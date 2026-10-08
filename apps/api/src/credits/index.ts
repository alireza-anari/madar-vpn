export type CreditLedgerKind = 'initial' | 'ad' | 'usage' | 'manual';

export type CreditLedgerEntry = {
  uniqueKey: string;
  userId: string;
  kind: CreditLedgerKind;
  freeDay: string;
  deltaSeconds: number;
  occurredAt: string;
  nodeId?: string | undefined;
  sessionId?: string | undefined;
  sequence?: number | undefined;
};

export type Entitlement = {
  freeSeconds: number;
  premiumUntil: string | null;
  tier: 'free' | 'premium';
};

export interface CreditStore {
  getVerifiedAt(userId: string): Promise<string | null>;
  insertLedgerEntry(entry: CreditLedgerEntry): Promise<boolean>;
  sumFreeSeconds(userId: string, freeDay: string): Promise<number>;
  resolveUsageSession(nodeId: string, sessionId: string): Promise<string | null>;
  getPremiumUntil(userId: string): Promise<string | null>;
  applyPremiumAdjustment(userId: string, uniqueKey: string, premiumUntil: string | null, occurredAt: string): Promise<boolean>;
}

export class CreditError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CreditError';
  }
}

export class MemoryCreditStore implements CreditStore {
  readonly ledger: CreditLedgerEntry[] = [];
  private readonly ledgerKeys = new Set<string>();
  private readonly premiumAdjustmentKeys = new Set<string>();
  private readonly verifiedUsers = new Map<string, string>();
  private readonly usageSessions = new Map<string, string>();
  private readonly premium = new Map<string, string | null>();

  registerVerifiedUser(userId: string, verifiedAt: Date | string) {
    this.verifiedUsers.set(userId, typeof verifiedAt === 'string' ? verifiedAt : verifiedAt.toISOString());
  }

  registerUsageSession(nodeId: string, sessionId: string, userId: string) {
    this.usageSessions.set(`${nodeId}:${sessionId}`, userId);
  }

  setPremiumUntil(userId: string, premiumUntil: string | null) {
    this.premium.set(userId, premiumUntil);
  }

  async getVerifiedAt(userId: string) {
    return this.verifiedUsers.get(userId) ?? null;
  }

  async insertLedgerEntry(entry: CreditLedgerEntry) {
    if (this.ledgerKeys.has(entry.uniqueKey)) return false;
    this.ledgerKeys.add(entry.uniqueKey);
    this.ledger.push({ ...entry });
    return true;
  }

  async sumFreeSeconds(userId: string, freeDay: string) {
    return this.ledger
      .filter((entry) => entry.userId === userId && entry.freeDay === freeDay)
      .reduce((total, entry) => total + entry.deltaSeconds, 0);
  }

  async resolveUsageSession(nodeId: string, sessionId: string) {
    return this.usageSessions.get(`${nodeId}:${sessionId}`) ?? null;
  }

  async getPremiumUntil(userId: string) {
    return this.premium.get(userId) ?? null;
  }

  async applyPremiumAdjustment(userId: string, uniqueKey: string, premiumUntil: string | null, _occurredAt: string) {
    if (this.premiumAdjustmentKeys.has(uniqueKey)) return false;
    this.premiumAdjustmentKeys.add(uniqueKey);
    this.premium.set(userId, premiumUntil);
    return true;
  }
}

const INITIAL_FREE_SECONDS = 1800;
const AD_FREE_SECONDS = 900;
const MAX_MANUAL_ADJUSTMENT_SECONDS = 30 * 24 * 60 * 60;

const tehranDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Tehran',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function tehranDateKey(value: Date) {
  const parts = tehranDateFormatter.formatToParts(value);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  if (!year || !month || !day) throw new CreditError('DATE_INVALID', 'Could not determine Tehran accounting day.');
  return `${year}-${month}-${day}`;
}

function validUsageSeconds(seconds: number) {
  return Number.isSafeInteger(seconds) && seconds >= 0;
}

function validManualSeconds(seconds: number) {
  return Number.isSafeInteger(seconds) && seconds !== 0 && Math.abs(seconds) <= MAX_MANUAL_ADJUSTMENT_SECONDS;
}

function validIdempotencyKey(value: string) {
  return /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/.test(value);
}

function normalizePremiumUntil(value: string | null) {
  if (value === null) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new CreditError('PREMIUM_ADJUSTMENT_INVALID', 'Premium expiry is invalid.');
  }
  return parsed.toISOString();
}

export function createCreditService(options: { store: CreditStore }) {
  async function ensureInitialGrant(userId: string) {
    const verifiedAt = await options.store.getVerifiedAt(userId);
    if (!verifiedAt) return false;
    const verifiedDate = new Date(verifiedAt);
    if (Number.isNaN(verifiedDate.getTime())) {
      throw new CreditError('VERIFICATION_DATE_INVALID', 'Verified account has an invalid verification timestamp.');
    }

    return options.store.insertLedgerEntry({
      uniqueKey: `initial:${userId}`,
      userId,
      kind: 'initial',
      freeDay: tehranDateKey(verifiedDate),
      deltaSeconds: INITIAL_FREE_SECONDS,
      occurredAt: verifiedDate.toISOString(),
    });
  }

  return {
    async getEntitlement(userId: string, now: Date): Promise<Entitlement> {
      await ensureInitialGrant(userId);
      const freeDay = tehranDateKey(now);
      const [rawFreeSeconds, premiumUntil] = await Promise.all([
        options.store.sumFreeSeconds(userId, freeDay),
        options.store.getPremiumUntil(userId),
      ]);
      const premiumActive = premiumUntil !== null && new Date(premiumUntil).getTime() > now.getTime();
      return {
        freeSeconds: Math.max(0, rawFreeSeconds),
        premiumUntil,
        tier: premiumActive ? 'premium' : 'free',
      };
    },

    async awardAd(userId: string, eventId: string, now: Date): Promise<boolean> {
      if (!eventId.trim()) throw new CreditError('EVENT_INVALID', 'Ad event id is required.');
      const verifiedAt = await options.store.getVerifiedAt(userId);
      if (!verifiedAt) return false;
      return options.store.insertLedgerEntry({
        uniqueKey: `ad:${eventId}`,
        userId,
        kind: 'ad',
        freeDay: tehranDateKey(now),
        deltaSeconds: AD_FREE_SECONDS,
        occurredAt: now.toISOString(),
      });
    },

    async adjustManual(userId: string, idempotencyKey: string, seconds: number, now: Date): Promise<boolean> {
      if (!validIdempotencyKey(idempotencyKey) || !validManualSeconds(seconds)) {
        throw new CreditError('MANUAL_ADJUSTMENT_INVALID', 'Manual credit adjustment is invalid.');
      }
      const verifiedAt = await options.store.getVerifiedAt(userId);
      if (!verifiedAt) return false;
      return options.store.insertLedgerEntry({
        uniqueKey: `manual:${idempotencyKey}`,
        userId,
        kind: 'manual',
        freeDay: tehranDateKey(now),
        deltaSeconds: seconds,
        occurredAt: now.toISOString(),
      });
    },

    async adjustPremium(
      userId: string,
      idempotencyKey: string,
      premiumUntilInput: string | null,
      now: Date,
    ): Promise<boolean> {
      if (!validIdempotencyKey(idempotencyKey)) {
        throw new CreditError('PREMIUM_ADJUSTMENT_INVALID', 'Premium adjustment idempotency key is invalid.');
      }
      const verifiedAt = await options.store.getVerifiedAt(userId);
      if (!verifiedAt) return false;
      const premiumUntil = normalizePremiumUntil(premiumUntilInput);
      return options.store.applyPremiumAdjustment(
        userId,
        `premium:${idempotencyKey}`,
        premiumUntil,
        now.toISOString(),
      );
    },

    async recordUsage(
      nodeId: string,
      sessionId: string,
      sequence: number,
      seconds: number,
      occurredAt: Date,
    ): Promise<boolean> {
      if (!validUsageSeconds(seconds) || !Number.isSafeInteger(sequence) || sequence < 0) {
        throw new CreditError('USAGE_INVALID', 'Usage must contain non-negative integer seconds and sequence.');
      }
      const userId = await options.store.resolveUsageSession(nodeId, sessionId);
      if (!userId) return false;
      const premiumUntil = await options.store.getPremiumUntil(userId);
      const premiumActiveAtUsage = premiumUntil !== null && new Date(premiumUntil).getTime() > occurredAt.getTime();
      return options.store.insertLedgerEntry({
        uniqueKey: `usage:${nodeId}:${sessionId}:${sequence}`,
        userId,
        kind: 'usage',
        freeDay: tehranDateKey(occurredAt),
        deltaSeconds: premiumActiveAtUsage ? 0 : -seconds,
        occurredAt: occurredAt.toISOString(),
        nodeId,
        sessionId,
        sequence,
      });
    },
  };
}
