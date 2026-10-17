import { runInNewContext } from "node:vm";
import { test } from "node:test";
import assert from "node:assert/strict";
import client from "../public/app.js";

function recoveryPage(initial = {}) {
  const requests = [];
  const listeners = new Map();
  const stored = new Map(Object.entries(initial));
  const elements = new Map();
  for (const id of ["app-shell", "app-content", "app-nav", "app-toast", "result-qr"]) {
    elements.set(id, {
      id,
      innerHTML: "",
      textContent: "",
      hidden: false,
      className: "",
      dataset: {},
      addEventListener(type, fn) {
        listeners.set(`${id}:${type}`, fn);
      },
      setAttribute() {},
    });
  }
  const sessionStorage = {
    getItem(key) {
      return stored.has(key) ? stored.get(key) : null;
    },
    setItem(key, value) {
      stored.set(key, String(value));
    },
    removeItem(key) {
      stored.delete(key);
    },
  };
  const dashboard = {
    role: "seller",
    summary: {
      configsInService: 1,
      currentSoldBytes: 1e9,
      allTimeSoldBytes: 1e9,
      usedBytes: 0,
    },
    nodes: [],
  };
  const result = {
    accountId: "a-recover",
    state: "active",
    ready: true,
    label: "Recovered",
    kind: "sale",
    quotaBytes: 1e9,
    durationSeconds: 86400,
    validUntil: 20_000,
    serverName: "Stockholm",
    config: "vless://secret-config",
    qrSvg: '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1v1H0z"/></svg>',
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
  const window = {
    Telegram: {
      WebApp: {
        initData: "signed-init-data",
        ready() {},
        expand() {},
        setHeaderColor() {},
        setBackgroundColor() {},
      },
    },
    sessionStorage,
  };
  const context = {
    window,
    document,
    navigator: { clipboard: { async writeText() {} } },
    URLSearchParams,
    Intl,
    console,
    Date,
    Math,
    setTimeout,
    clearTimeout,
    fetch: async (path, options = {}) => {
      requests.push({ path, options });
      if (path === "/api/app/dashboard")
        return { ok: true, status: 200, json: async () => dashboard };
      if (path === "/api/app/configs/a-recover/result")
        return { ok: true, status: 200, json: async () => result };
      return { ok: false, status: 404, json: async () => ({ error: "NOT_FOUND" }) };
    },
  };
  runInNewContext(client, context);
  return { context, elements, requests, stored };
}

test("reopening the WebView recovers a pending account without creating again or persisting config", async () => {
  const p = recoveryPage({ "madar.pendingAccountId": "a-recover" });
  await p.context.window.MadarApp.ready;

  assert.ok(
    p.requests.some((request) => request.path === "/api/app/configs/a-recover/result"),
    "stored account id must be recovered",
  );
  assert.equal(
    p.requests.some(
      (request) =>
        request.path === "/api/app/configs/create" ||
        request.path === "/api/app/configs/test",
    ),
    false,
    "recovery must never create a duplicate",
  );
  assert.match(p.elements.get("app-content").innerHTML, /data-result-screen="ready"/);
  assert.match(p.elements.get("app-content").innerHTML, /<svg/);
  assert.equal(p.stored.has("madar.pendingAccountId"), false);
  assert.equal(
    [...p.stored.values()].some((value) => String(value).includes("vless://")),
    false,
    "raw config must never be stored",
  );
});
