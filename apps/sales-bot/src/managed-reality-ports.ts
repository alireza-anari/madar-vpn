/** Optional direct REALITY ports: same account UUID and common loopback meter.
 * Alternative ports are not automatically assumed reachable from Iran.
 * Only ports explicitly approved and ACKed by the managed node may be sold.
 */
export const ALLOWED_MANAGED_REALITY_PORTS = [2053, 8443] as const;
export type ManagedRealityPort = (typeof ALLOWED_MANAGED_REALITY_PORTS)[number];

export function validateManagedRealityPorts(value: unknown): ManagedRealityPort[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2 ||
      value.some((port: unknown) =>
        !Number.isSafeInteger(port) ||
        !ALLOWED_MANAGED_REALITY_PORTS.includes(port as ManagedRealityPort)) ||
      new Set(value).size !== value.length
  ) throw Error("INVALID_MANAGED_REALITY_PORTS");
  return [...value].sort((a, b) => a - b) as ManagedRealityPort[];
}

/** Missing metadata MUST be interpreted as disabled, not as a default set. */
export async function readApprovedRealityPorts(
  db: D1Database,
  nodeId: string,
): Promise<ManagedRealityPort[] | null> {
  const prefix = "managed_reality_alt:" + nodeId + ":";
  const rows = await db.prepare(
    "SELECT key,value FROM settings WHERE key IN (?,?,?,?)",
  ).bind(
    prefix + "enabled", prefix + "ports",
    prefix + "reachability_confirmed", prefix + "auto_installed",
  )
    .all<{key:string;value:string}>();
  const values = new Map(rows.results.map(row => [row.key, row.value]));
  // Fresh installs can automatically provision secondary listeners. This is
  // NOT a claim of mobile-carrier reachability: publication still requires
  // exact signed policy and an actual live metered listener ACK.
  if (values.get(prefix + "enabled") !== "1" ||
      (values.get(prefix + "reachability_confirmed") !== "1" &&
       values.get(prefix + "auto_installed") !== "1")) return null;
  try {
    return validateManagedRealityPorts(JSON.parse(values.get(prefix + "ports") || ""));
  } catch {
    return null;
  }
}

/**
 * Never expose additional ports unless settings, exact signed policy, fresh
 * ACK and the node's live optional listener capability all agree.
 */
export function approvedRealityPortsForDelivery(
  node: {
    id: string;
    state: string;
    revision: number;
    acked_revision: number;
    healthy: number;
    last_seen: number;
    agent_capabilities: string;
  },
  policy: {version?:number; nodeId?:string; revision?:number;
           expiresAt?:number; realityAltPorts?:unknown},
  settings: readonly number[] | null,
  now: number,
): ManagedRealityPort[] {
  if (!settings || node.state !== "ready" || node.healthy !== 1 ||
      node.revision < 1 || node.revision !== node.acked_revision ||
      node.last_seen <= now - 90 ||
      policy.version !== 2 || policy.nodeId !== node.id ||
      policy.revision !== node.revision ||
      !Number.isSafeInteger(policy.expiresAt) ||
      (policy.expiresAt as number) <= now ||
      (policy.expiresAt as number) > now + 330 ||
      !node.agent_capabilities.split(",").includes("quota-v2") ||
      !node.agent_capabilities.split(",").includes("per-account-process") ||
      !node.agent_capabilities.split(",").includes("shared-443") ||
      !node.agent_capabilities.split(",").includes("reality-alt-metered")
  ) return [];
  try {
    const configured = validateManagedRealityPorts(settings);
    const signed = validateManagedRealityPorts(policy.realityAltPorts);
    if (JSON.stringify(configured) !== JSON.stringify(signed)) return [];
    return configured;
  } catch {
    return [];
  }
}
