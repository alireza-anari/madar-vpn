import { publicTarget } from "./targets";
import { boundedText } from "./auth";
import { hash } from "./crypto";
// Owner-issued, hashed, expiring, one-use grant. Never accepts an arbitrary node ID.
export async function adoptionApi(request: Request, env: Env, now: number) {
  const headers = {
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  };
  const fail = (status = 401) =>
    Response.json({ error: "ADOPTION_REJECTED" }, { status, headers });
  if (request.method !== "POST") return fail(405);
  try {
    const token =
      request.headers.get("Authorization")?.replace(/^Bearer /, "") || "";
    if (!/^[a-f0-9]{64}$/.test(token)) return fail();
    const key = "adoption:" + hash(token);
    const raw = await env.SALES_DB.prepare(
      "SELECT value FROM settings WHERE key=?",
    )
      .bind(key)
      .first<string>("value");
    if (!raw) return fail();
    const grant = JSON.parse(raw);
    if (!Number.isSafeInteger(grant.expiresAt) || grant.expiresAt <= now)
      return fail();
    const body = JSON.parse(await boundedText(request, 4096));
    if (body.instanceId !== grant.instanceId) return fail();
    if (
      !/^[A-Za-z0-9_-]{40,100}$/.test(body.nodeToken) ||
      !/^[a-f0-9]{64}$/.test(body.policyKey) ||
      !/^[A-Za-z0-9_-]{43}$/.test(body.publicKey) ||
      !/^(?:[a-f0-9]{2}){1,8}$/.test(body.shortId) ||
      typeof body.sni !== "string" ||
      body.sni.length > 253 ||
      !/^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/.test(
        body.sni,
      )
    )
      return fail(400);
    const ip = publicTarget(body.publicIp);
    const digest = hash(body.nodeToken);
    const results = await env.SALES_DB.batch([
      env.SALES_DB.prepare(
        "UPDATE nodes SET token_hash=?,policy_key=?,public_key=?,short_id=?,sni=?,target_ip=?,vpn_port=443,state='verifying' WHERE id=? AND token_hash IS NULL AND EXISTS(SELECT 1 FROM settings WHERE key=? AND value=?)",
      ).bind(
        digest,
        body.policyKey,
        body.publicKey,
        body.shortId,
        body.sni,
        ip,
        grant.nodeId,
        key,
        raw,
      ),
      env.SALES_DB.prepare(
        "INSERT INTO audit_events(actor_id,action,target_id,created_at) SELECT '479321174','adopt_existing_node',id,? FROM nodes WHERE id=? AND token_hash=? AND EXISTS(SELECT 1 FROM settings WHERE key=? AND value=?)",
      ).bind(now, grant.nodeId, digest, key, raw),
      env.SALES_DB.prepare(
        "DELETE FROM settings WHERE key=? AND value=? AND EXISTS(SELECT 1 FROM nodes WHERE id=? AND token_hash=?)",
      ).bind(key, raw, grant.nodeId, digest),
    ]);
    if (!results[0]?.meta.changes) return fail();
    return Response.json({ ok: true, nodeId: grant.nodeId }, { headers });
  } catch {
    return fail(503);
  }
}
