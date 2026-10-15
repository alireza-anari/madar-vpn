import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import { resetDb } from "./db";
import { bootstrapPair } from "../src/ops-bootstrap";
let identity: { publicKey: JsonWebKey; fingerprint: string };
beforeEach(async () => {
  await resetDb();
  await env.SALES_DB.exec(
    "CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);",
  );
  const keys = await crypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 3072,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["encrypt", "decrypt"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
  const publicKey = {
    kty: jwk.kty!,
    n: jwk.n!,
    e: jwk.e!,
    alg: "RSA-OAEP-256",
    ext: true,
    key_ops: ["encrypt"],
  };
  const canonical = JSON.stringify(publicKey, Object.keys(publicKey).sort());
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  identity = {
    publicKey,
    fingerprint: Array.from(new Uint8Array(digest), (x) =>
      x.toString(16).padStart(2, "0"),
    ).join(""),
  };
});
const req = (body = identity, ip = "56.228.6.3") =>
  new Request("https://bot.example/ops/runner-bootstrap/pair", {
    method: "POST",
    headers: { "CF-Connecting-IP": ip },
    body: JSON.stringify(body),
  });
it("denies other hosts and expired pairing without storing a candidate", async () => {
  expect(
    (await bootstrapPair(req(identity, "1.1.1.1"), env, 100, 200)).status,
  ).toBe(403);
  expect((await bootstrapPair(req(), env, 201, 200)).status).toBe(410);
  expect(
    await env.SALES_DB.prepare(
      "SELECT key FROM settings WHERE key='runner_bootstrap_candidate'",
    ).first(),
  ).toBeNull();
});
it("pins the first public identity, refuses mismatches and returns only approved ciphertext", async () => {
  let r = await bootstrapPair(req(), env, 100, 200);
  expect(await r.json()).toEqual({
    pending: true,
    fingerprint: identity.fingerprint,
  });
  r = await bootstrapPair(
    req({ ...identity, fingerprint: "a".repeat(64) }),
    env,
    101,
    200,
  );
  expect(r.status).toBe(400);
  await env.SALES_DB.prepare(
    "INSERT INTO settings(key,value) VALUES('runner_bootstrap_envelope',?)",
  )
    .bind(
      JSON.stringify({
        fingerprint: identity.fingerprint,
        envelope: {
          v: 1,
          key: "encrypted",
          iv: "encrypted",
          data: "encrypted",
        },
      }),
    )
    .run();
  r = await bootstrapPair(req(), env, 102, 200);
  const result = await r.json();
  expect(result).toEqual({
    envelope: { v: 1, key: "encrypted", iv: "encrypted", data: "encrypted" },
  });
  expect(JSON.stringify(result)).not.toContain("serviceSecret");
});
it("never replaces a pinned identity and bounds request size", async () => {
  await bootstrapPair(req(), env, 100, 200);
  await env.SALES_DB.prepare(
    "UPDATE settings SET value=? WHERE key='runner_bootstrap_candidate'",
  )
    .bind(JSON.stringify({ fingerprint: "other-key" }))
    .run();
  expect((await bootstrapPair(req(), env, 101, 200)).status).toBe(409);
  const huge = new Request("https://bot.example/ops/runner-bootstrap/pair", {
    method: "POST",
    headers: { "CF-Connecting-IP": "56.228.6.3" },
    body: "x".repeat(4097),
  });
  expect((await bootstrapPair(huge, env, 101, 200)).status).toBe(413);
});
