import { runInNewContext } from "node:vm";
import { test } from "node:test";
import assert from "node:assert/strict";
import client from "../public/app.js";
import adminClient from "../public/app-admin.js";

const forbidden = [
  "ADMIN CONTROL",
  "ADMIN · SERVERS",
  "ADMIN · SELLERS",
  "SERVER DETAIL",
  "SELLER DETAIL",
  "CONFIG DETAIL",
  "CONFIGS",
  "REPORTS",
  "READY",
  "CONFIG PREPARING",
  "SELLER STATS",
];

test("user-facing Mini App source no longer carries English section labels", () => {
  const source = client + "\n" + adminClient;
  for (const label of forbidden) assert.equal(source.includes(label), false, label);
});

function page() {
  const elements = new Map();
  const listeners = new Map();
  for (const id of ["app-shell", "app-content", "app-nav", "app-toast"]) {
    elements.set(id, {
      id,
      innerHTML: "",
      textContent: "",
      hidden: false,
      className: "",
      dataset: {},
      addEventListener(type, fn) { listeners.set(id + ":" + type, fn); },
      setAttribute() {},
    });
  }
  const document = {
    hidden: false,
    getElementById(id) { return elements.get(id) || null; },
    addEventListener(type, fn) { listeners.set("document:" + type, fn); },
  };
  const dashboard = {
    role: "admin",
    summary: { configsInService: 2, reservedBytes: 30e9, finalizedUsedBytes: 8e9, activeSellers: 1 },
    nodes: [],
  };
  const payloads = {
    "/api/app/dashboard": dashboard,
    "/api/app/admin/sellers": [{
      sellerId: "10",
      username: "alireseller",
      displayName: "@alireseller",
      enabled: true,
      current: { configCount: 2, soldBytes: 30e9 },
      all: { usedBytes: 5e9, soldBytes: 60e9 },
      limits: {},
    }],
  };
  const context = {
    window: { Telegram: { WebApp: { initData: "signed", ready() {}, expand() {}, setHeaderColor() {}, setBackgroundColor() {}, close() {} } } },
    document,
    navigator: { clipboard: { async writeText() {} } },
    location: { hash: "" },
    URLSearchParams,
    Intl,
    Date,
    Math,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch: async (path) => {
      const value = payloads[path];
      if (value === undefined) return { ok: false, status: 404, json: async () => ({ error: "NOT_FOUND" }) };
      return { ok: true, status: 200, json: async () => value };
    },
  };
  runInNewContext(client, context);
  runInNewContext(adminClient, context);
  return { context, elements };
}

test("navigation metrics and actions use allow-listed inline SVG icons", async () => {
  const p = page();
  await p.context.window.MadarApp.ready;
  const icon = p.context.window.MadarApp.icon;
  assert.equal(typeof icon, "function");
  for (const name of ["home", "servers", "sellers", "configs", "reports", "volume", "usage", "active", "refresh", "copy", "share", "link", "archive", "revoke"])
    assert.match(icon(name), /^<svg\b[^>]*>/, name);
  assert.equal(icon("not-allowed"), "");
  assert.match(p.elements.get("app-nav").innerHTML, /<svg\b/);
  assert.match(p.elements.get("app-content").innerHTML, /metric-icon[^>]*>\s*<svg\b/);
});

test("seller cards show Telegram display name first and numeric id second", async () => {
  const p = page();
  await p.context.window.MadarApp.ready;
  await p.context.window.MadarApp.renderView("sellers");
  const html = p.elements.get("app-content").innerHTML;
  const nameAt = html.indexOf("@alireseller");
  const idAt = html.indexOf(">10<");
  assert.ok(nameAt >= 0, "display name missing");
  assert.ok(idAt > nameAt, "numeric id should be secondary");
});
