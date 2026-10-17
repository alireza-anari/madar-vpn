import { boundedText } from "./auth";
import { ownedAccount } from "./accounts";
import { buildAccountDeliveryArtifact } from "./account-delivery";
import { authenticateMiniApp } from "./miniapp-auth";
import {
  listAppConfigs,
  listAppNodes,
  loadAppDashboard,
  loadSellerSelfStats,
} from "./app-dashboard";
import {
  createAppSale,
  createAppTrial,
  previewSale,
  type AppSaleInput,
} from "./app-sales";

function json(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function mappedError(code: string): { code: string; status: number } | null {
  const conflict: Record<string, string> = {
    SELLER_ACCOUNT_LIMIT: "SELLER_CONFIG_LIMIT",
    SELLER_ALLOCATION_FULL: "SELLER_VOLUME_LIMIT",
    NODE_ALLOCATION_FULL: "INSUFFICIENT_NODE_CAPACITY",
    NODE_FULL: "NODE_SLOT_LIMIT",
  };
  if (conflict[code]) return { code: conflict[code]!, status: 409 };
  if (
    [
      "SELLER_CONFIG_LIMIT",
      "SELLER_VOLUME_LIMIT",
      "INSUFFICIENT_NODE_CAPACITY",
      "NODE_SLOT_LIMIT",
      "NODE_UNAVAILABLE",
    ].includes(code)
  )
    return { code, status: 409 };
  if (code === "ACCOUNT_NOT_FOUND") return { code, status: 404 };
  if (["INVALID_ACCOUNT", "INVALID_CURSOR", "INVALID_INPUT"].includes(code))
    return { code, status: 400 };
  return null;
}

async function body(request: Request) {
  return JSON.parse(await boundedText(request, 24_000)) as Record<string, unknown>;
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

    if (request.method === "GET") {
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
          throw Error("INVALID_INPUT");
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
      const resultMatch = path.match(/^\/api\/app\/configs\/([^/]+)\/result$/);
      if (resultMatch) {
        const account = await ownedAccount(env.SALES_DB, actor, resultMatch[1]!);
        const artifact = await buildAccountDeliveryArtifact(env, account.id, now);
        return artifact
          ? json({ state: account.state, ready: true, ...artifact })
          : json({ accountId: account.id, state: account.state, ready: false });
      }
      return json({ error: "NOT_FOUND" }, 404);
    }

    if (request.method === "POST") {
      if (path === "/api/app/configs/preview")
        return json(
          await previewSale(
            env.SALES_DB,
            actor,
            (await body(request)) as unknown as AppSaleInput,
            now,
          ),
        );
      if (path === "/api/app/configs/create")
        return json(
          await createAppSale(
            env,
            actor,
            (await body(request)) as unknown as AppSaleInput & { requestKey: string },
            now,
          ),
          202,
        );
      if (path === "/api/app/configs/test") {
        const input = await body(request);
        return json(
          await createAppTrial(
            env,
            actor,
            {
              nodeId: String(input.nodeId || ""),
              requestKey: String(input.requestKey || ""),
            },
            now,
          ),
          202,
        );
      }
      return json({ error: "NOT_FOUND" }, 404);
    }
    return json({ error: "NOT_FOUND" }, 404);
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (["INVALID_SIGNATURE", "AUTH_EXPIRED", "SELLER_REQUIRED"].includes(code))
      return json({ error: code || "SELLER_REQUIRED" }, 403);
    const mapped = mappedError(code);
    if (mapped) return json({ error: mapped.code }, mapped.status);
    if (error instanceof SyntaxError) return json({ error: "INVALID_INPUT" }, 400);
    return json({ error: "REQUEST_FAILED" }, 400);
  }
}
