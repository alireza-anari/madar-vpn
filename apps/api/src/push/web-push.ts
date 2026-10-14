import type { VapidConfig, VapidTransport } from './vapid';

const encoder = new TextEncoder();
const PUSH_HOSTS = ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'push.services.mozilla.com', 'web.push.apple.com'];

export function decodeBase64Url(value: string, length: number): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid push key material.');
  const bytes = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
  if (bytes.length !== length || encodeBase64Url(bytes) !== value) throw new Error('Invalid push key material.');
  return bytes;
}

function encodeBase64Url(bytes: Uint8Array<ArrayBuffer>): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function concat(...parts: Uint8Array<ArrayBuffer>[]): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}

async function hmac(key: Uint8Array<ArrayBuffer>, input: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const imported = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', imported, input));
}

async function authorization(config: VapidConfig, audience: string): Promise<string> {
  const publicKey = decodeBase64Url(config.publicKey, 65);
  const signing = await crypto.subtle.importKey('jwk', {
    kty: 'EC', crv: 'P-256', x: encodeBase64Url(publicKey.slice(1, 33)), y: encodeBase64Url(publicKey.slice(33)), d: config.privateKey,
  }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const encodedHeader = encodeBase64Url(encoder.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const encodedClaims = encodeBase64Url(encoder.encode(JSON.stringify({ aud: audience, exp: Math.floor(Date.now() / 1000) + 3600, sub: config.subject })));
  const input = encoder.encode(`${encodedHeader}.${encodedClaims}`);
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signing, input));
  const verification = await crypto.subtle.importKey('raw', publicKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  if (!await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, verification, signature, input)) {
    throw new Error('Invalid VAPID key pair.');
  }
  return `vapid t=${encodedHeader}.${encodedClaims}.${encodeBase64Url(signature)}, k=${config.publicKey}`;
}

export async function validateVapidKeyPair(config: VapidConfig): Promise<void> {
  // Import, sign and verify before advertising availability; reject invalid curve/scalar/pair.
  await authorization(config, 'https://push.invalid');
}

/** RFC 8291/8188 single-record aes128gcm; RFC 8292 VAPID. Worker APIs only. */
export function createWebPushTransport(): VapidTransport {
  return {
    async send({ config, subscription, payload }) {
      const endpoint = new URL(subscription.endpoint);
      // User-supplied endpoints must not turn authenticated push into an arbitrary server-side fetch.
      const permitted = PUSH_HOSTS.some(host => endpoint.hostname === host || (host !== 'fcm.googleapis.com' && endpoint.hostname.endsWith(`.${host}`)));
      if (!permitted || endpoint.protocol !== 'https:' || endpoint.port || endpoint.username || endpoint.password || endpoint.hash) {
        throw new Error('Unsupported push endpoint.');
      }
      const receiverPublic = decodeBase64Url(subscription.p256dh, 65);
      if (receiverPublic[0] !== 4) throw new Error('Invalid push key material.');
      const auth = decodeBase64Url(subscription.auth, 16);
      const plaintext = encoder.encode(JSON.stringify(payload));
      if (plaintext.length > 3993) throw new Error('Push payload is too large.');
      const peer = await crypto.subtle.importKey('raw', receiverPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
      const ephemeral = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
      const senderPublic = new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey));
      const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, ephemeral.privateKey, 256));
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const prkKey = await hmac(auth, shared);
      const ikm = await hmac(prkKey, concat(encoder.encode('WebPush: info\0'), receiverPublic, senderPublic, new Uint8Array([1])));
      const prk = await hmac(salt, ikm);
      const cek = (await hmac(prk, encoder.encode('Content-Encoding: aes128gcm\0\x01'))).slice(0, 16);
      const nonce = (await hmac(prk, encoder.encode('Content-Encoding: nonce\0\x01'))).slice(0, 12);
      const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
      const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(plaintext, new Uint8Array([2]))));
      const header = new Uint8Array(21);
      header.set(salt);
      new DataView(header.buffer).setUint32(16, 4096);
      header[20] = senderPublic.length;
      const response = await fetch(endpoint.href, {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10000),
        headers: {
          authorization: await authorization(config, endpoint.origin),
          'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream', ttl: '60',
        },
        body: concat(header, senderPublic, ciphertext),
      });
      // Provider bodies and headers can echo bearer material. Never read or log them.
      await response.body?.cancel();
      return { statusCode: response.status };
    },
  };
}
