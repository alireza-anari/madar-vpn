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
  const clipboardWrites = [];
  const shares = [];
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
    close() {},
  };
  const navigator = {
    clipboard: {
      async writeText(value) {
        clipboardWrites.push(value);
      },
    },
    async share(value) {
      shares.push(value);
    },
  };
  const context = {
    window: { Telegram: { WebApp: tg } },
    document,
    navigator,
    location: { hash: "" },
    URLSearchParams,
    Intl,
    console,
    setTimeout,
    clearTimeout,
    fetch: async (path, options = {}) => {
      requests.push({ path, options });
      let value = payloads[path];
      if (typeof value === "function") value = await value({ path, options, requests });
      if (value === undefined)
        return { ok: false, status: 404, json: async () => ({ error: "NOT_FOUND" }) };
      if (value && value.__error)
        return {
          ok: false,
          status: value.status || 400,
          json: async () => ({ error: value.__error }),
        };
      return { ok: true, status: value?.__status || 200, json: async () => value };
    },
  };
  runInNewContext(client, context);
  return { context, document, elements, requests, listeners, clipboardWrites, shares };
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

const sellerDashboard = {
  role: "seller",
  summary: {
    configsInService: 1,
    currentSoldBytes: 10e9,
    allTimeSoldBytes: 20e9,
    usedBytes: 4e9,
    maxReservedAccounts: 10,
    maxCommittedBytes: 100e9,
    reservedAccounts: 1,
    committedBytes: 10e9,
  },
  nodes: [],
};

const wizardPreview = {
  nodes: [
    {
      id: "n1",
      displayName: "Stockholm",
      healthy: true,
      sellableBytes: 70e9,
      remainingSlots: 9,
      utilizationPercent: 30,
      eligible: true,
      recommended: true,
      alertLevel: 0,
      maxAllocatedBytes: 100e9,
      committedBytes: 30e9,
      finalizedUsedBytes: 0,
    },
  ],
  selectedNode: {
    id: "n1",
    eligible: true,
    beforeSellableBytes: 70e9,
    afterSellableBytes: 40e9,
    remainingSlotsBefore: 9,
    remainingSlotsAfter: 8,
  },
};

test("sale wizard reaches server preview and confirmation with exact before/after capacity", async () => {
  const p = page({
    role: "seller",
    dashboard: sellerDashboard,
    extra: { "/api/app/configs/preview": wizardPreview },
  });
  await p.context.window.MadarApp.ready;
  p.context.window.MadarApp.beginSale();
  assert.match(p.elements.get("app-content").innerHTML, /data-wizard-step="label"/);

  p.context.window.MadarApp.setWizardField("label", "Nima");
  await p.context.window.MadarApp.wizardNext();
  assert.match(p.elements.get("app-content").innerHTML, /data-wizard-step="quota"/);

  p.context.window.MadarApp.setWizardField("quotaBytes", 30e9);
  await p.context.window.MadarApp.wizardNext();
  assert.match(p.elements.get("app-content").innerHTML, /data-wizard-step="duration"/);

  p.context.window.MadarApp.setWizardField("durationSeconds", 30 * 86400);
  await p.context.window.MadarApp.wizardNext();
  let content = p.elements.get("app-content").innerHTML;
  assert.match(content, /data-wizard-step="server"/);
  assert.match(content, /Stockholm/);
  assert.match(content, /پیشنهادی/);

  await p.context.window.MadarApp.selectWizardNode("n1");
  content = p.elements.get("app-content").innerHTML;
  assert.match(content, /data-wizard-step="confirm"/);
  assert.match(content, /۷۰ گیگ/);
  assert.match(content, /۴۰ گیگ/);
  const previews = p.requests.filter((r) => r.path === "/api/app/configs/preview");
  assert.ok(previews.length >= 2);
  assert.equal(JSON.parse(previews.at(-1).options.body).nodeId, "n1");
});

