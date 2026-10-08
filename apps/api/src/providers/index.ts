export type MagicLinkMessage = Readonly<{
  email: string;
  token: string;
  expiresAt: string;
}>;

export interface EmailProvider {
  sendMagicLink(input: MagicLinkMessage): Promise<'sent' | 'unavailable'>;
}

export type VerifiedAdEvent = Readonly<{
  provider: string;
  eventId: string;
  userId: string;
  occurredAt: string;
}>;

export interface RewardedAdProvider {
  verifyCallback(request: Request): Promise<VerifiedAdEvent>;
}

export type VerifiedPaymentEvent = Readonly<{
  provider: string;
  eventId: string;
  orderId: string;
  amountMinor: number;
  currency: string;
  occurredAt: string;
}>;

export interface PaymentProvider {
  verifyCallback(request: Request): Promise<VerifiedPaymentEvent>;
}

export type PushSubscription = Readonly<{
  endpoint: string;
}>;

export type PushPayload = Readonly<{
  title: string;
  body: string;
}>;

export type DeliveryResult = Readonly<
  | { status: 'delivered'; providerMessageId?: string }
  | { status: 'failed'; reason?: string }
  | { status: 'unavailable' }
>;

export interface PushProvider {
  send(subscription: PushSubscription, payload: PushPayload): Promise<DeliveryResult>;
}

export class ProviderUnavailableError extends Error {
  readonly code = 'PROVIDER_UNAVAILABLE';

  constructor(readonly providerKind: 'ads' | 'payments') {
    super(`${providerKind} provider is not configured.`);
    this.name = 'ProviderUnavailableError';
  }
}

export class ProviderVerificationError extends Error {
  readonly code = 'PROVIDER_VERIFICATION_FAILED';

  constructor(readonly provider: string) {
    super(`Callback verification failed for provider ${provider}.`);
    this.name = 'ProviderVerificationError';
  }
}

type CallbackConfig<TEvent extends { provider: string }> = Readonly<{
  provider: string;
  verify(request: Request): boolean | Promise<boolean>;
  parse(request: Request): TEvent | Promise<TEvent>;
}>;

function createVerifiedCallback<TEvent extends { provider: string }>(
  providerKind: 'ads' | 'payments',
  config?: CallbackConfig<TEvent>,
): (request: Request) => Promise<TEvent> {
  if (!config) {
    return async () => {
      throw new ProviderUnavailableError(providerKind);
    };
  }

  return async (request: Request) => {
    const verified = await config.verify(request.clone());
    if (!verified) throw new ProviderVerificationError(config.provider);

    const event = await config.parse(request);
    if (event.provider !== config.provider) throw new ProviderVerificationError(config.provider);
    return event;
  };
}

export function createUnavailableEmailProvider(): EmailProvider {
  return {
    async sendMagicLink() {
      return 'unavailable';
    },
  };
}

export function createRewardedAdProvider(config?: CallbackConfig<VerifiedAdEvent>): RewardedAdProvider {
  const verifyCallback = createVerifiedCallback('ads', config);
  return { verifyCallback };
}

export function createPaymentProvider(config?: CallbackConfig<VerifiedPaymentEvent>): PaymentProvider {
  const verifyCallback = createVerifiedCallback('payments', config);
  return { verifyCallback };
}

export function createUnavailablePushProvider(): PushProvider {
  return {
    async send() {
      return { status: 'unavailable' };
    },
  };
}
