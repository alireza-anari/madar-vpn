import { statusResponse } from "./status-routes";
import { nodeApi } from "./node-api";
import { subscriptionResponse } from "./subscriptions";
import { runnerApi } from "./runner-api";
import enrollHtml from "../public/enroll.html";
import { adminApi } from "./admin-api";
import { cleanupCredentials } from "./enrollment";
import { drainInbox } from "./inbox";
import { authenticateUpdate } from "./auth";
import { recordUpdate } from "./telegram";
import { deliverOutbox } from "./outbox";
import { epoch } from "./contracts";
export default {
  async fetch(
    request: Request,
    env: Env,
    ctx?: ExecutionContext,
  ): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/usage/") || path.startsWith("/api/usage/"))
      return statusResponse(request, env, epoch());
    if (path.startsWith("/api/node/")) return nodeApi(request, env, epoch());
    if (path.startsWith("/subscription/"))
      return subscriptionResponse(env, path.slice(14), epoch());
    if (path === "/enroll")
      return new Response(enrollHtml, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
          "X-Content-Type-Options": "nosniff",
        },
      });
    if (path.startsWith("/api/runner/") && request.method === "POST")
      return runnerApi(request, env, epoch());
    if (path.startsWith("/api/admin/")) return adminApi(request, env, epoch());
    if (path === "/health")
      return Response.json({
        status: "prepared",
        telegram: env.BOT_TOKEN ? "configured" : "disabled",
      });
    if (path === "/webhook" && request.method === "POST") {
      let update;
      try {
        update = await authenticateUpdate(request, env);
      } catch {
        return Response.json({ error: "INVALID_UPDATE" }, { status: 400 });
      }
      if (!update)
        return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
      try {
        await recordUpdate(env.SALES_DB, update);
        if (ctx)
          ctx.waitUntil(
            (async () => {
              await drainInbox(env, epoch());
              await deliverOutbox(env, epoch());
            })(),
          );
        return Response.json({ ok: true });
      } catch {
        return Response.json({ error: "STORAGE_UNAVAILABLE" }, { status: 503 });
      }
    }
    return new Response("Not found", { status: 404 });
  },
  async scheduled(_event: ScheduledController, env: Env) {
    await cleanupCredentials(env.SALES_DB, epoch());
    await drainInbox(env, epoch());
    await deliverOutbox(env, epoch());
  },
};
