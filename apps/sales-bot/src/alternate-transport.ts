import { isValidSni } from "./connection-config";

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
}

export interface VmessWsInput extends ManagedWsFallback {
  uuid: string;
  label: string;
}

export interface ParsedVmessWs {
  uuid: string;
  hostname: string;
  path: string;
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
  if (
    item.type !== "vmess-ws-aead" ||
    typeof hostname !== "string" ||
    !isValidSni(hostname) ||
    hostname !== hostname.toLowerCase() ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "trycloudflare.com" ||
    hostname.endsWith(".trycloudflare.com") ||
    hostname.endsWith(".cfargotunnel.com") ||
    typeof item.path !== "string" ||
    !PATH.test(item.path)
  ) fail();
  return { type: "vmess-ws-aead", hostname, path: item.path };
}

/** Canonical VMess import URI, with encrypted payload end-to-end to the node. */
export function buildManagedVmessWsConfig(input: VmessWsInput): string {
  const endpoint = validateManagedWsFallback(input);
  if (!UUID.test(input.uuid) || !LABEL.test(input.label)) fail();
  const document = {
    v: "2",
    ps: input.label,
    add: endpoint.hostname,
    port: "443",
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
    parsed.label !== input.label
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
      parsed.port !== "443" ||
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
  });
  return {
    uuid: parsed.id,
    hostname: endpoint.hostname,
    path: endpoint.path,
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
