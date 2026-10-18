import { hash } from "./crypto";
import statusHtml from "../public/status.html";
import { verifyUsageTokenForEnv } from "./usage-links";
const headers = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy":
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
};

type StatusRow = {
  id: string;
  node_id: string;
  label: string;
  quota_bytes: number | null;
  used_bytes: number;
  valid_until: number;
  state: string;
  last_report_at: number | null;
};

function presentStatus(a: StatusRow, now: number) {
  return {
    label: a.label,
    totalBytes: a.quota_bytes,
    usedBytes: a.used_bytes,
    remainingBytes:
      a.quota_bytes === null ? null : Math.max(0, a.quota_bytes - a.used_bytes),
    expiresAt: a.valid_until,
    state: a.state === "active" && a.valid_until <= now ? "expired" : a.state,
    lastReportAt: a.last_report_at,
  };
}

async function accountRow(db: D1Database, token: string) {
  if (token.length < 32 || token.length > 512) return null;
  return db
    .prepare(
      "SELECT id,node_id,label,quota_bytes,used_bytes,valid_until,state,last_report_at FROM managed_accounts WHERE status_token_hash=? AND state<>'revoked'",
    )
    .bind(hash(token))
    .first<StatusRow>();
}

async function accountRowById(db: D1Database, accountId: string) {
  return db
    .prepare(
      "SELECT id,node_id,label,quota_bytes,used_bytes,valid_until,state,last_report_at FROM managed_accounts WHERE id=? AND state<>'revoked'",
    )
    .bind(accountId)
    .first<StatusRow>();
}

export async function accountStatus(
  db: D1Database,
  token: string,
  now: number,
) {
  const row = await accountRow(db, token);
  return row ? presentStatus(row, now) : null;
}

async function requestFreshUsage(db: D1Database, account: StatusRow, now: number) {
  // Capability-authenticated per-account requests only, capped at one write
  // per 30 seconds; opening the page does not initiate a write.
  await db.prepare(
    `INSERT INTO usage_refresh_requests(account_id,node_id,requested_at)
     VALUES(?,?,?)
     ON CONFLICT(account_id) DO UPDATE SET
       requested_at=excluded.requested_at,node_id=excluded.node_id
     WHERE usage_refresh_requests.requested_at <= ?`,
  ).bind(account.id, account.node_id, now, now - 30).run();
  const current = await db.prepare(
    "SELECT requested_at FROM usage_refresh_requests WHERE account_id=?",
  ).bind(account.id).first<{ requested_at: number }>();
  return current?.requested_at ?? now;
}

async function renderStatusResponse(request: Request, env: Env, now: number) {
  const url = new URL(request.url);
  const apiV2 = url.pathname.startsWith("/api/usage/v2/");
  const pageV2 = url.pathname.startsWith("/usage/v2/");
  const api = url.pathname.startsWith("/api/usage/");
  const isRefresh = url.pathname.endsWith("/refresh");
  if (!(request.method === "GET" || (request.method === "POST" && api && isRefresh)))
    return new Response("Method not allowed", { status: 405, headers });
  if (isRefresh && (request.method !== "POST" || !api))
    return new Response("Method not allowed", { status: 405, headers });

  const barePath = isRefresh ? url.pathname.slice(0, -"/refresh".length) : url.pathname;
  const prefix = apiV2 ? "/api/usage/v2/" : pageV2 ? "/usage/v2/" : api ? "/api/usage/" : "/usage/";
  const token = barePath.slice(prefix.length);
  if (!token || token.includes("/"))
    return new Response("یافت نشد", { status: 404, headers });
  const account =
    apiV2 || pageV2
      ? await (async () => {
          const id = verifyUsageTokenForEnv(env, token);
          return id ? accountRowById(env.SALES_DB, id) : null;
        })()
      : await accountRow(env.SALES_DB, token);
  if (!account)
    return new Response("یافت نشد", { status: 404, headers });

  if (request.method === "POST") {
    if (!["active", "preparing"].includes(account.state) || account.valid_until <= now)
      return Response.json({ error: "ACCOUNT_NOT_ACTIVE" }, { status: 409, headers });
    const requestedAt = await requestFreshUsage(env.SALES_DB, account, now);
    return Response.json({ pending: true, requestedAt }, { headers });
  }

  if (api) {
    const requestRow = await env.SALES_DB.prepare(
      "SELECT requested_at FROM usage_refresh_requests WHERE account_id=?",
    ).bind(account.id).first<{ requested_at: number }>();
    return Response.json({
      ...presentStatus(account, now),
      refreshPending: Boolean(requestRow && (account.last_report_at ?? 0) < requestRow.requested_at),
    }, { headers });
  }
  return new Response(statusHtml, {
    headers: { ...headers, "Content-Type": "text/html; charset=utf-8" },
  });
}

export async function statusResponse(request: Request, env: Env, now: number) {
  try {
    return await renderStatusResponse(request, env, now);
  } catch {
    return new Response("اطلاعات موقتاً در دسترس نیست", {
      status: 503,
      headers,
    });
  }
}
