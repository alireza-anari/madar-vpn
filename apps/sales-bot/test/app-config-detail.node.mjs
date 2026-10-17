import { runInNewContext } from "node:vm";
import { test } from "node:test";
import assert from "node:assert/strict";
import client from "../public/app.js";

const baseDetail = () => ({
  id: "c1",
  sellerId: "200",
  sellerDisplayName: "@seller",
  nodeId: "n1",
  serverName: "Stockholm",
  label: "Nima",
  state: "active",
  quotaBytes: 30e9,
  usedBytes: 5e9,
  remainingBytes: 25e9,
  validUntil: 2_000_000,
  createdAt: 1_000_000,
  archivedAt: null,
  archivedBy: null,
});

const result = {
  accountId: "c1",
  state: "active",
  ready: true,
  label: "Nima",
  kind: "sale",
  quotaBytes: 30e9,
  durationSeconds: 30 * 86400,
  validUntil: 2_000_000,
  serverName: "Stockholm",
  config: "vless://uuid@8.8.8.8:443?security=reality#Madar",
  usageUrl: "https://example.test/usage/v2/v2.c1.signature",
  qrSvg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><path d="M0 0h1v1H0z"/></svg>',
};

function page({ role = "seller", confirmValue = true, telegramConfirm } = {}) {
  const elements = new Map();
  const calls = [];
  const telegramPrompts = [];
  const browserPrompts = [];
  let detail = baseDetail();
  let archived = false;
  for (const id of ["app-shell", "app-content", "app-nav", "app-toast"]) {
    elements.set(id, {
      id,
      innerHTML: "",
      textContent: "",
      hidden: false,
      className: "",
      dataset: {},
      addEventListener() {},
      setAttribute() {},
    });
  }
  const session = new Map();
  const webApp = {
    initData: "signed-init-data",
    ready() {},
    expand() {},
    setHeaderColor() {},
    setBackgroundColor() {},
  };
  if (telegramConfirm !== undefined) {
    webApp.showConfirm = (message, callback) => {
      telegramPrompts.push(message);
      callback(Boolean(telegramConfirm));
    };
  }
  const window = {
    Telegram: { WebApp: webApp },
    sessionStorage: {
      getItem(key) { return session.get(key) || null; },
      setItem(key, value) { session.set(key, String(value)); },
      removeItem(key) { session.delete(key); },
    },
    confirm(message) {
      browserPrompts.push(message);
      return Boolean(confirmValue);
    },
  };
  const document = {
    hidden: false,
    getElementById(id) { return elements.get(id) || null; },
    addEventListener() {},
  };
  const dashboard = {
    role,
    summary: role === "admin"
      ? { configsInService: 1, reservedBytes: 30e9, finalizedUsedBytes: 0, activeSellers: 1 }
      : { configsInService: 1, currentSoldBytes: 30e9, allTimeSoldBytes: 30e9, usedBytes: 5e9 },
    nodes: [],
  };
  const fetch = async (path, options = {}) => {
    const method = options.method || "GET";
    calls.push([method, path]);
    let payload;
    let status = 200;
    if (path === "/api/app/dashboard") payload = dashboard;
    else if (path === "/api/app/configs")
      payload = {
        items: archived ? [] : [{ id: "c1", label: "Nima", state: detail.state, usedBytes: detail.usedBytes }],
        nextCursor: null,
      };
    else if (path === "/api/app/configs/c1" && method === "GET") payload = detail;
    else if (path === "/api/app/configs/c1/result" && method === "GET") payload = { ...result, state: detail.state };
    else if (path === "/api/app/configs/c1/revoke" && method === "POST") {
      detail = { ...detail, state: "revoked" };
      payload = detail;
    } else if (path === "/api/app/configs/c1/archive" && method === "POST") {
      archived = true;
      detail = { ...detail, state: "revoked", archivedAt: 2_100_000, archivedBy: "1" };
      payload = detail;
    } else {
      status = 404;
      payload = { error: "NOT_FOUND" };
    }
    return { ok: status < 400, status, json: async () => payload };
  };
  const context = {
    window,
    document,
    navigator: { clipboard: { async writeText() {} } },
    fetch,
    URLSearchParams,
    Intl,
    console,
    Date,
    Math,
    setTimeout,
    clearTimeout,
  };
  runInNewContext(client, context);
  return { context, elements, calls, telegramPrompts, browserPrompts };
}

test("seller config detail is rich and read-only", async () => {
  const p = page({ role: "seller" });
  await p.context.window.MadarApp.ready;
  await p.context.window.MadarApp.openConfigDetail("c1");
  const html = p.elements.get("app-content").innerHTML;
  for (const value of ["Nima", "Stockholm", "۳۰ گیگ", "۵ گیگ", "۲۵ گیگ", "مصرف و اعتبار", "usage/v2", "vless://", "<svg"])
    assert.ok(html.includes(value), value);
  assert.doesNotMatch(html, /لغو سرویس/);
  assert.doesNotMatch(html, /حذف از فهرست/);
});

test("admin config detail shows seller identity and destructive controls with archive explanation", async () => {
  const p = page({ role: "admin" });
  await p.context.window.MadarApp.ready;
  await p.context.window.MadarApp.openConfigDetail("c1");
  const html = p.elements.get("app-content").innerHTML;
  assert.match(html, /@seller/);
  assert.match(html, /200/);
  assert.match(html, /لغو سرویس/);
  assert.match(html, /حذف از فهرست/);
  assert.match(html, /سابقه.*حسابداری/);
});

test("Telegram confirmation is preferred and cancellation performs no lifecycle mutation", async () => {
  const p = page({ role: "admin", telegramConfirm: false, confirmValue: true });
  await p.context.window.MadarApp.ready;
  await p.context.window.MadarApp.openConfigDetail("c1");
  assert.equal(await p.context.window.MadarApp.revokeConfig("c1"), false);
  assert.equal(p.telegramPrompts.length, 1);
  assert.equal(p.browserPrompts.length, 0);
  assert.equal(p.calls.some(([method, path]) => method === "POST" && path.endsWith("/revoke")), false);
});

test("admin revoke confirms, refreshes dashboard/detail and shows terminal state", async () => {
  const p = page({ role: "admin", confirmValue: true });
  await p.context.window.MadarApp.ready;
  await p.context.window.MadarApp.openConfigDetail("c1");
  assert.equal(await p.context.window.MadarApp.revokeConfig("c1"), true);
  assert.equal(p.calls.some(([method, path]) => method === "POST" && path === "/api/app/configs/c1/revoke"), true);
  assert.ok(p.calls.filter(([, path]) => path === "/api/app/dashboard").length >= 2);
  assert.match(p.elements.get("app-content").innerHTML, /revoked/);
});

test("admin archive explains soft deletion and refreshes to a list without archived item", async () => {
  const p = page({ role: "admin", confirmValue: true });
  await p.context.window.MadarApp.ready;
  await p.context.window.MadarApp.openConfigDetail("c1");
  assert.equal(await p.context.window.MadarApp.archiveConfig("c1"), true);
  assert.equal(p.calls.some(([method, path]) => method === "POST" && path === "/api/app/configs/c1/archive"), true);
  const html = p.elements.get("app-content").innerHTML;
  assert.match(html, /کانفیگی وجود ندارد/);
  assert.doesNotMatch(html, /Nima/);
});
