import { isValidSni } from "./connection-config";
import { publicTarget } from "./targets";

/**
 * Production delivery contract for an additional, quota-metered VMess over WSS
 * endpoint. Never generate a commercial config for temporary Quick Tunnels.
 *
 * The same UUID is intentionally used as the primary REALITY account: the
 * managed node must bind both inbound identities to the same per-account
 * loopback Xray process, which is the only authority for traffic/quota.
 */
export interface ManagedWsFallback {
  type: "vmess-ws-aead";
  hostname: string;
  path: string;
  /** Port 2087 is permitted only for a verified public-IP TLS certificate. */
  port?: 2087;
}

export interface VmessWsInput extends ManagedWsFallback {
  uuid: string;
  label: string;
}

export interface ParsedVmessWs {
  uuid: string;
  hostname: string;
  path: string;
  port: 443 | 2087;
  label: string;
}

const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const PATH = /^\/madar-[a-f0-9]{24}$/;
const LABEL = /^[A-Za-z0-9_-]{1,64}$/;
const KEYS = ["v", "ps", "add", "port", "id", "aid", "scy", "net",
  "type", "host", "path", "tls", "sni"] as const;

function fail(): never {
  throw new Error("INVALID_MANAGED_WS_FALLBACK");
}

export function validateManagedWsFallback(
  value: unknown,
): ManagedWsFallback {
  if (!value || typeof value !== "object") fail();
  const item = value as Partial<ManagedWsFallback>;
  const hostname = item.hostname;
  const port = item.port;
  const ipTransport = port === 2087;
  let isPublicIpv4 = false;
  if (ipTransport && typeof hostname === "string") {
    try { isPublicIpv4 = publicTarget(hostname) === hostname && hostname.includes("."); }
    catch { isPublicIpv4 = false; }
  }
  if (
    item.type !== "vmess-ws-aead" ||
    typeof hostname !== "string" ||
    !(ipTransport ? isPublicIpv4 : isValidSni(hostname)) ||
    hostname !== hostname.toLowerCase() ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "trycloudflare.com" ||
    hostname.endsWith(".trycloudflare.com") ||
    hostname.endsWith(".cfargotunnel.com") ||
    (port !== undefined && port !== 2087) ||
    typeof item.path !== "string" ||
    !PATH.test(item.path)
  ) fail();
  return { type: "vmess-ws-aead", hostname, path: item.path, ...(ipTransport ? { port: 2087 as const } : {}) };
}

/** Canonical VMess import URI, with encrypted payload end-to-end to the node. */
export function buildManagedVmessWsConfig(input: VmessWsInput): string {
  const endpoint = validateManagedWsFallback(input);
  if (!UUID.test(input.uuid) || !LABEL.test(input.label)) fail();
  const document = {
    v: "2",
    ps: input.label,
    add: endpoint.hostname,
    port: String(endpoint.port || 443),
    id: input.uuid,
    aid: "0",
    scy: "aes-128-gcm",
    net: "ws",
    type: "none",
    host: endpoint.hostname,
    path: endpoint.path,
    tls: "tls",
    sni: endpoint.hostname,
  };
  const uri = "vmess://" + btoa(JSON.stringify(document));
  const parsed = parseManagedVmessWsConfig(uri);
  if (
    parsed.uuid !== input.uuid ||
    parsed.hostname !== endpoint.hostname ||
    parsed.path !== endpoint.path ||
    parsed.label !== input.label ||
    parsed.port !== (endpoint.port || 443)
  ) fail();
  return uri;
}

export function parseManagedVmessWsConfig(uri: string): ParsedVmessWs {
  if (!/^vmess:\/\/[A-Za-z0-9+/]+={0,2}$/.test(uri)) fail();
  let parsed: Record<string, unknown>;
  try {
    const raw = uri.slice("vmess://".length);
    if (btoa(atob(raw)) !== raw) fail();
    parsed = JSON.parse(atob(raw)) as Record<string, unknown>;
  } catch {
    return fail();
  }
  if (!parsed || Array.isArray(parsed) ||
      Object.keys(parsed).length !== KEYS.length ||
      Object.keys(parsed).some((key) => !KEYS.includes(key as typeof KEYS[number])) ||
      parsed.v !== "2" ||
      !["443","2087"].includes(String(parsed.port)) ||
      parsed.aid !== "0" ||
      parsed.scy !== "aes-128-gcm" ||
      parsed.net !== "ws" ||
      parsed.type !== "none" ||
      parsed.tls !== "tls" ||
      parsed.add !== parsed.host ||
      parsed.add !== parsed.sni ||
      typeof parsed.id !== "string" ||
      !UUID.test(parsed.id) ||
      typeof parsed.ps !== "string" ||
      !LABEL.test(parsed.ps)
  ) fail();
  const endpoint = validateManagedWsFallback({
    type: "vmess-ws-aead",
    hostname: parsed.add,
    path: parsed.path,
    ...(parsed.port === "2087" ? { port: 2087 } : {}),
  });
  return {
    uuid: parsed.id,
    hostname: endpoint.hostname,
    path: endpoint.path,
    port: endpoint.port || 443,
    label: parsed.ps,
  };
}

