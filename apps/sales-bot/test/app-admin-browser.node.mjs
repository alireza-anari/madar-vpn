import { runInNewContext } from "node:vm";
import { test } from "node:test";
import assert from "node:assert/strict";
import client from "../public/app.js";

const adminDashboard = {
  role: "admin",
  summary: { configsInService: 2, reservedBytes: 30e9, finalizedUsedBytes: 8e9, activeSellers: 1 },
  nodes: [
    {
      id: "n1",
      displayName: "Stockholm",
      healthy: true,
      sellableBytes: 70e9,
      remainingSlots: 18,
      utilizationPercent: 30,
      eligible: true,
      alertLevel: 0,
      maxAllocatedBytes: 100e9,
      committedBytes: 30e9,
      finalizedUsedBytes: 8e9,
      reservedAccounts: 2,
      maxAccounts: 20,
    },
  ],
};

function page(extra = {}) {
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
      dataset: {},
      addEventListener(type, fn) { listeners.set(id + ":" + type, fn); },
      setAttribute() {},
    });
  }
  const payloads = {
    "/api/app/dashboard": adminDashboard,
    "/api/app/admin/nodes": adminDashboard.nodes,
    "/api/app/configs": { items: [], nextCursor: null },
    ...extra,
  };
  const document = {
    hidden: false,
    getElementById(id) { return elements.get(id) || null; },
    addEventListener(type, fn) { listeners.set("document:" + type, fn); },
  };
  const context = {
    window: { Telegram: { WebApp: { initData: "signed", ready() {}, expand() {}, setHeaderColor() {}, setBackgroundColor() {}, close() {} } } },
    document,
    navigator: { clipboard: { async writeText() {} } },
    location: { hash: "" },
    URLSearchParams,
    Intl,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch: async (path, options = {}) => {
      requests.push({ path, options });
      let value = payloads[path];
      if (typeof value === "function") value = await value({ path, options, requests });
      if (value === undefined) return { ok: false, status: 404, json: async () => ({ error: "NOT_FOUND" }) };
      if (value?.__error) return { ok: false, status: value.status || 400, json: async () => ({ error: value.__error }) };
      return { ok: true, status: value?.__status || 200, json: async () => value };
    },
  };
  runInNewContext(client, context);
  return { context, elements, requests };
}

const nodeDetail = {
  id: "n1",
  displayName: "Stockholm",
  targetIp: "8.8.8.8",
  vpnPort: 443,
  state: "ready",
  revision: 5,
  ackedRevision: 5,
  lastSeen: 10_000,
  healthy: true,
  agentCapabilities: ["quota-v2", "shared-443"],
  publicKey: "public",
  shortId: "abcdef",
  sni: "www.cloudflare.com",
  purposes: ["sales"],
  maxAllocatedBytes: 100e9,
  committedBytes: 30e9,
  finalizedUsedBytes: 8e9,
  sellableBytes: 70e9,
  utilizationPercent: 30,
  reservedAccounts: 2,
  maxAccounts: 20,
  remainingSlots: 18,
  accountSlotsUnlimited: false,
  alertLevel: 0,
};

test("admin server page opens technical detail and saves finite/unlimited caps through admin API", async () => {
  const p = page({
    "/api/app/admin/nodes/n1": nodeDetail,
    "/api/app/admin/nodes/n1/bandwidth": nodeDetail,
    "/api/app/admin/nodes/n1/accounts": { ...nodeDetail, maxAccounts: null, remainingSlots: null, accountSlotsUnlimited: true },
  });
  await p.context.window.MadarApp.ready;
  await p.context.window.MadarApp.renderView("servers");
  assert.match(p.elements.get("app-content").innerHTML, /data-admin-node-id="n1"/);

  await p.context.window.MadarApp.openAdminNode("n1");
  let html = p.elements.get("app-content").innerHTML;
  assert.match(html, /8\.8\.8\.8/);
  assert.match(html, /443/);
  assert.match(html, /revision/i);
  assert.match(html, /5.*5/);
  assert.match(html, /سقف حجم/);
  assert.match(html, /سقف کانفیگ/);
  assert.match(html, /کانفیگ‌های مرتبط/);

  await p.context.window.MadarApp.saveNodeBandwidth("n1", null);
  await p.context.window.MadarApp.saveNodeSlots("n1", { mode: "finite", maxAccounts: 25 });
  await p.context.window.MadarApp.saveNodeSlots("n1", { mode: "unlimited" });
  const bandwidth = p.requests.find((r) => r.path.endsWith("/bandwidth") && r.options.method === "POST");
  assert.deepEqual(JSON.parse(bandwidth.options.body), { maxAllocatedBytes: null });
  const slotCalls = p.requests.filter((r) => r.path.endsWith("/accounts") && r.options.method === "POST");
  assert.deepEqual(JSON.parse(slotCalls[0].options.body), { mode: "finite", maxAccounts: 25 });
  assert.deepEqual(JSON.parse(slotCalls[1].options.body), { mode: "unlimited" });
});

