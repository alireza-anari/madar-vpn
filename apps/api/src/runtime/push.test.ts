import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPostgresRequestRuntime } from './postgres';
import type { PgQueryClient } from '../postgres/client';

const encode = (value: Uint8Array) => btoa(String.fromCharCode(...value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function bindings() {
  const signing = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const privateJwk = await crypto.subtle.exportKey('jwk', signing.privateKey);
  return {
    HYPERDRIVE: { connectionString: 'postgresql://test.invalid/runtime-test' },
    VAPID_PUBLIC_KEY: encode(new Uint8Array(await crypto.subtle.exportKey('raw', signing.publicKey))),
    VAPID_PRIVATE_KEY: privateJwk.d!, VAPID_SUBJECT: 'mailto:ops@example.com',
  };
}
afterEach(() => vi.restoreAllMocks());
describe('PostgreSQL runtime push wiring', () => {
  it('sends persisted subscriptions through real encrypted fetch rather than the unconfigured boundary', async () => {
    const env = await bindings();
    const receiver = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const row = {
      id: 'push-runtime-test', user_id: 'user-test', endpoint: 'https://fcm.googleapis.com/fcm/send/runtime-test',
      p256dh: encode(new Uint8Array(await crypto.subtle.exportKey('raw', receiver.publicKey))),
      auth: encode(crypto.getRandomValues(new Uint8Array(16))), expiration_time: null,
      created_at: '2026-10-14T00:00:00Z', updated_at: '2026-10-14T00:00:00Z',
    };
    const db: PgQueryClient = {
      async connect() {},
      async query<Row extends Record<string, unknown>>() { return { rows: [row as unknown as Row], rowCount: 1 }; },
    };
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 201 }));
    const runtime = await createPostgresRequestRuntime(env, () => db);
    expect(await runtime!.push.sendNotification('user-test', { title: 'Madar', body: 'test' })).toEqual({ delivered: 1, expiredRemoved: 0, failed: 0 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps unrelated runtime services available but disables push for invalid VAPID bindings', async () => {
    const env = { ...await bindings(), VAPID_PUBLIC_KEY: 'malformed' };
    const db: PgQueryClient = { async connect() {}, async query() { return { rows: [], rowCount: 0 }; } };
    const runtime = await createPostgresRequestRuntime(env, () => db);
    expect(runtime!.auth).toBeDefined();
    expect(runtime!.push.getPublicKey()).toBeNull();
  });
});


it('does not expose push readiness for mismatched or invalid curve keys of correct length', async () => {
  const env = await bindings();
  const other = await bindings();
  const db: PgQueryClient = { async connect() {}, async query() { return { rows: [], rowCount: 0 }; } };
  for (const invalid of [
    { ...env, VAPID_PRIVATE_KEY: other.VAPID_PRIVATE_KEY },
    { ...env, VAPID_PRIVATE_KEY: encode(new Uint8Array(32)) },
    { ...env, VAPID_PUBLIC_KEY: encode(new Uint8Array([4, ...new Uint8Array(64)])) },
  ]) {
    const runtime = await createPostgresRequestRuntime(invalid, () => db);
    expect(runtime!.push.getPublicKey()).toBeNull();
  }
});