test("confirmed sale creates once, recovers async result, and exposes local QR/copy/share actions", async () => {
  const config = "vless://11111111-1111-4111-8111-111111111111@8.8.8.8:443?security=reality#Madar";
  const p = page({
    role: "seller",
    dashboard: sellerDashboard,
    extra: {
      "/api/app/configs/preview": wizardPreview,
      "/api/app/configs/create": { accountId: "a1", state: "preparing", __status: 202 },
      "/api/app/configs/a1/result": {
        accountId: "a1",
        state: "active",
        ready: true,
        label: "Nima",
        quotaBytes: 30e9,
        durationSeconds: 30 * 86400,
        validUntil: 20_000,
        serverName: "Stockholm",
        config,
      },
    },
  });
  await p.context.window.MadarApp.ready;
  p.context.window.MadarApp.beginSale();
  p.context.window.MadarApp.setWizardField("label", "Nima");
  await p.context.window.MadarApp.wizardNext();
  p.context.window.MadarApp.setWizardField("quotaBytes", 30e9);
  await p.context.window.MadarApp.wizardNext();
  p.context.window.MadarApp.setWizardField("durationSeconds", 30 * 86400);
  await p.context.window.MadarApp.wizardNext();
  await p.context.window.MadarApp.selectWizardNode("n1");
  await p.context.window.MadarApp.createCurrentWizard();

  const content = p.elements.get("app-content").innerHTML;
  assert.match(content, /data-result-screen="ready"/);
  assert.match(content, /id="result-qr"/);
  assert.match(content, /کپی کانفیگ/);
  assert.match(content, /اشتراک‌گذاری/);
  assert.match(content, /Stockholm/);
  assert.match(content, /vless:\/\//);
  assert.equal(p.requests.filter((r) => r.path === "/api/app/configs/create").length, 1);
  const createBody = JSON.parse(
    p.requests.find((r) => r.path === "/api/app/configs/create").options.body,
  );
  assert.equal(createBody.label, "Nima");
  assert.equal(createBody.quotaBytes, 30e9);
  assert.equal(createBody.nodeId, "n1");
  assert.ok(createBody.requestKey);
  assert.ok(p.requests.some((r) => r.path === "/api/app/configs/a1/result"));

  await p.context.window.MadarApp.copyResult();
  await p.context.window.MadarApp.shareResult();
  assert.deepEqual(p.clipboardWrites, [config]);
  assert.equal(p.shares.length, 1);
  assert.equal(p.shares[0].text, config);

  p.elements.get("app-content").innerHTML = "";
  await p.context.window.MadarApp.recoverAccount("a1");
  assert.match(p.elements.get("app-content").innerHTML, /data-result-screen="ready"/);
});

test("trial flow uses the dedicated guarded endpoint and fixed product contract", async () => {
  const p = page({
    role: "seller",
    dashboard: sellerDashboard,
    extra: {
      "/api/app/configs/preview": wizardPreview,
      "/api/app/configs/test": { accountId: "t1", state: "preparing", __status: 202 },
      "/api/app/configs/t1/result": {
        accountId: "t1",
        state: "active",
        ready: true,
        label: "تست نیم‌ساعته",
        kind: "trial",
        quotaBytes: 1e9,
        durationSeconds: 1800,
        validUntil: 20_000,
        serverName: "Stockholm",
        config: "vless://trial",
      },
    },
  });
  await p.context.window.MadarApp.ready;
  await p.context.window.MadarApp.beginTrial();
  assert.match(p.elements.get("app-content").innerHTML, /data-wizard-step="server"/);
  await p.context.window.MadarApp.selectWizardNode("n1");
  await p.context.window.MadarApp.createCurrentWizard();
  const trialRequest = p.requests.find((r) => r.path === "/api/app/configs/test");
  assert.ok(trialRequest);
  const body = JSON.parse(trialRequest.options.body);
  assert.equal(body.nodeId, "n1");
  assert.ok(body.requestKey);
  assert.equal(Object.prototype.hasOwnProperty.call(body, "quotaBytes"), false);
  assert.match(p.elements.get("app-content").innerHTML, /۱ گیگ/);
  assert.match(p.elements.get("app-content").innerHTML, /۳۰ دقیقه/);
});
