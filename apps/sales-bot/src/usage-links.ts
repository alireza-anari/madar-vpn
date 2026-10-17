import { createHmac, timingSafeEqual } from "node:crypto";

type UsageEnv = {
  PUBLIC_BASE_URL: string;
  USAGE_LINK_SECRET?: string;
  POLICY_SIGNING_SECRET?: string;
};

function secretFrom(env: UsageEnv): string {
  const value = env.USAGE_LINK_SECRET || env.POLICY_SIGNING_SECRET || "";
  if (value.length < 16) throw Error("USAGE_LINK_SECRET_REQUIRED");
  return value;
}

function signature(secret: string, payload: string) {
  return createHmac("sha256", secret)
    .update(`madar-usage-v2:${payload}`)
    .digest("base64url");
}

export function createUsageToken(secret: string, accountId: string): string {
  if (secret.length < 16 || !accountId || accountId.length > 120)
    throw Error("INVALID_USAGE_TOKEN_INPUT");
  const payload = Buffer.from(accountId, "utf8").toString("base64url");
  return `v2.${payload}.${signature(secret, payload)}`;
}

export function verifyUsageToken(secret: string, token: string): string | null {
  if (secret.length < 16 || token.length > 512) return null;
  const match = /^v2\.([A-Za-z0-9_-]{1,200})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!match) return null;
  const expected = Buffer.from(signature(secret, match[1]!), "utf8");
  const actual = Buffer.from(match[2]!, "utf8");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  try {
    const accountId = Buffer.from(match[1]!, "base64url").toString("utf8");
    if (!accountId || accountId.length > 120 || accountId.includes("\0")) return null;
    return accountId;
  } catch {
    return null;
  }
}

export function usageUrl(env: UsageEnv, accountId: string): string {
  const base = env.PUBLIC_BASE_URL.replace(/\/+$/, "");
  if (!/^https:\/\//.test(base)) throw Error("INVALID_PUBLIC_BASE_URL");
  return `${base}/usage/v2/${createUsageToken(secretFrom(env), accountId)}`;
}

export function verifyUsageTokenForEnv(env: UsageEnv, token: string): string | null {
  try {
    return verifyUsageToken(secretFrom(env), token);
  } catch {
    return null;
  }
}