/**
 * A fallback is deliverable ONLY if the current signed quota policy carries
 * its exact endpoint AND the node ACK advertises a genuine metered route.
 * The optional rollout gate remains OFF without an explicit admin setting.
 */
export function managedWsFallbackIsDeliverable(
  transport: unknown,
  capabilities: ReadonlySet<string>,
  adminEnabled: boolean,
  termsApproved: boolean,
): transport is ManagedWsFallback {
  if (!adminEnabled || !termsApproved ||
      !capabilities.has("quota-v2") ||
      !capabilities.has("per-account-process") ||
      !capabilities.has("shared-443") ||
      !capabilities.has("ws-metered")
  ) return false;
  try {
    validateManagedWsFallback(transport);
    return true;
  } catch {
    return false;
  }
}

/**
 * Settings are deliberately per-node and fail-closed. Absence of any key
 * leaves all existing customers on the original, proven REALITY transport.
 * No automatic enabling from a successful temporary Quick Tunnel test.
 */
export async function readManagedWsRollout(
  db: D1Database,
  nodeId: string,
): Promise<ManagedWsFallback | null> {
  const prefix = "managed_ws:" + nodeId + ":";
  const rows = await db.prepare(
    "SELECT key,value FROM settings WHERE key IN (?,?,?,?)",
  ).bind(
    prefix + "enabled",
    prefix + "terms_approved",
    prefix + "hostname",
    prefix + "path",
  ).all<{ key: string; value: string }>();
  const values = new Map(rows.results.map((row) => [row.key, row.value]));
  if (
    values.get(prefix + "enabled") !== "1" ||
    values.get(prefix + "terms_approved") !== "1"
  ) return null;
  try {
    return validateManagedWsFallback({
      type: "vmess-ws-aead",
      hostname: values.get(prefix + "hostname"),
      path: values.get(prefix + "path"),
    });
  } catch {
    return null;
  }
}

/**
 * Admin UI status follows exactly the same signed-policy/ACK prerequisites
 * as a customer delivery. An old ACK after hostname rotation or a disabled
 * route must never be presented to an operator as ready for sale.
 */
export interface ManagedWsNodeStatus {
  id: string;
  state: string;
  healthy: number;
  last_seen: number;
  revision: number;
  acked_revision: number;
  policy_payload: string | null;
  agent_capabilities: string;
}

export function managedWsStatusReady(
  node: ManagedWsNodeStatus,
  approvedEndpoint: ManagedWsFallback | null,
  now: number,
): boolean {
  if (!approvedEndpoint || node.state !== "ready" ||
      node.healthy !== 1 ||
      !Number.isSafeInteger(node.last_seen) ||
      node.last_seen <= now - 90 ||
      !Number.isSafeInteger(node.revision) ||
      node.revision < 1 ||
      node.revision !== node.acked_revision ||
      !node.policy_payload) return false;

  const capabilities = new Set(
    node.agent_capabilities.split(",").map(v => v.trim()).filter(Boolean),
  );
  if (!managedWsFallbackIsDeliverable(approvedEndpoint, capabilities, true, true))
    return false;

  try {
    const p = JSON.parse(node.policy_payload) as {
      version?: number;
      nodeId?: string;
      revision?: number;
      expiresAt?: number;
      wsFallback?: unknown;
    };
    return p.version === 2 &&
      p.nodeId === node.id &&
      p.revision === node.revision &&
      Number.isSafeInteger(p.expiresAt) &&
      (p.expiresAt as number) > now &&
      (p.expiresAt as number) <= now + 330 &&
      JSON.stringify(p.wsFallback) === JSON.stringify(approvedEndpoint);
  } catch {
    return false;
  }
}
