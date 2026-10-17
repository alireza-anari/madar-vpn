import { deliverReadyAccounts } from "./account-delivery";
import { refreshCapacityAlert } from "./capacity-alerts";
import { buildQuotaPolicy, ackQuotaPolicy } from "./quota-policies";
import { acceptQuotaReports } from "./quota-reports";
import { salesMode } from "./resellers";
import { boundedText } from "./auth";
import { hash, sign } from "./crypto";
import { buildPolicy, ackPolicy } from "./policies";
export async function nodeApi(request: Request, env: Env, now: number) {
  const token =
    request.headers.get("Authorization")?.replace(/^Bearer /, "") || "";
  if (!/^[A-Za-z0-9_-]{40,100}$/.test(token))
    return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
  const node = await env.SALES_DB.prepare(
    "SELECT id,policy_key FROM nodes WHERE token_hash=?",
  )
    .bind(hash(token))
    .first<{ id: string; policy_key: string }>();
  if (!node?.policy_key)
    return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
  const path = new URL(request.url).pathname;
  if (
    [
      "/api/node/policy-v2",
      "/api/node/ack-v2",
      "/api/node/quota-reports",
    ].includes(path)
  ) {
    // Explicit rollout gate: legacy nodes never accidentally receive quota policies.
    if (
      !(await salesMode(env.SALES_DB)) &&
      (await env.SALES_DB.prepare(
        "SELECT value FROM settings WHERE key='quota_protocol_enabled'",
      ).first<string>("value")) !== "1"
    )
      return Response.json({ error: "QUOTA_MODE_DISABLED" }, { status: 409 });
    try {
      if (path.endsWith("/policy-v2") && request.method === "GET") {
        const payload = JSON.stringify(
          await buildQuotaPolicy(env.SALES_DB, node.id, now),
        );
        return Response.json({
          payload,
          signature: sign(node.policy_key, payload),
        });
      }
      if (request.method !== "POST")
        return new Response("Not found", { status: 404 });
      const body = JSON.parse(
        await boundedText(
          request,
          path.endsWith("/quota-reports") ? 65536 : 2048,
        ),
      );
      if (path.endsWith("/quota-reports")) {
        const result = await acceptQuotaReports(
          env.SALES_DB,
          node.id,
          body.reports,
          now,
        );
        try {
          await refreshCapacityAlert(env, node.id, now);
        } catch {
          // Alerting is best-effort and never invalidates an accepted report.
        }
        return Response.json(result);
      }
      if (
        !Number.isSafeInteger(body.revision) ||
        typeof body.healthy !== "boolean"
      )
        throw Error();
      await ackQuotaPolicy(env.SALES_DB, node.id, body.revision, body, now);
      await deliverReadyAccounts(env, now);
      return Response.json({ ok: true });
    } catch {
      return Response.json({ error: "INVALID_QUOTA_REQUEST" }, { status: 400 });
    }
  }
  if (await salesMode(env.SALES_DB))
    return Response.json({ error: "QUOTA_AGENT_REQUIRED" }, { status: 409 });
  if (path === "/api/node/policy" && request.method === "GET") {
    const policy = await buildPolicy(env.SALES_DB, node.id, now);
    const payload = JSON.stringify(policy);
    return Response.json({
      payload,
      signature: sign(node.policy_key, payload),
    });
  }
  if (path === "/api/node/ack" && request.method === "POST") {
    try {
      const body = JSON.parse(await boundedText(request, 2048));
      if (
        !Number.isSafeInteger(body.revision) ||
        typeof body.healthy !== "boolean"
      )
        throw new Error();
      await ackPolicy(
        env.SALES_DB,
        node.id,
        body.revision,
        { healthy: body.healthy },
        now,
      );
      return Response.json({ ok: true });
    } catch {
      return Response.json({ error: "INVALID_ACK" }, { status: 400 });
    }
  }
  return new Response("Not found", { status: 404 });
}