const sellerDetail = {
  sellerId: "10",
  enabled: true,
  createdAt: 1,
  current: { epoch: 2, startedAt: 100, configCount: 2, soldBytes: 30e9, usedBytes: 5e9, liveCount: 2, blockedCount: 0, expiredCount: 0, revokedCount: 0, exhaustedCount: 0 },
  all: { configCount: 7, soldBytes: 90e9, usedBytes: 31e9, liveCount: 2, blockedCount: 0, expiredCount: 2, revokedCount: 2, exhaustedCount: 1 },
  limits: { maxReservedAccounts: 10, maxCommittedBytes: 100e9, reservedAccounts: 2, committedBytes: 30e9, uncappedAccounts: 0 },
  currentNodes: [{ nodeId: "n1", nodeName: "Stockholm", configCount: 2, soldBytes: 30e9, usedBytes: 5e9 }],
  allNodes: [{ nodeId: "n1", nodeName: "Stockholm", configCount: 7, soldBytes: 90e9, usedBytes: 31e9 }],
};

const settlementHistory = [
  { settlementId: "s1", epoch: 1, startedAt: 10, endedAt: 100, configCount: 5, soldBytes: 60e9, usedBytes: 26e9, liveCount: 1, blockedCount: 0, expiredCount: 2, revokedCount: 1, exhaustedCount: 1, createdBy: "1", createdAt: 100, nodes: [] },
];

test("admin seller detail shows current/all-time/history and exposes limit, access and confirmed settlement controls", async () => {
  const p = page({
    "/api/app/admin/sellers": [{ sellerId: "10", enabled: true, current: sellerDetail.current, all: sellerDetail.all, limits: sellerDetail.limits }],
    "/api/app/admin/sellers/10": sellerDetail,
    "/api/app/admin/sellers/10/settlements": settlementHistory,
    "/api/app/admin/sellers/10/limits": sellerDetail,
    "/api/app/admin/sellers/10/access": { ...sellerDetail, enabled: false },
    "/api/app/admin/sellers/10/settle": { settlementId: "s2", closedEpoch: 2 },
  });
  await p.context.window.MadarApp.ready;
  await p.context.window.MadarApp.renderView("sellers");
  assert.match(p.elements.get("app-content").innerHTML, /data-admin-seller-id="10"/);

  await p.context.window.MadarApp.openAdminSeller("10");
  let html = p.elements.get("app-content").innerHTML;
  assert.match(html, /دوره جاری/);
  assert.match(html, /کل سابقه/);
  assert.match(html, /۳۰ گیگ/);
  assert.match(html, /۹۰ گیگ/);
  assert.match(html, /تاریخچه تسویه/);
  assert.match(html, /۶۰ گیگ/);

  await p.context.window.MadarApp.saveSellerLimits("10", 12, 120e9);
  await p.context.window.MadarApp.setSellerAccess("10", false);
  p.context.window.MadarApp.askSellerSettlement("10");
  assert.match(p.elements.get("app-content").innerHTML, /تأیید تسویه/);
  assert.match(p.elements.get("app-content").innerHTML, /کانفیگ‌های فعال متوقف نمی‌شوند/);
  await p.context.window.MadarApp.confirmSellerSettlement();

  const limitReq = p.requests.find((r) => r.path.endsWith("/limits") && r.options.method === "POST");
  assert.deepEqual(JSON.parse(limitReq.options.body), { maxReservedAccounts: 12, maxCommittedBytes: 120e9 });
  const accessReq = p.requests.find((r) => r.path.endsWith("/access") && r.options.method === "POST");
  assert.deepEqual(JSON.parse(accessReq.options.body), { enabled: false });
  assert.equal(p.requests.filter((r) => r.path.endsWith("/settle") && r.options.method === "POST").length, 1);
});

