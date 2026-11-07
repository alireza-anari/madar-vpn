import { expect, test } from "vitest";
import {
  ALLOWED_MANAGED_REALITY_PORTS,
  approvedRealityPortsForDelivery,
  validateManagedRealityPorts,
} from "../src/managed-reality-ports";

const now = 100;
const capabilities = [
  "quota-v2", "per-account-process", "shared-443", "reality-alt-metered",
].join(",");
const node = {
  id: "n", state: "ready", revision: 5, acked_revision: 5,
  healthy: 1, last_seen: 100, agent_capabilities: capabilities,
};
const policy = {
  version: 2, nodeId: "n", revision: 5, expiresAt: 400,
  realityAltPorts: [2053, 8443],
};

test("strict port whitelist excludes original 443 and quota backend ports", () => {
  expect(ALLOWED_MANAGED_REALITY_PORTS).toEqual([2053, 8443]);
  expect(validateManagedRealityPorts([8443, 2053])).toEqual([2053, 8443]);
  for (const ports of [
    [], [443], [80], [22], [20000], [18080],
    [8443, 8443], [2053, 8443, 443], [8443, "2053"],
    [null], [false], "8443", null,
  ]) expect(() => validateManagedRealityPorts(ports)).toThrow(
    "INVALID_MANAGED_REALITY_PORTS",
  );
});

test("never include a port without exact current signed policy and capability", () => {
  expect(approvedRealityPortsForDelivery(node, policy, [8443, 2053], now))
    .toEqual([2053, 8443]);
  for (const bad of [
    { node: {...node, state: "verifying"}, policy },
    { node: {...node, healthy: 0}, policy },
    { node: {...node, acked_revision: 4}, policy },
    { node: {...node, revision: 6}, policy },
    { node: {...node, last_seen: now - 91}, policy },
    { node: {...node, agent_capabilities: capabilities.replace("reality-alt-metered", "")}, policy },
    { node, policy: {...policy, revision: 4} },
    { node, policy: {...policy, nodeId: "other"} },
    { node, policy: {...policy, expiresAt: now - 1} },
    { node, policy: {...policy, realityAltPorts: [8443]} },
    { node, policy: {...policy, realityAltPorts: [443]} },
    { node, policy: {...policy, realityAltPorts: undefined} },
  ]) expect(
    approvedRealityPortsForDelivery(bad.node, bad.policy, [2053, 8443], now),
  ).toEqual([]);
  expect(approvedRealityPortsForDelivery(node, policy, null, now)).toEqual([]);
});
