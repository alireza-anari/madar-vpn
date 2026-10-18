import { runInNewContext } from "node:vm";
import { test } from "node:test";
import assert from "node:assert/strict";
import client from "../public/app.js";

const result = {
  accountId: "a1",
  state: "active",
  ready: true,
  label: "Nima",
  kind: "sale",
  quotaBytes: 30e9,
  durationSeconds: 30 * 86400,
  validUntil: 20_000,
  serverName: "Stockholm",
  config: "vless://11111111-1111-4111-8111-111111111111@8.8.8.8:443?security=reality#Madar",
  usageUrl: "https://example.test/usage/v2/v2.a1.signature",
  qrSvg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><path d="M0 0h1v1H0z"/></svg>',
};

function page({ canShareFiles = false, shareError = null, withShare = true, withClipboard = true } = {}) {
  const elements = new Map();
  const listeners = new Map();
  const shares = [];
  const clipboardWrites = [];
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

  class BlobStub {
    constructor(parts = [], options = {}) {
      this.parts = parts;
      this.type = options.type || "";
    }
  }
  class FileStub extends BlobStub {
    constructor(parts, name, options = {}) {
      super(parts, options);
      this.name = name;
    }
  }
  class ImageStub {
    set src(_value) {
      queueMicrotask(() => this.onload?.());
    }
  }

  const document = {
    hidden: false,
    getElementById(id) {
      return elements.get(id) || null;
    },
    addEventListener(type, fn) {
      listeners.set(`document:${type}`, fn);
    },
    createElement(name) {
      assert.equal(name, "canvas");
      return {
        width: 0,
        height: 0,
        getContext() {
          return { drawImage() {} };
        },
        toBlob(callback) {
          callback(new BlobStub(["png"], { type: "image/png" }));
        },
      };
    },
  };

  const navigator = {};
  if (withClipboard) {
    navigator.clipboard = {
      async writeText(value) {
        clipboardWrites.push(value);
      },
    };
  }
  if (withShare) {
    navigator.canShare = ({ files }) => canShareFiles && Array.isArray(files) && files.length === 1;
    navigator.share = async (payload) => {
      shares.push(payload);
      if (shareError) throw shareError;
    };
  }

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
  };

  const context = {
    window,
    document,
    navigator,
    Blob: BlobStub,
    File: FileStub,
    Image: ImageStub,
    URL: {
      createObjectURL() {
        return "blob:test";
      },
      revokeObjectURL() {},
    },
    URLSearchParams,
    Intl,
    console,
    Date,
    Math,
    queueMicrotask,
    setTimeout,
    clearTimeout,
    fetch: async (path) => {
      if (path === "/api/app/dashboard")
        return {
          ok: true,
          status: 200,
          json: async () => ({
            role: "seller",
            summary: {
              configsInService: 1,
              currentSoldBytes: 30e9,
              allTimeSoldBytes: 30e9,
              usedBytes: 0,
            },
            nodes: [],
          }),
        };
      if (path === "/api/app/configs/a1/result")
        return { ok: true, status: 200, json: async () => result };
      return { ok: false, status: 404, json: async () => ({ error: "NOT_FOUND" }) };
    },
  };
  runInNewContext(client, context);
  return { context, elements, shares, clipboardWrites };
}

test("ready result mounts server QR and exposes usage actions with complete share text", async () => {
  const p = page();
  await p.context.window.MadarApp.ready;
  await p.context.window.MadarApp.recoverAccount("a1");
  const html = p.elements.get("app-content").innerHTML;
  assert.match(html, /<svg/);
  assert.match(html, /مصرف و اعتبار/);
  assert.match(html, /کپی لینک مصرف/);
  assert.match(html, /https:\/\/example\.test\/usage\/v2\//);

  const text = p.context.window.MadarApp.buildShareText(result);
  for (const expected of [
    "Nima",
    "۳۰ گیگ",
    "۳۰ روز",
    "Stockholm",
    result.usageUrl,
    result.config,
  ])
    assert.ok(text.includes(expected), expected);
});

test("share uses a PNG file when Web Share accepts files", async () => {
  const p = page({ canShareFiles: true });
  await p.context.window.MadarApp.ready;
  await p.context.window.MadarApp.recoverAccount("a1");
  assert.equal(await p.context.window.MadarApp.shareResult(), true);
  assert.equal(p.shares.length, 1);
  assert.equal(p.shares[0].files.length, 1);
  assert.equal(p.shares[0].files[0].type, "image/png");
  assert.match(p.shares[0].text, /Nima/);
  assert.match(p.shares[0].text, /usage\/v2/);
});

test("share falls back to rich text, and then clipboard when share is unavailable", async () => {
  const p = page({ canShareFiles: false });
  await p.context.window.MadarApp.ready;
  await p.context.window.MadarApp.recoverAccount("a1");
  assert.equal(await p.context.window.MadarApp.shareResult(), true);
  assert.equal(p.shares.length, 1);
  assert.equal(p.shares[0].files, undefined);
  assert.match(p.shares[0].text, /Nima/);
  assert.match(p.shares[0].text, /Stockholm/);
  assert.match(p.shares[0].text, /usage\/v2/);
  assert.match(p.shares[0].text, /vless:\/\//);

  const clipboard = page({ withShare: false });
  await clipboard.context.window.MadarApp.ready;
  await clipboard.context.window.MadarApp.recoverAccount("a1");
  assert.equal(await clipboard.context.window.MadarApp.shareResult(), true);
  assert.equal(clipboard.clipboardWrites.length, 1);
  assert.match(clipboard.clipboardWrites[0], /Nima/);
  assert.match(clipboard.clipboardWrites[0], /usage\/v2/);
});

test("user-cancelled native share does not unexpectedly copy", async () => {
  const error = new Error("cancelled");
  error.name = "AbortError";
  const p = page({ canShareFiles: false, shareError: error });
  await p.context.window.MadarApp.ready;
  await p.context.window.MadarApp.recoverAccount("a1");
  assert.equal(await p.context.window.MadarApp.shareResult(), false);
  assert.equal(p.clipboardWrites.length, 0);
});
