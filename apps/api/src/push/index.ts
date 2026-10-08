export type PushSubscriptionRecord = {
  id: string;
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  expirationTime: number | null;
  createdAt: string;
  updatedAt: string;
};

export type PushPayload = {
  title: string;
  body: string;
  url?: string;
};

export type PushSendResult = { status: 'delivered' | 'expired' | 'failed' };

export interface PushSender {
  send(subscription: PushSubscriptionRecord, payload: PushPayload): Promise<PushSendResult>;
}

export interface PushStore {
  saveSubscription(record: PushSubscriptionRecord): Promise<PushSubscriptionRecord>;
  listUserSubscriptions(userId: string): Promise<PushSubscriptionRecord[]>;
  deleteUserSubscription(userId: string, id: string): Promise<boolean>;
}

export class PushError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PushError';
  }
}

export class MemoryPushStore implements PushStore {
  readonly subscriptions: PushSubscriptionRecord[] = [];

  async saveSubscription(record: PushSubscriptionRecord) {
    const endpointIndex = this.subscriptions.findIndex((candidate) => candidate.endpoint === record.endpoint);
    if (endpointIndex >= 0) {
      const existing = this.subscriptions[endpointIndex]!;
      const next: PushSubscriptionRecord = {
        ...record,
        id: existing.id,
        createdAt: existing.createdAt,
      };
      this.subscriptions[endpointIndex] = next;
      return { ...next };
    }
    this.subscriptions.push({ ...record });
    return { ...record };
  }

  async listUserSubscriptions(userId: string) {
    return this.subscriptions.filter((subscription) => subscription.userId === userId).map((subscription) => ({ ...subscription }));
  }

  async deleteUserSubscription(userId: string, id: string) {
    const index = this.subscriptions.findIndex((subscription) => subscription.userId === userId && subscription.id === id);
    if (index < 0) return false;
    this.subscriptions.splice(index, 1);
    return true;
  }
}

function validateId(value: string, code = 'PUSH_SUBSCRIPTION_INVALID') {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)) {
    throw new PushError(400, code, 'Push subscription identifier is invalid.');
  }
  return value;
}

function requiredSecret(value: unknown) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 4096) {
    throw new PushError(400, 'PUSH_SUBSCRIPTION_INVALID', 'Push subscription key material is invalid.');
  }
  return value;
}

function parseSubscription(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new PushError(400, 'PUSH_SUBSCRIPTION_INVALID', 'Push subscription is invalid.');
  }
  const candidate = input as Record<string, unknown>;
  if (typeof candidate.endpoint !== 'string' || candidate.endpoint.length > 4096) {
    throw new PushError(400, 'PUSH_SUBSCRIPTION_INVALID', 'Push endpoint is invalid.');
  }
  let endpoint: URL;
  try {
    endpoint = new URL(candidate.endpoint);
  } catch {
    throw new PushError(400, 'PUSH_SUBSCRIPTION_INVALID', 'Push endpoint is invalid.');
  }
  if (endpoint.protocol !== 'https:') {
    throw new PushError(400, 'PUSH_SUBSCRIPTION_INVALID', 'Push endpoint must use HTTPS.');
  }
  if (!candidate.keys || typeof candidate.keys !== 'object' || Array.isArray(candidate.keys)) {
    throw new PushError(400, 'PUSH_SUBSCRIPTION_INVALID', 'Push subscription key material is invalid.');
  }
  const keys = candidate.keys as Record<string, unknown>;
  const expirationTime = candidate.expirationTime;
  if (expirationTime !== null && expirationTime !== undefined && (!Number.isSafeInteger(expirationTime) || Number(expirationTime) < 0)) {
    throw new PushError(400, 'PUSH_SUBSCRIPTION_INVALID', 'Push subscription expiry is invalid.');
  }
  return {
    endpoint: endpoint.toString(),
    p256dh: requiredSecret(keys.p256dh),
    auth: requiredSecret(keys.auth),
    expirationTime: expirationTime == null ? null : Number(expirationTime),
  };
}

function validatePayload(payload: PushPayload) {
  const title = payload.title?.trim();
  const body = payload.body?.trim();
  if (!title || title.length > 120 || !body || body.length > 1000) {
    throw new PushError(400, 'PUSH_PAYLOAD_INVALID', 'Push notification payload is invalid.');
  }
  let url: string | undefined;
  if (payload.url !== undefined) {
    if (!payload.url.startsWith('/') || payload.url.startsWith('//') || payload.url.length > 500) {
      throw new PushError(400, 'PUSH_PAYLOAD_INVALID', 'Push notification URL is invalid.');
    }
    url = payload.url;
  }
  return url === undefined ? { title, body } : { title, body, url };
}

export function createPushService(options: {
  store: PushStore;
  sender?: PushSender;
  publicKey?: string;
  now?: () => Date;
  randomId?: () => string;
}) {
  const now = options.now ?? (() => new Date());
  const randomId = options.randomId ?? (() => crypto.randomUUID());

  return {
    getPublicKey() {
      return options.publicKey?.trim() || null;
    },

    async saveSubscription(userId: string, input: unknown) {
      validateId(userId, 'USER_INVALID');
      const parsed = parseSubscription(input);
      const timestamp = now().toISOString();
      return options.store.saveSubscription({
        id: randomId(),
        userId,
        ...parsed,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    },

    async listSubscriptions(userId: string) {
      validateId(userId, 'USER_INVALID');
      return options.store.listUserSubscriptions(userId);
    },

    async removeSubscription(userId: string, id: string) {
      validateId(userId, 'USER_INVALID');
      validateId(id);
      return options.store.deleteUserSubscription(userId, id);
    },

    async sendNotification(userId: string, payloadInput: PushPayload) {
      validateId(userId, 'USER_INVALID');
      const payload = validatePayload(payloadInput);
      const subscriptions = await options.store.listUserSubscriptions(userId);
      let delivered = 0;
      let expiredRemoved = 0;
      let failed = 0;

      for (const subscription of subscriptions) {
        if (!options.sender) {
          failed += 1;
          continue;
        }
        try {
          const result = await options.sender.send(subscription, payload);
          if (result.status === 'delivered') {
            delivered += 1;
          } else if (result.status === 'expired') {
            await options.store.deleteUserSubscription(userId, subscription.id);
            expiredRemoved += 1;
          } else {
            failed += 1;
          }
        } catch {
          failed += 1;
        }
      }

      return { delivered, expiredRemoved, failed };
    },
  };
}

export type PushService = ReturnType<typeof createPushService>;
