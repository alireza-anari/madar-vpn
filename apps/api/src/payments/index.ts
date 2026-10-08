import { ProviderUnavailableError, type PaymentProvider } from '../providers';

const DAY_MS = 24 * 60 * 60 * 1000;

export type PaymentPlan = Readonly<{
  id: string;
  title: string;
  durationDays: number;
  priceMinor: number;
  currency: string;
  enabled: boolean;
}>;

export type PaymentOrder = {
  id: string;
  userId: string;
  planId: string;
  durationDays: number;
  amountMinor: number;
  currency: string;
  status: 'pending' | 'settled';
  createdAt: string;
  settledAt: string | null;
};

export type PaymentSettlement = Readonly<{
  applied: boolean;
  premiumUntil: string | null;
}>;

export interface PaymentStore {
  getPlan(id: string): Promise<PaymentPlan | null>;
  saveOrder(order: PaymentOrder): Promise<void>;
  getOrder(id: string): Promise<PaymentOrder | null>;
  settlePendingOrder(orderId: string, sourceKey: string, settledAt: string): Promise<PaymentSettlement | null>;
  getPremiumUntil(userId: string): Promise<string | null>;
}

export class MemoryPaymentStore implements PaymentStore {
  readonly plans: PaymentPlan[] = [];
  readonly orders: PaymentOrder[] = [];
  private readonly settlementKeys = new Set<string>();
  private readonly premium = new Map<string, string | null>();

  seedPlan(plan: PaymentPlan) {
    const index = this.plans.findIndex((candidate) => candidate.id === plan.id);
    if (index >= 0) this.plans[index] = { ...plan };
    else this.plans.push({ ...plan });
  }

  async getPlan(id: string) {
    const plan = this.plans.find((candidate) => candidate.id === id);
    return plan ? { ...plan } : null;
  }

  async saveOrder(order: PaymentOrder) {
    if (this.orders.some((candidate) => candidate.id === order.id)) {
      throw new PaymentError(400, 'ORDER_INVALID', 'Order id already exists.');
    }
    this.orders.push({ ...order });
  }

  async getOrder(id: string) {
    const order = this.orders.find((candidate) => candidate.id === id);
    return order ? { ...order } : null;
  }

  async settlePendingOrder(orderId: string, sourceKey: string, settledAt: string): Promise<PaymentSettlement | null> {
    const order = this.orders.find((candidate) => candidate.id === orderId);
    if (!order) return null;

    const currentPremiumUntil = this.premium.get(order.userId) ?? null;
    if (this.settlementKeys.has(sourceKey) || order.status === 'settled') {
      return { applied: false, premiumUntil: currentPremiumUntil };
    }

    const settledTime = new Date(settledAt).getTime();
    const currentTime = currentPremiumUntil ? new Date(currentPremiumUntil).getTime() : Number.NEGATIVE_INFINITY;
    const baseTime = Math.max(settledTime, Number.isNaN(currentTime) ? Number.NEGATIVE_INFINITY : currentTime);
    const premiumUntil = new Date(baseTime + order.durationDays * DAY_MS).toISOString();

    this.settlementKeys.add(sourceKey);
    order.status = 'settled';
    order.settledAt = settledAt;
    this.premium.set(order.userId, premiumUntil);
    return { applied: true, premiumUntil };
  }

  async getPremiumUntil(userId: string) {
    return this.premium.get(userId) ?? null;
  }
}

export class PaymentError extends Error {
  constructor(
    readonly status: 400 | 404,
    readonly code: 'PLAN_UNAVAILABLE' | 'ORDER_INVALID' | 'PAYMENT_ORDER_MISMATCH',
    message: string,
  ) {
    super(message);
    this.name = 'PaymentError';
  }
}

function validId(value: string) {
  return /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/.test(value);
}

export type PaymentService = ReturnType<typeof createPaymentService>;

export function createPaymentService(options: {
  store: PaymentStore;
  provider?: PaymentProvider;
  now?: () => Date;
  randomId?: () => string;
}) {
  const now = options.now ?? (() => new Date());
  const randomId = options.randomId ?? (() => crypto.randomUUID());

  async function requireOrder(orderId: string) {
    const order = await options.store.getOrder(orderId);
    if (!order) {
      throw new PaymentError(404, 'PAYMENT_ORDER_MISMATCH', 'Payment does not match a server-created order.');
    }
    return order;
  }

  async function settle(orderId: string, sourceKey: string, settledAt: Date) {
    if (!validId(sourceKey) || Number.isNaN(settledAt.getTime())) {
      throw new PaymentError(400, 'ORDER_INVALID', 'Payment settlement input is invalid.');
    }
    const result = await options.store.settlePendingOrder(orderId, sourceKey, settledAt.toISOString());
    if (!result) {
      throw new PaymentError(404, 'PAYMENT_ORDER_MISMATCH', 'Payment does not match a server-created order.');
    }
    return result;
  }

  return {
    async createOrder(userId: string, planId: string): Promise<PaymentOrder> {
      if (!validId(userId) || !validId(planId)) {
        throw new PaymentError(400, 'ORDER_INVALID', 'Order identifiers are invalid.');
      }
      const plan = await options.store.getPlan(planId);
      if (!plan || !plan.enabled) {
        throw new PaymentError(404, 'PLAN_UNAVAILABLE', 'Selected plan is not available.');
      }
      const createdAt = now();
      if (Number.isNaN(createdAt.getTime())) {
        throw new PaymentError(400, 'ORDER_INVALID', 'Order timestamp is invalid.');
      }
      const order: PaymentOrder = {
        id: randomId(),
        userId,
        planId: plan.id,
        durationDays: plan.durationDays,
        amountMinor: plan.priceMinor,
        currency: plan.currency,
        status: 'pending',
        createdAt: createdAt.toISOString(),
        settledAt: null,
      };
      if (!validId(order.id)) {
        throw new PaymentError(400, 'ORDER_INVALID', 'Generated order id is invalid.');
      }
      await options.store.saveOrder(order);
      return { ...order };
    },

    async confirmOrder(orderId: string, confirmationId: string) {
      await requireOrder(orderId);
      if (!validId(confirmationId)) {
        throw new PaymentError(400, 'ORDER_INVALID', 'Confirmation id is invalid.');
      }
      return settle(orderId, `manual:${confirmationId}`, now());
    },

    async settleProviderCallback(request: Request) {
      if (!options.provider) throw new ProviderUnavailableError('payments');
      const event = await options.provider.verifyCallback(request);
      const order = await requireOrder(event.orderId);
      if (
        event.amountMinor !== order.amountMinor ||
        event.currency.toUpperCase() !== order.currency.toUpperCase()
      ) {
        throw new PaymentError(400, 'PAYMENT_ORDER_MISMATCH', 'Verified payment amount or currency does not match the order.');
      }
      const occurredAt = new Date(event.occurredAt);
      if (Number.isNaN(occurredAt.getTime())) {
        throw new PaymentError(400, 'PAYMENT_ORDER_MISMATCH', 'Verified payment timestamp is invalid.');
      }
      return settle(order.id, `provider:${event.provider}:${event.eventId}`, occurredAt);
    },
  };
}
