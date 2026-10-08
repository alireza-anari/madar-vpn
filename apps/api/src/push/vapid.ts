import { PushError, type PushPayload, type PushSender, type PushSubscriptionRecord } from './index';

export type VapidConfig = {
  publicKey: string;
  privateKey: string;
  subject: string;
};

export type VapidTransport = {
  send(input: {
    config: VapidConfig;
    subscription: PushSubscriptionRecord;
    payload: PushPayload;
  }): Promise<{ statusCode: number }>;
};

function validateConfig(config: VapidConfig): VapidConfig {
  const publicKey = config.publicKey.trim();
  const privateKey = config.privateKey.trim();
  const subject = config.subject.trim();
  if (!publicKey || !privateKey || !subject) {
    throw new PushError(503, 'VAPID_UNAVAILABLE', 'VAPID credentials are not configured.');
  }
  if (!subject.startsWith('mailto:') && !subject.startsWith('https://')) {
    throw new PushError(503, 'VAPID_INVALID', 'VAPID subject is invalid.');
  }
  return { publicKey, privateKey, subject };
}

export function createVapidSender(configInput: VapidConfig, transport?: VapidTransport): PushSender {
  const config = validateConfig(configInput);
  return {
    async send(subscription, payload) {
      if (!transport) return { status: 'failed' };
      try {
        const result = await transport.send({ config, subscription, payload });
        if (result.statusCode === 404 || result.statusCode === 410) return { status: 'expired' };
        if (result.statusCode >= 200 && result.statusCode < 300) return { status: 'delivered' };
        return { status: 'failed' };
      } catch {
        return { status: 'failed' };
      }
    },
  };
}
