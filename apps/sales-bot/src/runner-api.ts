import { salesMode } from "./resellers";
import { boundedText, equalSecret } from "./auth";
import { hash, sign } from "./crypto";
import { enqueue } from "./telegram";
export type LeasedJob = {
  id: string;
  nodeId: string | null;
  kind: string;
  targetIp: string;
  port: number;
  username: string;
  hostFingerprint: string | null;
  encryptedCredentials: string | null;
  credentialsExpireAt: number;
  leaseId: string;
  leaseUntil: number;
  artifactVersion: string;
  protocolVersion: 1 | 2;
};
export async function leaseJob(
  env: Env,
  runnerId: string,
  now: number,
): Promise<LeasedJob | null> {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(runnerId))
    throw new Error("INVALID_RUNNER");
  const leaseId = crypto.randomUUID();
  const row = await env.SALES_DB.prepare(
    "UPDATE installation_jobs SET lease_id=?,lease_until=?,runner_id=?,state=CASE WHEN kind='probe' THEN 'leased' ELSE 'preflight' END WHERE id=(SELECT id FROM installation_jobs WHERE state NOT IN ('ready','failed') AND lease_until<=? AND expires_at>? AND (kind='probe' OR encrypted_credentials IS NOT NULL AND credentials_expire_at>?) ORDER BY created_at LIMIT 1) AND lease_until<=? RETURNING *",
  )
    .bind(leaseId, now + 120, runnerId, now, now, now, now)
    .first<Record<string, unknown>>();
  if (!row) return null;
  return {
    id: String(row.id),
    nodeId: row.node_id ? String(row.node_id) : null,
    kind: String(row.kind),
    targetIp: String(row.target_ip),
    port: Number(row.port),
    username: String(row.username),
    hostFingerprint: row.fingerprint ? String(row.fingerprint) : null,
    encryptedCredentials: row.encrypted_credentials
      ? String(row.encrypted_credentials)
      : null,
    credentialsExpireAt: Number(row.credentials_expire_at),
    leaseId,
    leaseUntil: now + 120,
    artifactVersion: String(row.artifact_version),
    protocolVersion: (await salesMode(env.SALES_DB)) ? 2 : 1,
  };
}
export async function reportJob(
  env: Env,
  id: string,
  leaseId: string,
  state: string,
  safeCode: string,
  now: number,
  details: Record<string, unknown> = {},
) {
  if (
    !["preflight", "installing", "verifying", "ready", "failed"].includes(
      state,
    ) ||
    !/^[A-Z_]{1,60}$/.test(safeCode)
  )
    throw new Error("INVALID_REPORT");
  const job = await env.SALES_DB.prepare(
    "SELECT * FROM installation_jobs WHERE id=? AND lease_id=? AND lease_until>? AND state NOT IN ('ready','failed')",
  )
    .bind(id, leaseId, now)
    .first<{ kind: string; node_id: string; user_id: string }>();
  if (!job) throw new Error("LEASE_EXPIRED");
  if (
    job.kind === "probe" &&
    state === "ready" &&
    (typeof details.fingerprint !== "string" ||
      !/^SHA256:[A-Za-z0-9+/]{43}$/.test(details.fingerprint))
  )
    throw new Error("INVALID_REPORT");
  // Never auto-configure EXISTING servers or reuse a previous enrollment.
  // A fresh quota-v2 installer attests it packaged both optional listeners,
  // and the signed-policy + live-agent metering gates remain mandatory.
  const autoProfiles =
    job.kind === "install" && state === "ready" && !!job.node_id &&
    details.freshInstall === true && details.protocolVersion === 2 &&
    JSON.stringify(details.autoRealityPorts) === "[2053,8443]" &&
    await salesMode(env.SALES_DB) &&
    !(await env.SALES_DB.prepare(
      "SELECT id FROM installation_jobs WHERE node_id=? AND id<>? AND kind='install' AND state='ready' LIMIT 1",
    ).bind(job.node_id, id).first("id")) &&
    !(await env.SALES_DB.prepare(
      "SELECT id FROM managed_accounts WHERE node_id=? LIMIT 1",
    ).bind(job.node_id).first("id"));
  const update = env.SALES_DB.prepare(
    "UPDATE installation_jobs SET state=?,safe_code=?,lease_until=?,fingerprint=COALESCE(?,fingerprint),encrypted_credentials=CASE WHEN ? IN ('ready','failed') THEN NULL ELSE encrypted_credentials END WHERE id=? AND lease_id=? AND lease_until>? AND state NOT IN ('ready','failed')",
  ).bind(
    state,
    safeCode,
    ["ready", "failed"].includes(state) ? 0 : now + 120,
    job.kind === "probe" && state === "ready" ? details.fingerprint : null,
    state,
    id,
    leaseId,
    now,
  );
  const actions: D1PreparedStatement[] = [update];
  if (autoProfiles) {
    const prefix = "managed_reality_alt:" + job.node_id + ":";
    for (const [suffix, value] of [
      ["enabled", "1"],
      ["ports", "[2053,8443]"],
      ["auto_installed", "1"],
    ] as const) {
      actions.push(env.SALES_DB.prepare(
        "INSERT INTO settings(key,value) SELECT ?,? WHERE EXISTS(SELECT 1 FROM installation_jobs WHERE id=? AND lease_id=? AND state='ready' AND node_id=?) AND NOT EXISTS(SELECT 1 FROM managed_accounts WHERE node_id=?) ON CONFLICT(key) DO NOTHING",
      ).bind(prefix + suffix, value, id, leaseId, job.node_id, job.node_id));
    }
  }
  const [r] = await env.SALES_DB.batch(actions);
  if (!r?.meta.changes) throw new Error("LEASE_EXPIRED");
  if (job.kind === "install" && state === "failed")
    await env.SALES_DB.prepare(
      "UPDATE nodes SET state='failed',healthy=0 WHERE id=?",
    )
      .bind(job.node_id)
      .run();
  if (job.kind === "install" && ["ready", "failed"].includes(state))
    await enqueue(env.SALES_DB, `install:${id}:${state}`, job.user_id, {
      text:
        state === "ready"
          ? (autoProfiles
              ? "✅ نصب سرور و آماده‌سازی خودکار REALITY روی پورت‌های ۴۴۳، ۲۰۵۳ و ۸۴۴۳ انجام شد. مسیرهای جایگزین پس از تأیید زنده Agent و حجم مشترک در لینک اشتراک ظاهر می‌شوند؛ کیفیت اپراتور هنوز تست نشده است."
              : "نصب نود انجام شد؛ سلامت و دریافت سیاست در حال بررسی است.")
          : `نصب متوقف شد: ${safeCode}. اطلاعات اتصال موقت پاک شد.`,
    });
}
export async function runnerApi(request: Request, env: Env, now: number) {
  if (
    !env.RUNNER_SERVICE_SECRET ||
    !equalSecret(
      request.headers.get("Authorization") || "",
      `Bearer ${env.RUNNER_SERVICE_SECRET}`,
    )
  )
    return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
  try {
    const path = new URL(request.url).pathname;
    const body = JSON.parse(await boundedText(request, 24000));
    if (path === "/api/runner/lease") {
      const job = await leaseJob(env, body.runnerId, now);
      const payload = JSON.stringify(job);
      return Response.json({
        payload,
        signature: sign(env.RUNNER_SERVICE_SECRET, payload),
      });
    }
    if (path === "/api/runner/report") {
      await reportJob(
        env,
        body.id,
        body.leaseId,
        body.state,
        body.safeCode,
        now,
        body.details || {},
      );
      return Response.json({ ok: true });
    }
    if (path === "/api/runner/renew") {
      const r = await env.SALES_DB.prepare(
        "UPDATE installation_jobs SET lease_until=? WHERE id=? AND lease_id=? AND lease_until>? AND state NOT IN ('ready','failed') AND expires_at>?",
      )
        .bind(now + 120, body.id, body.leaseId, now, now)
        .run();
      if (!r.meta.changes) throw new Error("LEASE_EXPIRED");
      return Response.json({ leaseUntil: now + 120 });
    }
    if (path === "/api/runner/register") {
      const job = await env.SALES_DB.prepare(
        "SELECT node_id FROM installation_jobs WHERE id=? AND lease_id=? AND lease_until>? AND kind='install' AND state NOT IN ('ready','failed')",
      )
        .bind(body.id, body.leaseId, now)
        .first<{ node_id: string }>();
      if (!job) throw new Error("LEASE_EXPIRED");
      const { nodeToken, policyKey, publicKey, shortId, sni } = body;
      if (
        !/^[A-Za-z0-9_-]{40,100}$/.test(nodeToken) ||
        !/^[a-f0-9]{64}$/.test(policyKey) ||
        !/^[A-Za-z0-9_-]{43}$/.test(publicKey) ||
        !/^[a-f0-9]{16}$/.test(shortId) ||
        !["www.microsoft.com", "www.cloudflare.com"].includes(sni)
      )
        throw new Error("INVALID_REPORT");
      await env.SALES_DB.prepare(
        "UPDATE nodes SET token_hash=?,policy_key=?,public_key=?,short_id=?,sni=?,state='verifying' WHERE id=?",
      )
        .bind(hash(nodeToken), policyKey, publicKey, shortId, sni, job.node_id)
        .run();
      return Response.json({ ok: true, nodeId: job.node_id });
    }
    return Response.json({ error: "NOT_FOUND" }, { status: 404 });
  } catch {
    return Response.json({ error: "RUNNER_REQUEST_FAILED" }, { status: 409 });
  }
}