test("integrated enrollment advances through seven safe states with fingerprint gate and ready result", async () => {
  let probePoll = 0;
  const p = page({
    "/api/app/admin/enrollment/session": { nonce: "nonce", publicKey: { kty: "RSA" } },
    "/api/app/admin/enrollment/probe": { jobId: "probe1" },
    "/api/app/admin/enrollment/jobs/probe1": () => {
      probePoll += 1;
      return probePoll === 1 ? { id: "probe1", kind: "probe", state: "running" } : { id: "probe1", kind: "probe", state: "ready", fingerprint: "SHA256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" };
    },
    "/api/app/admin/enrollment/enroll": { jobId: "install1" },
    "/api/app/admin/enrollment/jobs/install1": { id: "install1", kind: "install", state: "ready" },
  });
  await p.context.window.MadarApp.ready;
  p.context.window.MadarApp.beginEnrollment();
  assert.match(p.elements.get("app-content").innerHTML, /data-enrollment-step="identity"/);

  p.context.window.MadarApp.setEnrollmentField("name", "Europe 2");
  p.context.window.MadarApp.setEnrollmentField("maxAllocatedGb", 1000);
  p.context.window.MadarApp.setEnrollmentField("maxAccounts", 20);
  p.context.window.MadarApp.enrollmentNext();
  assert.match(p.elements.get("app-content").innerHTML, /data-enrollment-step="target"/);

  p.context.window.MadarApp.setEnrollmentField("targetIp", "8.8.8.8");
  p.context.window.MadarApp.setEnrollmentField("port", 22);
  p.context.window.MadarApp.setEnrollmentField("username", "ubuntu");
  await p.context.window.MadarApp.startEnrollmentProbe();
  assert.match(p.elements.get("app-content").innerHTML, /data-enrollment-step="probe"/);
  await p.context.window.MadarApp.pollEnrollmentJob();
  assert.match(p.elements.get("app-content").innerHTML, /در حال بررسی اتصال/);
  await p.context.window.MadarApp.pollEnrollmentJob();
  assert.match(p.elements.get("app-content").innerHTML, /data-enrollment-step="fingerprint"/);
  assert.match(p.elements.get("app-content").innerHTML, /SHA256:/);

  const beforeConfirm = p.requests.filter((r) => r.path === "/api/app/admin/enrollment/enroll").length;
  assert.equal(beforeConfirm, 0);
  p.context.window.MadarApp.confirmEnrollmentFingerprint();
  assert.match(p.elements.get("app-content").innerHTML, /data-enrollment-step="credentials"/);
  p.context.window.MadarApp.setEnrollmentCredentialMode("password");
  assert.match(p.elements.get("app-content").innerHTML, /رمز VPS/);
  p.context.window.MadarApp.setEnrollmentCredentialMode("key");
  assert.match(p.elements.get("app-content").innerHTML, /کلید خصوصی/);

  p.context.window.MadarApp.setEnrollmentField("encryptedCredentials", '{"v":1,"key":"AA==","iv":"AA==","data":"AA=="}');
  await p.context.window.MadarApp.submitEnrollment();
  assert.match(p.elements.get("app-content").innerHTML, /data-enrollment-step="progress"/);
  await p.context.window.MadarApp.pollEnrollmentJob();
  assert.match(p.elements.get("app-content").innerHTML, /data-enrollment-step="result"/);
  assert.match(p.elements.get("app-content").innerHTML, /سرور آماده است/);

  const enroll = p.requests.find((r) => r.path === "/api/app/admin/enrollment/enroll");
  const body = JSON.parse(enroll.options.body);
  assert.equal(body.targetIp, "8.8.8.8");
  assert.equal(body.hostFingerprint.startsWith("SHA256:"), true);
  assert.equal(body.encryptedCredentials.includes("password"), false);
});

test("enrollment failure shows safe tracking code instead of raw credentials or exceptions", async () => {
  const p = page({
    "/api/app/admin/enrollment/jobs/install-fail": { id: "install-fail", kind: "install", state: "failed", safe_code: "SSH_AUTH_FAILED" },
  });
  await p.context.window.MadarApp.ready;
  p.context.window.MadarApp.beginEnrollment();
  p.context.window.MadarApp.setEnrollmentJobForRecovery("install-fail", "progress");
  await p.context.window.MadarApp.pollEnrollmentJob();
  const html = p.elements.get("app-content").innerHTML;
  assert.match(html, /نصب کامل نشد/);
  assert.match(html, /SSH_AUTH_FAILED/);
  assert.doesNotMatch(html, /encryptedCredentials|password|private key/i);
});
