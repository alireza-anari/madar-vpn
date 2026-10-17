import type { TelegramUpdate } from "./contracts";
import { handleResellerAdminUi } from "./reseller-admin-ui";
import { handleResellerUpdate as handleDashboardResellerUpdate } from "./reseller-menus-dashboard";

const faDigits = (value: string) =>
  value.replace(/\d/g, (digit) => "۰۱۲۳۴۵۶۷۸۹"[Number(digit)]!);

async function localizeAdminReply(env: Env, updateId: number) {
  const id = `u${updateId}:reply`;
  const raw = await env.SALES_DB.prepare("SELECT payload FROM outbox WHERE id=?")
    .bind(id)
    .first<string>("payload");
  if (!raw) return;
  try {
    const payload = JSON.parse(raw) as Record<string, unknown>;
    if (typeof payload.text !== "string") return;
    payload.text = faDigits(payload.text);
    await env.SALES_DB.prepare("UPDATE outbox SET payload=? WHERE id=?")
      .bind(JSON.stringify(payload), id)
      .run();
  } catch {
    // Durable reply already exists; presentation localization must never fail the action.
  }
}

export async function handleResellerUpdate(
  env: Env,
  u: TelegramUpdate,
  now: number,
) {
  if (await handleResellerAdminUi(env, u, now)) {
    await localizeAdminReply(env, u.update_id);
    return;
  }
  await handleDashboardResellerUpdate(env, u, now);
}
