import { createHmac } from "node:crypto";
import { equalSecret, resolveActor } from "./auth";
import { admin, type Actor } from "./contracts";
import { resolveSalesActor, type SalesActor } from "./resellers";
import {
  upsertTelegramProfile,
  type VerifiedTelegramUser,
} from "./telegram-profiles";

function boundedProfileString(
  user: Record<string, unknown>,
  key: string,
  max: number,
): string | null {
  const value = user[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

export function verifyMiniAppTelegramUser(
  initData: string,
  env: Pick<Env, "BOT_TOKEN">,
  now: number,
): VerifiedTelegramUser {
  if (!env.BOT_TOKEN || initData.length > 8192)
    throw new Error("INVALID_SIGNATURE");
  const p = new URLSearchParams(initData);
  const keys = [...p.keys()];
  if (new Set(keys).size !== keys.length) throw new Error("INVALID_SIGNATURE");
  const signature = p.get("hash") || "";
  if (!/^[a-f0-9]{64}$/.test(signature)) throw new Error("INVALID_SIGNATURE");
  p.delete("hash");
  const secret = createHmac("sha256", "WebAppData")
    .update(env.BOT_TOKEN)
    .digest();
  const value = [...p.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const expected = createHmac("sha256", secret).update(value).digest("hex");
  if (!equalSecret(expected, signature)) throw new Error("INVALID_SIGNATURE");
  const date = Number(p.get("auth_date"));
  if (!Number.isSafeInteger(date) || date > now + 30 || now - date > 300)
    throw new Error("AUTH_EXPIRED");
  let rawUser: unknown;
  try {
    rawUser = JSON.parse(p.get("user") || "null");
  } catch {
    throw new Error("INVALID_SIGNATURE");
  }
  if (!rawUser || typeof rawUser !== "object")
    throw new Error("INVALID_SIGNATURE");
  const user = rawUser as Record<string, unknown>;
  if (!Number.isSafeInteger(user.id) || Number(user.id) <= 0)
    throw new Error("INVALID_SIGNATURE");
  return {
    telegramId: String(user.id),
    username: boundedProfileString(user, "username", 64),
    firstName: boundedProfileString(user, "first_name", 128),
    lastName: boundedProfileString(user, "last_name", 128),
  };
}

export function verifyMiniAppTelegramId(
  initData: string,
  env: Pick<Env, "BOT_TOKEN">,
  now: number,
): string {
  return verifyMiniAppTelegramUser(initData, env, now).telegramId;
}

export async function authenticateMiniApp(
  initData: string,
  env: Env,
  now: number,
): Promise<SalesActor> {
  const profile = verifyMiniAppTelegramUser(initData, env, now);
  await upsertTelegramProfile(env.SALES_DB, profile, now);
  const actor = await resolveSalesActor(env.SALES_DB, profile.telegramId, env);
  if (actor.role === "ordinary") {
    const reseller = await env.SALES_DB.prepare(
      "SELECT enabled FROM resellers WHERE telegram_id=?",
    )
      .bind(profile.telegramId)
      .first<{ enabled: number }>();
    if (reseller?.enabled === 0) throw Error("SELLER_DISABLED");
  }
  return actor;
}

export async function verifyMiniApp(
  initData: string,
  env: Env,
  now: number,
): Promise<Actor> {
  const telegramId = verifyMiniAppTelegramId(initData, env, now);
  const actor = resolveActor(telegramId, env);
  admin(actor);
  return actor;
}
