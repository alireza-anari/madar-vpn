import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryPushStore, createPushService, type PushSubscriptionRecord } from './index';
import { createWebPushTransport } from './web-push';
import { createVapidSender, type VapidConfig } from './vapid';

const encode = (bytes: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const decode = (value: string) => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const text = new TextEncoder();

async function fixture() {
  const signing = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', signing.privateKey);
  const config: VapidConfig = { publicKey: encode(await crypto.subtle.exportKey('raw', signing.publicKey)), privateKey: jwk.d!, subject: 'mailto:ops@example.com' };
  const receiver = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const subscription: PushSubscriptionRecord = {
    id: 'push-test', userId: 'user-test', endpoint: 'https://fcm.googleapis.com/fcm/send/test-only',
    p256dh: encode(await crypto.subtle.exportKey('raw', receiver.publicKey)), auth: encode(crypto.getRandomValues(new Uint8Array(16))),
    expirationTime: null, createdAt: '2026-10-14T00:00:00Z', updatedAt: '2026-10-14T00:00:00Z',
  };
  return { config, receiver, subscription, signing };
}

// Receiver uses Web Crypto HKDF, independently of the sender's derivation implementation.
async function derive(ikm: ArrayBuffer | Uint8Array, salt: Uint8Array, info: Uint8Array, bits: number) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bits);
}
async function decrypt(body: Uint8Array, receiver: CryptoKeyPair, subscription: PushSubscriptionRecord) {
  expect(body[20]).toBe(65);
  const senderPublic = body.slice(21, 86);
  const peer = await crypto.subtle.importKey('raw', senderPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, receiver.privateKey, 256);
  const info = new Uint8Array([...text.encode('WebPush: info\0'), ...decode(subscription.p256dh), ...senderPublic]);
  const ikm = await derive(shared, decode(subscription.auth), info, 256);
  const cek = await derive(ikm, body.slice(0, 16), text.encode('Content-Encoding: aes128gcm\0'), 128);
  const nonce = await derive(ikm, body.slice(0, 16), text.encode('Content-Encoding: nonce\0'), 96);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, body.slice(86)));
  expect(new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0)).toBeGreaterThan(plain.length + 16);
  expect(plain.at(-1)).toBe(2);
  return JSON.parse(new TextDecoder().decode(plain.slice(0, -1)));
}

afterEach(() => vi.restoreAllMocks());

describe('real Worker Web Push', () => {
  it('posts encrypted title/body/url and a valid public-only VAPID JWT', async () => {
    const { config, receiver, subscription, signing } = await fixture();
    let request: Request | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      request = new Request(input, init);
      return new Response(null, { status: 201 });
    });
    const payload = { title: 'مدار', body: 'پیام واقعی آزمایشی', url: '/settings' };
    await expect(createVapidSender(config, createWebPushTransport()).send(subscription, payload)).resolves.toEqual({ status: 'delivered' });
    expect(request?.method).toBe('POST');
    expect(request?.redirect).toBe('manual');
    expect(request?.headers.get('content-encoding')).toBe('aes128gcm');
    expect(request?.headers.get('ttl')).toBe('60');
    const authorization = request!.headers.get('authorization')!;
    const match = /^vapid t=([^,]+), k=(.+)$/.exec(authorization)!;
    expect(match[2]).toBe(config.publicKey);
    const [header, claims, signature] = match[1]!.split('.');
    expect(JSON.parse(new TextDecoder().decode(decode(header!)))).toEqual({ typ: 'JWT', alg: 'ES256' });
    const parsed = JSON.parse(new TextDecoder().decode(decode(claims!)));
    expect(parsed.aud).toBe('https://fcm.googleapis.com');
    expect(parsed.sub).toBe(config.subject);
    expect(parsed.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(parsed.exp).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 86400);
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, signing.publicKey, decode(signature!), text.encode(`${header}.${claims}`))).toBe(true);
    const body = new Uint8Array(await request!.arrayBuffer());
    expect(await decrypt(body, receiver, subscription)).toEqual(payload);
    expect(new TextDecoder().decode(body)).not.toContain(payload.body);
    expect(authorization).not.toContain(config.privateKey);
  });

  it.each([404, 410])('removes an expired subscription on HTTP %i through the actual sender', async status => {
    const { config, subscription } = await fixture();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status }));
    const store = new MemoryPushStore();
    await store.saveSubscription(subscription);
    const push = createPushService({ store, sender: createVapidSender(config, createWebPushTransport()) });
    expect(await push.sendNotification(subscription.userId, { title: 'Madar', body: 'test' })).toEqual({ delivered: 0, expiredRemoved: 1, failed: 0 });
    expect(await store.listUserSubscriptions(subscription.userId)).toEqual([]);
  });

  it.each([400, 403, 429, 500, 302])('reports HTTP %i as failed and retains the subscription', async status => {
    const { config, subscription } = await fixture();
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status }));
    const store = new MemoryPushStore();
    await store.saveSubscription(subscription);
    const push = createPushService({ store, sender: createVapidSender(config, createWebPushTransport()) });
    expect(await push.sendNotification(subscription.userId, { title: 'Madar', body: 'test' })).toEqual({ delivered: 0, expiredRemoved: 0, failed: 1 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await store.listUserSubscriptions(subscription.userId)).toHaveLength(1);
  });

  it('returns only failed on network errors and never logs key material or provider errors', async () => {
    const { config, subscription } = await fixture();
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'error'), vi.spyOn(console, 'warn')];
    const fetcher = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error(config.privateKey));
    const result = await createVapidSender(config, createWebPushTransport()).send(subscription, { title: 'Madar', body: 'test' });
    expect(result).toEqual({ status: 'failed' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain(config.privateKey);
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });

  it('rejects malformed VAPID configuration without including values in errors', async () => {
    const { config } = await fixture();
    for (const invalid of [{ ...config, publicKey: 'invalid' }, { ...config, privateKey: 'invalid' }, { ...config, subject: 'https://' }]) {
      let caught: unknown;
      try { createVapidSender(invalid); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(Error);
      expect(String(caught)).not.toContain(config.privateKey);
    }
  });

  it('fails closed for mismatched keys, invalid subscription keys, unsafe endpoints and oversized messages', async () => {
    const { config, subscription } = await fixture();
    const other = await fixture();
    const fetcher = vi.spyOn(globalThis, 'fetch');
    const cases = [
      { config: { ...config, privateKey: other.config.privateKey }, subscription, body: 'test' },
      { config, subscription: { ...subscription, p256dh: 'invalid' }, body: 'test' },
      { config, subscription: { ...subscription, auth: 'invalid' }, body: 'test' },
      { config, subscription: { ...subscription, endpoint: 'https://127.0.0.1/private' }, body: 'test' },
      { config, subscription: { ...subscription, endpoint: 'https://fcm.googleapis.com.attacker.test/push' }, body: 'test' },
      { config, subscription: { ...subscription, endpoint: 'http://fcm.googleapis.com/push' }, body: 'test' },
      { config, subscription, body: 'x'.repeat(4000) },
    ];
    for (const input of cases) expect(await createVapidSender(input.config, createWebPushTransport()).send(input.subscription, { title: 'Madar', body: input.body })).toEqual({ status: 'failed' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
