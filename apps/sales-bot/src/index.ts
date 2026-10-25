import { adoptionApi } from "./node-adoption";
import { refreshAllCapacityAlerts } from "./capacity-alerts";
import { refreshNodeAvailabilityAlerts } from "./node-availability-alerts";
import { statusResponse } from "./status-routes";
import { nodeApi } from "./node-api";
import { subscriptionResponse } from "./subscriptions";
import { runnerApi } from "./runner-api";
import enrollHtml from "../public/enroll.html";
import brandLogo from "../public/madar-logo.png";
import appHtml from "../public/app.html";
import appCss from "../public/app.css";
import appResultCss from "../public/app-result.css";
import appAdminCss from "../public/app-admin.css";
import appJs from "../public/app.js";
import appAdminJs from "../public/app-admin.js";
import { adminApi } from "./admin-api";
import { appApi } from "./app-api";
import { customerApi } from "./customer-api";
import { customerQrResponse } from "./customer-qr";
import customerHtml from "../public/customer.html";
import customerCss from "../public/customer.css";
import customerJs from "../public/customer.js";
import { appLifecycleApi } from "./app-lifecycle-api";
import { cleanupCredentials } from "./enrollment";
import { drainInbox } from "./inbox";
import { authenticateUpdate } from "./auth";
import { recordUpdate } from "./telegram";
import { deliverOutbox } from "./outbox";
import { epoch } from "./contracts";

const textResponse = (body: string, contentType: string, noStore = false) =>
  new Response(body, {
    headers: {
      "Content-Type": contentType,
      ...(noStore ? { "Cache-Control": "no-store" } : {}),
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx?: ExecutionContext,
  ): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/api/adoption/register")
      return adoptionApi(request, env, epoch());
    if (path.startsWith("/usage/") || path.startsWith("/api/usage/"))
      return statusResponse(request, env, epoch());
    if (path.startsWith("/api/node/")) return nodeApi(request, env, epoch());
    if (path.startsWith("/subscription/"))
      return subscriptionResponse(env, path.slice(14), epoch());
    if (path === "/madar-logo.png")
      return new Response(brandLogo, { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=3600", "X-Content-Type-Options": "nosniff" } });
    if (path === "/customer") return textResponse(customerHtml, "text/html; charset=utf-8", true);
    if (path.startsWith("/api/customer/qr/"))
      return customerQrResponse(request, env, path.slice("/api/customer/qr/".length), epoch());
    if (path === "/customer.css") return textResponse(customerCss, "text/css; charset=utf-8");
    if (path === "/customer.js") return textResponse(customerJs, "text/javascript; charset=utf-8");
    if (path.startsWith("/api/customer/")) return customerApi(request, env, epoch());
    if (path === "/app")
      return textResponse(appHtml, "text/html; charset=utf-8", true);
    if (path === "/app.css")
      return textResponse(appCss + "\n" + appResultCss, "text/css; charset=utf-8");
    if (path === "/app-admin.css")
      return textResponse(appAdminCss, "text/css; charset=utf-8");
    if (path === "/app.js")
      return textResponse(appJs, "text/javascript; charset=utf-8");
    if (path === "/app-admin.js")
      return textResponse(appAdminJs, "text/javascript; charset=utf-8");
    if (path.startsWith("/api/app/configs")) {
      const lifecycle = await appLifecycleApi(request, env, epoch());
      if (lifecycle) return lifecycle;
    }
    if (path.startsWith("/api/app/")) return appApi(request, env, epoch());
    if (path === "/enroll")
      return textResponse(enrollHtml, "text/html; charset=utf-8", true);
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
    const now = epoch();
    await cleanupCredentials(env.SALES_DB, now);
    await drainInbox(env, now);
    await refreshAllCapacityAlerts(env, now);
    // The Worker already has a one-minute cron. Sample fleet health only on
    // alternate minutes, avoiding extra scheduled invocations and AWS load.
    if (Math.floor(now / 60) % 2 === 0) {
      try {
        await refreshNodeAvailabilityAlerts(env, now);
      } catch {
        // Monitoring is best effort and never stalls bot/outbox processing.
      }
    }
    await deliverOutbox(env, now);
  },
};
