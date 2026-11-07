import { expect, test } from "vitest";
import {
  buildManagedVmessWsConfig,
  managedWsFallbackIsDeliverable,
  parseManagedVmessWsConfig,
  validateManagedWsFallback,
} from "../src/alternate-transport";

const endpoint = {
  type: "vmess-ws-aead" as const,
  hostname: "edge.madar.example.com",
  path: "/madar-" + "a".repeat(24),
};
const input = {
  ...endpoint,
  uuid: "11111111-1111-4111-8111-111111111111",
  label: "Madar-Irancell-a1b2c3",
};
const ready = new Set([
  "quota-v2", "per-account-process", "shared-443", "ws-metered",
]);

test("builds canonical VMess AES-128-GCM WSS config with encrypted origin payload", () => {
  const uri = buildManagedVmessWsConfig(input);
  const decoded = JSON.parse(atob(uri.slice("vmess://".length)));
  expect(decoded).toMatchObject({
    port: "443",
    id: input.uuid,
    aid: "0",
    scy: "aes-128-gcm",
    net: "ws",
    tls: "tls",
    host: endpoint.hostname,
    path: endpoint.path,
  });
  expect(parseManagedVmessWsConfig(uri)).toEqual({
    uuid: input.uuid,
    hostname: endpoint.hostname,
    path: endpoint.path,
    label: input.label,
  });
});

test("never accepts a temporary quick tunnel or malformed public endpoint", () => {
  const hosts = [
    "foo.trycloudflare.com",
    "trycloudflare.com",
    "edge.cfargotunnel.com",
    "localhost",
    "127.0.0.1",
    "https://example.com",
    "EXAMPLE.COM",
    "a".repeat(64) + ".example.com",
    "example.com/path",
  ];
  for (const hostname of hosts) {
    expect(() =>
      validateManagedWsFallback({ ...endpoint, hostname }),
    ).toThrow("INVALID_MANAGED_WS_FALLBACK");
  }
  for (const path of ["/", "/ws", "/madar-" + "a".repeat(23), "//madar-" + "a".repeat(24)]) {
    expect(() =>
      validateManagedWsFallback({ ...endpoint, path }),
    ).toThrow("INVALID_MANAGED_WS_FALLBACK");
  }
});

test("rejects incorrect UUID, label and changed payload", () => {
  expect(() =>
    buildManagedVmessWsConfig({ ...input, uuid: "not-a-uuid" }),
  ).toThrow();
  expect(() =>
    buildManagedVmessWsConfig({ ...input, label: "bad label" }),
  ).toThrow();
  const document = JSON.parse(atob(buildManagedVmessWsConfig(input).slice(8)));
  for (const change of [
    { port: "8443" },
    { scy: "auto" },
    { aid: "1" },
    { tls: "" },
    { add: "other.example.com" },
    { secret: "injected" },
  ]) {
    expect(() =>
      parseManagedVmessWsConfig("vmess://" + btoa(JSON.stringify({
        ...document, ...change,
      }))),
    ).toThrow("INVALID_MANAGED_WS_FALLBACK");
  }
});

test("fallback is strictly gated by agent capability and both rollout approvals", () => {
  expect(managedWsFallbackIsDeliverable(endpoint, ready, true, true)).toBe(true);
  expect(managedWsFallbackIsDeliverable(endpoint, ready, false, true)).toBe(false);
  expect(managedWsFallbackIsDeliverable(endpoint, ready, true, false)).toBe(false);
  for (const capability of ready) {
    expect(managedWsFallbackIsDeliverable(
      endpoint, new Set([...ready].filter(c => c !== capability)), true, true,
    )).toBe(false);
  }
  expect(managedWsFallbackIsDeliverable(
    { ...endpoint, hostname: "x.trycloudflare.com" }, ready, true, true,
  )).toBe(false);
});
