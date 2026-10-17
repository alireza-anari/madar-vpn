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

export async function accountStatus(
  db: D1Database,
  token: string,
  now: number,
) {
  if (token.length < 32 || token.length > 512) return null;
  const a = await db
    .prepare(
      "SELECT label,quota_bytes,used_bytes,valid_until,state,last_report_at FROM managed_accounts WHERE status_token_hash=? AND state<>'revoked'",
    )
    .bind(hash(token))
    .first<StatusRow>();
  return a ? presentStatus(a, now) : null;
}

async function accountStatusById(db: D1Database, accountId: string, now: number) {
  const a = await db
    .prepare(
      "SELECT label,quota_bytes,used_bytes,valid_until,state,last_report_at FROM managed_accounts WHERE id=? AND state<>'revoked'",
    )
    .bind(accountId)
    .first<StatusRow>();
  return a ? presentStatus(a, now) : null;
}

async function renderStatusResponse(request: Request, env: Env, now: number) {
  if (request.method !== "GET")
    return new Response("Method not allowed", { status: 405, headers });
  const url = new URL(request.url);
  const apiV2 = url.pathname.startsWith("/api/usage/v2/");
  const pageV2 = url.pathname.startsWith("/usage/v2/");
  const api = url.pathname.startsWith("/api/usage/");
  let status = null;
  if (apiV2 || pageV2) {
    const prefix = apiV2 ? "/api/usage/v2/" : "/usage/v2/";
    const token = url.pathname.slice(prefix.length);
    const accountId = verifyUsageTokenForEnv(env, token);
    status = accountId ? await accountStatusById(env.SALES_DB, accountId, now) : null;
  } else {
    const token = url.pathname.slice(api ? 11 : 7);
    status = await accountStatus(env.SALES_DB, token, now);
  }
  if (!status) return new Response("یافت نشد", { status: 404, headers });
  if (api || apiV2) return Response.json(status, { headers });
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
