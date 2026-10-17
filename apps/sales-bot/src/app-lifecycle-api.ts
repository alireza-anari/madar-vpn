import { authenticateMiniApp } from "./miniapp-auth";
import { requireSalesAdmin } from "./resellers";
import { revokeAccount } from "./accounts";
import { archiveAccount } from "./account-lifecycle";
import { listVisibleAppConfigs, loadAppConfigDetail } from "./app-configs";

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function appLifecycleApi(
  request: Request,
  env: Env,
  now: number,
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  const isList = request.method === "GET" && path === "/api/app/configs";
  const detail = request.method === "GET" ? path.match(/^\/api\/app\/configs\/([^/]+)$/) : null;
  const revoke = request.method === "POST" ? path.match(/^\/api\/app\/configs\/([^/]+)\/revoke$/) : null;
  const archive = request.method === "POST" ? path.match(/^\/api\/app\/configs\/([^/]+)\/archive$/) : null;
  if (!isList && !detail && !revoke && !archive) return null;

  try {
    const actor = await authenticateMiniApp(
      request.headers.get("X-Telegram-Init-Data") || "",
      env,
      now,
    );
    if (isList)
      return json(
        await listVisibleAppConfigs(
          env.SALES_DB,
          actor,
          now,
          url.searchParams.get("cursor") || undefined,
        ),
      );
    const encodedId = detail?.[1] || revoke?.[1] || archive?.[1] || "";
    const id = decodeURIComponent(encodedId);
    if (detail) return json(await loadAppConfigDetail(env.SALES_DB, actor, id, now));

    requireSalesAdmin(actor);
    await loadAppConfigDetail(env.SALES_DB, actor, id, now);
    if (revoke) await revokeAccount(env.SALES_DB, actor, id, now);
    if (archive) await archiveAccount(env.SALES_DB, actor, id, now);
    return json(await loadAppConfigDetail(env.SALES_DB, actor, id, now));
  } catch (error) {
    const code = error instanceof Error ? error.message : "REQUEST_FAILED";
    if (
      ["INVALID_SIGNATURE", "AUTH_EXPIRED", "SELLER_DISABLED", "SELLER_REQUIRED", "ADMIN_REQUIRED"].includes(code)
    )
      return json({ error: code }, 403);
    if (code === "ACCOUNT_NOT_FOUND") return json({ error: code }, 404);
    if (code === "INVALID_CURSOR") return json({ error: code }, 400);
    return json({ error: "REQUEST_FAILED" }, 400);
  }
}
