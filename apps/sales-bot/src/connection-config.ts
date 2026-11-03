import { publicTarget } from "./targets";

export type VlessFlow = "" | "xtls-rprx-vision";

export interface VlessRealityConfigInput {
  uuid: string;
  host: string;
  port: number;
  sni: string;
  publicKey: string;
  shortId: string;
  flow: VlessFlow;
  label: string;
}

export interface ParsedVlessRealityConfig {
  uuid: string;
  host: string;
  port: number;
  sni: string;
  publicKey: string;
  shortId: string;
  flow: VlessFlow;
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SNI = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/;
const PUBLIC_KEY = /^[A-Za-z0-9_-]{43}$/;
const SHORT_ID = /^(?:[a-f0-9]{2}){1,8}$/;
const REQUIRED_QUERY = ["encryption", "security", "sni", "fp", "pbk", "sid", "type"] as const;

function fail(): never {
  throw new Error("INVALID_VLESS_REALITY_CONFIG");
}

function normalizeHost(value: string): string {
  if (typeof value !== "string" || !value || value.trim() !== value) fail();
  try {
    return publicTarget(value);
  } catch {
    return fail();
  }
}

export function parseVlessRealityConfig(value: string): ParsedVlessRealityConfig {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail();
  }
  if (
    url.protocol !== "vless:" ||
    !UUID.test(url.username) ||
    url.password ||
    url.pathname ||
    !url.port ||
    !url.hash
  ) fail();

  const hostValue = url.hostname.startsWith("[") && url.hostname.endsWith("]")
    ? url.hostname.slice(1, -1)
    : url.hostname;
  const host = normalizeHost(hostValue);
  const port = Number(url.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) fail();

  const params = url.searchParams;
  const keys = [...params.keys()];
  if (
    keys.length !== REQUIRED_QUERY.length + (params.has("flow") ? 1 : 0) ||
    keys.some((key) => ![...REQUIRED_QUERY, "flow"].includes(key as typeof REQUIRED_QUERY[number] | "flow")) ||
    new Set(keys).size !== keys.length
  ) fail();
  for (const key of REQUIRED_QUERY) {
    if (params.getAll(key).length !== 1) fail();
  }
  if (
    params.get("encryption") !== "none" ||
    params.get("security") !== "reality" ||
    params.get("fp") !== "chrome" ||
    params.get("type") !== "tcp"
  ) fail();

  const sni = params.get("sni") || "";
  const publicKey = params.get("pbk") || "";
  const shortId = params.get("sid") || "";
  const flowValues = params.getAll("flow");
  const flow = flowValues.length === 0 ? "" : flowValues[0];
  if (
    !SNI.test(sni) ||
    !PUBLIC_KEY.test(publicKey) ||
    !SHORT_ID.test(shortId) ||
    (flow !== "" && flow !== "xtls-rprx-vision") ||
    (flowValues.length > 0 && !flow)
  ) fail();

  return { uuid: url.username, host, port, sni, publicKey, shortId, flow };
}

export function buildVlessRealityConfig(input: VlessRealityConfigInput): string {
  if (
    !input ||
    !UUID.test(input.uuid) ||
    !Number.isSafeInteger(input.port) ||
    input.port < 1 ||
    input.port > 65535 ||
    !SNI.test(input.sni) ||
    !PUBLIC_KEY.test(input.publicKey) ||
    !SHORT_ID.test(input.shortId) ||
    (input.flow !== "" && input.flow !== "xtls-rprx-vision") ||
    typeof input.label !== "string" ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(input.label)
  ) fail();

  const host = normalizeHost(input.host);
  const authority = host.includes(":") ? `[${host}]` : host;
  const url = new URL(`vless://${input.uuid}@${authority}:${input.port}`);
  url.searchParams.set("encryption", "none");
  if (input.flow) url.searchParams.set("flow", input.flow);
  url.searchParams.set("security", "reality");
  url.searchParams.set("sni", input.sni);
  url.searchParams.set("fp", "chrome");
  url.searchParams.set("pbk", input.publicKey);
  url.searchParams.set("sid", input.shortId);
  url.searchParams.set("type", "tcp");
  url.hash = input.label;

  const config = url.toString();
  const parsed = parseVlessRealityConfig(config);
  if (
    parsed.uuid !== input.uuid ||
    parsed.host !== host ||
    parsed.port !== input.port ||
    parsed.sni !== input.sni ||
    parsed.publicKey !== input.publicKey ||
    parsed.shortId !== input.shortId ||
    parsed.flow !== input.flow
  ) fail();
  return config;
}
