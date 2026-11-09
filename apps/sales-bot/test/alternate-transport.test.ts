import { expect, test } from "vitest";
import {
  buildManagedVmessWsConfig,
  managedWsFallbackIsDeliverable,
  managedWsStatusReady,
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
    port: 443,
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

test("admin readiness requires current ACK and the exact approved signed endpoint", () => {
  const now = 200;
  const policy = {
    version: 2, nodeId: "n", revision: 5, expiresAt: now + 300,
    clients: [], wsFallback: endpoint,
  };
  const node = {
    id: "n", state: "ready", healthy: 1, last_seen: now,
    revision: 5, acked_revision: 5, policy_payload: JSON.stringify(policy),
    agent_capabilities: [...ready].join(","),
  };
  expect(managedWsStatusReady(node, endpoint, now)).toBe(true);
  expect(managedWsStatusReady(node, null, now)).toBe(false);
  for (const bad of [
    { state: "verifying" },
    { healthy: 0 },
    { last_seen: now - 91 },
    { revision: 6 },
    { acked_revision: 4 },
    { agent_capabilities: "quota-v2,per-account-process" },
    { policy_payload: "invalid json" },
    { policy_payload: JSON.stringify({...policy, revision: 4}) },
    { policy_payload: JSON.stringify({...policy, nodeId: "other"}) },
    { policy_payload: JSON.stringify({...policy, expiresAt: now - 1}) },
    { policy_payload: JSON.stringify({...policy, wsFallback: {
        ...endpoint, path: "/madar-" + "b".repeat(24),
      }}) },
  ]) {
    expect(managedWsStatusReady({...node, ...bad}, endpoint, now)).toBe(false);
  }
});

test("valid trusted-IP field WSS transport is bound to same node on 2087, never on port 443", () => {
  const ip = { ...endpoint, hostname: "8.8.8.8", port: 2087 as const };
  const uri = buildManagedVmessWsConfig({
    ...ip, uuid: input.uuid, label: "Madar-IP-WSS",
  });
  const decoded = JSON.parse(atob(uri.slice("vmess://".length)));
  expect(decoded).toMatchObject({
    add: "8.8.8.8", host: "8.8.8.8", sni: "8.8.8.8",
    port: "2087", tls: "tls", net: "ws",
  });
  expect(parseManagedVmessWsConfig(uri)).toMatchObject({
    uuid: input.uuid, hostname: "8.8.8.8", port: 2087, path: endpoint.path,
  });
  for (const hostname of ["127.0.0.1","10.0.0.2","192.168.1.1","169.254.1.1","0.0.0.0"]) {
    expect(() => validateManagedWsFallback({ ...ip, hostname })).toThrow();
  }
  for (const port of [80, 443, 8443, "2087", null]) {
    expect(() => validateManagedWsFallback({ ...ip, port })).toThrow();
  }
  expect(() => validateManagedWsFallback({ ...endpoint, hostname: "8.8.8.8" })).toThrow();
  expect(() => validateManagedWsFallback({ ...endpoint, port: 2087 })).toThrow();
});
