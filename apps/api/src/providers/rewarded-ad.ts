import type { RewardedAdProvider } from './index';

export interface RewardedAdBindingStore {
  resolveUserId(provider: string, eventId: string): Promise<string | null>;
}

export class MemoryRewardedAdBindingStore implements RewardedAdBindingStore {
  private readonly bindings = new Map<string, string>();

  bind(provider: string, eventId: string, userId: string) {
    this.bindings.set(`${provider}:${eventId}`, userId);
  }

  async resolveUserId(provider: string, eventId: string) {
    return this.bindings.get(`${provider}:${eventId}`) ?? null;
  }
}

type AdCreditSettlement = {
  awardAd(userId: string, eventId: string, now: Date): Promise<boolean>;
};

export class RewardedAdSettlementError extends Error {
  constructor(
    readonly status: 400 | 403,
    readonly code: 'AD_EVENT_INVALID' | 'AD_USER_BINDING_INVALID',
    message: string,
  ) {
    super(message);
    this.name = 'RewardedAdSettlementError';
  }
}

export type RewardedAdSettlement = ReturnType<typeof createRewardedAdSettlement>;

export function createRewardedAdSettlement(options: {
  provider: RewardedAdProvider;
  credits: AdCreditSettlement;
  bindings: RewardedAdBindingStore;
}) {
  return {
    async settle(request: Request) {
      const event = await options.provider.verifyCallback(request);
      if (!event.provider.trim() || !event.eventId.trim() || !event.userId.trim()) {
        throw new RewardedAdSettlementError(400, 'AD_EVENT_INVALID', 'Verified ad event is incomplete.');
      }

      const occurredAt = new Date(event.occurredAt);
      if (Number.isNaN(occurredAt.getTime())) {
        throw new RewardedAdSettlementError(400, 'AD_EVENT_INVALID', 'Verified ad event timestamp is invalid.');
      }

      const boundUserId = await options.bindings.resolveUserId(event.provider, event.eventId);
      if (!boundUserId || boundUserId !== event.userId) {
        throw new RewardedAdSettlementError(
          403,
          'AD_USER_BINDING_INVALID',
          'Verified ad event does not match its server-side user binding.',
        );
      }

      const credited = await options.credits.awardAd(
        event.userId,
        `${event.provider}:${event.eventId}`,
        occurredAt,
      );
      return {
        creditedSeconds: credited ? 900 : 0,
        duplicate: !credited,
      };
    },
  };
}
