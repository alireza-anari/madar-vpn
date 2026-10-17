import type { TelegramUpdate } from "./contracts";
import { handleResellerAdminUi } from "./reseller-admin-ui";
import { handleResellerUpdate as handleDashboardResellerUpdate } from "./reseller-menus-dashboard";

export async function handleResellerUpdate(
  env: Env,
  u: TelegramUpdate,
  now: number,
) {
  if (await handleResellerAdminUi(env, u, now)) return;
  await handleDashboardResellerUpdate(env, u, now);
}
