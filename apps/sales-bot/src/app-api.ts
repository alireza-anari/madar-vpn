import { authenticateMiniApp } from "./miniapp-auth";
import {
  listAppConfigs,
  listAppNodes,
  loadAppDashboard,
  loadSellerSelfStats,
} from "./app-dashboard";

function json(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function appApi(
  request: Request,
  env: Env,
  now: number,
): Promise<Response> {
  try {
    const actor = await authenticateMiniApp(
      request.headers.get("X-Telegram-Init-Data") || "",
      env,
      now,
    );
    if (actor.role === "ordinary") throw Error("SELLER_REQUIRED");
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method !== "GET") return json({ error: "NOT_FOUND" }, 404);
    if (path === "/api/app/me")
      return json({ telegramId: actor.telegramId, role: actor.role });
    if (path === "/api/app/dashboard")
      return json(await loadAppDashboard(env.SALES_DB, actor, now));
    if (path === "/api/app/nodes") {
      const requested = url.searchParams.get("requestedBytes");
      const requestedBytes = requested === null ? undefined : Number(requested);
      if (
        requestedBytes !== undefined &&
        (!Number.isSafeInteger(requestedBytes) || requestedBytes < 0)
      )
        return json({ error: "INVALID_INPUT" }, 400);
      return json(await listAppNodes(env.SALES_DB, actor, now, requestedBytes));
    }
    if (path === "/api/app/configs")
      return json(
        await listAppConfigs(
          env.SALES_DB,
          actor,
          now,
          url.searchParams.get("cursor") || undefined,
        ),
      );
    if (path === "/api/app/seller/stats") {
      if (actor.role !== "seller") throw Error("SELLER_REQUIRED");
      return json(await loadSellerSelfStats(env.SALES_DB, actor, now));
    }
    return json({ error: "NOT_FOUND" }, 404);
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (["INVALID_SIGNATURE", "AUTH_EXPIRED", "SELLER_REQUIRED"].includes(code))
      return json({ error: code || "SELLER_REQUIRED" }, 403);
    if (["INVALID_CURSOR", "INVALID_INPUT"].includes(code))
      return json({ error: code }, 400);
    return json({ error: "REQUEST_FAILED" }, 400);
  }
}
