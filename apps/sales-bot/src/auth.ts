import { timingSafeEqual } from "node:crypto";
import type { Actor, TelegramUpdate } from "./contracts";
export function equalSecret(a: string, b: string) {
  const x = new TextEncoder().encode(a),
    y = new TextEncoder().encode(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export function resolveActor(
  id: string,
  env: Pick<Env, "ADMIN_TELEGRAM_IDS">,
): Actor {
  return {
    telegramId: id,
    role: (env.ADMIN_TELEGRAM_IDS || "").split(",")
      .map((x) => x.trim())
      .filter((x) => /^\d+$/.test(x))
      .includes(id)
      ? "admin"
      : "customer",
  };
}
export async function authenticateUpdate(
  request: Request,
  env: Env,
): Promise<TelegramUpdate | null> {
  if (
    !env.TELEGRAM_WEBHOOK_SECRET ||
    !equalSecret(
      request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "",
      env.TELEGRAM_WEBHOOK_SECRET,
    )
  )
    return null;
  const text = await boundedText(request, 65536);
  const data: unknown = JSON.parse(text);
  if (
    typeof data !== "object" ||
    data === null ||
    !("update_id" in data) ||
    !Number.isSafeInteger(data.update_id) ||
    Number(data.update_id) < 0
  )
    throw new Error("INVALID_UPDATE");
  return data as TelegramUpdate;
}
export async function boundedText(request: Request, max: number) {
  if (Number(request.headers.get("Content-Length")) > max)
    throw new Error("TOO_LARGE");
  const reader = request.body?.getReader();
  if (!reader) return "";
  let size = 0;
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel();
      throw new Error("TOO_LARGE");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return new TextDecoder().decode(out);
}
