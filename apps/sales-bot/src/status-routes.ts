import { hash } from "./crypto";
import statusHtml from "../public/status.html";
const headers = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy":
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
};
export async function accountStatus(
  db: D1Database,
  token: string,
  now: number,
) {
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const a = await db
    .prepare(
      "SELECT label,quota_bytes,used_bytes,valid_until,state,last_report_at FROM managed_accounts WHERE status_token_hash=? AND state<>'revoked'",
    )
    .bind(hash(token))
    .first<{
      label: string;
      quota_bytes: number | null;
      used_bytes: number;
      valid_until: number;
      state: string;
      last_report_at: number | null;
    }>();
  if (!a) return null;
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
async function renderStatusResponse(request: Request, env: Env, now: number) {
  if (request.method !== "GET")
    return new Response("Method not allowed", { status: 405, headers });
  const url = new URL(request.url),
    api = url.pathname.startsWith("/api/usage/"),
    token = url.pathname.slice(api ? 11 : 7),
    status = await accountStatus(env.SALES_DB, token, now);
  if (!status) return new Response("یافت نشد", { status: 404, headers });
  if (api) return Response.json(status, { headers });
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
