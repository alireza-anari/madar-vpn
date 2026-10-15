import { createHmac } from "node:crypto";
import { equalSecret, resolveActor } from "./auth";
import { admin, type Actor } from "./contracts";
export async function verifyMiniApp(
  initData: string,
  env: Env,
  now: number,
): Promise<Actor> {
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
  const user: unknown = JSON.parse(p.get("user") || "null");
  if (
    !user ||
    typeof user !== "object" ||
    !("id" in user) ||
    !Number.isSafeInteger(user.id) ||
    Number(user.id) <= 0
  )
    throw new Error("INVALID_SIGNATURE");
  const actor = resolveActor(String(user.id), env);
  admin(actor);
  return actor;
}
