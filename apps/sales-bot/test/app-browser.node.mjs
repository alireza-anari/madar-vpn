import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import assert from "node:assert/strict";
import client from "../public/app.js";

const html = readFileSync(new URL("../public/app.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../public/app.css", import.meta.url), "utf8");

test("app shell is RTL, Telegram-aware and exposes stable mount anchors", () => {
  assert.match(html, /<html[^>]+lang="fa"[^>]+dir="rtl"/);
  assert.match(html, /telegram-web-app\.js/);
  assert.match(html, /id="app-shell"/);
  assert.match(html, /id="app-content"/);
  assert.match(html, /id="app-nav"/);
  assert.match(html, /href="\/app\.css"/);
  assert.match(html, /src="\/app\.js"/);
});

test("visual system contains cards, progress, status states, safe-area and mobile breakpoint", () => {
  for (const token of [
    ".card",
    ".progress",
    ".status-dot",
    ".is-warning",
    ".is-critical",
    "safe-area-inset-bottom",
  ])
    assert.ok(css.includes(token), token);
  assert.match(css, /@media\s*\(max-width:\s*600px\)/);
  assert.match(css, /min-height:\s*44px/);
});

function page({ role = "admin", dashboard, extra = {} } = {}) {
  const requests = [];
  const listeners = new Map();
  const elements = new Map();
  for (const id of ["app-shell", "app-content", "app-nav", "app-toast"]) {
    elements.set(id, {
      id,
      innerHTML: "",
      textContent: "",
      hidden: false,
      className: "",
      addEventListener(type, fn) {
        listeners.set(`${id}:${type}`, fn);
      },
    });
  }
  const payloads = {
    "/api/app/me": { telegramId: role === "admin" ? "1" : "10", role },
    "/api/app/dashboard": dashboard,
    "/api/app/nodes": dashboard?.nodes || [],
    "/api/app/configs": { items: [], nextCursor: null },
    "/api/app/seller/stats": {
      current: { configCount: 0, soldBytes: 0, usedBytes: 0 },
      all: { configCount: 0, soldBytes: 0, usedBytes: 0 },
      limits: {
        maxReservedAccounts: null,
        maxCommittedBytes: null,
        reservedAccounts: 0,
        committedBytes: 0,
      },
      nodes: [],
    },
    "/api/app/admin/sellers": [],
    "/api/app/admin/reports/overview": {
      summary: dashboard?.summary || {},
      nodes: dashboard?.nodes || [],
      sellers: [],
    },
    ...extra,
  };
  const document = {
    hidden: false,
    getElementById(id) {
      return elements.get(id) || null;
    },
    addEventListener(type, fn) {
      listeners.set(`document:${type}`, fn);
    },
  };
  const tg = {
    initData: "signed-init-data",
    colorScheme: "dark",
    ready() {},
    expand() {},
    setHeaderColor() {},
    setBackgroundColor() {},
  };
  const context = {
    window: { Telegram: { WebApp: tg } },
    document,
    location: { hash: "" },
    URLSearchParams,
    Intl,
    console,
    setTimeout,
    clearTimeout,
    fetch: async (path, options = {}) => {
      requests.push({ path, options });
      const value = payloads[path];
      if (value === undefined)
        return { ok: false, status: 404, json: async () => ({ error: "NOT_FOUND" }) };
      if (value && value.__error)
        return {
          ok: false,
          status: value.status || 400,
          json: async () => ({ error: value.__error }),
        };
      return { ok: true, status: 200, json: async () => value };
    },
  };
  runInNewContext(client, context);
  return { context, document, elements, requests, listeners };
}

const adminDashboard = {
  role: "admin",
  summary: {
    configsInService: 7,
    reservedBytes: 38e9,
    finalizedUsedBytes: 12e9,
    activeSellers: 3,
  },
  nodes: [
    {
      id: "n1",
      displayName: "Stockholm",
      healthy: true,
      sellableBytes: 62e9,
      remainingSlots: 13,
      utilizationPercent: 38,
      eligible: true,
      alertLevel: 80,
      maxAllocatedBytes: 100e9,
      committedBytes: 30e9,
      finalizedUsedBytes: 8e9,
      reservedAccounts: 7,
      maxAccounts: 20,
    },
  ],
};

test("admin dashboard renders operational summary, five-role nav and real capacity progress", async () => {
  const p = page({ role: "admin", dashboard: adminDashboard });
  await p.context.window.MadarApp.ready;
  const content = p.elements.get("app-content").innerHTML;
  const nav = p.elements.get("app-nav").innerHTML;
  assert.match(content, /وضعیت کلی مدار/);
  assert.match(content, /۷/);
  assert.match(content, /۳۸/);
  assert.match(content, /Stockholm/);
  assert.match(content, /aria-valuenow="38"/);
  assert.match(content, /width:38%/);
  assert.match(content, /is-warning/);
  for (const view of ["home", "servers", "sellers", "configs", "reports"])
    assert.match(nav, new RegExp(`data-view="${view}"`));
  assert.doesNotMatch(nav, /data-view="stats"/);
  assert.equal(
    p.requests.every(
      (r) => r.options.headers?.["X-Telegram-Init-Data"] === "signed-init-data",
    ),
    true,
  );
});

test("seller dashboard hides admin navigation and renders own sales summary", async () => {
  const dashboard = {
    role: "seller",
    summary: {
      configsInService: 2,
      currentSoldBytes: 30e9,
      allTimeSoldBytes: 80e9,
      usedBytes: 11e9,
      maxReservedAccounts: 10,
      maxCommittedBytes: 100e9,
      reservedAccounts: 2,
      committedBytes: 30e9,
    },
    nodes: [],
  };
  const p = page({ role: "seller", dashboard });
  await p.context.window.MadarApp.ready;
  const content = p.elements.get("app-content").innerHTML;
  const nav = p.elements.get("app-nav").innerHTML;
  assert.match(content, /پنل فروش/);
  assert.match(content, /فروش این تسویه/);
  assert.match(content, /۳۰/);
  for (const view of ["home", "configs", "stats"])
    assert.match(nav, new RegExp(`data-view="${view}"`));
  assert.doesNotMatch(nav, /data-view="servers"/);
  assert.doesNotMatch(nav, /data-view="sellers"/);
  assert.doesNotMatch(content, /فروشنده‌های فعال/);
});

test("stable backend errors become Persian full-screen states", async () => {
  const p = page({
    role: "seller",
    dashboard: { __error: "AUTH_EXPIRED", status: 403 },
  });
  await p.context.window.MadarApp.ready;
  const content = p.elements.get("app-content").innerHTML;
  assert.match(content, /نشست تلگرام منقضی شده/);
  assert.match(content, /دوباره/);
  assert.match(content, /state-card/);
});
