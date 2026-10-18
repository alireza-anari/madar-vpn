import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import assert from "node:assert/strict";

const source = readFileSync(new URL("../public/status.html", import.meta.url), "utf8")
  .match(/<script>([\s\S]*?)<\/script>/)[1];

function page(status, pathname = "/usage/" + "a".repeat(64)) {
  const elements = new Map(), requests = [];
  const doc = {
    hidden: true, // Suppress auto-refresh until the test explicitly requests it.
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, { textContent: "", value: 0, disabled: false });
      return elements.get(id);
    },
  };
  const context = {
    location: { pathname },
    document: doc,
    Date,
    fetch: async (path, options) => {
      requests.push({ path, options });
      return { ok: true, json: async () => options?.method === "POST" ? { pending: true } : status };
    },
    setTimeout: (callback) => callback(),
  };
  runInNewContext(source, context);
  return { context, elements, requests, doc };
}

const fresh = {
  label: "<script>test</script>",
  totalBytes: 30e9,
  usedBytes: 1e9,
  remainingBytes: 29e9,
  expiresAt: 2000000000,
  state: "active",
  lastReportAt: Math.floor(Date.now() / 1000),
  refreshPending: false,
};

test("customer refresh is explicit and does not start a background poller", async () => {
  const p = page(fresh);
  assert.equal(p.requests.length, 0);
  p.doc.hidden = false;
  await p.context.refresh();
  assert.equal(p.requests.length, 2);
  assert.equal(p.requests[0].path, "/api/usage/" + "a".repeat(64) + "/refresh");
  assert.equal(p.requests[0].options.method, "POST");
  assert.equal(p.requests[1].options.method, undefined);
  assert.equal(p.elements.get("label").textContent, fresh.label);
  assert.equal(p.elements.get("notice").textContent, "");
  assert.equal(p.requests[0].options.credentials, "omit");
  assert.equal(p.requests[0].options.referrerPolicy, "no-referrer");
  p.doc.hidden = true;
  await p.context.refresh();
  assert.equal(p.requests.length, 2);
});

test("v2 capability links use the v2 API route", async () => {
  const p = page(fresh, "/usage/v2/" + "b".repeat(80));
  p.doc.hidden = false;
  await p.context.refresh();
  assert.equal(p.requests[0].path, "/api/usage/v2/" + "b".repeat(80) + "/refresh");
});

test("old reports do not pretend to be live values", async () => {
  const p = page({ ...fresh, lastReportAt: 1 });
  p.doc.hidden = false;
  await p.context.refresh();
  assert.match(p.elements.get("notice").textContent, /تازه نیست/);
});

test("non-responding node leaves visible stale notice", async () => {
  const p = page({ ...fresh, refreshPending: true });
  p.doc.hidden = false;
  await p.context.refresh();
  assert.equal(p.requests.length, 13);
  assert.match(p.elements.get("notice").textContent, /پاسخ تازه نداد/);
});
