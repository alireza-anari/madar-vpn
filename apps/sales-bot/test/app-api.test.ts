import { createHmac } from "node:crypto";
import { env } from "cloudflare:workers";
import { beforeEach, expect, test } from "vitest";
import { resetDb } from "./db";
import m1 from "../migrations/0001.sql?raw";
import m2 from "../migrations/0002.sql?raw";
import m3 from "../migrations/0003.sql?raw";
import m4 from "../migrations/0004-reseller-accounts.sql?raw";
import m5 from "../migrations/0005-shared-node-purposes.sql?raw";
import m6 from "../migrations/0006-trial-quota.sql?raw";
import m7 from "../migrations/0007-node-capacity.sql?raw";
import m8 from "../migrations/0008-reseller-invites.sql?raw";
import m9 from "../migrations/0009-node-allocation-cap.sql?raw";
import m10 from "../migrations/0010-capacity-accounting-resellers.sql?raw";
import m11 from "../migrations/0011-node-account-slot-mode.sql?raw";
import { appApi } from "../src/app-api";
import worker from "../src/index";

const now = 10_000;
const token = "123456:APP_TEST";
const e = {
  ...env,
  BOT_TOKEN: token,
  ADMIN_TELEGRAM_IDS: "1",
  PUBLIC_BASE_URL: "https://example.test",
} as Env;

function signed(id: number, authDate = now) {
  const p = new URLSearchParams({
    auth_date: String(authDate),
    query_id: `q-${id}`,
    user: JSON.stringify({ id, first_name: "Madar" }),
  });
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const value = [...p.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  p.set("hash", createHmac("sha256", secret).update(value).digest("hex"));
  return p.toString();
}

function req(path: string, initData: string) {
  return new Request(`https://example.test${path}`, {
    headers: { "X-Telegram-Init-Data": initData },
  });
}

beforeEach(async () => {
  await resetDb();
  for (const sql of [m1, m2, m3, m4, m5, m6, m7, m8, m9, m10, m11])
    await env.SALES_DB.exec(sql);
  await env.SALES_DB.exec(
    "INSERT INTO resellers(telegram_id,enabled,created_at) VALUES('10',1,1),('11',0,1);",
  );
});

test("/me identifies admin and seller and all app API reads are no-store", async () => {
  const admin = await appApi(req("/api/app/me", signed(1)), e, now);
  expect(admin.status).toBe(200);
  expect(admin.headers.get("Cache-Control")).toBe("no-store");
  expect(await admin.json()).toEqual({ telegramId: "1", role: "admin" });

  const seller = await appApi(req("/api/app/me", signed(10)), e, now);
  expect(seller.status).toBe(200);
  expect(await seller.json()).toEqual({ telegramId: "10", role: "seller" });
});

test("seller dashboard nodes configs and stats use seller-safe role-scoped shapes", async () => {
  const dashboard = await appApi(req("/api/app/dashboard", signed(10)), e, now);
  expect(dashboard.status).toBe(200);
  expect((await dashboard.json() as any).role).toBe("seller");

  for (const path of ["/api/app/nodes", "/api/app/configs", "/api/app/seller/stats"]) {
    const response = await appApi(req(path, signed(10)), e, now);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const text = await response.text();
    expect(text).not.toContain("target_ip");
    expect(text).not.toContain("fingerprint");
  }
});

test("disabled or ordinary users fail closed and expired auth has a stable code", async () => {
  const disabled = await appApi(req("/api/app/me", signed(11)), e, now);
  expect(disabled.status).toBe(403);
  expect(await disabled.json()).toEqual({ error: "SELLER_REQUIRED" });

  const ordinary = await appApi(req("/api/app/me", signed(12)), e, now);
  expect(ordinary.status).toBe(403);
  expect(await ordinary.json()).toEqual({ error: "SELLER_REQUIRED" });

  const expired = await appApi(req("/api/app/me", signed(10, now - 301)), e, now);
  expect(expired.status).toBe(403);
  expect(await expired.json()).toEqual({ error: "AUTH_EXPIRED" });
});

test("unknown app API paths return stable 404 without internal errors", async () => {
  const response = await appApi(req("/api/app/nope", signed(10)), e, now);
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: "NOT_FOUND" });
});

test("worker serves the Mini App shell and static CSS/JS with no-store HTML", async () => {
  const html = await worker.fetch(new Request("https://example.test/app"), e);
  expect(html.status).toBe(200);
  expect(html.headers.get("Content-Type")).toContain("text/html");
  expect(html.headers.get("Cache-Control")).toBe("no-store");
  expect(await html.text()).toContain("مدار");

  const css = await worker.fetch(new Request("https://example.test/app.css"), e);
  expect(css.status).toBe(200);
  expect(css.headers.get("Content-Type")).toContain("text/css");

  const js = await worker.fetch(new Request("https://example.test/app.js"), e);
  expect(js.status).toBe(200);
  expect(js.headers.get("Content-Type")).toContain("javascript");
});
