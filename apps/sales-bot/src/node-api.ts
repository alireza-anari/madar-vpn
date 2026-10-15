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
