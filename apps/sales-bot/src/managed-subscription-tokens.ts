import { createHmac, timingSafeEqual } from "node:crypto";

type ManagedSubscriptionEnv = {
  PUBLIC_BASE_URL: string;
  USAGE_LINK_SECRET?: string;
  POLICY_SIGNING_SECRET?: string;
};

function secretFrom(env: ManagedSubscriptionEnv): string {
  const secret = env.USAGE_LINK_SECRET || env.POLICY_SIGNING_SECRET || "";
  if (secret.length < 16) throw Error("SUBSCRIPTION_SECRET_REQUIRED");
  return secret;
}

const ACCOUNT_ID = /^[a-zA-Z0-9_-]{1,120}$/;
const TOKEN = /^m1\.([A-Za-z0-9_-]{1,160})\.([A-Za-z0-9_-]{43})$/;

function signature(secret: string, encodedId: string): string {
  return createHmac("sha256", secret)
    .update("madar-managed-sub-v1:" + encodedId)
    .digest("base64url");
}

export function createManagedSubscriptionToken(
  secret: string,
  accountId: string,
): string {
  if (secret.length < 16 || !ACCOUNT_ID.test(accountId))
    throw Error("INVALID_MANAGED_SUBSCRIPTION_INPUT");
  const encoded = Buffer.from(accountId, "utf8").toString("base64url");
  return `m1.${encoded}.${signature(secret, encoded)}`;
}

export function verifyManagedSubscriptionToken(
  secret: string,
  token: string,
): string | null {
  if (secret.length < 16 || token.length > 256) return null;
  const match = TOKEN.exec(token);
  if (!match) return null;
  const expected = Buffer.from(signature(secret, match[1]!), "utf8");
  const received = Buffer.from(match[2]!, "utf8");
  if (expected.length !== received.length ||
      !timingSafeEqual(expected, received)) return null;
  try {
    const accountId = Buffer.from(match[1]!, "base64url").toString("utf8");
    if (!ACCOUNT_ID.test(accountId) ||
        Buffer.from(accountId, "utf8").toString("base64url") !== match[1]) return null;
    return accountId;
  } catch {
    return null;
  }
}

export function managedSubscriptionUrl(
  env: ManagedSubscriptionEnv,
  accountId: string,
): string {
  const base = new URL(env.PUBLIC_BASE_URL);
  if (
    base.protocol !== "https:" || base.username || base.password ||
    base.search || base.hash || (base.pathname !== "/" && base.pathname !== "")
  ) throw Error("INVALID_SUBSCRIPTION_BASE_URL");
  return `${base.origin}/managed-subscription/v1/${createManagedSubscriptionToken(secretFrom(env), accountId)}`;
}

/** Distinct, base64 VLESS feed for v2rayNG. Old v1 URLs remain untouched. */
export function managedCarrierSubscriptionUrl(
  env: ManagedSubscriptionEnv,
  accountId: string,
): string {
  return managedSubscriptionUrl(env,accountId).replace(
    "/managed-subscription/v1/","/managed-subscription/v2/");
}

export function verifyManagedSubscriptionForEnv(
  env: ManagedSubscriptionEnv,
  token: string,
): string | null {
  try {
    return verifyManagedSubscriptionToken(secretFrom(env), token);
  } catch {
    return null;
  }
}
