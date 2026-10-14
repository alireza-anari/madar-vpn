import { decodeBase64Url } from './web-push';
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
  try {
    const publicBytes = decodeBase64Url(publicKey, 65);
    decodeBase64Url(privateKey, 32);
    const parsedSubject = new URL(subject);
    if (publicBytes[0] !== 4 || !((parsedSubject.protocol === 'mailto:' && /^[^@\s]+@[^@\s]+$/.test(parsedSubject.pathname)) || (parsedSubject.protocol === 'https:' && parsedSubject.hostname && !parsedSubject.username && !parsedSubject.password))) throw new Error();
  } catch {
    throw new PushError(503, 'VAPID_INVALID', 'VAPID configuration is invalid.');
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
