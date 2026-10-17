import { boundedText } from "./auth";
import { ownedAccount } from "./accounts";
import { buildAccountDeliveryArtifact } from "./account-delivery";
import {
  listAdminSellerCards,
  listAdminSellerSettlements,
  loadAdminNodeDetail,
  loadAdminReportOverview,
  loadAdminSellerDetail,
} from "./app-admin";
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
import {
  setNodeMaxAccounts,
  setNodeMaxAllocatedBytes,
  setNodeUnlimitedAccounts,
} from "./node-settings";
import { setSellerLimits, settleSeller } from "./seller-accounting";
import { requireSalesAdmin, setReseller } from "./resellers";

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
      "SETTLEMENT_CONFLICT",
    ].includes(code)
  )
    return { code, status: 409 };
  if (["ACCOUNT_NOT_FOUND", "INVALID_NODE", "INVALID_SELLER"].includes(code))
    return { code, status: 404 };
  if (
    [
      "INVALID_ACCOUNT",
      "INVALID_CURSOR",
      "INVALID_INPUT",
      "INVALID_CAPACITY",
      "INVALID_ALLOCATION_CAP",
      "INVALID_SELLER_LIMITS",
    ].includes(code)
  )
    return { code, status: 400 };
  return null;
}

async function body(request: Request) {
  return JSON.parse(await boundedText(request, 24_000)) as Record<string, unknown>;
}

function numericOrNull(value: unknown, errorCode: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number") throw Error(errorCode);
  return value;
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

    // Authorize the whole namespace before route or target resolution so a seller
    // cannot use status differences to discover admin-only resource existence.
    if (path.startsWith("/api/app/admin/")) requireSalesAdmin(actor);

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

      if (path === "/api/app/admin/nodes")
        return json(await listAppNodes(env.SALES_DB, actor, now));
      if (path === "/api/app/admin/sellers")
        return json(await listAdminSellerCards(env.SALES_DB, actor, now));
      if (path === "/api/app/admin/reports/overview")
        return json(await loadAdminReportOverview(env.SALES_DB, actor, now));

      const adminNodeMatch = path.match(/^\/api\/app\/admin\/nodes\/([^/]+)$/);
      if (adminNodeMatch)
        return json(
          await loadAdminNodeDetail(
            env.SALES_DB,
            actor,
            decodeURIComponent(adminNodeMatch[1]!),
            now,
          ),
        );

      const settlementMatch = path.match(
        /^\/api\/app\/admin\/sellers\/([^/]+)\/settlements$/,
      );
      if (settlementMatch)
        return json(
          await listAdminSellerSettlements(
            env.SALES_DB,
            actor,
            decodeURIComponent(settlementMatch[1]!),
          ),
        );

      const adminSellerMatch = path.match(/^\/api\/app\/admin\/sellers\/([^/]+)$/);
      if (adminSellerMatch)
        return json(
          await loadAdminSellerDetail(
            env.SALES_DB,
            actor,
            decodeURIComponent(adminSellerMatch[1]!),
            now,
          ),
        );

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
      const nodeAccountsMatch = path.match(
        /^\/api\/app\/admin\/nodes\/([^/]+)\/accounts$/,
      );
      if (nodeAccountsMatch) {
        const nodeId = decodeURIComponent(nodeAccountsMatch[1]!);
        const input = await body(request);
        if (input.mode === "unlimited") {
          await setNodeUnlimitedAccounts(env.SALES_DB, actor, nodeId, true, now);
        } else if (input.mode === "finite") {
          if (typeof input.maxAccounts !== "number") throw Error("INVALID_CAPACITY");
          await setNodeMaxAccounts(env.SALES_DB, actor, nodeId, input.maxAccounts, now);
        } else {
          throw Error("INVALID_CAPACITY");
        }
        return json(await loadAdminNodeDetail(env.SALES_DB, actor, nodeId, now));
      }

      const nodeBandwidthMatch = path.match(
        /^\/api\/app\/admin\/nodes\/([^/]+)\/bandwidth$/,
      );
      if (nodeBandwidthMatch) {
        const nodeId = decodeURIComponent(nodeBandwidthMatch[1]!);
        const input = await body(request);
        await setNodeMaxAllocatedBytes(
          env.SALES_DB,
          actor,
          nodeId,
          numericOrNull(input.maxAllocatedBytes, "INVALID_ALLOCATION_CAP"),
          now,
        );
        return json(await loadAdminNodeDetail(env.SALES_DB, actor, nodeId, now));
      }

      const sellerAccessMatch = path.match(
        /^\/api\/app\/admin\/sellers\/([^/]+)\/access$/,
      );
      if (sellerAccessMatch) {
        const sellerId = decodeURIComponent(sellerAccessMatch[1]!);
        const input = await body(request);
        if (typeof input.enabled !== "boolean") throw Error("INVALID_INPUT");
        await setReseller(env.SALES_DB, actor, sellerId, input.enabled, now);
        return json(await loadAdminSellerDetail(env.SALES_DB, actor, sellerId, now));
      }

      const sellerLimitsMatch = path.match(
        /^\/api\/app\/admin\/sellers\/([^/]+)\/limits$/,
      );
      if (sellerLimitsMatch) {
        const sellerId = decodeURIComponent(sellerLimitsMatch[1]!);
        const input = await body(request);
        await setSellerLimits(
          env.SALES_DB,
          actor,
          sellerId,
          {
            maxReservedAccounts: numericOrNull(
              input.maxReservedAccounts,
              "INVALID_SELLER_LIMITS",
            ),
            maxCommittedBytes: numericOrNull(
              input.maxCommittedBytes,
              "INVALID_SELLER_LIMITS",
            ),
          },
          now,
        );
        return json(await loadAdminSellerDetail(env.SALES_DB, actor, sellerId, now));
      }

      const sellerSettleMatch = path.match(
        /^\/api\/app\/admin\/sellers\/([^/]+)\/settle$/,
      );
      if (sellerSettleMatch) {
        const sellerId = decodeURIComponent(sellerSettleMatch[1]!);
        // Parse the body to preserve one bounded JSON contract for mutating routes.
        await body(request);
        return json(await settleSeller(env.SALES_DB, actor, sellerId, now));
      }

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
    if (
      ["INVALID_SIGNATURE", "AUTH_EXPIRED", "SELLER_REQUIRED", "ADMIN_REQUIRED"].includes(
        code,
      )
    )
      return json({ error: code || "SELLER_REQUIRED" }, 403);
    const mapped = mappedError(code);
    if (mapped) return json({ error: mapped.code }, mapped.status);
    if (error instanceof SyntaxError) return json({ error: "INVALID_INPUT" }, 400);
    return json({ error: "REQUEST_FAILED" }, 400);
  }
}
