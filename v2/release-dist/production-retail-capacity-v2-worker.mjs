var __freeze = Object.freeze;
var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });
var __template = (cooked, raw) => __freeze(__defProp(cooked, "raw", { value: __freeze(raw || cooked.slice()) }));

// src/android-account.mjs
var TOKEN = /^[A-Za-z0-9_-]{43}$/;
var tokenDigest = /* @__PURE__ */ __name(async (value) => {
  if (!TOKEN.test(value ?? "")) return null;
  const digest2 = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest2)).map((x) => x.toString(16).padStart(2, "0")).join("");
}, "tokenDigest");
var randomToken = /* @__PURE__ */ __name(() => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}, "randomToken");
async function issueAppSession(env, telegramId, now = Date.now()) {
  if (!env.DB || !/^\d{5,20}$/.test(telegramId ?? "")) return null;
  const owner = await env.DB.prepare(
    "SELECT c.telegram_id FROM customers c JOIN telegram_bot_activations a ON a.telegram_id=c.telegram_id WHERE c.telegram_id=? AND c.state='active' LIMIT 1"
  ).bind(telegramId).first();
  if (!owner) return null;
  const token = randomToken(), hash = await tokenDigest(token);
  const expiresAt = now + 30 * 24 * 60 * 60 * 1e3;
  await env.DB.prepare(
    "INSERT INTO android_app_sessions(token_hash,telegram_id,created_ms,expires_ms) VALUES(?,?,?,?)"
  ).bind(hash, telegramId, now, expiresAt).run();
  return { token, expires_at: expiresAt };
}
__name(issueAppSession, "issueAppSession");
async function findAppSession(db, digest2, now = Date.now()) {
  if (!db || !digest2) return null;
  const row = await db.prepare(
    "SELECT a.telegram_id FROM android_app_sessions a JOIN customers c ON c.telegram_id=a.telegram_id AND c.state='active' JOIN telegram_bot_activations b ON b.telegram_id=c.telegram_id WHERE a.token_hash=? AND a.revoked=0 AND a.expires_ms>? LIMIT 1"
  ).bind(digest2, now).first();
  return row?.telegram_id ?? null;
}
__name(findAppSession, "findAppSession");
async function revokeAppSession(db, digest2) {
  await db.prepare(
    "UPDATE android_app_sessions SET revoked=1 WHERE token_hash=?"
  ).bind(digest2).run();
}
__name(revokeAppSession, "revokeAppSession");

// src/bot-ux.mjs
var faDigits = new Intl.NumberFormat("fa-IR");
function faNumber(value, options = {}) {
  const n = Number(value);
  return Number.isFinite(n) ? faDigits.format(n) : "\u06F0";
}
__name(faNumber, "faNumber");
function faMoney(amount, currency = "IRT") {
  const unit = { IRT: "\u062A\u0648\u0645\u0627\u0646", IRR: "\u0631\u06CC\u0627\u0644", USD: "\u062F\u0644\u0627\u0631 \u0622\u0645\u0631\u06CC\u06A9\u0627" }[currency] ?? currency;
  return faNumber(amount) + " " + unit;
}
__name(faMoney, "faMoney");
function faGB(value) {
  const n = Number(value);
  return (Number.isFinite(n) ? new Intl.NumberFormat("fa-IR", { maximumFractionDigits: 2 }).format(n) : "\u06F0") + " \u06AF\u06CC\u06AF\u0627\u0628\u0627\u06CC\u062A";
}
__name(faGB, "faGB");
function faDate(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "\u062B\u0628\u062A \u0646\u0634\u062F\u0647";
  try {
    return new Intl.DateTimeFormat("fa-IR-u-ca-persian", {
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: "Asia/Tehran"
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat("fa-IR", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      timeZone: "Asia/Tehran"
    }).format(date);
  }
}
__name(faDate, "faDate");
var states = {
  pending: "\u062F\u0631 \u0627\u0646\u062A\u0638\u0627\u0631 \u0628\u0631\u0631\u0633\u06CC",
  receipt_submitted: "\u0631\u0633\u06CC\u062F \u0627\u0631\u0633\u0627\u0644 \u0634\u062F\u0647",
  approved: "\u062A\u0623\u06CC\u06CC\u062F \u0634\u062F\u0647",
  rejected: "\u0631\u062F \u0634\u062F\u0647",
  provisioning: "\u062F\u0631 \u062D\u0627\u0644 \u0622\u0645\u0627\u062F\u0647\u200C\u0633\u0627\u0632\u06CC",
  active: "\u0641\u0639\u0627\u0644",
  suspended: "\u062A\u0639\u0644\u06CC\u0642\u200C\u0634\u062F\u0647",
  expired: "\u0645\u0646\u0642\u0636\u06CC\u200C\u0634\u062F\u0647",
  open: "\u0628\u0627\u0632",
  waiting: "\u062F\u0631 \u0627\u0646\u062A\u0638\u0627\u0631 \u067E\u0627\u0633\u062E",
  closed: "\u0628\u0633\u062A\u0647\u200C\u0634\u062F\u0647",
  installed: "\u0646\u0635\u0628\u200C\u0634\u062F\u0647",
  enrolling: "\u062F\u0631 \u062D\u0627\u0644 \u062B\u0628\u062A",
  ready: "\u0622\u0645\u0627\u062F\u0647",
  degraded: "\u0646\u06CC\u0627\u0632\u0645\u0646\u062F \u0628\u0631\u0631\u0633\u06CC",
  draft: "\u067E\u06CC\u0634\u200C\u0646\u0648\u06CC\u0633",
  checking: "\u062F\u0631 \u062D\u0627\u0644 \u0628\u0631\u0631\u0633\u06CC",
  dispatching: "\u062F\u0631 \u062D\u0627\u0644 \u0627\u0631\u0633\u0627\u0644 \u062F\u0633\u062A\u0648\u0631",
  dispatched: "\u062F\u0633\u062A\u0648\u0631 \u0627\u0631\u0633\u0627\u0644 \u0634\u062F",
  failed: "\u0646\u0627\u0645\u0648\u0641\u0642",
  disabled: "\u063A\u06CC\u0631\u0641\u0639\u0627\u0644",
  revoked: "\u0644\u063A\u0648\u0634\u062F\u0647",
  reserved: "\u0631\u0632\u0631\u0648\u0634\u062F\u0647",
  accepted: "\u067E\u0630\u06CC\u0631\u0641\u062A\u0647\u200C\u0634\u062F\u0647",
  fulfilled: "\u062A\u062D\u0648\u06CC\u0644 \u062F\u0627\u062F\u0647 \u0634\u062F\u0647",
  cancelled: "\u0644\u063A\u0648 \u0634\u062F\u0647",
  refunded: "\u0648\u062C\u0647 \u0628\u0627\u0632\u06AF\u0631\u062F\u0627\u0646\u062F\u0647 \u0634\u062F",
  quarantined: "\u0642\u0631\u0646\u0637\u06CC\u0646\u0647\u200C\u0634\u062F\u0647",
  retired: "\u062E\u0627\u0631\u062C \u0627\u0632 \u0633\u0631\u0648\u06CC\u0633",
  released: "\u0622\u0632\u0627\u062F \u0634\u062F\u0647"
};
function faStatus(value) {
  const key = String(value ?? "").toLowerCase();
  return states[key] ?? (key || "\u0646\u0627\u0645\u0634\u062E\u0635");
}
__name(faStatus, "faStatus");
function faRole(value) {
  return { seller: "\u0641\u0631\u0648\u0634\u0646\u062F\u0647", support: "\u067E\u0634\u062A\u06CC\u0628\u0627\u0646", admin: "\u0645\u062F\u06CC\u0631" }[value] ?? String(value ?? "");
}
__name(faRole, "faRole");
function panelHeading(icon, title, subtitle = "") {
  return [icon + "  " + title, subtitle].filter(Boolean).join("\n");
}
__name(panelHeading, "panelHeading");
function frameMessage(content) {
  const body3 = String(content ?? "").replace(/^[━─═]{6,}\s*$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
  if (body3.startsWith("\u{1F310}  \u0645\u0640\u0640\u062F\u0627\u0631\n")) return body3;
  return "\u{1F310}  \u0645\u0640\u0640\u062F\u0627\u0631\n" + body3;
}
__name(frameMessage, "frameMessage");
var BRAND_BANNER_URL = "https://madar-v2-staging.alirezaanari117.workers.dev/brand/banner.jpg";
function styleInlineKeyboard(markup) {
  if (!markup || !Array.isArray(markup.inline_keyboard)) return markup;
  const primary = /* @__PURE__ */ new Set([
    "v2:plans",
    "v2:my",
    "v2:admin:home",
    "v2:customer:home",
    "v2:admin:nodes",
    "v2:admin:tickets",
    "v2:status",
    "v2:seller:home"
  ]);
  const success = /* @__PURE__ */ new Set(["v2:admin:node:new", "v2:seller:invite", "v2:customer:trial"]);
  const danger = /* @__PURE__ */ new Set(["v2:seller:revoke"]);
  return { ...markup, inline_keyboard: markup.inline_keyboard.map(
    (row) => row.map((button4) => {
      const cb = String(button4.callback_data ?? "");
      if (button4.style || !cb) return { ...button4 };
      const style = primary.has(cb) ? "primary" : success.has(cb) ? "success" : danger.has(cb) ? "danger" : null;
      return style ? { ...button4, style } : { ...button4 };
    })
  ) };
}
__name(styleInlineKeyboard, "styleInlineKeyboard");
var customerMenu = { inline_keyboard: [
  [
    { text: "\u{1F6CD} \u062E\u0631\u06CC\u062F \u0627\u0634\u062A\u0631\u0627\u06A9", callback_data: "v2:plans" },
    { text: "\u{1F4E6} \u0627\u0634\u062A\u0631\u0627\u06A9\u200C\u0647\u0627\u06CC \u0645\u0646", callback_data: "v2:my" }
  ],
  [
    { text: "\u{1F9EA} \u062F\u0631\u06CC\u0627\u0641\u062A \u062A\u0633\u062A \u0631\u0627\u06CC\u06AF\u0627\u0646", callback_data: "v2:customer:trial" },
    { text: "\u{1F4F6} \u0648\u0636\u0639\u06CC\u062A \u0633\u0631\u0648\u06CC\u0633", callback_data: "v2:status" }
  ],
  [
    { text: "\u{1F9FE} \u0633\u0641\u0627\u0631\u0634\u200C\u0647\u0627\u06CC \u0645\u0646", callback_data: "v2:orders" },
    { text: "\u{1F4AC} \u067E\u0634\u062A\u06CC\u0628\u0627\u0646\u06CC", callback_data: "v2:customer:tickets" }
  ],
  [
    { text: "\u{1F4D8} \u0631\u0627\u0647\u0646\u0645\u0627\u06CC \u0627\u062A\u0635\u0627\u0644", callback_data: "v2:help" },
    { text: "\u{1F510} \u062D\u0631\u06CC\u0645 \u062E\u0635\u0648\u0635\u06CC", callback_data: "v2:privacy" }
  ]
] };
var managerMenu = { inline_keyboard: [
  [
    { text: "\u{1F5A5} \u0645\u062F\u06CC\u0631\u06CC\u062A \u0633\u0631\u0648\u0631\u0647\u0627", callback_data: "v2:admin:nodes" },
    { text: "\u{1F6CD} \u0645\u062F\u06CC\u0631\u06CC\u062A \u067E\u0644\u0646\u200C\u0647\u0627", callback_data: "v2:admin:plans" }
  ],
  [
    { text: "\u{1F9FE} \u0628\u0631\u0631\u0633\u06CC \u0631\u0633\u06CC\u062F\u0647\u0627", callback_data: "v2:admin:queue" },
    { text: "\u{1F465} \u0645\u0634\u062A\u0631\u06CC\u0627\u0646", callback_data: "v2:admin:customers" }
  ],
  [
    { text: "\u{1F4AC} \u0635\u0646\u062F\u0648\u0642 \u067E\u0634\u062A\u06CC\u0628\u0627\u0646\u06CC", callback_data: "v2:admin:tickets" },
    { text: "\u{1F517} \u0635\u062F\u0648\u0631 \u06A9\u0627\u0646\u0641\u06CC\u06AF", callback_data: "v2:admin:configs" }
  ],
  [{ text: "\u{1F9D1}\u200D\u{1F4BC} \u06A9\u0627\u0631\u06A9\u0646\u0627\u0646 \u0648 \u0641\u0631\u0648\u0634\u0646\u062F\u06AF\u0627\u0646", callback_data: "v2:admin:staff" }]
] };
var sellerMenuMarkup = { inline_keyboard: [
  [
    { text: "\u{1F9FE} \u0633\u0641\u0627\u0631\u0634\u200C\u0647\u0627\u06CC \u0645\u0646", callback_data: "v2:seller:orders" },
    { text: "\u{1F517} \u0633\u0627\u062E\u062A \u0644\u06CC\u0646\u06A9 \u0645\u0639\u0631\u0641\u06CC", callback_data: "v2:seller:invite" }
  ],
  [
    { text: "\u{1F512} \u0644\u063A\u0648 \u0644\u06CC\u0646\u06A9\u200C\u0647\u0627\u06CC \u0642\u0628\u0644\u06CC", callback_data: "v2:seller:revoke" },
    { text: "\u{1F3E0} \u062E\u0627\u0646\u0647", callback_data: "v2:customer:home" }
  ]
] };
var supportMenuMarkup = { inline_keyboard: [
  [{ text: "\u{1F4AC} \u0635\u0646\u062F\u0648\u0642 \u067E\u0634\u062A\u06CC\u0628\u0627\u0646\u06CC", callback_data: "v2:admin:tickets" }],
  [{ text: "\u{1F3E0} \u062E\u0627\u0646\u0647 \u0645\u0634\u062A\u0631\u06CC", callback_data: "v2:customer:home" }]
] };
function botMenu() {
  return structuredClone(customerMenu);
}
__name(botMenu, "botMenu");
function adminMenu() {
  return structuredClone(managerMenu);
}
__name(adminMenu, "adminMenu");
function sellerMenu() {
  return structuredClone(sellerMenuMarkup);
}
__name(sellerMenu, "sellerMenu");
function supportMenu() {
  return structuredClone(supportMenuMarkup);
}
__name(supportMenu, "supportMenu");
function sectionNavigation(role = "customer") {
  const destination = {
    customer: "customer:home",
    admin: "admin:home",
    seller: "seller:home",
    support: "admin:tickets"
  }[role] ?? "customer:home";
  return [[{ text: "\u21A9\uFE0F \u0628\u0627\u0632\u06AF\u0634\u062A", callback_data: "v2:" + destination }]];
}
__name(sectionNavigation, "sectionNavigation");
function parentPage(key, isAdmin = false) {
  key = String(key ?? "");
  if (key === "customer:trial") return "customer:home";
  if (key === "admin:node:new") return "admin:node:cancel";
  if (key === "admin:node:cancel") return "admin:home";
  if (key === "admin:node:trials") return "admin:nodes";
  if (key === "admin:configs" || key === "admin:configs:home") return "admin:home";
  if (key === "admin:configs:e2e:list") return "admin:configs";
  if (/^admin:configs:e2e:(view|start|status|link|end|revoke):[a-f0-9]{24}$/.test(key))
    return "admin:configs:e2e:list";
  if (/^admin:configs:(trials|subscriptions):[0-9]{1,4}$/.test(key))
    return "admin:configs";
  if (/^admin:configs:trial:[a-f0-9]{24}$/.test(key))
    return "admin:configs:trials:0";
  if (/^admin:configs:subscription:[a-f0-9]{24}$/.test(key))
    return "admin:configs:subscriptions:0";
  if (/^admin:configs:issue:[a-f0-9]{24}$/.test(key))
    return "admin:configs:subscription:" + key.slice(-24);
  if (/^admin:tickets:(open|waiting|closed|all):[0-9]{1,4}$/.test(key))
    return "admin:tickets";
  if (/^ticket:page:tg-[0-9]{1,20}:[0-9]{1,4}$/.test(key))
    return "ticket:view:" + key.split(":")[2];
  if (/^customer:ticket:page:tg-[0-9]{1,20}:[0-9]{1,4}$/.test(key))
    return "customer:ticket:" + key.split(":")[3];
  if (/^admin:nodes:(all|ready|setup|testing|attention|quarantine|archive):[0-9]{1,4}$/.test(key))
    return "admin:nodes";
  if (/^admin:node:(confirm|apply):(quarantine|restore|retire):[a-f0-9]{24}$/.test(key))
    return "admin:node:view:" + key.slice(-24);
  if (/^admin:node:(field|fieldapply):(mci|irancell):[a-f0-9]{24}$/.test(key))
    return "admin:node:view:" + key.slice(-24);
  if (/^admin:node:trialref:[a-f0-9]{24}$/.test(key))
    return "admin:node:view:" + key.slice(-24);
  if (/^admin:node:view:[a-f0-9]{24}$/.test(key)) return "admin:nodes";
  if (key.startsWith("admin:node:trial:")) return "admin:node:trials";
  if (key === "admin:nodes" || key === "/nodes" || key === "/node_add" || key === "/node_route") return "admin:home";
  if (key.startsWith("admin:plan:") || key.startsWith("plan:")) return "admin:plans";
  if (key === "admin:plans") return "admin:home";
  if (key.startsWith("admin:receipt:")) return "admin:queue";
  if (key.startsWith("admin:review:")) {
    const id = key.split(":").at(-1);
    return /^[a-zA-Z0-9][a-zA-Z0-9_-]{1,48}$/.test(id) ? "admin:receipt:" + id : "admin:queue";
  }
  if (key === "admin:queue") return "admin:home";
  if (key.startsWith("admin:customer:")) {
    const id = key.split(":").at(-1);
    const isAction = /^admin:customer:(?:suspend|activate|confirm):/.test(key);
    return isAction && /^[0-9]{1,20}$/.test(id) ? "admin:customer:" + id : "admin:customers";
  }
  if (key.startsWith("admin:customers")) return "admin:home";
  if (key.startsWith("admin:staff:")) return "admin:staff";
  if (key === "admin:staff") return "admin:home";
  if (key === "admin:tickets") return isAdmin ? "admin:home" : "home";
  if (key.startsWith("ticket:view:")) return "admin:tickets";
  if (key.startsWith("ticket:")) {
    const id = key.split(":").at(-1);
    return /^tg-[0-9]{1,20}$/.test(id) ? "ticket:view:" + id : "admin:tickets";
  }
  if (key.startsWith("seller:")) return "seller:home";
  if (key === "support" || key === "/support") return "customer:tickets";
  if (key.startsWith("customer:ticket:reply:"))
    return "customer:ticket:" + key.slice("customer:ticket:reply:".length);
  if (key.startsWith("customer:ticket:")) return "customer:tickets";
  if (key.startsWith("customer:tickets")) return "customer:home";
  if (key.startsWith("orders:view:")) return "orders";
  if (key.startsWith("my:link:")) return "my";
  if (key.startsWith("buy:")) return "plans";
  if (key === "plans" || key === "my" || key === "orders" || key === "status" || key === "help" || key === "privacy" || key === "/plans" || key === "/my" || key === "/orders")
    return "customer:home";
  return isAdmin ? "admin:home" : "customer:home";
}
__name(parentPage, "parentPage");
function contextualKeyboard(key, markup, { isAdmin = false } = {}) {
  if (!markup || !Array.isArray(markup.inline_keyboard)) return markup;
  key = String(key ?? "");
  const adminHome = isAdmin && ["/start", "/admin", "admin:home", "home"].includes(key);
  const userHome = ["customer:home"].includes(key) || !isAdmin && ["/start", "home"].includes(key);
  const sellerHome = key === "seller:home" || key === "/seller";
  if (adminHome) return structuredClone(markup);
  if (userHome || sellerHome) {
    return { ...markup, inline_keyboard: markup.inline_keyboard.map((row) => row.filter(
      (b) => !String(b.text ?? "").includes("\u0646\u0645\u0627\u06CC \u0645\u0634\u062A\u0631\u06CC")
    )).filter((row) => row.length > 0) };
  }
  const source = markup.inline_keyboard;
  if (source.flat().some((b) => b.callback_data === "v2:admin:plan:cancel"))
    return { ...markup, inline_keyboard: source.map((row) => row.filter(
      (b) => !String(b.text ?? "").startsWith("\u21A9\uFE0F") && !String(b.text ?? "").startsWith("\u{1F3E0}")
    )).filter((row) => row.length > 0) };
  const explicitBack = key === "text" || /^ticket:media:[0-9]{1,20}$/.test(key) || /^customer:ticket:media:[0-9]{1,20}$/.test(key);
  const typedBack = explicitBack ? source.flat().find((b) => String(b.text ?? "").startsWith("\u21A9\uFE0F") && /^v2:[a-zA-Z0-9:_-]{1,64}$/.test(String(b.callback_data ?? ""))) : null;
  const target = typedBack ? typedBack.callback_data.slice(3) : parentPage(key, isAdmin);
  const backData = "v2:" + target;
  const rootAdmin = new Set(adminMenu().inline_keyboard.flat().map((b) => b.callback_data));
  const rootCustomer = new Set(botMenu().inline_keyboard.flat().map((b) => b.callback_data));
  const rootSeller = new Set(sellerMenu().inline_keyboard.flat().map((b) => b.callback_data));
  const isFullAdminMenu = source.flat().filter((b) => rootAdmin.has(b.callback_data)).length >= 4;
  const isFullCustomerMenu = source.flat().filter((b) => rootCustomer.has(b.callback_data)).length >= 4;
  const isFullSellerMenu = source.flat().filter((b) => rootSeller.has(b.callback_data)).length >= 3;
  const rows = source.map((row) => row.filter((button4) => {
    const txt = String(button4.text ?? ""), cb = String(button4.callback_data ?? "");
    if (txt.includes("\u0646\u0645\u0627\u06CC \u0645\u0634\u062A\u0631\u06CC")) return false;
    if (cb === backData) return false;
    if (txt.startsWith("\u21A9\uFE0F") || txt.startsWith("\u{1F3E0}")) return false;
    if (isFullAdminMenu && rootAdmin.has(cb)) return false;
    if (isFullCustomerMenu && rootCustomer.has(cb)) return false;
    if (isFullSellerMenu && rootSeller.has(cb)) return false;
    return true;
  })).filter((row) => row.length > 0);
  rows.push([{ text: "\u21A9\uFE0F \u0628\u0627\u0632\u06AF\u0634\u062A", callback_data: backData }]);
  return { ...markup, inline_keyboard: rows };
}
__name(contextualKeyboard, "contextualKeyboard");
function usageMeter(usedBytes, maxBytes) {
  const max = Number(maxBytes), used = Number(usedBytes);
  if (!Number.isFinite(max) || max <= 0) return "\u062D\u062C\u0645 \u0627\u0634\u062A\u0631\u0627\u06A9 \u0646\u0627\u0645\u0634\u062E\u0635 \u0627\u0633\u062A";
  const safeUsed = Number.isFinite(used) ? Math.max(0, used) : 0;
  const ratio = Math.min(1, safeUsed / max), filled = Math.round(ratio * 10);
  const percent = new Intl.NumberFormat("fa-IR", { maximumFractionDigits: 0 }).format(Math.min(100, Math.max(0, safeUsed / max * 100)));
  return "\u25B0".repeat(filled) + "\u25B1".repeat(10 - filled) + "  " + percent + "\u066A";
}
__name(usageMeter, "usageMeter");
function shortCode(value, max = 10) {
  const str = String(value ?? "");
  return str.length <= max ? str : str.slice(0, max) + "\u2026";
}
__name(shortCode, "shortCode");
function statusSymbol(state) {
  return {
    active: "\u{1F7E2}",
    ready: "\u{1F7E2}",
    approved: "\u2705",
    installed: "\u{1F7E2}",
    pending: "\u{1F7E1}",
    receipt_submitted: "\u{1F7E1}",
    waiting: "\u{1F7E1}",
    provisioning: "\u{1F7E0}",
    enrolling: "\u{1F7E0}",
    open: "\u{1F535}",
    rejected: "\u{1F534}",
    failed: "\u{1F534}",
    suspended: "\u{1F534}",
    degraded: "\u{1F7E0}",
    expired: "\u26AA",
    closed: "\u26AA",
    disabled: "\u26AA",
    fulfilled: "\u2705",
    cancelled: "\u26AA",
    refunded: "\u26AA",
    quarantined: "\u{1F534}",
    retired: "\u26AA"
  }[state] ?? "\u{1F539}";
}
__name(statusSymbol, "statusSymbol");
var pages = {
  home: "\u{1F310} \u0628\u0647 \u0645\u062F\u0627\u0631 \u062E\u0648\u0634 \u0622\u0645\u062F\u06CC\u062F\n\n\u0627\u0632 \u0627\u06CC\u0646\u062C\u0627 \u0645\u06CC\u200C\u062A\u0648\u0627\u0646\u06CC\u062F \u0627\u0634\u062A\u0631\u0627\u06A9 \u0628\u062E\u0631\u06CC\u062F\u060C \u0648\u0636\u0639\u06CC\u062A \u0633\u0631\u0648\u06CC\u0633 \u0648 \u0633\u0641\u0627\u0631\u0634\u200C\u0647\u0627 \u0631\u0627 \u0628\u0628\u06CC\u0646\u06CC\u062F \u0648 \u0628\u0627 \u067E\u0634\u062A\u06CC\u0628\u0627\u0646\u06CC \u062F\u0631 \u0627\u0631\u062A\u0628\u0627\u0637 \u0628\u0627\u0634\u06CC\u062F.\n\n\u26D4 \u0641\u0631\u0648\u0634 \u0639\u0645\u0648\u0645\u06CC \u062A\u0627 \u062A\u0623\u06CC\u06CC\u062F \u0622\u0632\u0645\u0648\u0646 \u0627\u062A\u0635\u0627\u0644 \u0648 \u06A9\u0646\u062A\u0631\u0644 \u0645\u0635\u0631\u0641 \u063A\u06CC\u0631\u0641\u0639\u0627\u0644 \u0627\u0633\u062A. \u0644\u0637\u0641\u0627\u064B \u0641\u0639\u0644\u0627\u064B \u067E\u0631\u062F\u0627\u062E\u062A\u06CC \u0627\u0646\u062C\u0627\u0645 \u0646\u062F\u0647\u06CC\u062F.",
  plans: "\u{1F6CD}  \u0627\u0646\u062A\u062E\u0627\u0628 \u0627\u0634\u062A\u0631\u0627\u06A9\n\n\u0641\u0631\u0648\u0634 \u0639\u0645\u0648\u0645\u06CC \u063A\u06CC\u0631\u0641\u0639\u0627\u0644 \u0627\u0633\u062A. \u0628\u0633\u062A\u0647\u200C\u0647\u0627 \u067E\u0633 \u0627\u0632 \u062A\u0623\u06CC\u06CC\u062F \u0638\u0631\u0641\u06CC\u062A \u0648 \u06A9\u0646\u062A\u0631\u0644 \u0645\u0635\u0631\u0641 \u062F\u0631 \u0627\u06CC\u0646 \u0628\u062E\u0634 \u0645\u0646\u062A\u0634\u0631 \u0645\u06CC\u200C\u0634\u0648\u0646\u062F.\n\n\u0627\u0634\u062A\u0631\u0627\u06A9\u200C\u0647\u0627\u06CC \u0646\u0633\u062E\u0647 \u0642\u0628\u0644\u06CC \u0634\u0645\u0627 \u0645\u0633\u062A\u0642\u0644 \u0648 \u0645\u062D\u0641\u0648\u0638 \u0647\u0633\u062A\u0646\u062F.",
  my: "\u{1F4E6}  \u0627\u0634\u062A\u0631\u0627\u06A9\u200C\u0647\u0627\u06CC \u0645\u0646\n\n\u0648\u0636\u0639\u06CC\u062A\u060C \u062D\u062C\u0645 \u0645\u0635\u0631\u0641\u06CC\u060C \u062A\u0627\u0631\u06CC\u062E \u067E\u0627\u06CC\u0627\u0646 \u0648 \u0644\u06CC\u0646\u06A9 \u0627\u062A\u0635\u0627\u0644 \u0627\u0634\u062A\u0631\u0627\u06A9\u200C\u0647\u0627\u06CC \u0634\u0645\u0627 \u062F\u0631 \u0627\u06CC\u0646 \u0628\u062E\u0634 \u0646\u0645\u0627\u06CC\u0634 \u062F\u0627\u062F\u0647 \u0645\u06CC\u200C\u0634\u0648\u062F.",
  status: "\u{1F4F6}  \u0648\u0636\u0639\u06CC\u062A \u0633\u0631\u0648\u06CC\u0633\n\n\u0645\u062F\u0627\u0631 \u062F\u0631 \u0645\u0631\u062D\u0644\u0647 \u0622\u0632\u0645\u0648\u0646 \u0646\u0647\u0627\u06CC\u06CC \u0642\u0631\u0627\u0631 \u062F\u0627\u0631\u062F. \u0645\u0633\u06CC\u0631\u0647\u0627\u06CC \u062A\u0623\u06CC\u06CC\u062F\u0646\u0634\u062F\u0647 \u0647\u0646\u0648\u0632 \u0622\u0645\u0627\u062F\u0647 \u0627\u0633\u062A\u0641\u0627\u062F\u0647 \u0646\u06CC\u0633\u062A\u0646\u062F\u061B \u0641\u0642\u0637 \u0645\u0633\u06CC\u0631\u0647\u0627\u06CC\u06CC \u06A9\u0647 \u0622\u0632\u0645\u0648\u0646 \u0648\u0627\u0642\u0639\u06CC \u0627\u062A\u0635\u0627\u0644 \u0631\u0627 \u06AF\u0630\u0631\u0627\u0646\u062F\u0647 \u0628\u0627\u0634\u0646\u062F \u0641\u0639\u0627\u0644 \u0645\u06CC\u200C\u0634\u0648\u0646\u062F.",
  support: "\u{1F4AC}  \u067E\u0634\u062A\u06CC\u0628\u0627\u0646\u06CC\n\n\u0628\u0631\u0627\u06CC \u062B\u0628\u062A \u062F\u0631\u062E\u0648\u0627\u0633\u062A\u060C \u062F\u06A9\u0645\u0647 \xAB\u0634\u0631\u0648\u0639 \u062F\u0631\u062E\u0648\u0627\u0633\u062A \u067E\u0634\u062A\u06CC\u0628\u0627\u0646\u06CC\xBB \u0631\u0627 \u0628\u0632\u0646\u06CC\u062F \u0648 \u0645\u0634\u06A9\u0644 \u0631\u0627 \u062F\u0631 \u06CC\u06A9 \u067E\u06CC\u0627\u0645 \u062A\u0648\u0636\u06CC\u062D \u062F\u0647\u06CC\u062F.\n\n\u{1F510} \u0631\u0645\u0632 \u0639\u0628\u0648\u0631\u060C \u0627\u0637\u0644\u0627\u0639\u0627\u062A \u0628\u0627\u0646\u06A9\u06CC \u06CC\u0627 \u06A9\u0644\u06CC\u062F \u062E\u0635\u0648\u0635\u06CC \u0627\u0631\u0633\u0627\u0644 \u0646\u06A9\u0646\u06CC\u062F.",
  help: "\u{1F4D8}  \u0631\u0627\u0647\u0646\u0645\u0627\u06CC \u0627\u0633\u062A\u0641\u0627\u062F\u0647\n\n\u06F1. \u0627\u0632 \xAB\u062E\u0631\u06CC\u062F \u0627\u0634\u062A\u0631\u0627\u06A9\xBB \u0628\u0633\u062A\u0647 \u0645\u0648\u0631\u062F\u0646\u0638\u0631 \u0631\u0627 \u0627\u0646\u062A\u062E\u0627\u0628 \u06A9\u0646\u06CC\u062F.\n\u06F2. \u067E\u0633 \u0627\u0632 \u062B\u0628\u062A \u0633\u0641\u0627\u0631\u0634\u060C \u0631\u0633\u06CC\u062F \u067E\u0631\u062F\u0627\u062E\u062A \u0631\u0627 \u062F\u0631 \u0647\u0645\u06CC\u0646 \u0631\u0628\u0627\u062A \u0628\u0641\u0631\u0633\u062A\u06CC\u062F.\n\u06F3. \u0646\u062A\u06CC\u062C\u0647 \u0628\u0631\u0631\u0633\u06CC \u0631\u0627 \u062F\u0631 \xAB\u0633\u0641\u0627\u0631\u0634\u200C\u0647\u0627\u06CC \u0645\u0646\xBB \u062F\u0646\u0628\u0627\u0644 \u06A9\u0646\u06CC\u062F.\n\u06F4. \u0644\u06CC\u0646\u06A9 \u0627\u062A\u0635\u0627\u0644 \u0648 \u062D\u062C\u0645 \u0645\u0635\u0631\u0641\u06CC \u062F\u0631 \xAB\u0627\u0634\u062A\u0631\u0627\u06A9\u200C\u0647\u0627\u06CC \u0645\u0646\xBB \u0642\u0631\u0627\u0631 \u0645\u06CC\u200C\u06AF\u06CC\u0631\u062F.\n\u06F5. \u0628\u0631\u0627\u06CC \u067E\u06CC\u06AF\u06CC\u0631\u06CC \u0645\u0634\u06A9\u0644 \u0627\u0632 \xAB\u067E\u0634\u062A\u06CC\u0628\u0627\u0646\u06CC\xBB \u0627\u0633\u062A\u0641\u0627\u062F\u0647 \u06A9\u0646\u06CC\u062F.",
  privacy: "\u{1F510}  \u062D\u0631\u06CC\u0645 \u062E\u0635\u0648\u0635\u06CC\n\n\u0645\u062F\u0627\u0631 \u0641\u0642\u0637 \u0627\u0637\u0644\u0627\u0639\u0627\u062A \u0636\u0631\u0648\u0631\u06CC \u0628\u0631\u0627\u06CC \u0645\u062F\u06CC\u0631\u06CC\u062A \u062D\u0633\u0627\u0628\u060C \u0633\u0641\u0627\u0631\u0634 \u0648 \u067E\u0634\u062A\u06CC\u0628\u0627\u0646\u06CC \u0631\u0627 \u0646\u06AF\u0647\u062F\u0627\u0631\u06CC \u0645\u06CC\u200C\u06A9\u0646\u062F.\n\n\u0631\u0645\u0632 \u0639\u0628\u0648\u0631\u060C \u0627\u0637\u0644\u0627\u0639\u0627\u062A \u06A9\u0627\u0631\u062A \u0628\u0627\u0646\u06A9\u06CC\u060C \u06A9\u0644\u06CC\u062F \u062E\u0635\u0648\u0635\u06CC \u0648 \u0627\u0637\u0644\u0627\u0639\u0627\u062A \u0648\u0631\u0648\u062F \u0633\u0631\u0648\u0631 \u0631\u0627 \u062F\u0631 \u06AF\u0641\u062A\u200C\u0648\u06AF\u0648 \u0627\u0631\u0633\u0627\u0644 \u0646\u06A9\u0646\u06CC\u062F.",
  orders: "\u{1F9FE}  \u0633\u0641\u0627\u0631\u0634\u200C\u0647\u0627\u06CC \u0645\u0646\n\n\u0622\u062E\u0631\u06CC\u0646 \u0633\u0641\u0627\u0631\u0634\u200C\u0647\u0627\u060C \u0645\u0628\u0644\u063A \u0648 \u0648\u0636\u0639\u06CC\u062A \u0628\u0631\u0631\u0633\u06CC \u0631\u0633\u06CC\u062F \u062F\u0631 \u0627\u06CC\u0646 \u0628\u062E\u0634 \u0646\u0645\u0627\u06CC\u0634 \u062F\u0627\u062F\u0647 \u0645\u06CC\u200C\u0634\u0648\u062F.",
  tickets: "\u{1F4AC}  \u062F\u0631\u062E\u0648\u0627\u0633\u062A\u200C\u0647\u0627\u06CC \u067E\u0634\u062A\u06CC\u0628\u0627\u0646\u06CC \u0645\u0646\n\n\u062F\u0631\u062E\u0648\u0627\u0633\u062A\u200C\u0647\u0627\u06CC \u062B\u0628\u062A\u200C\u0634\u062F\u0647 \u0648 \u067E\u0627\u0633\u062E\u200C\u0647\u0627\u06CC \u067E\u0634\u062A\u06CC\u0628\u0627\u0646\u06CC \u0631\u0627 \u0627\u0632 \u0627\u06CC\u0646 \u0628\u062E\u0634 \u062F\u0646\u0628\u0627\u0644 \u06A9\u0646\u06CC\u062F.",
  lang: "\u{1F310}  \u0632\u0628\u0627\u0646 \u0631\u0628\u0627\u062A\n\n\u0632\u0628\u0627\u0646 \u0631\u0628\u0627\u062A \u0645\u062F\u0627\u0631 \u0641\u0627\u0631\u0633\u06CC \u0627\u0633\u062A.",
  unknown: "\u0627\u06CC\u0646 \u06AF\u0632\u06CC\u0646\u0647 \u0634\u0646\u0627\u062E\u062A\u0647 \u0646\u0634\u062F. \u0628\u0631\u0627\u06CC \u0646\u0645\u0627\u06CC\u0634 \u0645\u0646\u0648\u06CC \u0627\u0635\u0644\u06CC\u060C \xAB\u062E\u0627\u0646\u0647\xBB \u0631\u0627 \u0627\u0646\u062A\u062E\u0627\u0628 \u06A9\u0646\u06CC\u062F."
};
function botPage(page) {
  const resolved = page === "customer:tickets" ? "tickets" : page === "customer:home" || page === "admin:home" ? "home" : page;
  const body3 = Object.hasOwn(pages, resolved) ? pages[resolved] : pages.unknown;
  return { text: frameMessage(body3), replyMarkup: botMenu() };
}
__name(botPage, "botPage");

// src/admin-carrier-accept.mjs
var OPERATORS = { mci: 443, irancell: 8443 };
var TEST_TTL = 24 * 60 * 60 * 1e3;
var ACK_TTL = 10 * 60 * 1e3;
var ID = /^[A-Za-z][A-Za-z0-9_-]{2,63}$/;
function manualAttestationEnabled(env) {
  return env?.ADMIN_MANUAL_FIELD_ACCEPT_ENABLED === "true";
}
__name(manualAttestationEnabled, "manualAttestationEnabled");
async function manualPair(db, nodeId, revision, nowMs = Date.now(), acceptedOnce = false) {
  const earliest = acceptedOnce ? 1 : nowMs - TEST_TTL;
  const rows = (await db.prepare(
    "SELECT operator,port,revision,confirmed_ms FROM admin_carrier_tests WHERE node_id=? AND revision=? AND confirmed_ms BETWEEN ? AND ?"
  ).bind(nodeId, revision, earliest, nowMs + 3e4).all()).results ?? [];
  return rows.length === 2 && rows.some((x) => x.operator === "mci" && x.port === 443) && rows.some((x) => x.operator === "irancell" && x.port === 8443);
}
__name(manualPair, "manualPair");
async function promoteAdminPair(env, nodeId, nowMs = Date.now()) {
  if (!manualAttestationEnabled(env) || !ID.test(nodeId ?? "")) return { ready: false, reason: "disabled" };
  const db = env.DB;
  const node = await db.prepare(
    "SELECT n.id,n.lifecycle,n.desired_revision,n.acked_revision,j.state AS installed FROM nodes n JOIN node_bootstrap_jobs j ON j.node_id=n.id WHERE n.id=?"
  ).bind(nodeId).first();
  if (!node || node.installed !== "installed" || !["provisioning", "ready"].includes(node.lifecycle))
    return { ready: false, reason: "not_installed" };
  const rev = node.desired_revision;
  if (rev !== node.acked_revision) return { ready: false, reason: "node_ack_pending" };
  const ack2 = await db.prepare(
    "SELECT 1 AS ok FROM node_acks WHERE node_id=? AND revision=? AND status='accepted' AND observed_ms BETWEEN ? AND ? LIMIT 1"
  ).bind(nodeId, rev, nowMs - ACK_TTL, nowMs + 3e4).first();
  if (!ack2) return { ready: false, reason: "node_ack_pending" };
  if (!await manualPair(db, nodeId, rev, nowMs))
    return { ready: false, reason: "carrier_confirmation_missing" };
  const routeId = nodeId + "_reality";
  const variants = (await db.prepare(
    "SELECT operator,port FROM route_carrier_variants WHERE route_id=?"
  ).bind(routeId).all()).results ?? [];
  if (variants.length !== 2 || !variants.some((x) => x.operator === "mci" && x.port === 443) || !variants.some((x) => x.operator === "irancell" && x.port === 8443))
    return { ready: false, reason: "dual_route_missing" };
  const route = await db.prepare(
    "SELECT state FROM routes WHERE id=? AND node_id=? AND transport='reality'"
  ).bind(routeId, nodeId).first();
  if (!route || !["checking", "ready"].includes(route.state))
    return { ready: false, reason: "route_not_eligible" };
  const guard = " AND EXISTS(SELECT 1 FROM nodes n JOIN node_bootstrap_jobs j ON j.node_id=n.id WHERE n.id=? AND n.desired_revision=? AND n.acked_revision=? AND n.lifecycle IN ('provisioning','ready') AND j.state='installed' AND EXISTS(SELECT 1 FROM node_acks a WHERE a.node_id=n.id AND a.revision=? AND a.status='accepted' AND a.observed_ms BETWEEN ? AND ?) AND (SELECT COUNT(*) FROM admin_carrier_tests a WHERE a.node_id=n.id AND a.revision=? AND a.confirmed_ms BETWEEN ? AND ? AND ((a.operator='mci' AND a.port=443) OR (a.operator='irancell' AND a.port=8443)))=2)";
  const args = [
    nodeId,
    rev,
    rev,
    rev,
    nowMs - ACK_TTL,
    nowMs + 3e4,
    rev,
    nowMs - TEST_TTL,
    nowMs + 3e4
  ];
  const result = await db.batch([
    db.prepare(
      "UPDATE route_carrier_variants SET published=1,verified_ms=? WHERE route_id=? AND ((operator='mci' AND port=443) OR (operator='irancell' AND port=8443))" + guard
    ).bind(nowMs, routeId, ...args),
    db.prepare(
      "UPDATE routes SET state='ready',verified_ms=? WHERE id=? AND node_id=? AND state IN ('checking','ready') AND (SELECT COUNT(*) FROM route_carrier_variants v WHERE v.route_id=routes.id AND v.published=1 AND v.verified_ms>=?)=2" + guard
    ).bind(nowMs, routeId, nodeId, nowMs, ...args),
    db.prepare(
      "UPDATE nodes SET lifecycle='ready' WHERE id=? AND desired_revision=? AND acked_revision=? AND lifecycle IN ('provisioning','ready') AND EXISTS(SELECT 1 FROM routes r WHERE r.node_id=nodes.id AND r.id=nodes.id||'_reality' AND r.state='ready' AND r.verified_ms>=?)"
    ).bind(nodeId, rev, rev, nowMs)
  ]);
  if (Number(result[0]?.meta?.changes) !== 2 || Number(result[1]?.meta?.changes) !== 1 || Number(result[2]?.meta?.changes) !== 1)
    return { ready: false, reason: "state_changed" };
  return { ready: true, source: "admin_manual_plus_signed_agent" };
}
__name(promoteAdminPair, "promoteAdminPair");
async function recordAdminCarrierTest(env, actor, nodeId, operator, nowMs = Date.now()) {
  if (!manualAttestationEnabled(env)) return { ok: false, reason: "disabled" };
  if (!ID.test(nodeId ?? "") || !Object.hasOwn(OPERATORS, operator) || !/^[0-9]{5,20}$/.test(String(actor ?? "")))
    return { ok: false, reason: "invalid" };
  const db = env.DB;
  const node = await db.prepare(
    "SELECT n.desired_revision,n.lifecycle,j.state,j.owner_id FROM nodes n JOIN node_bootstrap_jobs j ON j.node_id=n.id WHERE n.id=?"
  ).bind(nodeId).first();
  if (!node || node.state !== "installed" || node.owner_id !== String(actor) || !["provisioning", "ready"].includes(node.lifecycle))
    return { ok: false, reason: "not_owner_or_not_installed" };
  const variant = await db.prepare(
    "SELECT 1 AS ok FROM route_carrier_variants WHERE route_id=? AND operator=? AND port=? AND EXISTS(SELECT 1 FROM routes r WHERE r.id=route_carrier_variants.route_id AND r.state IN ('checking','ready'))"
  ).bind(nodeId + "_reality", operator, OPERATORS[operator]).first();
  if (!variant) return { ok: false, reason: "route_missing" };
  const stored = await db.prepare(
    "INSERT INTO admin_carrier_tests(node_id,operator,port,revision,actor_id,confirmed_ms) VALUES(?,?,?,?,?,?) ON CONFLICT(node_id,operator) DO UPDATE SET port=excluded.port,revision=excluded.revision,actor_id=excluded.actor_id,confirmed_ms=excluded.confirmed_ms"
  ).bind(nodeId, operator, OPERATORS[operator], node.desired_revision, String(actor), nowMs).run();
  if (Number(stored.meta?.changes) !== 1) return { ok: false, reason: "save_failed" };
  const paired = await manualPair(db, nodeId, node.desired_revision, nowMs);
  const promotion = paired ? await promoteAdminPair(env, nodeId, nowMs) : {
    ready: false,
    reason: "carrier_confirmation_missing"
  };
  return { ok: true, operator, paired, ...promotion };
}
__name(recordAdminCarrierTest, "recordAdminCarrierTest");

// src/node-admin.mjs
var NODE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$/;
var PROVIDER = /^[A-Za-z0-9][A-Za-z0-9_.-]{1,63}$/;
var REGION = /^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$/;
var HOST = /^[a-zA-Z0-9][a-zA-Z0-9.-]{2,252}$/;
var NAT = /^(0|[1-9]\d*)$/;
var MAX_GB = 2e5;
var gbToBytes = /* @__PURE__ */ __name((n) => n * 1073741824, "gbToBytes");
function panel(message) {
  return { text: frameMessage(message), replyMarkup: { inline_keyboard: sectionNavigation("admin") } };
}
__name(panel, "panel");
function parseNodeAdd(input) {
  if (typeof input !== "string") return null;
  const parts = input.replace(/^\/node_add(?:@\w+)?\s*/, "").trim().split("|").map((x) => x.trim());
  if (parts.length !== 5) return null;
  const [id, provider, region, usersRaw, gbRaw] = parts;
  if (!NODE_ID.test(id) || !PROVIDER.test(provider) || !REGION.test(region) || !NAT.test(usersRaw) || !NAT.test(gbRaw)) return null;
  const users = Number(usersRaw), gb = Number(gbRaw);
  if (!Number.isSafeInteger(users) || users < 1 || users > 1e5 || !Number.isSafeInteger(gb) || gb < 1 || gb > MAX_GB) return null;
  return { id, provider, region, userLimit: users, byteLimit: gbToBytes(gb) };
}
__name(parseNodeAdd, "parseNodeAdd");
function parseRouteAdd(input) {
  if (typeof input !== "string") return null;
  const parts = input.replace(/^\/node_route(?:@\w+)?\s*/, "").trim().split("|").map((x) => x.trim());
  const [nodeId, transport, portRaw, hostname, path] = parts;
  if (!NODE_ID.test(nodeId ?? "") || !["reality", "wss"].includes(transport) || !NAT.test(portRaw ?? "")) return null;
  const port = Number(portRaw);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) return null;
  if (transport === "reality" && parts.length === 3)
    return { nodeId, transport, port, hostname: null, path: null, id: nodeId + "_reality", operatorHint: null };
  if (transport === "reality" && parts.length === 4 && ["mci", "irancell"].includes(hostname))
    return { nodeId, transport, port, hostname: null, path: null, id: nodeId + "_reality_" + hostname, operatorHint: hostname };
  if (transport === "wss" && parts.length === 5 && HOST.test(hostname ?? "") && typeof path === "string" && path.startsWith("/") && path.length <= 256 && !/[\r\n?&#]/.test(path))
    return { nodeId, transport, port, hostname, path, id: nodeId + "_wss", operatorHint: null };
  return null;
}
__name(parseRouteAdd, "parseRouteAdd");
async function enrollNode(db, actor, input) {
  const data = parseNodeAdd(input);
  if (!data) return panel("\u0642\u0627\u0644\u0628 \u062B\u0628\u062A \u062F\u0633\u062A\u06CC \u0633\u0631\u0648\u0631:\n/node_add \u0634\u0646\u0627\u0633\u0647|\u0627\u0631\u0627\u0626\u0647\u200C\u062F\u0647\u0646\u062F\u0647|\u0645\u0646\u0637\u0642\u0647|\u0633\u0642\u0641 \u06A9\u0627\u0631\u0628\u0631|\u0638\u0631\u0641\u06CC\u062A \u06AF\u06CC\u06AF\u0627\u0628\u0627\u06CC\u062A");
  const { id, provider, region, userLimit, byteLimit } = data;
  try {
    await db.batch([
      db.prepare(
        "INSERT INTO nodes(id,provider,region,lifecycle,user_limit,byte_limit,desired_revision,acked_revision) VALUES(?,?,?,'enrolling',?,?,1,0)"
      ).bind(id, provider, region, userLimit, byteLimit),
      db.prepare(
        "INSERT INTO audit_events(event_id,actor_id,object_type,object_id,verb) VALUES(?,?,?,?,?)"
      ).bind("node:add:" + id, actor, "node", id, "enroll")
    ]);
    return panel("\u2705 \u0633\u0631\u0648\u0631 " + id + " \u062B\u0628\u062A \u0634\u062F\u060C \u0627\u0645\u0627 \u0647\u0646\u0648\u0632 \u0622\u0645\u0627\u062F\u0647 \u0627\u0633\u062A\u0641\u0627\u062F\u0647 \u0646\u06CC\u0633\u062A.\n\u0628\u0631\u0627\u06CC \u062A\u0639\u0631\u06CC\u0641 \u0645\u0633\u06CC\u0631 \u0627\u0632 \u062F\u0633\u062A\u0648\u0631 /node_route \u0627\u0633\u062A\u0641\u0627\u062F\u0647 \u06A9\u0646\u06CC\u062F. \u0646\u0635\u0628 \u0639\u0627\u0645\u0644 \u0627\u0645\u0646 \u0648 \u0622\u0632\u0645\u0648\u0646 \u0648\u0627\u0642\u0639\u06CC \u0627\u062A\u0635\u0627\u0644 \u0646\u06CC\u0632 \u0644\u0627\u0632\u0645 \u0627\u0633\u062A.");
  } catch {
    return panel("\u26A0\uFE0F \u0633\u0631\u0648\u0631 \u0627\u0632 \u0642\u0628\u0644 \u062B\u0628\u062A \u0634\u062F\u0647 \u06CC\u0627 \u0627\u0637\u0644\u0627\u0639\u0627\u062A \u0622\u0646 \u0645\u0639\u062A\u0628\u0631 \u0646\u06CC\u0633\u062A\u061B \u0647\u06CC\u0686 \u062A\u063A\u06CC\u06CC\u0631\u06CC \u0627\u0646\u062C\u0627\u0645 \u0646\u0634\u062F.");
  }
}
__name(enrollNode, "enrollNode");
async function addRoute(db, actor, input) {
  const data = parseRouteAdd(input);
  if (!data) return panel(
    "\u0642\u0627\u0644\u0628 \u062A\u0639\u0631\u06CC\u0641 \u0645\u0633\u06CC\u0631:\n/node_route \u0634\u0646\u0627\u0633\u0647_\u0633\u0631\u0648\u0631|reality|443|mci\n/node_route \u0634\u0646\u0627\u0633\u0647_\u0633\u0631\u0648\u0631|reality|8443|irancell\n/node_route \u0634\u0646\u0627\u0633\u0647_\u0633\u0631\u0648\u0631|wss|8443|\u062F\u0627\u0645\u0646\u0647|/ws"
  );
  const node = await db.prepare(
    "SELECT id,lifecycle,desired_revision FROM nodes WHERE id=?"
  ).bind(data.nodeId).first();
  if (!node || !["enrolling", "provisioning", "degraded"].includes(node.lifecycle))
    return panel("\u0633\u0631\u0648\u0631 \u067E\u06CC\u062F\u0627 \u0646\u0634\u062F \u06CC\u0627 \u0645\u0645\u06A9\u0646 \u0627\u0633\u062A \u0627\u0634\u062A\u0631\u0627\u06A9 \u0641\u0639\u0627\u0644 \u062F\u0627\u0634\u062A\u0647 \u0628\u0627\u0634\u062F\u061B \u0645\u0633\u06CC\u0631 \u062A\u063A\u06CC\u06CC\u0631\u06CC \u0646\u06A9\u0631\u062F.");
  if (node.desired_revision >= 2147483647) return panel("\u062D\u062F \u0645\u062C\u0627\u0632 \u0646\u0633\u062E\u0647 \u062A\u0646\u0638\u06CC\u0645\u0627\u062A \u0633\u0631\u0648\u0631 \u0628\u0647 \u067E\u0627\u06CC\u0627\u0646 \u0631\u0633\u06CC\u062F\u0647 \u0627\u0633\u062A.");
  if (data.operatorHint) {
    const parent = await db.prepare(
      "SELECT r.id,re.host,re.server_name,re.reality_public_key,re.reality_short_id FROM routes r JOIN route_endpoints re ON re.route_id=r.id WHERE r.node_id=? AND r.transport='reality' LIMIT 1"
    ).bind(data.nodeId).first();
    if (!parent || !HOST.test(parent.host ?? "") || !HOST.test(parent.server_name ?? "") || !/^[A-Za-z0-9_-]{43}$/.test(parent.reality_public_key ?? "") || !/^[a-fA-F0-9]{0,16}$/.test(parent.reality_short_id ?? ""))
      return panel("\u0627\u0637\u0644\u0627\u0639\u0627\u062A \u0639\u0645\u0648\u0645\u06CC \u0645\u0633\u06CC\u0631 \u0627\u0635\u0644\u06CC REALITY \u06A9\u0627\u0645\u0644 \u0646\u06CC\u0633\u062A\u061B \u0645\u0633\u06CC\u0631 \u0627\u067E\u0631\u0627\u062A\u0648\u0631 \u062C\u062F\u06CC\u062F \u0633\u0627\u062E\u062A\u0647 \u0646\u0634\u062F.");
    try {
      await db.batch([
        db.prepare(
          "INSERT INTO route_carrier_variants(route_id,operator,host,port,server_name,reality_public_key,reality_short_id,published,verified_ms) VALUES(?,?,?,?,?,?,?,0,NULL)"
        ).bind(
          parent.id,
          data.operatorHint,
          parent.host,
          data.port,
          parent.server_name,
          parent.reality_public_key,
          parent.reality_short_id
        ),
        db.prepare(
          "UPDATE nodes SET desired_revision=desired_revision+1,lifecycle='provisioning' WHERE id=? AND desired_revision=? AND lifecycle IN ('enrolling','provisioning','degraded')"
        ).bind(data.nodeId, node.desired_revision),
        db.prepare(
          "INSERT INTO audit_events(event_id,actor_id,object_type,object_id,verb) VALUES(?,?,?,?,?)"
        ).bind(
          "node:carrier:" + parent.id + ":" + data.operatorHint,
          actor,
          "route",
          parent.id,
          "stage:carrier:" + data.operatorHint
        )
      ]);
    } catch {
      return panel("\u0627\u06CC\u0646 \u0645\u0633\u06CC\u0631 \u0627\u067E\u0631\u0627\u062A\u0648\u0631 \u0642\u0628\u0644\u0627\u064B \u062B\u0628\u062A \u0634\u062F\u0647 \u06CC\u0627 \u0628\u0647\u200C\u0631\u0648\u0632\u0631\u0633\u0627\u0646\u06CC \u067E\u0630\u06CC\u0631\u0641\u062A\u0647 \u0646\u0634\u062F\u061B \u062A\u063A\u06CC\u06CC\u0631\u06CC \u0627\u0646\u062C\u0627\u0645 \u0646\u0634\u062F.");
    }
    return panel("\u2705 \u0645\u0633\u06CC\u0631 " + (data.operatorHint === "mci" ? "\u0647\u0645\u0631\u0627\u0647 \u0627\u0648\u0644" : "\u0627\u06CC\u0631\u0627\u0646\u0633\u0644") + " \u0631\u0648\u06CC \u062F\u0631\u06AF\u0627\u0647 " + faNumber(data.port) + " \u0628\u0647\u200C\u0635\u0648\u0631\u062A \u067E\u06CC\u0634\u200C\u0646\u0648\u06CC\u0633 \u062B\u0628\u062A \u0634\u062F.\n\u0647\u06CC\u0686 \u062A\u063A\u06CC\u06CC\u0631\u06CC \u0631\u0648\u06CC \u0633\u0631\u0648\u06CC\u0633\u200C\u0647\u0627\u06CC VPS \u0627\u0639\u0645\u0627\u0644 \u0646\u0634\u062F\u0647 \u0627\u0633\u062A. \u0628\u0631\u0627\u06CC \u0627\u0646\u062A\u0634\u0627\u0631\u060C \u0639\u0627\u0645\u0644 \u0627\u0645\u0636\u0627\u0634\u062F\u0647 \u0648 \u0622\u0632\u0645\u0648\u0646 \u0645\u0633\u062A\u0642\u0644 \u0627\u062A\u0635\u0627\u0644 \u0644\u0627\u0632\u0645 \u0627\u0633\u062A.");
  }
  try {
    await db.batch([
      db.prepare(
        "INSERT INTO routes(id,node_id,transport,state,listen_port,tls_hostname,ws_path,operator_hint) VALUES(?,?,?,'draft',?,?,?,?)"
      ).bind(data.id, data.nodeId, data.transport, data.port, data.hostname, data.path, data.operatorHint),
      db.prepare(
        "UPDATE nodes SET desired_revision=desired_revision+1,lifecycle='provisioning' WHERE id=? AND desired_revision=? AND lifecycle IN ('enrolling','provisioning','degraded')"
      ).bind(data.nodeId, node.desired_revision),
      db.prepare(
        "INSERT INTO audit_events(event_id,actor_id,object_type,object_id,verb) VALUES(?,?,?,?,?)"
      ).bind("node:route:" + data.id, actor, "route", data.id, "enroll:draft")
    ]);
  } catch {
    return panel("\u0627\u06CC\u0646 \u0645\u0633\u06CC\u0631 \u0627\u0632 \u0642\u0628\u0644 \u062B\u0628\u062A \u0634\u062F\u0647 \u06CC\u0627 \u0628\u0647\u200C\u0631\u0648\u0632\u0631\u0633\u0627\u0646\u06CC \u0631\u062F \u0634\u062F\u061B \u0647\u06CC\u0686 \u062A\u063A\u06CC\u06CC\u0631\u06CC \u0627\u0646\u062C\u0627\u0645 \u0646\u0634\u062F.");
  }
  return panel("\u2705 \u0645\u0633\u06CC\u0631 " + data.transport.toUpperCase() + " \u0628\u0631\u0627\u06CC \u0633\u0631\u0648\u0631 " + data.nodeId + " \u0628\u0647\u200C\u0635\u0648\u0631\u062A \u067E\u06CC\u0634\u200C\u0646\u0648\u06CC\u0633 \u062B\u0628\u062A \u0634\u062F.\n\u062A\u0627 \u062A\u0623\u06CC\u06CC\u062F \u0639\u0627\u0645\u0644 \u0627\u0645\u0636\u0627\u0634\u062F\u0647 \u0648 \u0645\u0648\u0641\u0642\u06CC\u062A \u0622\u0632\u0645\u0648\u0646 \u062A\u0631\u0627\u0641\u06CC\u06A9 \u0648\u0627\u0642\u0639\u06CC\u060C \u0641\u0631\u0648\u0634 \u0627\u06CC\u0646 \u0645\u0633\u06CC\u0631 \u0645\u062C\u0627\u0632 \u0646\u06CC\u0633\u062A.");
}
__name(addRoute, "addRoute");
var NODE_REF = /^[a-f0-9]{24}$/;
var PAGE_SIZE = 6;
var FILTERS = {
  all: { title: "\u0647\u0645\u0647", sql: "1=1" },
  ready: { title: "\u0622\u0645\u0627\u062F\u0647", sql: "n.lifecycle='ready'" },
  setup: { title: "\u062F\u0631 \u062D\u0627\u0644 \u0646\u0635\u0628", sql: "n.lifecycle IN ('enrolling','provisioning') AND NOT EXISTS (SELECT 1 FROM node_bootstrap_jobs j WHERE j.node_id=n.id AND j.state='installed')" },
  testing: { title: "\u0622\u0645\u0627\u062F\u0647 \u0622\u0632\u0645\u0648\u0646", sql: "n.lifecycle='provisioning' AND EXISTS (SELECT 1 FROM node_bootstrap_jobs j WHERE j.node_id=n.id AND j.state='installed')" },
  attention: { title: "\u0646\u06CC\u0627\u0632\u0645\u0646\u062F \u0628\u0631\u0631\u0633\u06CC", sql: "n.lifecycle='degraded'" },
  quarantine: { title: "\u0642\u0631\u0646\u0637\u06CC\u0646\u0647", sql: "n.lifecycle='quarantined'" },
  archive: { title: "\u0628\u0627\u06CC\u06AF\u0627\u0646\u06CC", sql: "n.lifecycle='retired'" }
};
var statusOrder = "CASE n.lifecycle WHEN 'ready' THEN 0 WHEN 'enrolling' THEN 1 WHEN 'provisioning' THEN 2 WHEN 'degraded' THEN 3 WHEN 'quarantined' THEN 4 ELSE 5 END";
var nodeButton = /* @__PURE__ */ __name((text, key) => [{ text, callback_data: "v2:" + key }], "nodeButton");
var short = /* @__PURE__ */ __name((value, max = 32) => String(value).length > max ? String(value).slice(0, max - 1) + "\u2026" : String(value), "short");
var formatCount = /* @__PURE__ */ __name((n) => faNumber(Number(n ?? 0)), "formatCount");
async function nodeUiRef(id) {
  if (!NODE_ID.test(String(id ?? ""))) return null;
  const digest2 = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(id)));
  return Array.from(digest2.slice(0, 12), (b) => b.toString(16).padStart(2, "0")).join("");
}
__name(nodeUiRef, "nodeUiRef");
async function resolveNodeRef(db, ref) {
  if (!NODE_REF.test(String(ref ?? ""))) return null;
  const list = (await db.prepare("SELECT id FROM nodes ORDER BY id LIMIT 5001").all()).results ?? [];
  if (list.length > 5e3) return null;
  let result = null;
  for (const row of list) {
    if (await nodeUiRef(row.id) !== ref) continue;
    if (result) return null;
    result = row.id;
  }
  return result;
}
__name(resolveNodeRef, "resolveNodeRef");
async function countNodes(db, sql) {
  const row = await db.prepare(sql).first();
  return Number(row?.n ?? 0);
}
__name(countNodes, "countNodes");
function filterMenu(filter) {
  const f = /* @__PURE__ */ __name((name, title) => ({ text: (filter === name ? "\u2705 " : "") + title, callback_data: "v2:admin:nodes:" + name + ":0" }), "f");
  return [
    [f("all", "\u0647\u0645\u0647"), f("ready", "\u0622\u0645\u0627\u062F\u0647"), f("setup", "\u062F\u0631 \u062D\u0627\u0644 \u0646\u0635\u0628")],
    [f("testing", "\u0622\u0645\u0627\u062F\u0647 \u0622\u0632\u0645\u0648\u0646"), f("attention", "\u0646\u06CC\u0627\u0632\u0645\u0646\u062F \u0628\u0631\u0631\u0633\u06CC"), f("quarantine", "\u0642\u0631\u0646\u0637\u06CC\u0646\u0647")],
    [f("archive", "\u0628\u0627\u06CC\u06AF\u0627\u0646\u06CC")]
  ];
}
__name(filterMenu, "filterMenu");
function nodeStatusPresentation(lifecycle, installState, health = null, nowMs = Date.now()) {
  if (lifecycle === "provisioning" && installState === "installed")
    return { label: "\u0622\u0645\u0627\u062F\u0647 \u0622\u0632\u0645\u0648\u0646", symbol: "\u{1F9EA}" };
  if (lifecycle === "ready" && health) {
    const recent = health.revision === health.desired_revision && health.xray_healthy === 1 && health.stats_healthy === 1 && Number.isFinite(health.observed_ms) && health.observed_ms >= nowMs - 6e5 && health.observed_ms <= nowMs;
    if (!recent) return { label: "\u0622\u0645\u0627\u062F\u0647\u061B \u06AF\u0632\u0627\u0631\u0634 \u0639\u0627\u0645\u0644 \u0642\u062F\u06CC\u0645\u06CC", symbol: "\u{1F7E0}" };
  }
  return { label: faStatus(lifecycle), symbol: statusSymbol(lifecycle) };
}
__name(nodeStatusPresentation, "nodeStatusPresentation");
async function nodeOverview(db, { filter = "all", page = 0 } = {}) {
  if (!Object.hasOwn(FILTERS, filter)) filter = "all";
  page = Number.isSafeInteger(page) && page >= 0 && page <= 1e3 ? page : 0;
  const sql = FILTERS[filter].sql;
  const [total, ready, setup, testing, attention, quarantine, archived, filtered] = await Promise.all([
    countNodes(db, "SELECT COUNT(*) AS n FROM nodes"),
    countNodes(db, "SELECT COUNT(*) AS n FROM nodes n WHERE n.lifecycle='ready'"),
    countNodes(db, "SELECT COUNT(*) AS n FROM nodes n WHERE " + FILTERS.setup.sql),
    countNodes(db, "SELECT COUNT(*) AS n FROM nodes n WHERE " + FILTERS.testing.sql),
    countNodes(db, "SELECT COUNT(*) AS n FROM nodes n WHERE n.lifecycle='degraded'"),
    countNodes(db, "SELECT COUNT(*) AS n FROM nodes n WHERE n.lifecycle='quarantined'"),
    countNodes(db, "SELECT COUNT(*) AS n FROM nodes n WHERE n.lifecycle='retired'"),
    countNodes(db, "SELECT COUNT(*) AS n FROM nodes n WHERE " + sql)
  ]);
  const maxPage = Math.max(0, Math.ceil(filtered / PAGE_SIZE) - 1);
  page = Math.min(page, maxPage);
  const list = (await db.prepare(
    "SELECT n.id,n.provider,n.region,n.lifecycle,n.desired_revision,j.state AS install_state,h.revision,h.observed_ms,h.xray_healthy,h.stats_healthy FROM nodes n LEFT JOIN node_bootstrap_jobs j ON j.node_id=n.id LEFT JOIN node_health h ON h.node_id=n.id WHERE " + sql + " ORDER BY " + statusOrder + ",n.created_at DESC,n.id LIMIT ? OFFSET ?"
  ).bind(PAGE_SIZE, page * PAGE_SIZE).all()).results ?? [];
  const text = panelHeading("\u{1F5A5}", "\u0645\u062F\u06CC\u0631\u06CC\u062A \u0633\u0631\u0648\u0631\u0647\u0627", "\u0647\u0631 \u0633\u0631\u0648\u0631 \u06CC\u06A9 \u0635\u0641\u062D\u0647 \u0627\u062E\u062A\u0635\u0627\u0635\u06CC \u062F\u0627\u0631\u062F") + "\n\n\u{1F4CA} \u06A9\u0644: " + formatCount(total) + "  |  \u2705 \u0622\u0645\u0627\u062F\u0647: " + formatCount(ready) + "\n\u{1F6E0} \u062F\u0631 \u062D\u0627\u0644 \u0646\u0635\u0628: " + formatCount(setup) + "  |  \u{1F9EA} \u0622\u0645\u0627\u062F\u0647 \u0622\u0632\u0645\u0648\u0646: " + formatCount(testing) + "\n\u26A0\uFE0F \u0628\u0631\u0631\u0633\u06CC: " + formatCount(attention) + "\n\u{1F534} \u0642\u0631\u0646\u0637\u06CC\u0646\u0647: " + formatCount(quarantine) + "  |  \u{1F5C4} \u0628\u0627\u06CC\u06AF\u0627\u0646\u06CC: " + formatCount(archived) + "\n\n\u{1F50E} \u0641\u06CC\u0644\u062A\u0631: " + FILTERS[filter].title + " \xB7 \u0635\u0641\u062D\u0647 " + formatCount(page + 1) + " \u0627\u0632 " + formatCount(maxPage + 1) + "\n\n" + (list.length ? "\u0628\u0631\u0627\u06CC \u0645\u062F\u06CC\u0631\u06CC\u062A\u060C \u0646\u0627\u0645 \u0633\u0631\u0648\u0631 \u0631\u0627 \u0627\u0646\u062A\u062E\u0627\u0628 \u06A9\u0646\u06CC\u062F." : "\u062F\u0631 \u0627\u06CC\u0646 \u062F\u0633\u062A\u0647 \u0633\u0631\u0648\u0631\u06CC \u0648\u062C\u0648\u062F \u0646\u062F\u0627\u0631\u062F.");
  const items = [];
  for (const n of list) {
    const ref = await nodeUiRef(n.id);
    const status = nodeStatusPresentation(n.lifecycle, n.install_state, n, Date.now());
    items.push(nodeButton(
      status.symbol + " " + short(n.id, 33) + " \xB7 " + status.label,
      "admin:node:view:" + ref
    ));
  }
  const pages3 = [];
  if (page > 0) pages3.push({ text: "\u25C0\uFE0F \u0642\u0628\u0644\u06CC", callback_data: "v2:admin:nodes:" + filter + ":" + (page - 1) });
  if (page < maxPage) pages3.push({ text: "\u0628\u0639\u062F\u06CC \u25B6\uFE0F", callback_data: "v2:admin:nodes:" + filter + ":" + (page + 1) });
  return { text: frameMessage(text), replyMarkup: { inline_keyboard: [
    ...filterMenu(filter),
    ...items,
    ...pages3.length ? [pages3] : [],
    nodeButton("\u2795 \u0627\u0641\u0632\u0648\u062F\u0646 \u0633\u0631\u0648\u0631", "admin:node:new"),
    nodeButton("\u{1F9EA} \u0622\u0632\u0645\u0648\u0646 \u0633\u0631\u0648\u0631\u0647\u0627", "admin:node:trials"),
    ...sectionNavigation("admin")
  ] } };
}
__name(nodeOverview, "nodeOverview");
async function nodeRecord(db, ref) {
  const id = await resolveNodeRef(db, ref);
  if (!id) return null;
  return db.prepare(
    "SELECT id,provider,region,lifecycle,user_limit,byte_limit,desired_revision,acked_revision FROM nodes WHERE id=?"
  ).bind(id).first();
}
__name(nodeRecord, "nodeRecord");
async function activeAllocations(db, id) {
  const row = await db.prepare(
    "SELECT COUNT(*) AS n, COALESCE(SUM(quota_bytes),0) AS bytes FROM node_allocations WHERE node_id=? AND state IN ('reserved','active')"
  ).bind(id).first();
  return { n: Number(row?.n ?? 0), bytes: Number(row?.bytes ?? 0) };
}
__name(activeAllocations, "activeAllocations");
function quotaLabel(value) {
  return formatCount((Number(value ?? 0) / 1073741824).toFixed(1)) + " \u06AF\u06CC\u06AF\u0627\u0628\u0627\u06CC\u062A";
}
__name(quotaLabel, "quotaLabel");
function managementButtons(node, ref, active, jobState) {
  const installing = ["pending", "dispatching", "dispatched"].includes(jobState);
  if (node.lifecycle === "retired") return [];
  if (node.lifecycle === "quarantined") return [
    nodeButton("\u{1F504} \u0628\u0627\u0632\u06AF\u0631\u062F\u0627\u0646\u06CC \u0628\u0647 \u0628\u0631\u0631\u0633\u06CC", "admin:node:confirm:restore:" + ref),
    ...active === 0 && !installing ? [nodeButton("\u{1F5C4} \u0628\u0627\u06CC\u06AF\u0627\u0646\u06CC \u0633\u0631\u0648\u0631", "admin:node:confirm:retire:" + ref)] : []
  ];
  return [
    nodeButton("\u{1F6E1} \u0642\u0631\u0646\u0637\u06CC\u0646\u0647 \u0633\u0631\u0648\u0631", "admin:node:confirm:quarantine:" + ref),
    ...["enrolling", "provisioning", "degraded"].includes(node.lifecycle) && active === 0 && !installing ? [nodeButton("\u{1F5C4} \u0628\u0627\u06CC\u06AF\u0627\u0646\u06CC \u0633\u0631\u0648\u0631", "admin:node:confirm:retire:" + ref)] : []
  ];
}
__name(managementButtons, "managementButtons");
async function nodeDetails(db, ref, actor, env = {}) {
  const n = await nodeRecord(db, ref);
  if (!n) return panel("\u26A0\uFE0F \u0633\u0631\u0648\u0631 \u06CC\u0627\u0641\u062A \u0646\u0634\u062F \u06CC\u0627 \u0644\u06CC\u0646\u06A9 \u0627\u0646\u062A\u062E\u0627\u0628 \u0645\u0646\u0642\u0636\u06CC \u0634\u062F\u0647 \u0627\u0633\u062A.");
  const [alloc, job, routes, variants, manual, ack2, health] = await Promise.all([
    activeAllocations(db, n.id),
    db.prepare("SELECT state,owner_id FROM node_bootstrap_jobs WHERE node_id=?").bind(n.id).first(),
    db.prepare("SELECT id,transport,state,listen_port,operator_hint FROM routes WHERE node_id=? ORDER BY id LIMIT 16").bind(n.id).all(),
    db.prepare("SELECT cv.operator,cv.port,cv.published,cv.verified_ms FROM route_carrier_variants cv JOIN routes r ON r.id=cv.route_id WHERE r.node_id=? ORDER BY cv.operator LIMIT 10").bind(n.id).all(),
    db.prepare("SELECT operator,port,revision,confirmed_ms FROM admin_carrier_tests WHERE node_id=?").bind(n.id).all(),
    db.prepare("SELECT MAX(observed_ms) AS seen FROM node_acks WHERE node_id=? AND revision=? AND status='accepted'").bind(n.id, n.desired_revision).first(),
    db.prepare("SELECT revision,observed_ms,xray_healthy,stats_healthy FROM node_health WHERE node_id=?").bind(n.id).first()
  ]);
  const routeRows = routes.results ?? [], variantRows = variants.results ?? [];
  const presentation = nodeStatusPresentation(
    n.lifecycle,
    job?.state,
    { ...health, desired_revision: n.desired_revision },
    Date.now()
  );
  const healthAge = Number.isFinite(health?.observed_ms) ? Math.max(0, Math.floor((Date.now() - health.observed_ms) / 6e4)) : null;
  const healthFresh = n.lifecycle === "ready" && presentation.symbol === "\u{1F7E2}";
  const manualRows = manual.results ?? [];
  const currentManual = /* @__PURE__ */ __name((operator) => manualRows.some((x) => x.operator === operator && x.revision === n.desired_revision && x.confirmed_ms > Date.now() - 864e5), "currentManual");
  const canConfirm = manualAttestationEnabled(env) && job?.state === "installed" && job.owner_id === actor && ["provisioning", "ready"].includes(n.lifecycle);
  const waitingForFieldTest = n.lifecycle === "provisioning" && job?.state === "installed";
  const routeText = routeRows.length ? routeRows.map((r) => statusSymbol(r.state) + " " + r.transport.toUpperCase() + (r.operator_hint ? " \xB7 " + (r.operator_hint === "mci" ? "\u0647\u0645\u0631\u0627\u0647 \u0627\u0648\u0644" : "\u0627\u06CC\u0631\u0627\u0646\u0633\u0644") : "") + (r.listen_port ? " :" + formatCount(r.listen_port) : "") + " \xB7 " + faStatus(r.state)).join("\n") : "\u0647\u0646\u0648\u0632 \u0645\u0633\u06CC\u0631\u06CC \u062B\u0628\u062A \u0646\u0634\u062F\u0647 \u0627\u0633\u062A.";
  const carriers = variantRows.map((v) => (v.operator === "mci" ? "\u0647\u0645\u0631\u0627\u0647 \u0627\u0648\u0644" : "\u0627\u06CC\u0631\u0627\u0646\u0633\u0644") + " :" + formatCount(v.port) + " \xB7 " + (v.published && v.verified_ms ? "\u0645\u0646\u062A\u0634\u0631 \u0648 \u062A\u0623\u06CC\u06CC\u062F\u0634\u062F\u0647" : "\u0622\u0632\u0645\u0627\u06CC\u0634\u06CC")).join("\n");
  const text = panelHeading("\u{1F5A5}", "\u067E\u0631\u0648\u0646\u062F\u0647 \u0633\u0631\u0648\u0631", n.id) + "\n\n\u{1F30D} \u0627\u0631\u0627\u0626\u0647\u200C\u062F\u0647\u0646\u062F\u0647: " + n.provider + "\n\u{1F4CD} \u0645\u0646\u0637\u0642\u0647: " + n.region + "\n" + presentation.symbol + " \u0648\u0636\u0639\u06CC\u062A: " + presentation.label + "\n\u2699\uFE0F \u0646\u0635\u0628: " + (job ? faStatus(job.state) : "\u062B\u0628\u062A \u0646\u0634\u062F\u0647") + (n.lifecycle === "ready" ? "\n\u{1F4E1} \u0633\u0644\u0627\u0645\u062A \u0644\u062D\u0638\u0647\u200C\u0627\u06CC \u0639\u0627\u0645\u0644: " + (healthFresh ? "\u2705 \u062A\u0627\u0632\u0647 \u0648 \u0645\u0639\u062A\u0628\u0631" : "\u{1F7E0} \u0622\u062E\u0631\u06CC\u0646 \u06AF\u0632\u0627\u0631\u0634 " + (healthAge === null ? "\u062B\u0628\u062A \u0646\u0634\u062F\u0647" : formatCount(healthAge) + " \u062F\u0642\u06CC\u0642\u0647 \u067E\u06CC\u0634") + "\u061B \u0635\u062F\u0648\u0631 \u062C\u062F\u06CC\u062F \u062A\u0627 \u0628\u0627\u0632\u06CC\u0627\u0628\u06CC \u0627\u0631\u062A\u0628\u0627\u0637 \u0645\u062A\u0648\u0642\u0641 \u0627\u0633\u062A. \u062A\u0623\u06CC\u06CC\u062F \u062F\u0648 \u0627\u067E\u0631\u0627\u062A\u0648\u0631 \u0645\u062D\u0641\u0648\u0638 \u0627\u0633\u062A.") : "") + "\n\u{1F464} \u0638\u0631\u0641\u06CC\u062A: " + formatCount(alloc.n) + " / " + formatCount(n.user_limit) + "\n\u{1F4E6} \u062D\u062C\u0645 \u062A\u062E\u0635\u06CC\u0635\u200C\u06CC\u0627\u0641\u062A\u0647: " + quotaLabel(alloc.bytes) + " / " + quotaLabel(n.byte_limit) + "\n\n\u{1F500} \u0645\u0633\u06CC\u0631\u0647\u0627\u06CC \u0633\u0631\u0648\u0631\n" + routeText + (carriers ? "\n\n\u{1F4F1} \u0645\u0633\u06CC\u0631\u0647\u0627\u06CC \u0627\u067E\u0631\u0627\u062A\u0648\u0631\u0647\u0627\n" + carriers : "") + (waitingForFieldTest ? "\n\n\u{1F9EA} \u0646\u0635\u0628 \u0633\u0631\u0648\u0631 \u0645\u0648\u0641\u0642 \u0628\u0648\u062F\u0647 \u0627\u0633\u062A. \u0628\u0631\u0627\u06CC \u0627\u062F\u0627\u0645\u0647\u060C \u0644\u06CC\u0646\u06A9 \u062A\u0633\u062A \u0631\u0627 \u0628\u0627\u0632 \u06A9\u0646\u06CC\u062F \u0648 \u0627\u062A\u0635\u0627\u0644 \u0647\u0631 \u062F\u0648 \u0627\u067E\u0631\u0627\u062A\u0648\u0631 \u0631\u0627 \u0627\u0632 \u06AF\u0648\u0634\u06CC \u0628\u0631\u0631\u0633\u06CC \u06A9\u0646\u06CC\u062F. \u062A\u0627 \u062A\u0623\u06CC\u06CC\u062F \u0622\u0632\u0645\u0648\u0646\u060C \u0645\u0633\u06CC\u0631 \u0645\u0646\u062A\u0634\u0631 \u0646\u0645\u06CC\u200C\u0634\u0648\u062F." : "") + (canConfirm ? "\n\n\u{1F4CB} \u062A\u0623\u06CC\u06CC\u062F \u062F\u0633\u062A\u06CC \u0645\u062F\u06CC\u0631: \u0647\u0645\u0631\u0627\u0647 \u0627\u0648\u0644 " + (currentManual("mci") ? "\u2705" : "\u23F3") + " \xB7 \u0627\u06CC\u0631\u0627\u0646\u0633\u0644 " + (currentManual("irancell") ? "\u2705" : "\u23F3") + "\n\u{1F510} \u062A\u0623\u06CC\u06CC\u062F \u0627\u0645\u0636\u0627\u0634\u062F\u0647 \u0639\u0627\u0645\u0644 \u0633\u0631\u0648\u0631: " + (Number(ack2?.seen) > Date.now() - 6e5 ? "\u062A\u0627\u0632\u0647 \u0648 \u0645\u0639\u062A\u0628\u0631" : "\u062F\u0631\u06CC\u0627\u0641\u062A \u0646\u0634\u062F\u0647 \u06CC\u0627 \u0645\u0646\u0642\u0636\u06CC\u061B \u0648\u0636\u0639\u06CC\u062A \u0622\u0645\u0627\u062F\u0647 \u0645\u0633\u062F\u0648\u062F \u0627\u0633\u062A") + "\n\u062B\u0628\u062A \u0646\u062A\u06CC\u062C\u0647\u0654 \u062A\u0633\u062A \u0628\u0647\u200C\u062A\u0646\u0647\u0627\u06CC\u06CC \u062C\u0627\u06CC \u062A\u0623\u06CC\u06CC\u062F \u0633\u0644\u0627\u0645\u062A \u0639\u0627\u0645\u0644 \u06CC\u0627 \u0622\u0632\u0645\u0648\u0646 \u0645\u0633\u062A\u0642\u0644 \u0631\u0627 \u0646\u0645\u06CC\u200C\u06AF\u06CC\u0631\u062F." : "") + "\n\n\u{1F510} \u062A\u063A\u06CC\u06CC\u0631 \u0648\u0636\u0639\u06CC\u062A \u0641\u0642\u0637 \u067E\u0633 \u0627\u0632 \u062A\u0623\u06CC\u06CC\u062F \u0627\u0646\u062C\u0627\u0645 \u0645\u06CC\u200C\u0634\u0648\u062F\u061B \u0627\u06CC\u0646 \u0628\u062E\u0634 \u0628\u0647 VPS \u0641\u0631\u0645\u0627\u0646 \u062D\u0630\u0641 \u0646\u0645\u06CC\u200C\u062F\u0647\u062F.";
  const buttons = [
    nodeButton("\u{1F504} \u062A\u0627\u0632\u0647\u200C\u0633\u0627\u0632\u06CC \u0647\u0645\u06CC\u0646 \u0633\u0631\u0648\u0631", "admin:node:view:" + ref),
    ...job?.state === "installed" && job.owner_id === actor && n.lifecycle !== "retired" && n.lifecycle !== "quarantined" ? [nodeButton("\u{1F9EA} \u0644\u06CC\u0646\u06A9 \u062A\u0633\u062A \u0627\u06CC\u0646 \u0633\u0631\u0648\u0631", "admin:node:trialref:" + ref)] : [],
    ...canConfirm ? [
      nodeButton((currentManual("mci") ? "\u2705" : "\u{1F4F1}") + " \u062B\u0628\u062A \u062A\u0633\u062A \u0647\u0645\u0631\u0627\u0647 \u0627\u0648\u0644 \xB7 \u06F4\u06F4\u06F3", "admin:node:field:mci:" + ref),
      nodeButton((currentManual("irancell") ? "\u2705" : "\u{1F4F1}") + " \u062B\u0628\u062A \u062A\u0633\u062A \u0627\u06CC\u0631\u0627\u0646\u0633\u0644 \xB7 \u06F8\u06F4\u06F4\u06F3", "admin:node:field:irancell:" + ref)
    ] : [],
    ...managementButtons(n, ref, alloc.n, job?.state),
    nodeButton("\u21A9\uFE0F \u0641\u0647\u0631\u0633\u062A \u0633\u0631\u0648\u0631\u0647\u0627", "admin:nodes")
  ];
  return { text: frameMessage(text), replyMarkup: { inline_keyboard: buttons } };
}
__name(nodeDetails, "nodeDetails");
var transition = {
  quarantine: { to: "quarantined", from: ["enrolling", "provisioning", "ready", "degraded"], label: "\u0642\u0631\u0646\u0637\u06CC\u0646\u0647" },
  restore: { to: "degraded", from: ["quarantined"], label: "\u0628\u0627\u0632\u06AF\u0631\u062F\u0627\u0646\u06CC \u0628\u0647 \u0628\u0631\u0631\u0633\u06CC" },
  retire: { to: "retired", from: ["enrolling", "provisioning", "degraded", "quarantined"], label: "\u0628\u0627\u06CC\u06AF\u0627\u0646\u06CC" }
};
async function nodeManagement(db, actor, ref, operation, apply = false, updateId = null) {
  const t2 = transition[operation];
  if (!t2) return panel("\u26A0\uFE0F \u0639\u0645\u0644\u06CC\u0627\u062A \u0645\u062F\u06CC\u0631\u06CC\u062A \u0633\u0631\u0648\u0631 \u0634\u0646\u0627\u062E\u062A\u0647 \u0646\u0634\u062F.");
  const n = await nodeRecord(db, ref);
  if (!n) return panel("\u26A0\uFE0F \u0633\u0631\u0648\u0631 \u067E\u06CC\u062F\u0627 \u0646\u0634\u062F.");
  const alloc = await activeAllocations(db, n.id);
  const job = operation === "retire" ? await db.prepare(
    "SELECT state FROM node_bootstrap_jobs WHERE node_id=?"
  ).bind(n.id).first() : null;
  const installing = ["pending", "dispatching", "dispatched"].includes(job?.state);
  if (!t2.from.includes(n.lifecycle) || operation === "retire" && (alloc.n > 0 || installing))
    return {
      text: frameMessage("\u26D4 \u062A\u063A\u06CC\u06CC\u0631 \u0648\u0636\u0639\u06CC\u062A \u0645\u062C\u0627\u0632 \u0646\u06CC\u0633\u062A. \u0648\u0636\u0639\u06CC\u062A \u0633\u0631\u0648\u0631 \u06CC\u0627 \u0627\u0634\u062A\u0631\u0627\u06A9\u200C\u0647\u0627\u06CC \u062A\u062E\u0635\u06CC\u0635\u200C\u06CC\u0627\u0641\u062A\u0647 \u0631\u0627 \u0628\u0631\u0631\u0633\u06CC \u06A9\u0646\u06CC\u062F."),
      replyMarkup: { inline_keyboard: [nodeButton("\u21A9\uFE0F \u067E\u0631\u0648\u0646\u062F\u0647 \u0633\u0631\u0648\u0631", "admin:node:view:" + ref)] }
    };
  if (!apply) {
    const description = operation === "quarantine" ? "\u0642\u0631\u0646\u0637\u06CC\u0646\u0647\u060C \u0633\u0631\u0648\u0631 \u0631\u0627 \u0627\u0632 \u0641\u0647\u0631\u0633\u062A \u0622\u0645\u0627\u062F\u0647 \u062E\u0627\u0631\u062C \u0645\u06CC\u200C\u06A9\u0646\u062F \u0648 \u0645\u0645\u06A9\u0646 \u0627\u0633\u062A \u0628\u0631 \u0633\u0631\u0648\u06CC\u0633\u200C\u0647\u0627\u06CC \u0641\u0639\u0627\u0644 \u0627\u062B\u0631 \u0628\u06AF\u0630\u0627\u0631\u062F." : operation === "restore" ? "\u0633\u0631\u0648\u0631 \u0641\u0642\u0637 \u0628\u0647 \u0648\u0636\u0639\u06CC\u062A \xAB\u0646\u06CC\u0627\u0632\u0645\u0646\u062F \u0628\u0631\u0631\u0633\u06CC\xBB \u0628\u0627\u0632\u0645\u06CC\u200C\u06AF\u0631\u062F\u062F\u061B \u0622\u0645\u0627\u062F\u0647 \u0641\u0631\u0648\u0634 \u0646\u0645\u06CC\u200C\u0634\u0648\u062F." : "\u0633\u0631\u0648\u0631 \u062F\u0631 \u0645\u062F\u0627\u0631 \u0628\u0627\u06CC\u06AF\u0627\u0646\u06CC \u0645\u06CC\u200C\u0634\u0648\u062F\u061B VPS \u0648 \u0641\u0627\u06CC\u0644\u200C\u0647\u0627 \u062D\u0630\u0641 \u0646\u0645\u06CC\u200C\u0634\u0648\u0646\u062F.";
    return {
      text: frameMessage(panelHeading("\u26A0\uFE0F", "\u062A\u0623\u06CC\u06CC\u062F " + t2.label, n.id) + "\n\n\u0648\u0636\u0639\u06CC\u062A \u0641\u0639\u0644\u06CC: " + faStatus(n.lifecycle) + "\n\u0627\u0634\u062A\u0631\u0627\u06A9\u200C\u0647\u0627\u06CC \u062A\u062E\u0635\u06CC\u0635\u200C\u06CC\u0627\u0641\u062A\u0647: " + formatCount(alloc.n) + "\n\n" + description + "\n\n\u0628\u0631\u0627\u06CC \u0627\u0646\u062C\u0627\u0645 \u0627\u06CC\u0646 \u062A\u063A\u06CC\u06CC\u0631\u060C \u062A\u0623\u06CC\u06CC\u062F \u0631\u0627 \u0627\u0646\u062A\u062E\u0627\u0628 \u06A9\u0646\u06CC\u062F."),
      replyMarkup: { inline_keyboard: [
        nodeButton("\u2705 \u062A\u0623\u06CC\u06CC\u062F " + t2.label, "admin:node:apply:" + operation + ":" + ref),
        nodeButton("\u21A9\uFE0F \u0627\u0646\u0635\u0631\u0627\u0641", "admin:node:view:" + ref)
      ] }
    };
  }
  if (!Number.isSafeInteger(updateId) || updateId < 0)
    return panel("\u26D4 \u062F\u0631\u062E\u0648\u0627\u0633\u062A \u062A\u063A\u06CC\u06CC\u0631 \u0645\u0639\u062A\u0628\u0631 \u0646\u06CC\u0633\u062A.");
  const allowed = t2.from.map((x) => "'" + x + "'").join(",");
  const sql = "UPDATE nodes SET lifecycle=? WHERE id=? AND lifecycle IN (" + allowed + ")" + (operation === "retire" ? " AND NOT EXISTS (SELECT 1 FROM node_allocations WHERE node_id=? AND state IN ('reserved','active')) AND NOT EXISTS (SELECT 1 FROM node_bootstrap_jobs WHERE node_id=? AND state IN ('pending','dispatching','dispatched'))" : "");
  const params = operation === "retire" ? [t2.to, n.id, n.id, n.id] : [t2.to, n.id];
  const results = await db.batch([
    db.prepare(sql).bind(...params),
    db.prepare("INSERT OR IGNORE INTO audit_events(event_id,actor_id,object_type,object_id,verb) SELECT ?,?,'node',?,? WHERE EXISTS (SELECT 1 FROM nodes WHERE id=? AND lifecycle=?)").bind("node:management:" + updateId, actor, n.id, "lifecycle:" + operation, n.id, t2.to)
  ]);
  if (results[0]?.meta?.changes !== 1)
    return panel("\u23F3 \u0648\u0636\u0639\u06CC\u062A \u0633\u0631\u0648\u0631 \u0647\u0645\u200C\u0632\u0645\u0627\u0646 \u062A\u063A\u06CC\u06CC\u0631 \u06A9\u0631\u062F\u061B \u0644\u0637\u0641\u0627\u064B \u0635\u0641\u062D\u0647 \u0633\u0631\u0648\u0631 \u0631\u0627 \u062A\u0627\u0632\u0647\u200C\u0633\u0627\u0632\u06CC \u06A9\u0646\u06CC\u062F.");
  return {
    text: frameMessage("\u2705 " + (operation === "retire" ? "\u0633\u0631\u0648\u0631 \u0628\u0627\u06CC\u06AF\u0627\u0646\u06CC \u0634\u062F: " : "\u0648\u0636\u0639\u06CC\u062A \u0633\u0631\u0648\u0631 \u062A\u063A\u06CC\u06CC\u0631 \u06A9\u0631\u062F: ") + n.id + "\n\u0648\u0636\u0639\u06CC\u062A \u062C\u062F\u06CC\u062F: " + faStatus(t2.to) + "\n\n\u0627\u06CC\u0646 \u062A\u063A\u06CC\u06CC\u0631 \u0628\u0647 \u0645\u0639\u0646\u0627\u06CC \u062A\u0623\u06CC\u06CC\u062F \u0627\u062A\u0635\u0627\u0644 \u06CC\u0627 \u062D\u0630\u0641 VPS \u0646\u06CC\u0633\u062A."),
    replyMarkup: { inline_keyboard: [nodeButton("\u{1F5A5} \u0645\u0634\u0627\u0647\u062F\u0647 \u0633\u0631\u0648\u0631", "admin:node:view:" + ref)] }
  };
}
__name(nodeManagement, "nodeManagement");
async function nodeFieldAction(env, actor, ref, operator, apply = false, nowMs = Date.now()) {
  const n = await nodeRecord(env.DB, ref);
  if (!n) return panel("\u26D4 \u0633\u0631\u0648\u0631 \u067E\u06CC\u062F\u0627 \u0646\u0634\u062F.");
  if (!["mci", "irancell"].includes(operator) || !manualAttestationEnabled(env))
    return panel("\u26D4 \u062B\u0628\u062A \u0622\u0632\u0645\u0648\u0646 \u062F\u0633\u062A\u06CC \u062F\u0631 \u0627\u06CC\u0646 \u0645\u062D\u06CC\u0637 \u0641\u0639\u0627\u0644 \u0646\u06CC\u0633\u062A.");
  const job = await env.DB.prepare(
    "SELECT state,owner_id FROM node_bootstrap_jobs WHERE node_id=?"
  ).bind(n.id).first();
  if (!job || job.state !== "installed" || job.owner_id !== actor || !["provisioning", "ready"].includes(n.lifecycle))
    return panel("\u26D4 \u0641\u0642\u0637 \u0645\u062F\u06CC\u0631 \u062B\u0628\u062A\u200C\u06A9\u0646\u0646\u062F\u0647 \u0648 \u067E\u0633 \u0627\u0632 \u0646\u0635\u0628 \u0645\u0648\u0641\u0642 \u0645\u06CC\u200C\u062A\u0648\u0627\u0646\u062F \u0646\u062A\u06CC\u062C\u0647 \u0622\u0632\u0645\u0648\u0646 \u0631\u0627 \u062A\u0623\u06CC\u06CC\u062F \u06A9\u0646\u062F.");
  const carrier = operator === "mci" ? "\u0647\u0645\u0631\u0627\u0647 \u0627\u0648\u0644" : "\u0627\u06CC\u0631\u0627\u0646\u0633\u0644";
  const port = operator === "mci" ? "\u06F4\u06F4\u06F3" : "\u06F8\u06F4\u06F4\u06F3";
  if (!apply) return { text: frameMessage(panelHeading("\u{1F9EA}", "\u062A\u0623\u06CC\u06CC\u062F \u0622\u0632\u0645\u0648\u0646 \u062F\u0633\u062A\u06CC", n.id) + "\n\n\u0622\u06CC\u0627 \u062E\u0648\u062F\u062A \u0628\u0627 \u0627\u06CC\u0646\u062A\u0631\u0646\u062A \u0633\u06CC\u0645\u200C\u06A9\u0627\u0631\u062A " + carrier + "\u060C \u0627\u062A\u0635\u0627\u0644 \u0648\u0627\u0642\u0639\u06CC VPN \u0631\u0648\u06CC \u067E\u0648\u0631\u062A " + port + " \u0631\u0627 \u0628\u0631\u0631\u0633\u06CC \u06A9\u0631\u062F\u0647\u200C\u0627\u06CC \u0648 \u0627\u0631\u0633\u0627\u0644 \u0648 \u062F\u0631\u06CC\u0627\u0641\u062A \u062F\u0627\u062F\u0647 \u0645\u0648\u0641\u0642 \u0628\u0648\u062F\u0647 \u0627\u0633\u062A\u061F\n\n\u0627\u06CC\u0646 \u0641\u0642\u0637 \u06AF\u0632\u0627\u0631\u0634 \u062F\u0633\u062A\u06CC \u0645\u062F\u06CC\u0631 \u0627\u0633\u062A\u061B \u062A\u0623\u06CC\u06CC\u062F \u0645\u0633\u062A\u0642\u0644 \u06CC\u0627 \u0633\u0644\u0627\u0645\u062A \u0646\u0648\u062F \u0631\u0627 \u062C\u0639\u0644 \u0646\u0645\u06CC\u200C\u06A9\u0646\u062F."), replyMarkup: {
    inline_keyboard: [
      nodeButton(
        "\u2705 \u0628\u0644\u0647\u061B \u0627\u062A\u0635\u0627\u0644 \u0648\u0627\u0642\u0639\u06CC \u0631\u0627 \u062A\u0633\u062A \u06A9\u0631\u062F\u0645",
        "admin:node:fieldapply:" + operator + ":" + ref
      ),
      nodeButton("\u21A9\uFE0F \u0628\u0627\u0632\u06AF\u0634\u062A \u0628\u062F\u0648\u0646 \u062B\u0628\u062A", "admin:node:view:" + ref)
    ]
  } };
  const result = await recordAdminCarrierTest(env, actor, n.id, operator, nowMs);
  let message;
  if (!result.ok) message = "\u26D4 \u062A\u0623\u06CC\u06CC\u062F \u062B\u0628\u062A \u0646\u0634\u062F. " + result.reason;
  else if (result.ready) message = "\u2705 \u062A\u0633\u062A\u200C\u0647\u0627\u06CC \u062F\u0633\u062A\u06CC \u0648 \u062A\u0623\u06CC\u06CC\u062F \u0627\u0645\u0636\u0627\u0634\u062F\u0647\u0654 \u0639\u0627\u0645\u0644 \u062F\u0631\u06CC\u0627\u0641\u062A \u0634\u062F\u061B \u0633\u0631\u0648\u0631 \u0622\u0645\u0627\u062F\u0647 \u0634\u062F.";
  else if (!result.paired) message = "\u2705 \u062A\u0633\u062A " + carrier + " \u062B\u0628\u062A \u0634\u062F. \u0644\u0637\u0641\u0627\u064B \u0627\u067E\u0631\u0627\u062A\u0648\u0631 \u062F\u06CC\u06AF\u0631 \u0631\u0627 \u0646\u06CC\u0632 \u062A\u0623\u06CC\u06CC\u062F \u06A9\u0646.";
  else message = "\u2705 \u0647\u0631 \u062F\u0648 \u062A\u0633\u062A \u062F\u0633\u062A\u06CC \u062B\u0628\u062A \u0634\u062F\u0647\u200C\u0627\u0646\u062F\u060C \u0648\u0644\u06CC \u0633\u0631\u0648\u0631 \u0647\u0646\u0648\u0632 \u0622\u0645\u0627\u062F\u0647 \u0646\u06CC\u0633\u062A.\n\u0639\u0644\u062A: " + (result.reason === "node_ack_pending" ? "\u0639\u0627\u0645\u0644 \u0646\u0648\u062F \u0647\u0646\u0648\u0632 ACK \u0627\u0645\u0636\u0627\u0634\u062F\u0647 \u0646\u0641\u0631\u0633\u062A\u0627\u062F\u0647 \u0627\u0633\u062A." : result.reason) + "\n\u0646\u0635\u0628 \u0639\u0627\u0645\u0644 \u0648 \u0633\u0631\u0648\u06CC\u0633 madar-v2-runtime \u0628\u0627\u06CC\u062F \u0628\u0631\u0631\u0633\u06CC \u0634\u0648\u062F.";
  return { text: frameMessage(message), replyMarkup: { inline_keyboard: [
    nodeButton("\u{1F504} \u0648\u0636\u0639\u06CC\u062A \u0647\u0645\u06CC\u0646 \u0633\u0631\u0648\u0631", "admin:node:view:" + ref),
    nodeButton("\u21A9\uFE0F \u0645\u062F\u06CC\u0631\u06CC\u062A \u0633\u0631\u0648\u0631\u0647\u0627", "admin:nodes")
  ] } };
}
__name(nodeFieldAction, "nodeFieldAction");
async function nodeFromRef(db, ref) {
  return nodeRecord(db, ref);
}
__name(nodeFromRef, "nodeFromRef");
async function nodeAdminAction(db, actor, key, input) {
  if (key === "/node_add") return enrollNode(db, actor, input);
  if (key === "/node_route") return addRoute(db, actor, input);
  if (key === "/nodes") return nodeOverview(db);
  return null;
}
__name(nodeAdminAction, "nodeAdminAction");

// src/feature-flags.mjs
function enabled(env, name) {
  if (!env || typeof env !== "object" || typeof name !== "string" || !/^[A-Z][A-Z0-9_]{1,79}$/.test(name)) return false;
  const secret = env[name + "_SECRET"];
  if (typeof secret === "string") return secret === "true";
  return env[name] === "true";
}
__name(enabled, "enabled");

// src/subscription.mjs
var ascii = new TextEncoder();
var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
var TOKEN2 = /^[A-Za-z0-9_-]{43}$/;
var SAFE_HOST = /^[a-zA-Z0-9][a-zA-Z0-9.:-]{1,252}$/;
var hex = /* @__PURE__ */ __name((bytes) => Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join(""), "hex");
var base64Decode = /* @__PURE__ */ __name((value) => {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]+$/.test(value))
    throw new TypeError("invalid_b64url");
  const clean = value.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(clean + "=".repeat((4 - clean.length % 4) % 4)), (x) => x.charCodeAt(0));
}, "base64Decode");
var json = /* @__PURE__ */ __name((obj, status = 200) => new Response(JSON.stringify(obj), {
  status,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store, private",
    "pragma": "no-cache",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer"
  }
}), "json");
async function tokenDigest2(token) {
  if (!TOKEN2.test(token ?? "")) return null;
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", ascii.encode(token))));
}
__name(tokenDigest2, "tokenDigest");
async function unwrapClientUuid(credential, keyText) {
  const raw = base64Decode(keyText);
  if (raw.length !== 32) throw new TypeError("credential_key_length");
  const nonce = base64Decode(credential?.nonce_b64);
  const ciphertext = base64Decode(credential?.ciphertext_b64);
  if (nonce.length !== 12 || ciphertext.length < 16) throw new TypeError("bad_ciphertext");
  const key = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["decrypt"]);
  const uuid = new TextDecoder("utf-8", { fatal: true }).decode(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ciphertext)
  );
  if (!UUID.test(uuid)) throw new TypeError("bad_client_uuid");
  return uuid;
}
__name(unwrapClientUuid, "unwrapClientUuid");
function eligibleEndpoint(row) {
  if (!row || !SAFE_HOST.test(row.host ?? "") || !Number.isInteger(row.port) || row.port < 1 || row.port > 65535) return false;
  if (row.transport === "reality")
    return typeof row.server_name === "string" && SAFE_HOST.test(row.server_name) && /^[A-Za-z0-9_-]{43}$/.test(row.reality_public_key ?? "") && /^[a-fA-F0-9]{0,16}$/.test(row.reality_short_id ?? "");
  if (row.transport === "wss")
    return typeof row.server_name === "string" && SAFE_HOST.test(row.server_name) && typeof row.ws_path === "string" && row.ws_path.startsWith("/") && row.ws_path.length <= 256 && !/[\r\n]/.test(row.ws_path);
  return false;
}
__name(eligibleEndpoint, "eligibleEndpoint");
async function activeRoutes(db, subId, nowMs) {
  const rows = (await db.prepare(
    "SELECT r.id || ':' || rv.operator AS route_id,r.transport,rv.operator AS operator_hint,rv.host,rv.port,rv.server_name,rv.ws_path,rv.reality_public_key,rv.reality_short_id FROM node_allocations a JOIN nodes n ON n.id=a.node_id JOIN routes r ON r.node_id=n.id JOIN route_carrier_variants rv ON rv.route_id=r.id WHERE a.subscription_id=? AND a.state='active' AND n.lifecycle='ready' AND n.desired_revision=n.acked_revision AND r.transport='reality' AND r.state='ready' AND r.verified_ms BETWEEN ? AND ? AND rv.published=1 AND rv.verified_ms BETWEEN ? AND ? AND EXISTS(SELECT 1 FROM node_client_acks ac WHERE ac.node_id=n.id AND ac.subscription_id=a.subscription_id AND ac.revision=n.desired_revision AND ac.observed_ms BETWEEN ? AND ?) UNION ALL SELECT r.id AS route_id,r.transport,r.operator_hint,re.host,re.port,re.server_name,re.ws_path,re.reality_public_key,re.reality_short_id FROM node_allocations a JOIN nodes n ON n.id=a.node_id JOIN routes r ON r.node_id=n.id JOIN route_endpoints re ON re.route_id=r.id WHERE a.subscription_id=? AND a.state='active' AND n.lifecycle='ready' AND n.desired_revision=n.acked_revision AND r.state='ready' AND r.verified_ms BETWEEN ? AND ? AND re.published=1 AND NOT EXISTS(SELECT 1 FROM route_carrier_variants rv WHERE rv.route_id=r.id) AND EXISTS(SELECT 1 FROM node_client_acks ac WHERE ac.node_id=n.id AND ac.subscription_id=a.subscription_id AND ac.revision=n.desired_revision AND ac.observed_ms BETWEEN ? AND ?) ORDER BY route_id LIMIT 8"
  ).bind(
    subId,
    nowMs - 6e5,
    nowMs,
    nowMs - 6e5,
    nowMs,
    nowMs - 6e5,
    nowMs,
    subId,
    nowMs - 6e5,
    nowMs,
    nowMs - 6e5,
    nowMs
  ).all()).results ?? [];
  return rows.filter(eligibleEndpoint);
}
__name(activeRoutes, "activeRoutes");
async function isAdminE2eSubscription(env, subId, nowMs = Date.now()) {
  if (env.ADMIN_E2E_TEST_ENABLED !== "true" || !env.DB || typeof subId !== "string" || subId.length > 80) return false;
  const row = await env.DB.prepare(
    "SELECT o.id AS order_id,s.owner_telegram_id AS owner,a.node_id,j.owner_id FROM subscriptions s JOIN orders o ON o.id=s.order_id JOIN plans p ON p.id=o.plan_id JOIN customers c ON c.telegram_id=s.owner_telegram_id JOIN node_allocations a ON a.subscription_id=s.id AND a.state='active' JOIN node_bootstrap_jobs j ON j.node_id=a.node_id AND j.state='installed' WHERE s.id=? AND s.state='active' AND s.expires_at>? AND s.max_bytes=104857600 AND s.used_bytes<s.max_bytes AND c.state='active' AND o.customer_telegram_id=s.owner_telegram_id AND o.state='fulfilled' AND o.plan_id='v2-admin-e2e-100mb-1day' AND o.quoted_amount=0 AND o.quoted_currency='IRT' AND p.id=o.plan_id AND p.active=0 AND p.price_amount=0 AND p.duration_days=1 AND p.quota_bytes=104857600 LIMIT 1"
  ).bind(subId, nowMs).first();
  if (!row || row.owner !== row.owner_id || !/^[0-9]{5,20}$/.test(row.owner ?? "") || typeof env.ADMIN_TELEGRAM_IDS !== "string" || !env.ADMIN_TELEGRAM_IDS.split(",").includes(row.owner)) return false;
  return row.order_id === "e2e-" + await nodeUiRef(row.node_id);
}
__name(isAdminE2eSubscription, "isAdminE2eSubscription");
async function isAdminE2eToken(env, token, nowMs = Date.now()) {
  if (env.ADMIN_E2E_TEST_ENABLED !== "true" || !env.DB) return false;
  const hash = await tokenDigest2(token);
  if (!hash) return false;
  const row = await env.DB.prepare(
    "SELECT subscription_id FROM subscription_tokens WHERE token_hash=? AND revoked=0 AND expires_at>? LIMIT 1"
  ).bind(hash, nowMs).first();
  return !!row && await isAdminE2eSubscription(env, row.subscription_id, nowMs);
}
__name(isAdminE2eToken, "isAdminE2eToken");
async function isAdminDirectSubscription(env, subId, nowMs = Date.now()) {
  if (env.ADMIN_DIRECT_ISSUE_ENABLED !== "true" || !env.DB || typeof subId !== "string" || subId.length > 80) return false;
  const row = await env.DB.prepare(
    "SELECT i.id,i.actor_id,i.node_id,i.quota_bytes,i.duration_days,o.id order_id,o.customer_telegram_id,j.owner_id,p.id plan_id,p.quota_bytes plan_quota,p.duration_days plan_days FROM subscriptions s JOIN orders o ON o.id=s.order_id JOIN admin_direct_issues i ON i.order_id=o.id JOIN plans p ON p.id=o.plan_id JOIN customers c ON c.telegram_id=s.owner_telegram_id JOIN node_allocations a ON a.subscription_id=s.id AND a.node_id=i.node_id AND a.state='active' JOIN node_bootstrap_jobs j ON j.node_id=i.node_id AND j.state='installed' WHERE s.id=? AND s.state='active' AND s.expires_at>? AND s.max_bytes=i.quota_bytes AND s.used_bytes<s.max_bytes AND c.state='active' AND o.state='fulfilled' AND o.quoted_amount=0 AND o.quoted_currency='IRT' AND o.seller_telegram_id IS NULL AND o.customer_telegram_id=s.owner_telegram_id AND p.price_amount=0 AND p.active=0 AND p.price_currency='IRT' LIMIT 1"
  ).bind(subId, nowMs).first();
  if (!row || row.actor_id !== row.owner_id || row.actor_id !== row.customer_telegram_id || row.plan_quota !== row.quota_bytes || row.plan_days !== row.duration_days || row.plan_id !== "dp-" + row.quota_bytes / 1073741824 + "-" + row.duration_days || row.order_id !== "do-" + row.id.slice(3) || !/^di-[a-f0-9]{24}$/.test(row.id) || !/^[0-9]{5,20}$/.test(row.actor_id ?? "") || typeof env.ADMIN_TELEGRAM_IDS !== "string" || !env.ADMIN_TELEGRAM_IDS.split(",").map((x) => x.trim()).includes(row.actor_id))
    return false;
  return true;
}
__name(isAdminDirectSubscription, "isAdminDirectSubscription");
async function isAdminDirectToken(env, token, nowMs = Date.now()) {
  if (env.ADMIN_DIRECT_ISSUE_ENABLED !== "true" || !env.DB) return false;
  const hash = await tokenDigest2(token);
  if (!hash) return false;
  const row = await env.DB.prepare(
    "SELECT subscription_id FROM subscription_tokens WHERE token_hash=? AND revoked=0 AND expires_at>? LIMIT 1"
  ).bind(hash, nowMs).first();
  return !!row && await isAdminDirectSubscription(env, row.subscription_id, nowMs);
}
__name(isAdminDirectToken, "isAdminDirectToken");
async function getSubscription(request, env, nowMs = Date.now()) {
  if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
  const generalApi = enabled(env, "SUBSCRIPTION_API_ENABLED");
  if (!generalApi && env.ADMIN_E2E_TEST_ENABLED !== "true" && env.ADMIN_DIRECT_ISSUE_ENABLED !== "true")
    return json({ error: "service_not_ready" }, 503);
  if (!env.DB || !env.SUBSCRIPTION_CREDENTIAL_KEY)
    return json({ error: "service_not_ready" }, 503);
  const header = request.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return json({ error: "unauthorized" }, 401);
  const token = header.slice(7);
  const hash = await tokenDigest2(token);
  if (!hash) return json({ error: "unauthorized" }, 401);
  if (!generalApi && !(await isAdminE2eToken(env, token, nowMs) || await isAdminDirectToken(env, token, nowMs)))
    return json({ error: "service_not_ready" }, 503);
  const owner = generalApi ? await findAppSession(env.DB, hash, nowMs) : null;
  const active = owner ? await env.DB.prepare(
    "SELECT id,state,expires_at,max_bytes,used_bytes FROM subscriptions WHERE owner_telegram_id=? AND state='active' AND expires_at>? ORDER BY expires_at DESC LIMIT 1"
  ).bind(owner, nowMs).first() : await env.DB.prepare(
    "SELECT s.id,s.state,s.expires_at,s.max_bytes,s.used_bytes FROM subscription_tokens t JOIN subscriptions s ON s.id=t.subscription_id JOIN customers c ON c.telegram_id=s.owner_telegram_id WHERE t.token_hash=? AND t.revoked=0 AND t.expires_at>? AND s.state='active' AND c.state='active' AND s.expires_at>? LIMIT 1"
  ).bind(hash, nowMs, nowMs).first();
  if (!active) return json({ error: "subscription_inactive" }, 403);
  if (active.max_bytes <= 0 || active.used_bytes >= active.max_bytes)
    return json({ error: "quota_exhausted" }, 403);
  const routes = await activeRoutes(env.DB, active.id, nowMs);
  if (!routes.length) return json({ error: "no_verified_routes" }, 503);
  const secrets = await env.DB.prepare(
    "SELECT ciphertext_b64,nonce_b64,key_version FROM subscription_credentials WHERE subscription_id=?"
  ).bind(active.id).first();
  if (!secrets || secrets.key_version !== 1) return json({ error: "credential_unavailable" }, 503);
  let id;
  try {
    id = await unwrapClientUuid(secrets, env.SUBSCRIPTION_CREDENTIAL_KEY);
  } catch {
    return json({ error: "credential_unavailable" }, 503);
  }
  const named = env.ADMIN_DIRECT_ISSUE_ENABLED === "true" ? await env.DB.prepare(
    "SELECT i.label FROM admin_direct_issues i JOIN subscriptions s ON s.order_id=i.order_id WHERE s.id=?"
  ).bind(active.id).first() : null;
  return json({
    version: 1,
    subscription_id: active.id,
    expires_at: active.expires_at,
    ...named?.label ? { customer_label: named.label } : {},
    quota_bytes: active.max_bytes,
    used_bytes: active.used_bytes,
    client: { protocol: "vless", uuid: id },
    routes: routes.map((x) => ({
      id: x.route_id,
      protocol: "vless",
      transport: x.transport,
      operator_hint: x.operator_hint ?? null,
      endpoint: { host: x.host, port: x.port },
      tls: {
        server_name: x.server_name,
        ...x.transport === "reality" ? {
          reality_public_key: x.reality_public_key,
          short_id: x.reality_short_id
        } : {}
      },
      ...x.transport === "wss" ? { websocket: { path: x.ws_path } } : {}
    }))
  });
}
__name(getSubscription, "getSubscription");
async function wrapClientUuid(uuid, keyText) {
  if (!UUID.test(uuid ?? "")) throw new TypeError("invalid_client_uuid");
  const raw = base64Decode(keyText);
  if (raw.length !== 32) throw new TypeError("credential_key_length");
  const key = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt"]);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({
    name: "AES-GCM",
    iv: nonce
  }, key, ascii.encode(uuid)));
  const encode = /* @__PURE__ */ __name((data) => btoa(String.fromCharCode(...data)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""), "encode");
  return { nonce_b64: encode(nonce), ciphertext_b64: encode(encrypted), key_version: 1 };
}
__name(wrapClientUuid, "wrapClientUuid");
async function issueActiveToken(env, subId, nowMs = Date.now()) {
  if (!env.DB || !env.SUBSCRIPTION_CREDENTIAL_KEY || typeof subId !== "string" || subId.length > 80)
    return null;
  if (!enabled(env, "SUBSCRIPTION_API_ENABLED") && !await isAdminE2eSubscription(env, subId, nowMs) && !await isAdminDirectSubscription(env, subId, nowMs)) return null;
  const row = await env.DB.prepare(
    "SELECT s.id,s.expires_at FROM subscriptions s JOIN subscription_credentials c ON c.subscription_id=s.id AND c.key_version=1 JOIN customers owner ON owner.telegram_id=s.owner_telegram_id WHERE s.id=? AND s.state='active' AND owner.state='active' AND s.expires_at>? AND s.max_bytes>0 AND s.used_bytes<s.max_bytes AND EXISTS(SELECT 1 FROM node_allocations a WHERE a.subscription_id=s.id AND a.state='active')"
  ).bind(subId, nowMs).first();
  if (!row) return null;
  const entropy = crypto.getRandomValues(new Uint8Array(32));
  const token = btoa(String.fromCharCode(...entropy)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const hash = await tokenDigest2(token);
  await env.DB.prepare(
    "INSERT INTO subscription_tokens(token_hash,subscription_id,expires_at) VALUES(?,?,?)"
  ).bind(hash, subId, row.expires_at).run();
  return { token, expires_at: row.expires_at };
}
__name(issueActiveToken, "issueActiveToken");

// src/carrier-subscription.mjs
var TOKEN3 = /^[A-Za-z0-9_-]{43}$/;
var PAIR = ["mci", "irancell"];
var PROFILE = { mci: "\u0645\u062F\u0627\u0631 | \u0647\u0645\u0631\u0627\u0647 \u0627\u0648\u0644", irancell: "\u0645\u062F\u0627\u0631 | \u0627\u06CC\u0631\u0627\u0646\u0633\u0644" };
var noStore = /* @__PURE__ */ __name((body3, status, contentType = "text/plain; charset=utf-8", extra = {}) => new Response(body3, { status, headers: {
  "content-type": contentType,
  "cache-control": "private, no-store, max-age=0",
  "pragma": "no-cache",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-robots-tag": "noindex, nofollow",
  ...extra
} }), "noStore");
function carrierPair(routes) {
  if (!Array.isArray(routes)) return null;
  const selected = [];
  for (const operator of PAIR) {
    const choices = routes.filter((r) => r?.transport === "reality" && r.operator_hint === operator);
    if (choices.length !== 1) return null;
    selected.push(choices[0]);
  }
  if (selected[0].id === selected[1].id) return null;
  const address = /* @__PURE__ */ __name((route) => ({
    host: route.endpoint?.host ?? route.host,
    port: route.endpoint?.port ?? route.port
  }), "address");
  const first = address(selected[0]), second = address(selected[1]);
  if (first.host === second.host && first.port === second.port)
    return null;
  return selected;
}
__name(carrierPair, "carrierPair");
function vlessLink(route, uuid, customerLabel = null) {
  const opts = new URLSearchParams({
    encryption: "none",
    security: "reality",
    type: "tcp",
    flow: "xtls-rprx-vision",
    sni: route.tls.server_name,
    fp: "chrome",
    pbk: route.tls.reality_public_key,
    sid: route.tls.short_id
  });
  const hostname = route.endpoint.host;
  const address = hostname.includes(":") && !hostname.startsWith("[") ? "[" + hostname + "]" : hostname;
  const baseLabel = PROFILE[route.operator_hint];
  const label2 = typeof customerLabel === "string" && customerLabel.length <= 60 && !/[\r\n<>]/.test(customerLabel) ? baseLabel + " \xB7 " + customerLabel : baseLabel;
  if (!label2) throw new TypeError("unknown_carrier");
  return "vless://" + uuid + "@" + address + ":" + route.endpoint.port + "?" + opts.toString() + "#" + encodeURIComponent(label2);
}
__name(vlessLink, "vlessLink");
function base64Feed(snapshot) {
  const routes = carrierPair(snapshot.routes);
  if (!routes) return null;
  const source = routes.map((r) => vlessLink(r, snapshot.client.uuid, snapshot.customer_label)).join("\n") + "\n";
  const bytes = new TextEncoder().encode(source);
  return btoa(String.fromCharCode(...bytes));
}
__name(base64Feed, "base64Feed");
async function getCarrierFeed(request, env, nowMs = Date.now()) {
  if (request.method !== "GET") return noStore("Not found", 404);
  const url = new URL(request.url);
  const token = url.pathname.startsWith("/s/") ? url.pathname.slice(3) : "";
  if (url.search || url.hash || !TOKEN3.test(token)) return noStore("Not found", 404);
  if ((!enabled(env, "SUBSCRIPTION_LINKS_ENABLED") || !enabled(env, "SUBSCRIPTION_API_ENABLED")) && !(await isAdminE2eToken(env, token, nowMs) || await isAdminDirectToken(env, token, nowMs)))
    return noStore("Not ready", 503);
  const internal = new Request(url.origin + "/api/v2/subscription", {
    headers: { authorization: "Bearer " + token }
  });
  const response4 = await getSubscription(internal, env, nowMs);
  if (response4.status !== 200)
    return noStore(
      response4.status === 401 || response4.status === 403 ? "Unavailable" : "Not ready",
      response4.status === 401 || response4.status === 403 ? 403 : 503
    );
  const snapshot = await response4.json();
  const body3 = base64Feed(snapshot);
  if (body3 === null) return noStore("Operator routes not ready", 503);
  const info = "upload=0; download=" + snapshot.used_bytes + "; total=" + snapshot.quota_bytes + "; expire=" + Math.floor(snapshot.expires_at / 1e3);
  return noStore(body3, 200, "text/plain; charset=utf-8", {
    "subscription-userinfo": info,
    "profile-update-interval": "12",
    "content-disposition": 'attachment; filename="Madar.txt"'
  });
}
__name(getCarrierFeed, "getCarrierFeed");
function trustedOrigin(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.search || url.hash || url.pathname !== "/" || url.port)
      return null;
    return url.origin;
  } catch {
    return null;
  }
}
__name(trustedOrigin, "trustedOrigin");
async function issueCarrierLink(env, subscriptionId, nowMs = Date.now()) {
  if (!env.DB) return null;
  if ((!enabled(env, "SUBSCRIPTION_LINKS_ENABLED") || !enabled(env, "SUBSCRIPTION_API_ENABLED")) && !await isAdminE2eSubscription(env, subscriptionId, nowMs) && !await isAdminDirectSubscription(env, subscriptionId, nowMs)) return null;
  const origin = trustedOrigin(env.SUBSCRIPTION_PUBLIC_ORIGIN);
  if (!origin) return null;
  const routes = await activeRoutes(env.DB, subscriptionId, nowMs);
  if (!carrierPair(routes.map((r) => ({
    id: r.route_id,
    transport: r.transport,
    operator_hint: r.operator_hint,
    host: r.host,
    port: r.port
  })))) return null;
  const issued = await issueActiveToken(env, subscriptionId, nowMs);
  return issued ? { url: origin + "/s/" + issued.token, expires_at: issued.expires_at } : null;
}
__name(issueCarrierLink, "issueCarrierLink");

// src/node-auto.mjs
var ID2 = /^(?!prod(?:uction)?(?:[-_0-9]|$))(?!main(?:[-_0-9]|$))(?!node1$)(?!madar-v2-node1$)[A-Za-z][A-Za-z0-9_-]{2,63}$/i;
var ERROR = /^[A-Z0-9_]{3,64}$/;
var PUB = /^[A-Za-z0-9_-]{43}$/;
var SID = /^[a-f0-9]{2,16}$/;
var TOKEN4 = /^[A-Za-z0-9_-]{43}$/;
var EXACT_COMMIT = "ec9a19f5cf1925e2ab7b114c35f29345d508f4ba";
var WFLOW = "madar-v2-node-provision.yml";
function publicV4(input) {
  if (typeof input !== "string") return false;
  const p = input.split(".");
  if (p.length !== 4 || p.some((x) => !/^(0|[1-9]\d{0,2})$/.test(x) || Number(x) > 255)) return false;
  const n = p.map(Number), [a, b, c] = n;
  return a !== 0 && a !== 10 && a !== 127 && a !== 169 && a !== 172 && a !== 192 && a !== 198 && a !== 224 && a !== 225 && a !== 226 && a !== 227 && a !== 228 && a !== 229 && a !== 230 && a !== 231 && a !== 232 && a !== 233 && a !== 234 && a !== 235 && a !== 236 && a !== 237 && a !== 238 && a !== 239 && a !== 240 && a !== 241 && a !== 242 && a !== 243 && a !== 244 && a !== 245 && a !== 246 && a !== 247 && a !== 248 && a !== 249 && a !== 250 && a !== 251 && a !== 252 && a !== 253 && a !== 254 && a !== 255 && !(a === 100 && b >= 64 && b <= 127) && !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && b === 168) && !(a === 192 && b === 0 && c === 0) && !(a === 192 && b === 0 && c === 2) && !(a === 198 && b === 51 && c === 100) && !(a === 203 && b === 0 && c === 113);
}
__name(publicV4, "publicV4");
var toBase64url = /* @__PURE__ */ __name((bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""), "toBase64url");
var response = /* @__PURE__ */ __name((body3, status = 200, type = "application/json; charset=utf-8") => new Response(type.startsWith("application/json") ? JSON.stringify(body3) : body3, { status, headers: {
  "content-type": type,
  "cache-control": "private, no-store",
  "pragma": "no-cache",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer"
} }), "response");
function parseAutoNode(raw) {
  if (typeof raw !== "string") return null;
  const a = raw.trim().split("|").map((x) => x.trim());
  if (a.length !== 6) return null;
  const [id, provider, region, users, gb, ip] = a;
  if (!ID2.test(id) || !/[A-Za-z0-9_.-]{2,64}/.test(provider) || !/^[A-Za-z0-9_-]{2,64}$/.test(region) || !publicV4(ip) || !/^[1-9][0-9]{0,5}$/.test(users) || !/^([1-9][0-9]{0,5})$/.test(gb))
    return null;
  const capacity = Number(gb) * 1073741824;
  if (Number(users) > 1e5 || Number(gb) > 2e5 || !Number.isSafeInteger(capacity))
    return null;
  if (ip === "86.54.42.66" && id !== "test-aria01") return null;
  return {
    id,
    provider,
    region,
    users: Number(users),
    bytes: capacity,
    ip,
    mode: ip === "86.54.42.66" ? "aria-cutover" : "fresh"
  };
}
__name(parseAutoNode, "parseAutoNode");
async function enqueueAutoNode(env, actor, input, nowMs = Date.now()) {
  const spec = parseAutoNode(input);
  if (!spec) return { error: "bad_input" };
  if (!env.DB) return { error: "not_ready" };
  if (env.NODE_AUTO_ENABLED !== "true" || !env.NODE_AUTO_GH_TOKEN || !env.NODE_PROVISION_CALLBACK_SECRET || !env.SUBSCRIPTION_CREDENTIAL_KEY)
    return { error: "automation_not_configured" };
  const id = crypto.randomUUID();
  try {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO nodes(id,provider,region,lifecycle,user_limit,byte_limit,desired_revision,acked_revision) VALUES(?,?,?,'enrolling',?,?,1,0)").bind(spec.id, spec.provider, spec.region, spec.users, spec.bytes),
      env.DB.prepare("INSERT INTO node_bootstrap_jobs(id,node_id,ip,owner_id,mode,state,created_ms,updated_ms) VALUES(?,?,?,?,?,'pending',?,?)").bind(id, spec.id, spec.ip, actor, spec.mode, nowMs, nowMs),
      env.DB.prepare("INSERT INTO audit_events(event_id,actor_id,object_type,object_id,verb) VALUES(?,?,?,?,?)").bind("autonode:" + spec.id, actor, "node", spec.id, "enroll:queued")
    ]);
  } catch {
    return { error: "already_exists" };
  }
  const dispatched = await tryDispatch(env, { id, node_id: spec.id, ip: spec.ip, mode: spec.mode }, nowMs);
  return { id: spec.id, jobId: id, dispatched };
}
__name(enqueueAutoNode, "enqueueAutoNode");
async function tryDispatch(env, job, nowMs = Date.now(), send = fetch) {
  if (env.NODE_AUTO_ENABLED !== "true" || !env.NODE_AUTO_GH_TOKEN || !env.NODE_PROVISION_CALLBACK_SECRET || !env.SUBSCRIPTION_CREDENTIAL_KEY)
    return false;
  if (!ID2.test(job.node_id) || !publicV4(job.ip) || !["aria-cutover", "fresh"].includes(job.mode)) return false;
  const claimed = await env.DB.prepare(
    "UPDATE node_bootstrap_jobs SET state='dispatching',updated_ms=? WHERE id=? AND state='pending'"
  ).bind(nowMs, job.id).run();
  if (claimed.meta?.changes !== 1) return false;
  try {
    const r = await send("https://api.github.com/repos/alireza-anari/madar-vpn/actions/workflows/" + WFLOW + "/dispatches", {
      method: "POST",
      headers: {
        "authorization": "Bearer " + env.NODE_AUTO_GH_TOKEN,
        "accept": "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "madar-v2-staging",
        "content-type": "application/json"
      },
      body: JSON.stringify({ ref: "main", inputs: {
        job_id: job.id,
        node_id: job.node_id,
        ip: job.ip,
        mode: job.mode,
        pinned_sha: EXACT_COMMIT
      } }),
      signal: AbortSignal.timeout(1e4)
    });
    if (!r.ok) throw Error("dispatch");
    await env.DB.prepare("UPDATE node_bootstrap_jobs SET state='dispatched',updated_ms=? WHERE id=? AND state='dispatching'").bind(nowMs, job.id).run();
    return true;
  } catch {
    await env.DB.prepare(
      "UPDATE node_bootstrap_jobs SET state='pending',updated_ms=? WHERE id=? AND state='dispatching'"
    ).bind(nowMs, job.id).run();
    return false;
  }
}
__name(tryDispatch, "tryDispatch");
async function retryPending(env, nowMs = Date.now()) {
  if (env.NODE_AUTO_ENABLED !== "true" || !env.DB) return;
  const rows = (await env.DB.prepare(
    "SELECT id,node_id,ip,mode FROM node_bootstrap_jobs WHERE state='pending' ORDER BY created_ms LIMIT 2"
  ).all()).results ?? [];
  for (const job of rows) await tryDispatch(env, job, nowMs);
}
__name(retryPending, "retryPending");
async function matchesSecret(raw, expected) {
  if (typeof raw !== "string" || typeof expected !== "string" || expected.length < 32 || raw.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < raw.length; i++) diff |= raw.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}
__name(matchesSecret, "matchesSecret");
function validReport(b) {
  if (!b || typeof b !== "object" || !ID2.test(b.node_id) || !/^[0-9a-f-]{36}$/.test(b.job_id ?? "") || !publicV4(b.ip)) return false;
  if (b.status === "failed") return ERROR.test(b.error_code ?? "");
  return b.status === "installed" && PUB.test(b.public_key ?? "") && SID.test(b.short_id ?? "") && /^(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,63}$/.test(b.server_name ?? "") && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(b.uuid ?? "");
}
__name(validReport, "validReport");
async function reportInstall(req, env, nowMs = Date.now(), completionStatements = []) {
  if (req.method !== "POST" || env.NODE_AUTO_ENABLED !== "true" || !env.DB || !env.NODE_PROVISION_CALLBACK_SECRET || !env.SUBSCRIPTION_CREDENTIAL_KEY)
    return response({ error: "not_found" }, 404);
  if (!await matchesSecret(
    req.headers.get("x-madar-deploy-auth"),
    env.NODE_PROVISION_CALLBACK_SECRET
  ))
    return response({ error: "unauthorized" }, 401);
  if (Number(req.headers.get("content-length")) > 2048) return response({ error: "large" }, 413);
  let data;
  try {
    const payload = await req.text();
    if (payload.length > 2048) return response({ error: "large" }, 413);
    data = JSON.parse(payload);
  } catch {
    return response({ error: "bad_request" }, 400);
  }
  if (!validReport(data)) return response({ error: "bad_request" }, 400);
  const job = await env.DB.prepare(
    "SELECT id,node_id,ip,mode,state FROM node_bootstrap_jobs WHERE id=? AND node_id=? AND ip=?"
  ).bind(data.job_id, data.node_id, data.ip).first();
  if (!job || !["dispatched", "dispatching"].includes(job.state))
    return response({ error: "not_pending" }, 409);
  if (data.status === "failed") {
    await env.DB.batch([env.DB.prepare(
      "UPDATE node_bootstrap_jobs SET state='failed',error_code=?,updated_ms=? WHERE id=? AND state IN ('dispatched','dispatching')"
    ).bind(data.error_code, nowMs, job.id), ...completionStatements]);
    return response({ accepted: true, installed: false });
  }
  const encoded = await wrapClientUuid(data.uuid, env.SUBSCRIPTION_CREDENTIAL_KEY);
  const route = data.node_id + "_reality";
  const statements = [
    env.DB.prepare(
      "INSERT INTO routes(id,node_id,transport,state,listen_port,operator_hint) VALUES(?,?,'reality','checking',8443,NULL)"
    ).bind(route, data.node_id),
    env.DB.prepare(
      "INSERT INTO route_endpoints(route_id,host,port,server_name,reality_public_key,reality_short_id,published) VALUES(?,?,?,?,?,?,0)"
    ).bind(route, data.ip, 8443, data.server_name, data.public_key, data.short_id),
    ...[["mci", 443], ["irancell", 8443]].map(([operator, port]) => env.DB.prepare(
      "INSERT INTO route_carrier_variants(route_id,operator,host,port,server_name,reality_public_key,reality_short_id,published,verified_ms) VALUES(?,?,?,?,?,?,?,0,NULL)"
    ).bind(route, operator, data.ip, port, data.server_name, data.public_key, data.short_id)),
    env.DB.prepare(
      "INSERT INTO node_trial_credentials(node_id,ciphertext_b64,nonce_b64,key_version,created_ms) VALUES(?,?,?,?,?)"
    ).bind(data.node_id, encoded.ciphertext_b64, encoded.nonce_b64, 1, nowMs),
    env.DB.prepare("UPDATE nodes SET lifecycle='provisioning' WHERE id=? AND lifecycle='enrolling'").bind(data.node_id),
    env.DB.prepare(
      "UPDATE node_bootstrap_jobs SET state='installed',updated_ms=? WHERE id=? AND state IN ('dispatched','dispatching')"
    ).bind(nowMs, job.id),
    ...completionStatements
  ];
  try {
    await env.DB.batch(statements);
  } catch {
    return response({ error: "write_failed" }, 503);
  }
  return response({ accepted: true, installed: true, carrier_field_verified: false });
}
__name(reportInstall, "reportInstall");
async function issueTrialLink(env, owner, nodeId, nowMs = Date.now()) {
  if (!env.DB || !env.SUBSCRIPTION_CREDENTIAL_KEY || !/^[0-9]{1,20}$/.test(owner ?? "") || !ID2.test(nodeId)) return null;
  const base = env.SUBSCRIPTION_PUBLIC_ORIGIN;
  if (typeof base !== "string" || !/^https:\/\/[a-z0-9.-]+$/i.test(base)) return null;
  const job = await env.DB.prepare(
    "SELECT j.node_id FROM node_bootstrap_jobs j JOIN nodes n ON n.id=j.node_id WHERE j.node_id=? AND j.owner_id=? AND j.state='installed' AND n.lifecycle NOT IN ('quarantined','retired')"
  ).bind(nodeId, owner).first();
  if (!job) return null;
  const entropy = crypto.getRandomValues(new Uint8Array(32));
  const token = toBase64url(entropy);
  const digest2 = await tokenDigest2(token);
  await env.DB.prepare(
    "INSERT INTO node_trial_links(token_hash,node_id,owner_id,expires_ms) VALUES(?,?,?,?)"
  ).bind(digest2, nodeId, owner, nowMs + 36e5).run();
  return base + "/t/" + token;
}
__name(issueTrialLink, "issueTrialLink");
async function customerTrialToken(telegramId, issuedMs, keyText) {
  if (typeof keyText !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(keyText) || !/^[0-9]{1,20}$/.test(telegramId ?? "") || !Number.isSafeInteger(issuedMs) || issuedMs < 0) return null;
  let raw;
  try {
    const clean = keyText.replace(/-/g, "+").replace(/_/g, "/");
    raw = Uint8Array.from(atob(clean + "="), (x) => x.charCodeAt(0));
  } catch {
    return null;
  }
  if (raw.length !== 32) return null;
  const key = await crypto.subtle.importKey(
    "raw",
    raw,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode("madar-v2-customer-trial-v1:" + telegramId + ":" + issuedMs)
  );
  const token = toBase64url(new Uint8Array(signature));
  return TOKEN4.test(token) ? token : null;
}
__name(customerTrialToken, "customerTrialToken");
async function customerTrialResult(env, claim, nowMs) {
  if (!claim || claim.expires_ms <= nowMs) return { status: "used" };
  const token = await customerTrialToken(
    claim.telegram_id,
    claim.issued_ms,
    env.SUBSCRIPTION_CREDENTIAL_KEY
  );
  if (!token || await tokenDigest2(token) !== claim.token_hash) return { status: "used" };
  const stored = await env.DB.prepare(
    "SELECT token_hash FROM node_trial_links WHERE token_hash=? AND node_id=? AND owner_id=? AND expires_ms=?"
  ).bind(claim.token_hash, claim.node_id, claim.telegram_id, claim.expires_ms).first();
  if (!stored) return { status: "unavailable" };
  return {
    status: claim.issued_ms === nowMs ? "issued" : "existing",
    url: env.SUBSCRIPTION_PUBLIC_ORIGIN + "/t/" + token,
    expires_ms: claim.expires_ms
  };
}
__name(customerTrialResult, "customerTrialResult");
async function issueCustomerTrialLink(env, telegramId, nowMs = Date.now()) {
  if (!env.DB || !env.SUBSCRIPTION_CREDENTIAL_KEY || !/^[0-9]{1,20}$/.test(telegramId ?? "") || typeof env.SUBSCRIPTION_PUBLIC_ORIGIN !== "string" || !/^https:\/\/[a-z0-9.-]+$/i.test(env.SUBSCRIPTION_PUBLIC_ORIGIN))
    return { status: "unavailable" };
  const prior = await env.DB.prepare(
    "SELECT telegram_id,node_id,token_hash,issued_ms,expires_ms FROM customer_trial_claims WHERE telegram_id=?"
  ).bind(telegramId).first();
  if (prior) return customerTrialResult(env, prior, nowMs);
  const token = await customerTrialToken(telegramId, nowMs, env.SUBSCRIPTION_CREDENTIAL_KEY);
  if (!token) return { status: "unavailable" };
  const digest2 = await tokenDigest2(token), expiresMs = nowMs + 36e5;
  const subId = "trial-" + telegramId, trialQuota = 1073741824;
  const cred = await wrapClientUuid(crypto.randomUUID(), env.SUBSCRIPTION_CREDENTIAL_KEY);
  try {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT OR IGNORE INTO customer_trial_claims(telegram_id,node_id,token_hash,issued_ms,expires_ms) SELECT ?,n.id,?,?,? FROM nodes n JOIN node_bootstrap_jobs j ON j.node_id=n.id AND j.state='installed' JOIN node_trial_credentials tc ON tc.node_id=n.id AND tc.key_version=1 JOIN routes r ON r.node_id=n.id AND r.transport='reality' AND r.state='ready' JOIN route_carrier_variants m ON m.route_id=r.id AND m.operator='mci' AND m.published=1 JOIN route_carrier_variants i ON i.route_id=r.id AND i.operator='irancell' AND i.published=1 WHERE n.lifecycle='ready' AND r.verified_ms BETWEEN ? AND ? AND m.verified_ms BETWEEN ? AND ? AND i.verified_ms BETWEEN ? AND ? AND m.port<>i.port AND (SELECT COUNT(*) FROM route_carrier_variants v WHERE v.route_id=r.id)=2 AND EXISTS(SELECT 1 FROM customers c WHERE c.telegram_id=? AND c.state='active') AND n.user_limit>(SELECT COUNT(*) FROM node_allocations a WHERE a.node_id=n.id AND a.state IN ('reserved','active')) AND n.byte_limit-(SELECT COALESCE(SUM(a.quota_bytes),0) FROM node_allocations a WHERE a.node_id=n.id AND a.state IN ('reserved','active'))>=1073741824 ORDER BY (SELECT COUNT(*) FROM node_trial_links l WHERE l.node_id=n.id AND l.expires_ms>?) ASC,n.id LIMIT 1"
      ).bind(
        telegramId,
        digest2,
        nowMs,
        expiresMs,
        nowMs - 6e5,
        nowMs,
        nowMs - 6e5,
        nowMs,
        nowMs - 6e5,
        nowMs,
        telegramId,
        nowMs
      ),
      env.DB.prepare(
        "INSERT OR IGNORE INTO node_trial_links(token_hash,node_id,owner_id,expires_ms) SELECT token_hash,node_id,telegram_id,expires_ms FROM customer_trial_claims WHERE telegram_id=? AND token_hash=?"
      ).bind(telegramId, digest2),
      // A customer test gets its OWN UUID, server quota, and expiry. The
      // bootstrap admin test UUID is never issued to a public customer.
      env.DB.prepare(
        "INSERT OR IGNORE INTO subscriptions(id,owner_telegram_id,state,expires_at,max_bytes,used_bytes) SELECT ?,?,'active',?,?,0 FROM customer_trial_claims WHERE telegram_id=? AND token_hash=?"
      ).bind(subId, telegramId, expiresMs, trialQuota, telegramId, digest2),
      env.DB.prepare(
        "INSERT OR IGNORE INTO subscription_credentials(subscription_id,ciphertext_b64,nonce_b64,key_version) SELECT ?,?,?,1 WHERE EXISTS(SELECT 1 FROM customer_trial_claims WHERE telegram_id=? AND token_hash=?)"
      ).bind(subId, cred.ciphertext_b64, cred.nonce_b64, telegramId, digest2),
      env.DB.prepare(
        "INSERT OR IGNORE INTO node_allocations(id,node_id,subscription_id,quota_bytes,state) SELECT ?,c.node_id,?,?, 'active' FROM customer_trial_claims c WHERE c.telegram_id=? AND c.token_hash=?"
      ).bind("trial-alloc-" + telegramId, subId, trialQuota, telegramId, digest2)
    ]);
  } catch {
    return { status: "unavailable" };
  }
  const claim = await env.DB.prepare(
    "SELECT telegram_id,node_id,token_hash,issued_ms,expires_ms FROM customer_trial_claims WHERE telegram_id=?"
  ).bind(telegramId).first();
  return claim ? customerTrialResult(env, claim, nowMs) : { status: "unavailable" };
}
__name(issueCustomerTrialLink, "issueCustomerTrialLink");
async function getTrialFeed(req, env, nowMs = Date.now()) {
  if (req.method !== "GET" || !env.DB || !env.SUBSCRIPTION_CREDENTIAL_KEY)
    return response("Not ready", 503, "text/plain; charset=utf-8");
  const u = new URL(req.url), token = u.pathname.startsWith("/t/") ? u.pathname.slice(3) : "";
  if (u.search || u.hash || !TOKEN4.test(token))
    return response("Not found", 404, "text/plain; charset=utf-8");
  const h = await tokenDigest2(token);
  const customerClaim = await env.DB.prepare(
    "SELECT telegram_id,node_id FROM customer_trial_claims WHERE token_hash=?"
  ).bind(h).first();
  if (customerClaim) {
    const customer = await env.DB.prepare(
      "SELECT state FROM customers WHERE telegram_id=?"
    ).bind(customerClaim.telegram_id).first();
    if (customer?.state !== "active")
      return response("Expired", 403, "text/plain; charset=utf-8");
  }
  const trial = await env.DB.prepare(
    "SELECT l.node_id FROM node_trial_links l JOIN node_bootstrap_jobs j ON j.node_id=l.node_id JOIN nodes n ON n.id=l.node_id WHERE l.token_hash=? AND l.expires_ms>? AND j.state='installed' AND n.lifecycle NOT IN ('quarantined','retired')"
  ).bind(h, nowMs).first();
  if (!trial) return response("Expired", 403, "text/plain; charset=utf-8");
  if (customerClaim) {
    const ready = await env.DB.prepare(
      "SELECT r.id FROM nodes n JOIN routes r ON r.node_id=n.id AND r.transport='reality' JOIN route_carrier_variants m ON m.route_id=r.id AND m.operator='mci' AND m.published=1 JOIN route_carrier_variants i ON i.route_id=r.id AND i.operator='irancell' AND i.published=1 WHERE n.id=? AND n.lifecycle='ready' AND r.state='ready' AND r.verified_ms BETWEEN ? AND ? AND m.verified_ms BETWEEN ? AND ? AND i.verified_ms BETWEEN ? AND ? AND m.port<>i.port AND (SELECT COUNT(*) FROM route_carrier_variants v WHERE v.route_id=r.id)=2"
    ).bind(
      trial.node_id,
      nowMs - 6e5,
      nowMs,
      nowMs - 6e5,
      nowMs,
      nowMs - 6e5,
      nowMs
    ).first();
    if (!ready) return response("Not ready", 503, "text/plain; charset=utf-8");
  }
  if (customerClaim) {
    const subId = "trial-" + customerClaim.telegram_id;
    const account = await env.DB.prepare(
      "SELECT s.id,s.state,s.max_bytes,s.used_bytes,s.expires_at FROM subscriptions s JOIN node_allocations a ON a.subscription_id=s.id WHERE s.id=? AND a.node_id=? AND a.state='active'"
    ).bind(subId, trial.node_id).first();
    if (!account || account.state !== "active" || account.expires_at <= nowMs || account.max_bytes <= account.used_bytes)
      return response("Expired", 403, "text/plain; charset=utf-8");
    const secure = await env.DB.prepare(
      "SELECT ciphertext_b64,nonce_b64,key_version FROM subscription_credentials WHERE subscription_id=?"
    ).bind(subId).first();
    if (!secure || secure.key_version !== 1)
      return response("Not ready", 503, "text/plain; charset=utf-8");
    const routes2 = await activeRoutes(env.DB, subId, nowMs);
    if (routes2.length !== 2 || !routes2.some((x) => x.operator_hint === "mci" && x.port === 443) || !routes2.some((x) => x.operator_hint === "irancell" && x.port === 8443))
      return response("Not ready", 503, "text/plain; charset=utf-8");
    let uuid2;
    try {
      uuid2 = await unwrapClientUuid(secure, env.SUBSCRIPTION_CREDENTIAL_KEY);
    } catch {
      return response("Not ready", 503, "text/plain; charset=utf-8");
    }
    const snapshot2 = { client: { uuid: uuid2 }, routes: routes2.map((x) => ({
      id: trial.node_id + ":" + x.operator_hint,
      transport: "reality",
      operator_hint: x.operator_hint,
      endpoint: { host: x.host, port: x.port },
      tls: { server_name: x.server_name, reality_public_key: x.reality_public_key, short_id: x.reality_short_id }
    })) };
    const feed2 = base64Feed(snapshot2);
    return feed2 === null ? response("Not ready", 503, "text/plain; charset=utf-8") : response(feed2, 200, "text/plain; charset=utf-8");
  }
  const c = await env.DB.prepare(
    "SELECT ciphertext_b64,nonce_b64,key_version FROM node_trial_credentials WHERE node_id=?"
  ).bind(trial.node_id).first();
  if (!c || c.key_version !== 1) return response("Not ready", 503, "text/plain; charset=utf-8");
  const routes = (await env.DB.prepare(
    "SELECT operator,host,port,server_name,reality_public_key,reality_short_id FROM route_carrier_variants WHERE route_id=? " + (customerClaim ? "AND published=1 AND verified_ms BETWEEN ? AND ? " : "") + "ORDER BY operator"
  ).bind(...customerClaim ? [trial.node_id + "_reality", nowMs - 6e5, nowMs] : [trial.node_id + "_reality"]).all()).results ?? [];
  const uuid = await unwrapClientUuid(c, env.SUBSCRIPTION_CREDENTIAL_KEY);
  const snapshot = { client: { uuid }, routes: routes.map((x) => ({
    id: trial.node_id + ":" + x.operator,
    transport: "reality",
    operator_hint: x.operator,
    endpoint: { host: x.host, port: x.port },
    tls: { server_name: x.server_name, reality_public_key: x.reality_public_key, short_id: x.reality_short_id }
  })) };
  const feed = base64Feed(snapshot);
  return feed === null ? response("Not ready", 503, "text/plain; charset=utf-8") : response(feed, 200, "text/plain; charset=utf-8");
}
__name(getTrialFeed, "getTrialFeed");

// src/node-control.mjs
var NODE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$/;
var HEX32 = /^[a-f0-9]{32}$/;
var HEX64 = /^[a-f0-9]{64}$/;
var HEADER = "x-madar-node-";
var encoder = new TextEncoder();
var toHex = /* @__PURE__ */ __name((bytes) => Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join(""), "toHex");
var fromBase64Url = /* @__PURE__ */ __name((x) => {
  if (typeof x !== "string" || !/^[A-Za-z0-9_-]+$/.test(x)) throw new Error("invalid_key");
  const normal = x.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(normal + "=".repeat((4 - normal.length % 4) % 4)), (c) => c.charCodeAt(0));
}, "fromBase64Url");
var base64Url = /* @__PURE__ */ __name((bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""), "base64Url");
var digest = /* @__PURE__ */ __name(async (bytes) => new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), "digest");
var safeJson = /* @__PURE__ */ __name((body3, status = 200) => new Response(JSON.stringify(body3), {
  status,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  }
}), "safeJson");
function canonical(value) {
  if (value === null || typeof value === "number" || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (!value || typeof value !== "object") throw new TypeError("unsupported canonical type");
  return "{" + Object.keys(value).sort().map((k) => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}";
}
__name(canonical, "canonical");
async function deriveNodeKey(masterText, nodeId) {
  if (!NODE_RE.test(nodeId ?? "")) throw new Error("invalid_node_id");
  const raw = fromBase64Url(masterText);
  if (raw.byteLength !== 32) throw new Error("invalid_master_length");
  const master = await crypto.subtle.importKey("raw", raw, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({
    name: "HKDF",
    hash: "SHA-256",
    salt: encoder.encode("madar-v2/node-hkdf/v1"),
    info: encoder.encode("madar-v2/node/v1:" + nodeId)
  }, master, 256));
}
__name(deriveNodeKey, "deriveNodeKey");
async function hmac(key, value) {
  const obj = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", obj, encoder.encode(value)));
}
__name(hmac, "hmac");
async function sameMac(expected, signature) {
  if (typeof signature !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(signature)) return false;
  const actual = fromBase64Url(signature);
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected[i] ^ actual[i];
  return diff === 0;
}
__name(sameMac, "sameMac");
async function authenticatedNode(request, env, nowMs = Date.now()) {
  if (!env.DB || !env.NODE_MASTER_KEY) return { error: safeJson({ error: "not_configured" }, 503) };
  const url = new URL(request.url);
  if (url.search) return { error: safeJson({ error: "unauthorized" }, 401) };
  const id = request.headers.get(HEADER + "id") ?? "";
  const nonce = request.headers.get(HEADER + "nonce") ?? "";
  const timestamp = request.headers.get(HEADER + "timestamp") ?? "";
  const signature = request.headers.get(HEADER + "signature") ?? "";
  const sec = Number(timestamp);
  if (!NODE_RE.test(id) || !HEX32.test(nonce) || !/^[0-9]{10}$/.test(timestamp) || !Number.isSafeInteger(sec) || Math.abs(nowMs - sec * 1e3) > 9e4)
    return { error: safeJson({ error: "unauthorized" }, 401) };
  const raw = await request.arrayBuffer();
  if (raw.byteLength > 4096) return { error: safeJson({ error: "too_large" }, 413) };
  const key = await deriveNodeKey(env.NODE_MASTER_KEY, id);
  const expected = await hmac(key, [
    request.method,
    url.pathname,
    timestamp,
    nonce,
    toHex(await digest(raw))
  ].join("\n"));
  if (!await sameMac(expected, signature))
    return { error: safeJson({ error: "unauthorized" }, 401) };
  const node = await env.DB.prepare(
    "SELECT id,lifecycle,desired_revision,acked_revision,user_limit,byte_limit FROM nodes WHERE id=?"
  ).bind(id).first();
  if (!node || node.lifecycle === "retired" || node.lifecycle === "quarantined")
    return { error: safeJson({ error: "unauthorized" }, 401) };
  const saved = await env.DB.prepare(
    "INSERT OR IGNORE INTO node_nonces(node_id,nonce,created_ms) VALUES(?,?,?)"
  ).bind(id, nonce, nowMs).run();
  if (saved.meta?.changes !== 1) return { error: safeJson({ error: "replay" }, 409) };
  return { id, key, node, raw };
}
__name(authenticatedNode, "authenticatedNode");
function nonceHex() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return toHex(b);
}
__name(nonceHex, "nonceHex");
async function manifest(env, identity, nowMs) {
  const { id, key, node } = identity;
  const rows = (await env.DB.prepare(
    "SELECT id,transport,listen_port,tls_hostname,ws_path FROM routes WHERE node_id=? AND state IN ('draft','checking','ready') ORDER BY id LIMIT 8"
  ).bind(id).all()).results ?? [];
  const routes = [];
  for (const r of rows) {
    if (!Number.isInteger(r.listen_port) || r.listen_port < 1 || r.listen_port > 65535)
      continue;
    const route = { id: r.id, transport: r.transport, listen_port: r.listen_port };
    if (r.transport === "wss") {
      if (!r.tls_hostname || !r.ws_path) continue;
      route.tls_hostname = r.tls_hostname;
      route.ws_path = r.ws_path;
    }
    routes.push(route);
  }
  if (!routes.length) return safeJson({ error: "no_desired_routes" }, 409);
  const issued = Math.floor(nowMs / 1e3);
  const payload = {
    node_id: id,
    revision: node.desired_revision,
    issued_at: issued,
    expires_at: issued + 300,
    nonce: nonceHex(),
    routes,
    user_limit: node.user_limit,
    byte_limit: node.byte_limit
  };
  const signature = base64Url(await hmac(key, canonical(payload)));
  return safeJson({ payload, signature, status: "provisioning_not_connected" });
}
__name(manifest, "manifest");
async function ack(env, identity, nowMs) {
  let data;
  try {
    data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(identity.raw));
  } catch {
    return safeJson({ error: "bad_request" }, 400);
  }
  const revision = data?.revision, code = data?.status, hash = data?.digest;
  if (!Number.isSafeInteger(revision) || revision < 1 || !["accepted", "rejected"].includes(code) || typeof hash !== "string" || !HEX64.test(hash))
    return safeJson({ error: "bad_request" }, 400);
  if (revision !== identity.node.desired_revision) return safeJson({ error: "stale_revision" }, 409);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO node_acks(node_id,revision,digest,status,observed_ms) VALUES(?,?,?,?,?) ON CONFLICT(node_id,revision,digest) DO UPDATE SET status=excluded.status,observed_ms=excluded.observed_ms WHERE excluded.observed_ms>=node_acks.observed_ms"
    ).bind(identity.id, revision, hash, code, nowMs),
    env.DB.prepare(
      "UPDATE nodes SET acked_revision=? WHERE id=? AND desired_revision=? AND acked_revision<? AND ?=?"
    ).bind(revision, identity.id, revision, revision, code, "accepted")
  ]);
  let promoted = { ready: false };
  if (code === "accepted") {
    try {
      promoted = await promoteAdminPair(env, identity.id, nowMs);
    } catch {
      promoted = { ready: false };
    }
  }
  return safeJson({ ok: true, route_ready: promoted.ready });
}
__name(ack, "ack");
async function clientManifest(env, identity, nowMs) {
  if (!env.SUBSCRIPTION_CREDENTIAL_KEY) return safeJson({ error: "not_configured" }, 503);
  const rows = (await env.DB.prepare(
    "SELECT s.id,s.state,s.expires_at,s.max_bytes,s.used_bytes,c.ciphertext_b64,c.nonce_b64,c.key_version FROM node_allocations a JOIN subscriptions s ON s.id=a.subscription_id JOIN subscription_credentials c ON c.subscription_id=s.id JOIN customers u ON u.telegram_id=s.owner_telegram_id WHERE a.node_id=? AND a.state IN ('reserved','active') AND s.state IN ('pending','active') AND u.state='active' AND s.max_bytes>s.used_bytes AND (s.state='pending' OR s.expires_at>?) ORDER BY s.id LIMIT 1001"
  ).bind(identity.id, nowMs).all()).results ?? [];
  if (rows.length > 1e3 || rows.length > identity.node.user_limit)
    return safeJson({ error: "capacity_exceeded" }, 409);
  const clients = [];
  try {
    for (const row of rows) {
      if (row.key_version !== 1) return safeJson({ error: "credential_unavailable" }, 503);
      const uuid = await unwrapClientUuid(row, env.SUBSCRIPTION_CREDENTIAL_KEY);
      clients.push({
        subscription_id: row.id,
        uuid,
        expires_at: row.state === "pending" ? nowMs + 12e4 : row.expires_at,
        quota_bytes: row.max_bytes,
        used_bytes: row.used_bytes,
        remaining_bytes: row.max_bytes - row.used_bytes
      });
    }
  } catch {
    return safeJson({ error: "credential_unavailable" }, 503);
  }
  const issued = Math.floor(nowMs / 1e3);
  const payload = {
    node_id: identity.id,
    revision: identity.node.desired_revision,
    issued_at: issued,
    expires_at: issued + 120,
    mode: identity.node.lifecycle === "ready" ? "commercial" : "test",
    clients
  };
  const signature = base64Url(await hmac(identity.key, canonical(payload)));
  return safeJson({ payload, signature, applied: false });
}
__name(clientManifest, "clientManifest");
async function clientAck(env, identity, nowMs) {
  if (!env.SUBSCRIPTION_CREDENTIAL_KEY) return safeJson({ error: "not_configured" }, 503);
  let b;
  try {
    b = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(identity.raw));
  } catch {
    return safeJson({ error: "bad_request" }, 400);
  }
  const members = b?.clients;
  if (!Number.isSafeInteger(b?.revision) || b.revision !== identity.node.desired_revision || b.revision !== identity.node.acked_revision || identity.node.lifecycle !== "ready" || b.xray_healthy !== true || !Array.isArray(b.ports) || b.ports.length !== 2 || b.ports[0] !== 443 || b.ports[1] !== 8443 || !Array.isArray(members) || members.length < 1 || members.length > 100 || new Set(members.map((x) => x?.subscription_id)).size !== members.length)
    return safeJson({ error: "not_ready" }, 409);
  const commands = [];
  for (const member of members) {
    if (typeof member?.subscription_id !== "string" || member.subscription_id.length > 80 || !HEX64.test(member?.uuid_sha256 ?? ""))
      return safeJson({ error: "bad_request" }, 400);
    const row = await env.DB.prepare(
      "SELECT c.ciphertext_b64,c.nonce_b64,c.key_version,s.state,s.order_id,s.expires_at,o.state AS order_state,p.duration_days,s.owner_telegram_id FROM node_allocations a JOIN subscriptions s ON s.id=a.subscription_id JOIN subscription_credentials c ON c.subscription_id=s.id JOIN customers u ON u.telegram_id=s.owner_telegram_id LEFT JOIN orders o ON o.id=s.order_id LEFT JOIN plans p ON p.id=o.plan_id WHERE a.node_id=? AND a.subscription_id=? AND a.state IN ('reserved','active') AND s.state IN ('pending','active') AND u.state='active' AND s.max_bytes>s.used_bytes AND (s.state='pending' OR s.expires_at>?)"
    ).bind(identity.id, member.subscription_id, nowMs).first();
    if (!row || row.key_version !== 1) return safeJson({ error: "not_allocated" }, 409);
    let uuid;
    try {
      uuid = await unwrapClientUuid(row, env.SUBSCRIPTION_CREDENTIAL_KEY);
    } catch {
      return safeJson({ error: "credential_unavailable" }, 503);
    }
    const current = toHex(await digest(encoder.encode(uuid)));
    if (!sameMacHex(current, member.uuid_sha256))
      return safeJson({ error: "credential_mismatch" }, 409);
    if (row.state === "pending") {
      if (row.order_state !== "provisioning" || !Number.isSafeInteger(row.duration_days) || row.duration_days < 1 || row.duration_days > 366) return safeJson({ error: "order_not_ready" }, 409);
      const expires = nowMs + row.duration_days * 864e5;
      commands.push(env.DB.prepare(
        "UPDATE node_allocations SET state='active' WHERE node_id=? AND subscription_id=? AND state='reserved'"
      ).bind(identity.id, member.subscription_id));
      commands.push(env.DB.prepare(
        "UPDATE subscriptions SET state='active',expires_at=? WHERE id=? AND state='pending' AND order_id=?"
      ).bind(expires, member.subscription_id, row.order_id));
      commands.push(env.DB.prepare(
        "UPDATE orders SET state='fulfilled',updated_at=CURRENT_TIMESTAMP WHERE id=? AND state='provisioning'"
      ).bind(row.order_id));
      commands.push(env.DB.prepare(
        "INSERT OR IGNORE INTO telegram_notifications(id,chat_id,body,state,due_ms) VALUES(?,?,?,'pending',?)"
      ).bind(
        "client-active:" + member.subscription_id,
        row.owner_telegram_id,
        "\u2705 \u0627\u0634\u062A\u0631\u0627\u06A9 \u0645\u062F\u0627\u0631 \u0641\u0639\u0627\u0644 \u0634\u062F. \u06A9\u0627\u0646\u0641\u06CC\u06AF \u0631\u0627 \u0627\u0632 \u0628\u062E\u0634 \xAB\u0627\u0634\u062A\u0631\u0627\u06A9\u200C\u0647\u0627\u06CC \u0645\u0646\xBB \u062F\u0631\u06CC\u0627\u0641\u062A \u06A9\u0646\u06CC\u062F.",
        nowMs
      ));
    }
    commands.push(env.DB.prepare(
      "INSERT INTO node_client_acks(node_id,subscription_id,revision,credential_sha256,observed_ms) VALUES(?,?,?,?,?) ON CONFLICT(node_id,subscription_id) DO UPDATE SET revision=excluded.revision,credential_sha256=excluded.credential_sha256,observed_ms=excluded.observed_ms"
    ).bind(identity.id, member.subscription_id, b.revision, current, nowMs));
  }
  await env.DB.batch(commands);
  return safeJson({ ok: true, applied: members.length });
}
__name(clientAck, "clientAck");
function sameMacHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
__name(sameMacHex, "sameMacHex");
async function nodeRoute(request, env, nowMs = Date.now()) {
  const path = new URL(request.url).pathname;
  if (path === "/api/node/v1/manifest" && request.method === "GET") {
    const auth = await authenticatedNode(request, env, nowMs);
    return auth.error ?? manifest(env, auth, nowMs);
  }
  if (path === "/api/node/v1/ack" && request.method === "POST") {
    const auth = await authenticatedNode(request, env, nowMs);
    return auth.error ?? ack(env, auth, nowMs);
  }
  if (path === "/api/node/v1/clients" && request.method === "GET") {
    const auth = await authenticatedNode(request, env, nowMs);
    return auth.error ?? clientManifest(env, auth, nowMs);
  }
  if (path === "/api/node/v1/clients/ack" && request.method === "POST") {
    const auth = await authenticatedNode(request, env, nowMs);
    return auth.error ?? clientAck(env, auth, nowMs);
  }
  return safeJson({ error: "not_found" }, 404);
}
__name(nodeRoute, "nodeRoute");

// src/telegram.mjs
async function verifyTelegramSecret(provided, expected) {
  if (typeof provided !== "string" || typeof expected !== "string" || !expected) return false;
  const digest2 = /* @__PURE__ */ __name(async (s) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))), "digest");
  const [a, b] = await Promise.all([digest2(provided), digest2(expected)]);
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a[i] ^ b[i];
  return mismatch === 0;
}
__name(verifyTelegramSecret, "verifyTelegramSecret");
function toBotMessage(update) {
  if (!Number.isSafeInteger(update?.update_id) || update.update_id < 0) return null;
  const event = update.message ?? update.callback_query?.message;
  const chatId = event?.chat?.id;
  const sender = update.message?.from ?? update.callback_query?.from;
  if (event?.chat?.type !== "private" || !Number.isSafeInteger(chatId) || !Number.isSafeInteger(sender?.id) || sender.id !== chatId || sender.is_bot === true) return null;
  const callback = update.callback_query?.data;
  const isCallback = callback !== void 0;
  const raw = isCallback ? callback : update.message?.text ?? "";
  if (typeof raw !== "string" || raw.length > (isCallback ? 256 : 2e3)) return null;
  const key = isCallback && raw.startsWith("v2:") ? raw.slice(3) : !isCallback && raw.trim().startsWith("/") ? raw.trim().split(/\s+/)[0].split("@")[0] : "text";
  const locale = "fa";
  const photos = update.message?.photo;
  const lastPhoto = Array.isArray(photos) ? photos.at(-1) : null;
  const document = update.message?.document;
  const photoId = typeof lastPhoto?.file_id === "string" ? lastPhoto.file_id : /^image\/(jpeg|png|webp)$/.test(document?.mime_type ?? "") && typeof document.file_id === "string" ? document.file_id : null;
  const messageId = isCallback && Number.isSafeInteger(event?.message_id) && event.message_id > 0 ? event.message_id : null;
  const editKind = messageId ? Array.isArray(event?.photo) && event.photo.length > 0 ? "caption" : "text" : null;
  const initialPage = key === "/start" ? "home" : key.startsWith("/") ? key.slice(1) : key;
  const page = botPage(initialPage || "unknown", locale);
  return {
    updateId: update.update_id,
    actorId: String(sender.id),
    chatId: String(chatId),
    key,
    locale,
    inputText: typeof (update.message?.text ?? update.message?.caption) === "string" ? (update.message.text ?? update.message.caption).slice(0, 2e3) : null,
    photoId: photoId && photoId.length >= 5 && photoId.length <= 512 ? photoId : null,
    callbackId: typeof update.callback_query?.id === "string" ? update.callback_query.id.slice(0, 128) : null,
    messageId,
    editKind,
    sourcePhotoId: typeof event?.photo?.at(-1)?.file_id === "string" && event.photo.at(-1).file_id.length <= 512 ? event.photo.at(-1).file_id : null,
    // Compatibility with early V2 preview tests, before inbox processing:
    text: page.text,
    replyMarkup: page.replyMarkup
  };
}
__name(toBotMessage, "toBotMessage");

// src/node-reset.mjs
var RE = /^[A-Za-z][A-Za-z0-9_-]{2,63}$/;
async function count(db, sql, ...args) {
  const r = await db.prepare(sql).bind(...args).first();
  return Number(r?.n ?? 0);
}
__name(count, "count");
async function resetEligibility(db, owner, nodeId, nowMs) {
  if (!RE.test(nodeId ?? "")) return { ok: false, code: "INVALID_TARGET" };
  const node = await db.prepare(
    "SELECT n.id,n.lifecycle,n.desired_revision,j.ip,j.owner_id FROM nodes n JOIN node_bootstrap_jobs j ON j.node_id=n.id AND j.state='installed' WHERE n.id=? AND j.owner_id=? LIMIT 1"
  ).bind(nodeId, owner).first();
  if (!node || !["ready", "provisioning", "degraded", "quarantined"].includes(node.lifecycle))
    return { ok: false, code: "NODE_NOT_INSTALLED" };
  const [used, active, installed, claims, liveTrial, unsafeOrders, pending] = await Promise.all([
    count(db, "SELECT COUNT(*) n FROM node_allocations a JOIN subscriptions s ON s.id=a.subscription_id WHERE a.node_id=? AND (s.used_bytes<>0 OR s.state IN ('active','suspended') OR a.state='active')", nodeId),
    count(db, "SELECT COUNT(*) n FROM node_usage_reports WHERE node_id=?", nodeId),
    count(db, "SELECT COUNT(*) n FROM node_client_acks WHERE node_id=?", nodeId),
    count(db, "SELECT COUNT(*) n FROM customer_trial_claims WHERE node_id=?", nodeId),
    count(db, "SELECT COUNT(*) n FROM node_trial_links WHERE node_id=? AND expires_ms>?", nodeId, nowMs),
    count(db, "SELECT COUNT(*) n FROM node_allocations a JOIN subscriptions s ON s.id=a.subscription_id LEFT JOIN orders o ON o.id=s.order_id WHERE a.node_id=? AND (s.state NOT IN ('pending','revoked','expired') OR (s.state='pending' AND (o.quoted_amount>0 OR o.state='receipt_submitted' OR EXISTS(SELECT 1 FROM receipts r WHERE r.order_id=o.id AND r.state='accepted'))))", nodeId),
    count(db, "SELECT COUNT(*) n FROM node_allocations a JOIN subscriptions s ON s.id=a.subscription_id WHERE a.node_id=? AND s.state='pending' AND a.state='reserved'", nodeId)
  ]);
  if (used || active || installed || claims || unsafeOrders)
    return { ok: false, code: "NODE_HAS_ACTIVE_OR_USED_ACCOUNTS" };
  if (liveTrial) return { ok: false, code: "NODE_HAS_LIVE_TRIAL" };
  const issues = await count(
    db,
    "SELECT COUNT(*) n FROM admin_direct_issues i JOIN orders o ON o.id=i.order_id WHERE i.node_id=? AND (o.quoted_amount<>0 OR o.state='receipt_submitted')",
    nodeId
  );
  if (issues) return { ok: false, code: "NODE_HAS_PAID_ORDERS" };
  return { ok: true, node, willCancelPending: pending, code: "RESET_ALLOWED" };
}
__name(resetEligibility, "resetEligibility");
async function retireCleanedNode(db, owner, nodeId, jobId, nowMs, completion) {
  const gate = await resetEligibility(db, owner, nodeId, nowMs);
  if (!gate.ok || gate.node.lifecycle !== "quarantined")
    return false;
  const rows = [
    db.prepare("UPDATE orders SET state='cancelled',updated_at=CURRENT_TIMESTAMP WHERE state IN ('approved','provisioning') AND id IN (SELECT s.order_id FROM subscriptions s JOIN node_allocations a ON a.subscription_id=s.id WHERE a.node_id=? AND s.state='pending')").bind(nodeId),
    db.prepare("UPDATE subscription_tokens SET revoked=1 WHERE subscription_id IN (SELECT s.id FROM subscriptions s JOIN node_allocations a ON a.subscription_id=s.id WHERE a.node_id=? AND s.state='pending')").bind(nodeId),
    db.prepare("UPDATE subscriptions SET state='revoked' WHERE state='pending' AND id IN (SELECT subscription_id FROM node_allocations WHERE node_id=? AND state='reserved')").bind(nodeId),
    db.prepare("UPDATE node_allocations SET state='released' WHERE node_id=? AND state='reserved' AND subscription_id IN (SELECT id FROM subscriptions WHERE state='revoked')").bind(nodeId),
    db.prepare("UPDATE routes SET state='quarantined' WHERE node_id=?").bind(nodeId),
    db.prepare("UPDATE route_carrier_variants SET published=0 WHERE route_id IN (SELECT id FROM routes WHERE node_id=?)").bind(nodeId),
    db.prepare("UPDATE node_trial_links SET expires_ms=? WHERE node_id=? AND expires_ms>?").bind(nowMs, nodeId, nowMs),
    db.prepare("UPDATE nodes SET lifecycle='retired' WHERE id=? AND lifecycle='quarantined'").bind(nodeId),
    db.prepare("INSERT OR IGNORE INTO audit_events(event_id,actor_id,object_type,object_id,verb) VALUES(?,?, 'node',?,'v2-owner-remote-reset-complete')").bind("v2reset:" + jobId, owner, nodeId)
  ];
  if (!completion) return false;
  rows.push(completion);
  try {
    const result = await db.batch(rows);
    return Number(result.at(-1)?.meta?.changes) === 1;
  } catch {
    return false;
  }
}
__name(retireCleanedNode, "retireCleanedNode");

// src/runner-enrollment.mjs
var GITHUB_RUNNER_ID = "v2-github-actions";
var JOB_ID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
function githubExecutorReady(env) {
  if (env.V2_EXECUTOR_BACKEND !== "github-actions" || typeof env.GITHUB_ACTIONS_DISPATCH_TOKEN !== "string" || env.GITHUB_ACTIONS_DISPATCH_TOKEN.length < 20 || typeof env.RUNNER_SERVICE_SECRET !== "string" || env.RUNNER_SERVICE_SECRET.length < 32) return false;
  try {
    const key = JSON.parse(env.RUNNER_PUBLIC_KEY);
    return key?.kid === "madar-v2-github-actions" && key?.kty === "RSA" && key?.alg === "RSA-OAEP-256" && key?.e === "AQAB" && typeof key?.n === "string" && key.n.length >= 340;
  } catch {
    return false;
  }
}
__name(githubExecutorReady, "githubExecutorReady");
async function dispatchGithubJob(env, jobId, send = fetch) {
  if (!githubExecutorReady(env) || !JOB_ID.test(jobId)) return false;
  try {
    const r = await send("https://api.github.com/repos/alireza-anari/madar-vpn/actions/workflows/v2-on-demand-executor.yml/dispatches", {
      method: "POST",
      headers: {
        "authorization": "Bearer " + env.GITHUB_ACTIONS_DISPATCH_TOKEN,
        "accept": "application/vnd.github+json",
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "madar-v2-staging"
      },
      body: JSON.stringify({ ref: "rewrite/madar-v2-20261110", inputs: { job_id: jobId } }),
      signal: AbortSignal.timeout(1e4)
    });
    return r.status === 204;
  } catch {
    return false;
  }
}
__name(dispatchGithubJob, "dispatchGithubJob");
async function executorReady(env, now) {
  if (env.V2_EXECUTOR_BACKEND === "github-actions") return githubExecutorReady(env);
  if (env.V2_EXECUTOR_BACKEND !== "resident") return false;
  const presence = await env.DB.prepare("SELECT MAX(last_seen_ms) AS seen FROM v2_runner_presence WHERE id='existing-host-v2'").first();
  return !!presence?.seen && presence.seen >= now - 6e4;
}
__name(executorReady, "executorReady");
var enc = new TextEncoder();
var hex2 = /* @__PURE__ */ __name((bytes) => Array.from(new Uint8Array(bytes), (x) => x.toString(16).padStart(2, "0")).join(""), "hex");
async function hmac2(key, value) {
  const k = await crypto.subtle.importKey("raw", typeof key === "string" ? enc.encode(key) : key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(value)));
}
__name(hmac2, "hmac");
async function authenticateOwner(raw, env, nowMs = Date.now()) {
  if (typeof raw !== "string" || raw.length > 8192 || !env.BOT_TOKEN) return null;
  try {
    const p = new URLSearchParams(raw);
    if ([...p.keys()].some((k, i, a) => a.indexOf(k) !== i)) return null;
    const hash = p.get("hash");
    p.delete("hash");
    const date = Number(p.get("auth_date")), now = Math.floor(nowMs / 1e3);
    if (!Number.isSafeInteger(date) || date > now + 30 || date < now - 600 || !/^\d+$/.test(p.get("auth_date") ?? "")) return null;
    const text = [...p].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => k + "=" + v).join("\n");
    const expected = hex2(await hmac2(await hmac2("WebAppData", env.BOT_TOKEN), text));
    if (!/^[a-f0-9]{64}$/.test(hash ?? "") || !await verifyTelegramSecret(hash, expected)) return null;
    const user = JSON.parse(p.get("user"));
    if (!Number.isSafeInteger(user.id) || user.id < 1 || user.is_bot) return null;
    const id = String(user.id);
    return (env.ADMIN_TELEGRAM_IDS ?? "").split(",").map((x) => x.trim()).includes(id) ? id : null;
  } catch {
    return null;
  }
}
__name(authenticateOwner, "authenticateOwner");
function validateConnection(b) {
  if (!b || !/^[A-Za-z][A-Za-z0-9_-]{2,63}$/.test(b.nodeId ?? "") || /^(?:prod(?:uction)?(?:[-_0-9]|$)|main(?:[-_0-9]|$)|node1$|madar-v2-node1$)/i.test(b.nodeId) || !/^[A-Za-z0-9_.-]{2,64}$/.test(b.provider ?? "") || !/^[A-Za-z0-9_-]{2,64}$/.test(b.region ?? "") || !publicV4(b.ip) || !Number.isInteger(b.port) || b.port < 1 || b.port > 65535 || !/^[a-z_][a-z0-9_-]{0,31}$/.test(b.username ?? "") || !Number.isInteger(b.userLimit) || b.userLimit < 1 || b.userLimit > 1e5 || !Number.isInteger(b.capacityGb) || b.capacityGb < 1 || b.capacityGb > 2e5) return null;
  return {
    nodeId: b.nodeId,
    provider: b.provider,
    region: b.region,
    ip: b.ip,
    port: b.port,
    username: b.username,
    userLimit: b.userLimit,
    capacityGb: b.capacityGb,
    mode: "fresh"
  };
}
__name(validateConnection, "validateConnection");
function validEnvelope(b) {
  const base64 = /* @__PURE__ */ __name((s) => typeof s === "string" && /^[A-Za-z0-9+/]+={0,2}$/.test(s) && s.length % 4 === 0, "base64");
  return !!b && Object.keys(b).sort().join(",") === "data,iv,key,v" && b.v === 1 && base64(b.key) && b.key.length >= 344 && b.key.length <= 1024 && base64(b.iv) && b.iv.length === 16 && base64(b.data) && b.data.length >= 24 && b.data.length <= 18e3;
}
__name(validEnvelope, "validEnvelope");
var toBase64 = /* @__PURE__ */ __name((b) => btoa(String.fromCharCode(...new Uint8Array(b))), "toBase64");
async function makeResidentPairing(publicJwk, serviceSecret) {
  if (!publicJwk || publicJwk.kty !== "RSA" || publicJwk.alg !== "RSA-OAEP-256" || publicJwk.e !== "AQAB" || typeof publicJwk.n !== "string" || publicJwk.n.length < 340 || typeof serviceSecret !== "string" || serviceSecret.length < 32)
    throw Error("INVALID_PAIRING_CONFIG");
  const rsa = await crypto.subtle.importKey(
    "jwk",
    publicJwk,
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["encrypt"]
  );
  const aes = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
  const key = await crypto.subtle.exportKey("raw", aes);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const config = {
    baseUrl: "https://madar-v2-staging.alirezaanari117.workers.dev",
    runnerId: "existing-host-v2",
    serviceSecret,
    privateKeyPath: "/etc/madar-v2-runner/runner-private.pem"
  };
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aes, enc.encode(JSON.stringify(config)));
  const encryptedKey = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, rsa, key);
  return { v: 1, key: toBase64(encryptedKey), iv: toBase64(iv), data: toBase64(data) };
}
__name(makeResidentPairing, "makeResidentPairing");
var reply = /* @__PURE__ */ __name((data, status = 200) => new Response(JSON.stringify(data), { status, headers: {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer"
} }), "reply");
async function body(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers.get("content-type") ?? "")) throw Error("BAD_BODY");
  const reader = req.body?.getReader();
  if (!reader) throw Error("BAD_BODY");
  let bytes = 0, text = "";
  const decoder = new TextDecoder();
  try {
    for (; ; ) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > 24e3) {
        await reader.cancel();
        throw Error("BODY_LIMIT");
      }
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally {
    reader.releaseLock();
  }
}
__name(body, "body");
async function cleanupRunnerJobs(db, now) {
  await db.prepare("UPDATE v2_runner_jobs SET state='failed',safe_code='EXPIRED',encrypted_credentials=NULL WHERE state IN ('queued','leased') AND (expires_ms<=? OR (state='leased' AND lease_until_ms<=?))").bind(now, now).run();
}
__name(cleanupRunnerJobs, "cleanupRunnerJobs");
async function installedProbe(db, actor, probe) {
  if (!probe?.fingerprint) return false;
  const spec = JSON.parse(probe.spec_json);
  const match = await db.prepare(
    "SELECT 1 AS matched FROM node_bootstrap_jobs b JOIN v2_runner_jobs j ON j.id=b.id WHERE b.node_id=? AND b.ip=? AND b.owner_id=? AND b.state='installed' AND j.owner_id=? AND j.kind='v2-install' AND j.state='ready' AND j.fingerprint=? AND json_extract(j.spec_json,'$.port')=? LIMIT 1"
  ).bind(spec.nodeId, spec.ip, actor, actor, probe.fingerprint, spec.port).first();
  return !!match;
}
__name(installedProbe, "installedProbe");
async function enrollmentApi(req, env, now = Date.now(), dispatch = dispatchGithubJob) {
  if (!env.DB || env.RUNNER_ENROLLMENT_ENABLED !== "true") return reply({ error: "RUNNER_NOT_CONFIGURED" }, 503);
  const actor = await authenticateOwner(req.headers.get("x-telegram-init-data"), env, now);
  if (!actor) return reply({ error: "AUTH_EXPIRED" }, 401);
  const path = new URL(req.url).pathname;
  await cleanupRunnerJobs(env.DB, now);
  if (path === "/api/enrollment/session" && req.method === "GET") {
    let publicKey;
    try {
      publicKey = JSON.parse(env.RUNNER_PUBLIC_KEY);
    } catch {
    }
    if (!publicKey || !env.RUNNER_SERVICE_SECRET || !await executorReady(env, now))
      return reply({ error: env.V2_EXECUTOR_BACKEND === "github-actions" ? "EXECUTOR_NOT_CONFIGURED" : "RUNNER_OFFLINE" }, 503);
    return reply({ publicKey });
  }
  if (path === "/api/enrollment/reset-check" && req.method === "GET") {
    const requested = new URL(req.url).searchParams.get("nodeId");
    const eligible = await resetEligibility(env.DB, actor, requested, now);
    return reply({
      ok: eligible.ok,
      code: eligible.code,
      willCancelPending: eligible.ok ? eligible.willCancelPending : 0
    });
  }
  if (path === "/api/enrollment/recent" && req.method === "GET") {
    const job = await env.DB.prepare(
      "SELECT id,kind,state,safe_code,fingerprint,spec_json,expires_ms FROM v2_runner_jobs WHERE owner_id=? ORDER BY created_ms DESC LIMIT 1"
    ).bind(actor).first();
    if (!job) return reply({ job: null, failedInstall: null });
    const spec = JSON.parse(job.spec_json);
    const failed = await env.DB.prepare(
      "SELECT j.id,j.fingerprint,j.safe_code,j.created_ms FROM v2_runner_jobs j JOIN nodes n ON n.id=json_extract(j.spec_json,'$.nodeId') JOIN node_bootstrap_jobs bj ON bj.id=j.id AND bj.node_id=n.id WHERE j.owner_id=? AND j.kind='v2-install' AND j.state='failed' AND n.lifecycle='enrolling' AND bj.state='failed' AND json_extract(j.spec_json,'$.nodeId')=? ORDER BY j.created_ms DESC LIMIT 1"
    ).bind(actor, spec.nodeId).first();
    const failedInstall = failed && failed.created_ms >= now - 864e5 ? { id: failed.id, fingerprint: failed.fingerprint, safe_code: failed.safe_code } : null;
    return reply({ failedInstall, job: {
      id: job.id,
      kind: job.kind,
      state: job.state,
      safe_code: job.safe_code,
      fingerprint: job.fingerprint,
      expires_ms: job.expires_ms,
      diagnostic: spec.diagnostic === true,
      cleanup: spec.cleanup === true,
      spec: {
        nodeId: spec.nodeId,
        provider: spec.provider,
        region: spec.region,
        ip: spec.ip,
        port: spec.port,
        username: spec.username,
        userLimit: spec.userLimit,
        capacityGb: spec.capacityGb
      }
    } });
  }
  if (path.startsWith("/api/enrollment/jobs/") && req.method === "GET") {
    const id = path.slice("/api/enrollment/jobs/".length);
    const job = await env.DB.prepare("SELECT id,kind,state,safe_code,fingerprint,spec_json FROM v2_runner_jobs WHERE id=? AND owner_id=?").bind(id, actor).first();
    if (!job) return reply({ error: "NOT_FOUND" }, 404);
    const installed = job.kind === "probe" && job.state === "ready" && await installedProbe(env.DB, actor, job);
    const { spec_json, ...safeJob } = job;
    return reply({ ...safeJob, installed });
  }
  if (req.method !== "POST") return reply({ error: "NOT_FOUND" }, 404);
  let b;
  try {
    b = await body(req);
  } catch {
    return reply({ error: "BAD_BODY" }, 400);
  }
  if (path === "/api/enrollment/pair-runner") {
    if (env.V2_EXECUTOR_BACKEND !== "resident") return reply({ error: "RUNNER_NOT_CONFIGURED" }, 503);
    if (await executorReady(env, now)) return reply({ status: "RUNNER_CONNECTED" });
    let publicJwk;
    try {
      publicJwk = JSON.parse(env.RUNNER_PUBLIC_KEY);
    } catch {
    }
    let envelope;
    try {
      envelope = await makeResidentPairing(publicJwk, env.RUNNER_SERVICE_SECRET);
    } catch {
      return reply({ error: "PAIRING_KEY_NOT_CONFIGURED" }, 503);
    }
    const expires = now + 10 * 60 * 1e3;
    await env.DB.prepare("INSERT INTO v2_runner_pairing(id,envelope_json,expires_ms) VALUES('existing-runner',?,?) ON CONFLICT(id) DO UPDATE SET envelope_json=excluded.envelope_json,expires_ms=excluded.expires_ms").bind(JSON.stringify(envelope), expires).run();
    return reply({ status: "PAIRING_READY", expires_ms: expires });
  }
  if (path === "/api/enrollment/probe") {
    const spec = validateConnection(b);
    if (!spec || env.V2_EXECUTOR_BACKEND === "github-actions" && spec.mode !== "fresh")
      return reply({ error: "INVALID_TARGET" }, 400);
    if (!await executorReady(env, now))
      return reply({ error: env.V2_EXECUTOR_BACKEND === "github-actions" ? "EXECUTOR_NOT_CONFIGURED" : "RUNNER_OFFLINE" }, 503);
    const active = await env.DB.prepare("SELECT id FROM v2_runner_jobs WHERE owner_id=? AND state IN ('queued','leased') LIMIT 1").bind(actor).first();
    if (active) return reply({ error: "JOB_ALREADY_PENDING", id: active.id }, 409);
    const id = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO v2_runner_jobs(id,owner_id,kind,spec_json,state,created_ms,expires_ms) VALUES(?,?,'probe',?,'queued',?,?)").bind(id, actor, JSON.stringify(spec), now, now + 6e5).run();
    if (env.V2_EXECUTOR_BACKEND === "github-actions" && !await dispatch(env, id)) {
      await env.DB.prepare("UPDATE v2_runner_jobs SET state='failed',safe_code='EXECUTOR_DISPATCH_FAILED' WHERE id=? AND state='queued'").bind(id).run();
      return reply({ error: "EXECUTOR_DISPATCH_FAILED" }, 503);
    }
    return reply({ id });
  }
  if (path === "/api/enrollment/diagnose-installed") {
    if (!JOB_ID.test(b.probeId ?? "") || !validEnvelope(b.envelope) || b.trust !== true)
      return reply({ error: "ENCRYPTED_CREDENTIALS_REQUIRED" }, 400);
    const probe = await env.DB.prepare(
      "SELECT spec_json,fingerprint FROM v2_runner_jobs WHERE id=? AND owner_id=? AND kind='probe' AND state='ready' AND expires_ms>?"
    ).bind(b.probeId, actor, now).first();
    if (!probe || probe.fingerprint !== b.fingerprint || !await installedProbe(env.DB, actor, probe))
      return reply({ error: "INSTALLED_PROBE_REQUIRED" }, 409);
    if (!await executorReady(env, now)) return reply({ error: "EXECUTOR_NOT_CONFIGURED" }, 503);
    const spec = { ...JSON.parse(probe.spec_json), diagnostic: true, runtimeDiagnostic: true };
    if (b.startRuntime === true) {
      const prior = await env.DB.prepare(
        "SELECT spec_json,fingerprint FROM v2_runner_jobs WHERE id=? AND owner_id=? AND kind='v2-install' AND state='ready' AND safe_code='DIAG_RUNTIME_DOWN' AND created_ms>?"
      ).bind(b.diagnosticId ?? "", actor, now - 9e5).first();
      const target = prior ? JSON.parse(prior.spec_json) : null;
      if (!target?.runtimeDiagnostic || prior.fingerprint !== probe.fingerprint || target.nodeId !== spec.nodeId || target.ip !== spec.ip || target.port !== spec.port)
        return reply({ error: "RUNTIME_DOWN_DIAGNOSIS_REQUIRED" }, 409);
      spec.startRuntime = true;
    }
    const id = crypto.randomUUID();
    const queued = await env.DB.prepare(
      "INSERT INTO v2_runner_jobs(id,owner_id,kind,spec_json,fingerprint,encrypted_credentials,state,created_ms,expires_ms) SELECT ?,?,'v2-install',?,?,?,'queued',?,? WHERE NOT EXISTS (SELECT 1 FROM v2_runner_jobs WHERE owner_id=? AND state IN ('queued','leased') AND expires_ms>?)"
    ).bind(id, actor, JSON.stringify(spec), probe.fingerprint, JSON.stringify(b.envelope), now, now + 9e5, actor, now).run();
    if (queued.meta?.changes !== 1) return reply({ error: "JOB_ALREADY_PENDING" }, 409);
    if (env.V2_EXECUTOR_BACKEND === "github-actions" && !await dispatch(env, id)) {
      await env.DB.prepare(
        "UPDATE v2_runner_jobs SET state='failed',safe_code='EXECUTOR_DISPATCH_FAILED',encrypted_credentials=NULL WHERE id=? AND state='queued'"
      ).bind(id).run();
      return reply({ error: "EXECUTOR_DISPATCH_FAILED" }, 503);
    }
    return reply({ id });
  }
  if (path === "/api/enrollment/diagnose") {
    if (!validEnvelope(b.envelope) || b.trust !== true || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(b.fingerprint ?? "") || !JOB_ID.test(b.failedInstallId ?? ""))
      return reply({ error: "ENCRYPTED_CREDENTIALS_REQUIRED" }, 400);
    const failed = await env.DB.prepare(
      "SELECT id,spec_json,fingerprint,created_ms FROM v2_runner_jobs WHERE id=? AND owner_id=? AND kind='v2-install' AND state='failed'"
    ).bind(b.failedInstallId, actor).first();
    if (!failed || failed.created_ms < now - 864e5 || failed.fingerprint !== b.fingerprint)
      return reply({ error: "FAILED_INSTALL_REQUIRED" }, 409);
    const spec = JSON.parse(failed.spec_json);
    if (spec.diagnostic === true || spec.mode !== "fresh" || !validateConnection(spec))
      return reply({ error: "FAILED_INSTALL_REQUIRED" }, 409);
    if (!await executorReady(env, now))
      return reply({ error: "EXECUTOR_NOT_CONFIGURED" }, 503);
    const active = await env.DB.prepare(
      "SELECT id FROM v2_runner_jobs WHERE owner_id=? AND state IN ('queued','leased') LIMIT 1"
    ).bind(actor).first();
    if (active) return reply({ error: "JOB_ALREADY_PENDING", id: active.id }, 409);
    const freshProbe = await env.DB.prepare(
      "SELECT spec_json FROM v2_runner_jobs WHERE owner_id=? AND kind='probe' AND state='ready' AND fingerprint=? AND expires_ms>? ORDER BY created_ms DESC LIMIT 1"
    ).bind(actor, failed.fingerprint, now).first();
    const verified = freshProbe ? JSON.parse(freshProbe.spec_json) : null;
    const sameHost = verified && verified.nodeId === spec.nodeId && verified.ip === spec.ip && verified.port === spec.port;
    const id = crypto.randomUUID(), diagSpec = { ...sameHost ? verified : spec, diagnostic: true };
    await env.DB.prepare(
      "INSERT INTO v2_runner_jobs(id,owner_id,kind,spec_json,fingerprint,encrypted_credentials,state,created_ms,expires_ms) VALUES(?,?,'v2-install',?, ?,?,'queued',?,?)"
    ).bind(id, actor, JSON.stringify(diagSpec), failed.fingerprint, JSON.stringify(b.envelope), now, now + 9e5).run();
    if (env.V2_EXECUTOR_BACKEND === "github-actions" && !await dispatch(env, id)) {
      await env.DB.prepare(
        "UPDATE v2_runner_jobs SET state='failed',safe_code='EXECUTOR_DISPATCH_FAILED',encrypted_credentials=NULL WHERE id=? AND state='queued'"
      ).bind(id).run();
      return reply({ error: "EXECUTOR_DISPATCH_FAILED" }, 503);
    }
    return reply({ id });
  }
  if (path === "/api/enrollment/reset") {
    if (!validEnvelope(b.envelope) || b.trust !== true || b.confirm !== "RESET_V2_ONLY" || b.confirmNodeId !== b.nodeId || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(b.fingerprint ?? "") || !JOB_ID.test(b.probeId ?? ""))
      return reply({ error: "RESET_EXPLICIT_CONSENT_REQUIRED" }, 400);
    const prior = await env.DB.prepare(
      "SELECT spec_json,fingerprint FROM v2_runner_jobs WHERE id=? AND owner_id=? AND kind='probe' AND state='ready' AND expires_ms>?"
    ).bind(b.probeId, actor, now).first();
    if (!prior || prior.fingerprint !== b.fingerprint) return reply({ error: "PROBE_REQUIRED" }, 409);
    const spec = JSON.parse(prior.spec_json);
    if (spec.nodeId !== b.nodeId || !validateConnection(spec)) return reply({ error: "INVALID_TARGET" }, 400);
    const eligible = await resetEligibility(env.DB, actor, spec.nodeId, now);
    if (!eligible.ok) return reply({ error: eligible.code }, 409);
    if (eligible.node.ip !== spec.ip) return reply({ error: "RESET_HOST_MISMATCH" }, 409);
    if (!await executorReady(env, now)) return reply({ error: "EXECUTOR_NOT_CONFIGURED" }, 503);
    const pending = await env.DB.prepare(
      "SELECT id FROM v2_runner_jobs WHERE owner_id=? AND state IN ('queued','leased') LIMIT 1"
    ).bind(actor).first();
    if (pending) return reply({ error: "JOB_ALREADY_PENDING" }, 409);
    const id = crypto.randomUUID(), cleanupSpec = { ...spec, cleanup: true, cleanupPreviousLifecycle: eligible.node.lifecycle };
    try {
      const result = await env.DB.batch([
        env.DB.prepare("UPDATE nodes SET lifecycle='quarantined' WHERE id=? AND lifecycle IN ('ready','provisioning','degraded')").bind(spec.nodeId),
        env.DB.prepare("INSERT INTO v2_runner_jobs(id,owner_id,kind,spec_json,probe_id,fingerprint,encrypted_credentials,state,created_ms,expires_ms) VALUES(?,?,'v2-install',?,?,? ,?,'queued',?,?)").bind(
          id,
          actor,
          JSON.stringify(cleanupSpec),
          prior.probe_id ?? null,
          b.fingerprint,
          JSON.stringify(b.envelope),
          now,
          now + 9e5
        )
      ]);
      if (Number(result[0]?.meta?.changes) !== 1 || Number(result[1]?.meta?.changes) !== 1)
        return reply({ error: "RESET_QUARANTINE_FAILED" }, 409);
    } catch {
      return reply({ error: "RESET_QUARANTINE_FAILED" }, 409);
    }
    if (env.V2_EXECUTOR_BACKEND === "github-actions" && !await dispatch(env, id)) {
      await env.DB.prepare("UPDATE v2_runner_jobs SET state='failed',safe_code='EXECUTOR_DISPATCH_FAILED',encrypted_credentials=NULL WHERE id=? AND state='queued'").bind(id).run();
      return reply({ error: "EXECUTOR_DISPATCH_FAILED" }, 503);
    }
    return reply({ id, willCancelPending: eligible.willCancelPending });
  }
  if (path === "/api/enrollment/clear-failed") {
    if (!JOB_ID.test(b.failedInstallId ?? "") || !JOB_ID.test(b.diagnosticId ?? ""))
      return reply({ error: "FAILED_INSTALL_REQUIRED" }, 400);
    const failed = await env.DB.prepare(
      "SELECT j.id,j.spec_json,j.fingerprint,bj.state AS install_state,n.lifecycle FROM v2_runner_jobs j JOIN node_bootstrap_jobs bj ON bj.id=j.id JOIN nodes n ON n.id=bj.node_id WHERE j.id=? AND j.owner_id=? AND j.kind='v2-install' AND j.state='failed'"
    ).bind(b.failedInstallId, actor).first();
    if (!failed || failed.install_state !== "failed" || failed.lifecycle !== "enrolling")
      return reply({ error: "FAILED_INSTALL_REQUIRED" }, 409);
    const spec = JSON.parse(failed.spec_json);
    const diag = await env.DB.prepare(
      "SELECT id,spec_json,fingerprint,created_ms FROM v2_runner_jobs WHERE id=? AND owner_id=? AND kind='v2-install' AND state='ready' AND safe_code='DIAG_PRECHECK_OK' AND created_ms>?"
    ).bind(b.diagnosticId, actor, now - 9e5).first();
    const diagSpec = diag ? JSON.parse(diag.spec_json) : null;
    if (!diagSpec || diagSpec.diagnostic !== true || diag.fingerprint !== failed.fingerprint || diagSpec.nodeId !== spec.nodeId || diagSpec.ip !== spec.ip || diagSpec.port !== spec.port)
      return reply({ error: "CLEAN_DIAG_REQUIRED" }, 409);
    const pending = await env.DB.prepare(
      "SELECT id FROM v2_runner_jobs WHERE owner_id=? AND state IN ('queued','leased') LIMIT 1"
    ).bind(actor).first();
    if (pending) return reply({ error: "JOB_ALREADY_PENDING" }, 409);
    const safe = await env.DB.prepare(
      "SELECT n.id FROM nodes n WHERE n.id=? AND n.lifecycle='enrolling' AND NOT EXISTS(SELECT 1 FROM routes WHERE node_id=n.id) AND NOT EXISTS(SELECT 1 FROM node_allocations WHERE node_id=n.id) AND NOT EXISTS(SELECT 1 FROM node_trial_links WHERE node_id=n.id) AND NOT EXISTS(SELECT 1 FROM node_trial_credentials WHERE node_id=n.id) AND NOT EXISTS(SELECT 1 FROM customer_trial_claims WHERE node_id=n.id) AND NOT EXISTS(SELECT 1 FROM node_acks WHERE node_id=n.id) AND NOT EXISTS(SELECT 1 FROM node_bootstrap_jobs WHERE node_id=n.id AND id<>?)"
    ).bind(spec.nodeId, failed.id).first();
    if (!safe) return reply({ error: "NODE_RESET_UNSAFE" }, 409);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM node_bootstrap_jobs WHERE id=? AND node_id=? AND owner_id=? AND state='failed'").bind(failed.id, spec.nodeId, actor),
      env.DB.prepare(
        "DELETE FROM nodes WHERE id=? AND lifecycle='enrolling' AND NOT EXISTS(SELECT 1 FROM node_bootstrap_jobs WHERE node_id=?) AND NOT EXISTS(SELECT 1 FROM routes WHERE node_id=?) AND NOT EXISTS(SELECT 1 FROM node_allocations WHERE node_id=?)"
      ).bind(spec.nodeId, spec.nodeId, spec.nodeId, spec.nodeId)
    ]);
    const stillExists = await env.DB.prepare("SELECT id FROM nodes WHERE id=?").bind(spec.nodeId).first();
    return stillExists ? reply({ error: "NODE_RESET_UNSAFE" }, 409) : reply({ status: "CLEARED" });
  }
  if (path === "/api/enrollment/install") {
    if (!validEnvelope(b.envelope) || b.trust !== true || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(b.fingerprint ?? ""))
      return reply({ error: "ENCRYPTED_CREDENTIALS_REQUIRED" }, 400);
    const probe = await env.DB.prepare("SELECT id,spec_json,fingerprint FROM v2_runner_jobs WHERE id=? AND owner_id=? AND kind='probe' AND state='ready' AND expires_ms>?").bind(b.probeId, actor, now).first();
    if (!probe || probe.fingerprint !== b.fingerprint) return reply({ error: "PROBE_REQUIRED" }, 409);
    const existing = await env.DB.prepare("SELECT id FROM v2_runner_jobs WHERE probe_id=?").bind(probe.id).first();
    if (existing) return reply({ id: existing.id });
    const spec = JSON.parse(probe.spec_json), id = crypto.randomUUID();
    try {
      await env.DB.batch([
        env.DB.prepare("INSERT INTO nodes(id,provider,region,lifecycle,user_limit,byte_limit,desired_revision,acked_revision) VALUES(?,?,?,'enrolling',?,?,1,0)").bind(spec.nodeId, spec.provider, spec.region, spec.userLimit, spec.capacityGb * 1073741824),
        env.DB.prepare("INSERT INTO node_bootstrap_jobs(id,node_id,ip,owner_id,mode,state,created_ms,updated_ms) VALUES(?,?,?,?,?,'dispatching',?,?)").bind(id, spec.nodeId, spec.ip, actor, spec.mode, now, now),
        env.DB.prepare("INSERT INTO v2_runner_jobs(id,owner_id,kind,spec_json,probe_id,fingerprint,encrypted_credentials,state,created_ms,expires_ms) VALUES(?,?,'v2-install',?,?,?,?,'queued',?,?)").bind(id, actor, probe.spec_json, probe.id, probe.fingerprint, JSON.stringify(b.envelope), now, now + 9e5)
      ]);
    } catch {
      return reply({ error: "NODE_ALREADY_EXISTS" }, 409);
    }
    if (env.V2_EXECUTOR_BACKEND === "github-actions" && !await dispatch(env, id)) {
      await env.DB.batch([
        env.DB.prepare("UPDATE v2_runner_jobs SET state='failed',safe_code='EXECUTOR_DISPATCH_FAILED',encrypted_credentials=NULL WHERE id=? AND state='queued'").bind(id),
        env.DB.prepare("UPDATE node_bootstrap_jobs SET state='failed',error_code='EXECUTOR_DISPATCH_FAILED',updated_ms=? WHERE id=?").bind(now, id),
        env.DB.prepare("UPDATE nodes SET lifecycle='quarantined' WHERE id=? AND lifecycle='enrolling'").bind(spec.nodeId)
      ]);
      return reply({ error: "EXECUTOR_DISPATCH_FAILED" }, 503);
    }
    return reply({ id });
  }
  return reply({ error: "NOT_FOUND" }, 404);
}
__name(enrollmentApi, "enrollmentApi");
async function runnerApi(req, env, now = Date.now()) {
  if (!env.DB || env.RUNNER_ENROLLMENT_ENABLED !== "true") return reply({ error: "DISABLED" }, 503);
  if (req.method === "GET" && new URL(req.url).pathname === "/api/runner/pair") {
    const row2 = await env.DB.prepare("SELECT envelope_json FROM v2_runner_pairing WHERE id='existing-runner' AND expires_ms>?").bind(now).first();
    return row2 ? reply({ envelope: JSON.parse(row2.envelope_json) }) : reply({ error: "PAIRING_UNAVAILABLE" }, 404);
  }
  if (!env.RUNNER_SERVICE_SECRET || env.RUNNER_SERVICE_SECRET.length < 32 || !await verifyTelegramSecret(req.headers.get("authorization"), "Bearer " + env.RUNNER_SERVICE_SECRET))
    return reply({ error: "UNAUTHORIZED" }, 401);
  if (req.method !== "POST") return reply({ error: "NOT_FOUND" }, 404);
  let b;
  try {
    b = await body(req);
  } catch {
    return reply({ error: "BAD_BODY" }, 400);
  }
  const action2 = new URL(req.url).pathname.slice("/api/runner/".length);
  if (action2 === "verify") return reply({ ok: true });
  await cleanupRunnerJobs(env.DB, now);
  if (action2 === "abort-queued") {
    if (env.V2_EXECUTOR_BACKEND !== "github-actions" || b.runnerId !== GITHUB_RUNNER_ID || !JOB_ID.test(b.jobId ?? ""))
      return reply({ error: "INVALID_EXECUTOR_JOB" }, 403);
    await env.DB.prepare(
      "UPDATE v2_runner_jobs SET state='failed',safe_code='EXECUTOR_FAILED',encrypted_credentials=NULL WHERE id=? AND state='queued'"
    ).bind(b.jobId).run();
    return reply({ ok: true });
  }
  if (action2 === "lease") {
    if (!/^[A-Za-z0-9_-]{3,64}$/.test(b.runnerId ?? "")) return reply({ error: "BAD_RUNNER" }, 400);
    const github = env.V2_EXECUTOR_BACKEND === "github-actions";
    if (github && (b.runnerId !== GITHUB_RUNNER_ID || !JOB_ID.test(b.jobId ?? "")))
      return reply({ error: "INVALID_EXECUTOR_JOB" }, 403);
    if (!github && b.runnerId !== "existing-host-v2") return reply({ error: "INVALID_EXECUTOR_JOB" }, 403);
    if (!github) {
      await env.DB.prepare("INSERT INTO v2_runner_presence(id,last_seen_ms) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET last_seen_ms=excluded.last_seen_ms").bind(b.runnerId, now).run();
      await env.DB.prepare("DELETE FROM v2_runner_pairing WHERE id='existing-runner'").run();
    }
    const lease = crypto.randomUUID();
    const sql = github ? "UPDATE v2_runner_jobs SET state='leased',lease_id=?,lease_until_ms=? WHERE id=? AND state='queued' AND expires_ms>? RETURNING *" : "UPDATE v2_runner_jobs SET state='leased',lease_id=?,lease_until_ms=? WHERE id=(SELECT id FROM v2_runner_jobs WHERE state='queued' AND expires_ms>? ORDER BY created_ms LIMIT 1) AND state='queued' RETURNING *";
    const query = env.DB.prepare(sql);
    const row2 = await (github ? query.bind(lease, now + 9e4, b.jobId, now) : query.bind(lease, now + 9e4, now)).first();
    let job = null;
    if (row2) {
      const s = JSON.parse(row2.spec_json);
      job = {
        id: row2.id,
        leaseId: lease,
        kind: row2.kind,
        nodeId: s.nodeId,
        targetIp: s.ip,
        port: s.port,
        username: s.username,
        mode: s.mode,
        diagnostic: s.diagnostic === true,
        cleanup: s.cleanup === true,
        runtimeDiagnostic: s.runtimeDiagnostic === true,
        startRuntime: s.startRuntime === true,
        hostFingerprint: row2.fingerprint,
        encryptedCredentials: row2.encrypted_credentials,
        credentialsExpireAt: Math.floor(row2.expires_ms / 1e3),
        enableRuntime: env.NODE_RUNTIME_AUTO_ENABLED === "true"
      };
    }
    const payload = JSON.stringify(job);
    return reply({ payload, signature: hex2(await hmac2(env.RUNNER_SERVICE_SECRET, payload)) });
  }
  const row = await env.DB.prepare("SELECT * FROM v2_runner_jobs WHERE id=? AND lease_id=? AND state='leased' AND lease_until_ms>? AND expires_ms>?").bind(b.id, b.leaseId, now, now).first();
  if (!row) {
    const done = action2 === "report" && ["ready", "failed"].includes(b.state) ? await env.DB.prepare(
      "SELECT id FROM v2_runner_jobs WHERE id=? AND lease_id=? AND state=?"
    ).bind(b.id, b.leaseId, b.state).first() : null;
    return done ? reply({ ok: true }) : reply({ error: "LEASE_EXPIRED" }, 409);
  }
  if (action2 === "node-key") {
    if (env.NODE_RUNTIME_AUTO_ENABLED !== "true" || !env.NODE_MASTER_KEY || row.kind !== "v2-install") return reply({ error: "NOT_CONFIGURED" }, 503);
    const spec = JSON.parse(row.spec_json);
    if (spec.diagnostic === true || spec.mode !== "fresh" || spec.nodeId !== b.nodeId)
      return reply({ error: "INVALID_INSTALL_LEASE" }, 403);
    const key = await deriveNodeKey(env.NODE_MASTER_KEY, spec.nodeId);
    const nodeKey = btoa(String.fromCharCode(...key)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return reply({ nodeKey, origin: "https://madar-v2-staging.alirezaanari117.workers.dev" });
  }
  if (action2 === "renew") {
    await env.DB.prepare("UPDATE v2_runner_jobs SET lease_until_ms=? WHERE id=? AND lease_id=? AND state='leased' AND lease_until_ms>?").bind(now + 9e4, row.id, b.leaseId, now).run();
    return reply({ ok: true });
  }
  if (action2 !== "report" || !["ready", "failed"].includes(b.state)) return reply({ error: "BAD_REPORT" }, 400);
  const fingerprint = b.details?.fingerprint;
  if (b.state === "ready" && row.kind === "probe" && !/^SHA256:[A-Za-z0-9+/]{43}$/.test(fingerprint ?? "")) return reply({ error: "BAD_FINGERPRINT" }, 400);
  const safeProbeCodes = /* @__PURE__ */ new Set(["SSH_TIMEOUT", "SSH_REFUSED", "SSH_UNREACHABLE", "SSH_HANDSHAKE_FAILED", "PROBE_EXPIRED", "SSH_PROBE_FAILED"]);
  const safeInstallCodes = /* @__PURE__ */ new Set(["RESET_PREFLIGHT_BLOCKED", "RESET_BLOCKED", "RESET_REMOTE_FAILED", "RESET_CLEANUP_FAILED", "SSH_TIMEOUT", "SSH_REFUSED", "SSH_UNREACHABLE", "SSH_AUTH_FAILED", "HOST_KEY_CHANGED", "INVALID_SSH_KEY", "CREDENTIALS_EXPIRED", "CREDENTIAL_DECRYPT_FAILED", "SSH_LOGIN_FAILED", "REMOTE_INSTALL_FAILED", "INSTALL_REPORT_FAILED"]);
  const safeDiagnosticCodes = /* @__PURE__ */ new Set(["DIAG_EXISTING_VPN", "DIAG_PORT_443_BUSY", "DIAG_PORT_8443_BUSY", "DIAG_UNSUPPORTED_OS", "DIAG_NO_ROOT", "DIAG_SYSTEMD_MISSING", "DIAG_GITHUB_UNREACHABLE", "DIAG_PRECHECK_OK", "DIAG_REMOTE_FAILED", "DIAG_RUNTIME_ACTIVE", "DIAG_RUNTIME_DOWN", "DIAG_XRAY_DOWN", "DIAG_RUNTIME_GENERATION", "DIAG_RUNTIME_ERROR", "DIAG_RUNTIME_STARTED", "DIAG_RUNTIME_START_FAILED"]);
  for (const code2 of ["REMOTE_PACKAGE_FAILED", "REMOTE_BOOTSTRAP_FAILED", "REMOTE_DUAL_FAILED", "REMOTE_METADATA_FAILED"]) safeInstallCodes.add(code2);
  const specs = row.kind === "v2-install" ? JSON.parse(row.spec_json) : null;
  const diag = !!specs?.diagnostic, cleanup = !!specs?.cleanup;
  if (cleanup && diag) return reply({ error: "INVALID_RESET_JOB" }, 409);
  if (cleanup && b.state === "ready" && b.safeCode !== "RESET_COMPLETED")
    return reply({ error: "RESET_REMOTE_PROOF_MISSING" }, 409);
  if (diag && b.state === "ready" && !safeDiagnosticCodes.has(b.safeCode))
    return reply({ error: "BAD_DIAG_REPORT" }, 400);
  const code = cleanup ? b.state === "ready" ? "RESET_COMPLETED" : safeInstallCodes.has(b.safeCode) ? b.safeCode : "RESET_CLEANUP_FAILED" : diag ? safeDiagnosticCodes.has(b.safeCode) ? b.safeCode : safeInstallCodes.has(b.safeCode) ? b.safeCode : "DIAG_REMOTE_FAILED" : b.state === "ready" ? "OK" : row.kind === "probe" && safeProbeCodes.has(b.safeCode) || row.kind === "v2-install" && safeInstallCodes.has(b.safeCode) ? b.safeCode : "INSTALLATION_FAILED";
  const completion = env.DB.prepare("UPDATE v2_runner_jobs SET state=?,safe_code=?,fingerprint=COALESCE(?,fingerprint),encrypted_credentials=NULL,lease_until_ms=0 WHERE id=? AND lease_id=? AND state='leased'").bind(b.state, code, row.kind === "probe" ? fingerprint ?? null : null, row.id, b.leaseId);
  if (cleanup) {
    if (b.state === "ready") {
      const result = await retireCleanedNode(env.DB, row.owner_id, specs.nodeId, row.id, now, completion);
      if (!result) return reply({ error: "RESET_DB_FINALIZATION_FAILED" }, 409);
    } else if (code === "RESET_PREFLIGHT_BLOCKED") {
      const previous = specs.cleanupPreviousLifecycle;
      if (!["ready", "provisioning", "degraded"].includes(previous))
        return reply({ error: "RESET_PREFLIGHT_RESTORE_FAILED" }, 409);
      const results = await env.DB.batch([
        completion,
        env.DB.prepare("UPDATE nodes SET lifecycle=? WHERE id=? AND lifecycle='quarantined'").bind(previous, specs.nodeId)
      ]);
      if (Number(results[0]?.meta?.changes) !== 1 || Number(results[1]?.meta?.changes) !== 1)
        return reply({ error: "RESET_PREFLIGHT_RESTORE_FAILED" }, 409);
    } else await completion.run();
  } else if (row.kind === "v2-install" && !diag) {
    const spec = JSON.parse(row.spec_json);
    const result = await reportInstall(new Request("https://internal/report", { method: "POST", headers: { "x-madar-deploy-auth": env.RUNNER_SERVICE_SECRET }, body: JSON.stringify({
      ...b.details,
      job_id: row.id,
      node_id: spec.nodeId,
      ip: spec.ip,
      status: b.state === "ready" ? "installed" : "failed",
      error_code: "INSTALLATION_FAILED"
    }) }), { ...env, NODE_AUTO_ENABLED: "true", NODE_PROVISION_CALLBACK_SECRET: env.RUNNER_SERVICE_SECRET }, now, [completion]);
    if (!result.ok) return reply({ error: "METADATA_REJECTED" }, 409);
  } else await completion.run();
  return reply({ ok: true });
}
__name(runnerApi, "runnerApi");

// src/enrollment-page.mjs
var _a;
var enrollmentPage = String.raw(_a || (_a = __template([`<!doctype html><html lang="fa" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>\u0627\u0641\u0632\u0648\u062F\u0646 \u0633\u0631\u0648\u0631 \u0645\u062F\u0627\u0631 V2</title>
<script src="https://telegram.org/js/telegram-web-app.js"><\/script>
<style>
:root{color-scheme:dark;--surface:#111f33;--surface2:#172b45;--line:#2d4564;--accent:#438df5;--muted:#a9bbd2}
*{box-sizing:border-box}
body{font:16px/1.9 system-ui,-apple-system,sans-serif;background:radial-gradient(ellipse at top,#18365a 0,#0b1628 48%,#07111f 100%);color:#eef4ff;max-width:600px;min-height:100vh;margin:0 auto;padding:28px 16px 40px}
h1{font-size:25px;line-height:1.5;margin:8px 0 12px;letter-spacing:-.4px}
body>p:first-of-type{color:#bdcce0;margin:0 0 20px}
form,details{background:linear-gradient(145deg,rgba(24,43,69,.96),rgba(14,28,46,.96));border:1px solid var(--line);border-radius:20px;padding:18px;margin:16px 0;box-shadow:0 18px 44px rgba(0,0,0,.22)}
label{display:block;font-weight:600;color:#dbe7f8}
input,select,button{box-sizing:border-box;display:block;width:100%;font:inherit;padding:12px 14px;margin:8px 0 16px;border:1px solid #385474;border-radius:13px;background:#0c1a2c;color:inherit;transition:border-color .15s,box-shadow .15s}
input:focus,select:focus{outline:none;border-color:#6aa7ff;box-shadow:0 0 0 3px rgba(67,141,245,.18)}
button{background:linear-gradient(135deg,#438df5,#2868c7);border:0;font-weight:750;cursor:pointer;box-shadow:0 8px 18px rgba(25,91,183,.22)}
button:disabled{opacity:.45;cursor:not-allowed;box-shadow:none}
fieldset{border:1px solid var(--line);border-radius:16px;padding:14px;margin-top:18px}
legend{padding:0 8px;color:#a9caff;font-weight:700}
summary{cursor:pointer;font-weight:700;color:#c7dcf7}
#status{white-space:pre-wrap;overflow-wrap:anywhere;background:rgba(8,20,35,.75);border:1px solid var(--line);border-radius:14px;padding:12px 14px;color:#d9e8ff;min-height:48px}
#fingerprint{direction:ltr;overflow-wrap:anywhere;background:#091727;border:1px dashed #54749a;border-radius:12px;padding:10px}
input[type=checkbox]{width:auto;display:inline;accent-color:#438df5}
</style>
<h1>\u0627\u0641\u0632\u0648\u062F\u0646 \u0633\u0631\u0648\u0631 \u0645\u062F\u0627\u0631 V2</h1><p>\u0627\u0637\u0644\u0627\u0639\u0627\u062A \u0633\u0631\u0648\u0631 \u0631\u0627 \u0648\u0627\u0631\u062F \u06A9\u0646\u061B \u0628\u0631\u0631\u0633\u06CC \u0627\u062A\u0635\u0627\u0644 \u0648 \u0646\u0635\u0628 \u0627\u0632 \u0647\u0645\u06CC\u0646 \u0635\u0641\u062D\u0647 \u0627\u0646\u062C\u0627\u0645 \u0645\u06CC\u200C\u0634\u0648\u062F. \u0631\u0645\u0632 \u0648 \u06A9\u0644\u06CC\u062F \u0631\u0627 \u062F\u0631 \u067E\u06CC\u0627\u0645 \u062A\u0644\u06AF\u0631\u0627\u0645 \u0646\u0641\u0631\u0633\u062A.</p>
<details id="runnerPairing" hidden><summary>\u0641\u0639\u0627\u0644\u200C\u0633\u0627\u0632\u06CC \u06CC\u06A9\u200C\u0628\u0627\u0631\u0647 \u0633\u0631\u0648\u06CC\u0633 \u0646\u0635\u0628 V2 (\u0641\u0642\u0637 \u0645\u062F\u06CC\u0631)</summary>
<p>\u0627\u06CC\u0646 \u06A9\u0627\u0631 \u0641\u0642\u0637 \u06CC\u06A9\u200C\u0628\u0627\u0631 \u0631\u0648\u06CC \u0645\u06CC\u0632\u0628\u0627\u0646 \u0631\u0627\u0646\u0631 \u0645\u0648\u062C\u0648\u062F \u0627\u0646\u062C\u0627\u0645 \u0645\u06CC\u200C\u0634\u0648\u062F\u060C \u0646\u0647 \u0647\u0646\u06AF\u0627\u0645 \u0627\u0641\u0632\u0648\u062F\u0646 \u0647\u0631 \u0633\u0631\u0648\u0631. \u0633\u0631\u0648\u06CC\u0633 V1 \u062A\u063A\u06CC\u06CC\u0631 \u0646\u0645\u06CC\u200C\u06A9\u0646\u062F.</p>
<button type="button" id="pairRunner">\u0622\u0645\u0627\u062F\u0647\u200C\u0633\u0627\u0632\u06CC \u0627\u062A\u0635\u0627\u0644 \u0627\u0645\u0646 \u0631\u0627\u0646\u0631</button><p id="pairingStatus" role="status"></p>
</details>
<form id="form">
<label>\u0634\u0646\u0627\u0633\u0647 \u0633\u0631\u0648\u0631<input id="nodeId" placeholder="webdade6" required minlength="3" maxlength="64" pattern="[A-Za-z][A-Za-z0-9_-]{2,63}" title="\u0634\u0646\u0627\u0633\u0647 \u06F3 \u062A\u0627 \u06F6\u06F4 \u06A9\u0627\u0631\u0627\u06A9\u062A\u0631\u061B \u0628\u0627 \u062D\u0631\u0641 \u0644\u0627\u062A\u06CC\u0646 \u0634\u0631\u0648\u0639 \u0634\u0648\u062F \u0648 \u0641\u0642\u0637 \u0634\u0627\u0645\u0644 \u062D\u0631\u0648\u0641 \u0644\u0627\u062A\u06CC\u0646\u060C \u0639\u062F\u062F\u060C \u062E\u0637 \u062A\u06CC\u0631\u0647 \u0648 \u0632\u06CC\u0631\u062E\u0637 \u0628\u0627\u0634\u062F."></label><small>\u0628\u0631\u0627\u06CC \u0645\u062B\u0627\u0644: webdade6 \u06CC\u0627 aws-eu1. \u067E\u06CC\u0634\u0648\u0646\u062F test- \u0627\u062C\u0628\u0627\u0631\u06CC \u0646\u06CC\u0633\u062A\u061B \u0646\u0627\u0645\u200C\u0647\u0627\u06CC \u0631\u0632\u0631\u0648\u0634\u062F\u0647 \u0645\u0627\u0646\u0646\u062F production \u0642\u0627\u0628\u0644 \u0627\u0633\u062A\u0641\u0627\u062F\u0647 \u0646\u06CC\u0633\u062A\u0646\u062F.</small>
<label>\u0627\u0631\u0627\u0626\u0647\u200C\u062F\u0647\u0646\u062F\u0647<input id="provider" value="aws" required></label><label>\u0645\u0646\u0637\u0642\u0647<input id="region" value="eu-north-1" required></label>
<label>\u0633\u0642\u0641 \u06A9\u0627\u0631\u0628\u0631<input id="userLimit" type="number" value="20" min="1" max="100000" required></label><label>\u0633\u0642\u0641 \u062D\u062C\u0645 \u06AF\u06CC\u06AF\u0627\u0628\u0627\u06CC\u062A<input id="capacityGb" type="number" value="500" min="1" max="200000" required></label>
<label>IP \u0633\u0631\u0648\u0631<input id="ip" dir="ltr" required></label><label>\u067E\u0648\u0631\u062A SSH<input id="port" type="number" value="22" min="1" max="65535" required></label><label>\u0646\u0627\u0645 \u06A9\u0627\u0631\u0628\u0631<input id="username" value="root" dir="ltr" required></label>
<button id="probe" type="button" disabled>\u06F1 \xB7 \u0628\u0631\u0631\u0633\u06CC \u0627\u062A\u0635\u0627\u0644</button>
<fieldset id="credentials" hidden><legend>\u06F2 \xB7 \u0648\u0631\u0648\u062F \u0627\u0645\u0646 \u0648 \u0646\u0635\u0628 \u062E\u0648\u062F\u06A9\u0627\u0631</legend><p id="fingerprint"></p><label><input id="trust" type="checkbox">\u0627\u062B\u0631 \u0627\u0646\u06AF\u0634\u062A \u0631\u0627 \u0628\u0627 \u067E\u0646\u0644 \u0627\u0631\u0627\u0626\u0647\u200C\u062F\u0647\u0646\u062F\u0647 \u0645\u0637\u0627\u0628\u0642\u062A \u062F\u0627\u062F\u0645</label>
<label>\u0631\u0648\u0634 \u0648\u0631\u0648\u062F<select id="method"><option value="password">\u0631\u0645\u0632 \u0633\u0631\u0648\u0631</option><option value="key">\u06A9\u0644\u06CC\u062F \u062E\u0635\u0648\u0635\u06CC SSH</option></select></label>
<label>\u0641\u0627\u06CC\u0644 \u06A9\u0644\u06CC\u062F \u062E\u0635\u0648\u0635\u06CC<input id="keyfile" type="file"></label><label>\u0631\u0645\u0632 \u0633\u0631\u0648\u0631 \u06CC\u0627 \u0631\u0645\u0632 \u0645\u062D\u0627\u0641\u0638 \u06A9\u0644\u06CC\u062F<input id="password" type="password" autocomplete="off"></label><button id="install" type="submit">\u0634\u0631\u0648\u0639 \u0646\u0635\u0628 \u062E\u0648\u062F\u06A9\u0627\u0631</button><button id="diagnose" type="button" hidden disabled>\u{1F50E} \u0639\u06CC\u0628\u200C\u06CC\u0627\u0628\u06CC \u0628\u062F\u0648\u0646 \u0646\u0635\u0628 (\u0641\u0642\u0637 \u0628\u0631\u0631\u0633\u06CC)</button><button id="clearFailed" type="button" hidden disabled>\u067E\u0627\u06A9\u200C\u0633\u0627\u0632\u06CC \u062B\u0628\u062A \u0646\u0635\u0628 \u0646\u0627\u0645\u0648\u0641\u0642 \u0648 \u0634\u0631\u0648\u0639 \u062F\u0648\u0628\u0627\u0631\u0647</button><button id="resetInstalled" type="button" hidden>\u{1F9F9} \u067E\u0627\u06A9\u200C\u0633\u0627\u0632\u06CC V2 \u0627\u0632 \u0633\u0631\u0648\u0631 \u0648 \u0646\u0635\u0628 \u062F\u0648\u0628\u0627\u0631\u0647</button><p id="resetNote" hidden>\u0641\u0642\u0637 \u0633\u0631\u0648\u06CC\u0633\u200C\u0647\u0627 \u0648 \u0641\u0627\u06CC\u0644\u200C\u0647\u0627\u06CC \u0627\u062E\u062A\u0635\u0627\u0635\u06CC V2 \u067E\u0627\u06A9 \u0645\u06CC\u200C\u0634\u0648\u0646\u062F. \u067E\u06CC\u0634 \u0627\u0632 \u0627\u0642\u062F\u0627\u0645\u060C \u0633\u0648\u0627\u0628\u0642 \u0627\u0634\u062A\u0631\u0627\u06A9 \u0648 \u0645\u06CC\u0632\u0627\u0646 \u0645\u0635\u0631\u0641 \u0628\u0631\u0631\u0633\u06CC \u0645\u06CC\u200C\u0634\u0648\u0646\u062F\u061B \u0628\u0631\u0627\u06CC \u0646\u0635\u0628 \u062C\u062F\u06CC\u062F \u0634\u0646\u0627\u0633\u0647 \u062A\u0627\u0632\u0647 \u0644\u0627\u0632\u0645 \u0627\u0633\u062A.</p><p id="diagnoseNote" hidden>\u0641\u0642\u0637 \u0627\u0637\u0644\u0627\u0639\u0627\u062A \u0633\u06CC\u0633\u062A\u0645 \u0648 \u062F\u0633\u062A\u0631\u0633\u06CC \u062F\u0627\u0646\u0644\u0648\u062F \u0628\u0631\u0631\u0633\u06CC \u0645\u06CC\u200C\u0634\u0648\u062F\u061B \u0647\u06CC\u0686 \u0646\u0635\u0628 \u06CC\u0627 \u062D\u0630\u0641\u06CC \u0627\u0646\u062C\u0627\u0645 \u0646\u0645\u06CC\u200C\u0634\u0648\u062F. \u0627\u0637\u0644\u0627\u0639\u0627\u062A SSH \u0641\u0642\u0637 \u0628\u0647\u200C\u0635\u0648\u0631\u062A \u0631\u0645\u0632\u06AF\u0630\u0627\u0631\u06CC\u200C\u0634\u062F\u0647 \u0627\u0631\u0633\u0627\u0644 \u0645\u06CC\u200C\u0634\u0648\u0646\u062F.</p></fieldset></form><p id="status" role="status" aria-live="polite"></p>
<script>
const tg=window.Telegram?.WebApp;tg?.ready();const el=id=>document.getElementById(id),auth=tg?.initData||'';let publicKey,probeId,fingerprint,timer,busy=false,failedInstallId=null,failedNodeId=null,installedProbe=false,runtimeDownId=null,diagnosticId=null,probeExpires=0;
const status=s=>el('status').textContent=s;
const errors={PAIRING_KEY_NOT_CONFIGURED:'\u06A9\u0644\u06CC\u062F \u0639\u0645\u0648\u0645\u06CC \u0631\u0627\u0646\u0631 \u0641\u0639\u0644\u06CC \u0647\u0646\u0648\u0632 \u062A\u0646\u0638\u06CC\u0645 \u0646\u0634\u062F\u0647 \u0627\u0633\u062A.',RUNNER_OFFLINE:'\u0627\u062C\u0631\u0627\u06A9\u0646\u0646\u062F\u0647 \u0645\u0633\u062A\u0642\u0644 V2 \u0647\u0646\u0648\u0632 \u0631\u0648\u06CC \u0645\u06CC\u0632\u0628\u0627\u0646 AWS \u0645\u062A\u0635\u0644 \u0646\u0634\u062F\u0647 \u0627\u0633\u062A\u061B \u0647\u06CC\u0686 \u0646\u0635\u0628\u06CC \u0634\u0631\u0648\u0639 \u0646\u0645\u06CC\u200C\u0634\u0648\u062F.',RUNNER_NOT_CONFIGURED:'\u0627\u062A\u0635\u0627\u0644 \u0627\u062C\u0631\u0627\u06A9\u0646\u0646\u062F\u0647 \u0647\u0646\u0648\u0632 \u062A\u0646\u0638\u06CC\u0645 \u0646\u0634\u062F\u0647 \u0627\u0633\u062A.',EXECUTOR_NOT_CONFIGURED:'\u0627\u062C\u0631\u0627\u06CC \u062F\u0631\u062E\u0648\u0627\u0633\u062A\u06CC \u0647\u0646\u0648\u0632 \u0628\u0647\u200C\u0637\u0648\u0631 \u0627\u0645\u0646 \u0641\u0639\u0627\u0644 \u0646\u0634\u062F\u0647 \u0627\u0633\u062A.',EXECUTOR_DISPATCH_FAILED:'\u0627\u062C\u0631\u0627\u06CC \u0646\u0635\u0628 \u062F\u0631 GitHub \u0634\u0631\u0648\u0639 \u0646\u0634\u062F\u061B \u0647\u06CC\u0686 \u062A\u063A\u06CC\u06CC\u0631\u06CC \u062F\u0631 \u0633\u0631\u0648\u0631 \u0627\u0646\u062C\u0627\u0645 \u0646\u0634\u062F.',AUTH_EXPIRED:'\u0627\u06CC\u0646 \u0635\u0641\u062D\u0647 \u0631\u0627 \u0628\u0628\u0646\u062F \u0648 \u0627\u0632 \u0631\u0628\u0627\u062A \u062F\u0648\u0628\u0627\u0631\u0647 \u0628\u0627\u0632 \u06A9\u0646.',INVALID_TARGET:'\u0645\u0634\u062E\u0635\u0627\u062A \u0633\u0631\u0648\u0631 \u0645\u0639\u062A\u0628\u0631 \u0646\u06CC\u0633\u062A.',NODE_ALREADY_EXISTS:'\u0627\u06CC\u0646 \u0634\u0646\u0627\u0633\u0647 \u0627\u0632 \u0646\u0635\u0628 \u0646\u0627\u0645\u0648\u0641\u0642 \u0642\u0628\u0644\u06CC \u062F\u0631 \u0645\u062F\u0627\u0631 \u062B\u0628\u062A \u0634\u062F\u0647 \u0627\u0633\u062A. \u067E\u06CC\u0634 \u0627\u0632 \u062A\u0644\u0627\u0634 \u0645\u062C\u062F\u062F\u060C \u0639\u06CC\u0628\u200C\u06CC\u0627\u0628\u06CC \u0628\u062F\u0648\u0646 \u0646\u0635\u0628 \u0631\u0627 \u0627\u062C\u0631\u0627 \u06A9\u0646.',PROBE_REQUIRED:'\u0645\u0647\u0644\u062A \u0628\u0631\u0631\u0633\u06CC \u0627\u062A\u0635\u0627\u0644 \u062A\u0645\u0627\u0645 \u0634\u062F\u0647 \u06CC\u0627 \u0627\u062B\u0631 \u0627\u0646\u06AF\u0634\u062A \u0645\u0639\u062A\u0628\u0631 \u0646\u06CC\u0633\u062A\u061B \u062F\u0648\u0628\u0627\u0631\u0647 \xAB\u0628\u0631\u0631\u0633\u06CC \u0627\u062A\u0635\u0627\u0644\xBB \u0631\u0627 \u0628\u0632\u0646.',CLEAN_DIAG_REQUIRED:'\u0627\u0628\u062A\u062F\u0627 \u0646\u062A\u06CC\u062C\u0647 \u0645\u0648\u0641\u0642 \u0639\u06CC\u0628\u200C\u06CC\u0627\u0628\u06CC \u0628\u062F\u0648\u0646 \u0646\u0635\u0628 \u0631\u0627 \u062F\u0631\u06CC\u0627\u0641\u062A \u06A9\u0646.',NODE_RESET_UNSAFE:'\u067E\u0627\u06A9\u200C\u0633\u0627\u0632\u06CC \u062E\u0648\u062F\u06A9\u0627\u0631 \u0627\u0645\u0646 \u0646\u06CC\u0633\u062A\u061B \u0627\u06CC\u0646 \u0633\u0631\u0648\u0631 \u062F\u0627\u062F\u0647 \u0648\u0627\u0628\u0633\u062A\u0647 \u062F\u0627\u0631\u062F \u0648 \u0628\u0627\u06CC\u062F \u0628\u0631\u0631\u0633\u06CC \u0634\u0648\u062F.',JOB_ALREADY_PENDING:'\u06CC\u06A9 \u06A9\u0627\u0631 \u062F\u0631 \u062D\u0627\u0644 \u0627\u062C\u0631\u0627 \u062F\u0627\u0631\u06CC.',FAILED_INSTALL_REQUIRED:'\u062F\u0631\u062E\u0648\u0627\u0633\u062A \u0646\u0635\u0628 \u0646\u0627\u0645\u0648\u0641\u0642 \u0642\u0628\u0644\u06CC \u067E\u06CC\u062F\u0627 \u0646\u0634\u062F\u061B \u0635\u0641\u062D\u0647 \u0631\u0627 \u0627\u0632 \u0631\u0628\u0627\u062A \u062F\u0648\u0628\u0627\u0631\u0647 \u0628\u0627\u0632 \u06A9\u0646.',NODE_NOT_INSTALLED:'\u0641\u0642\u0637 \u0633\u0631\u0648\u0631 \u0646\u0635\u0628\u200C\u0634\u062F\u0647 \u0645\u062A\u0639\u0644\u0642 \u0628\u0647 \u0627\u06CC\u0646 \u0645\u062F\u06CC\u0631 \u0642\u0627\u0628\u0644 \u067E\u0627\u06A9\u200C\u0633\u0627\u0632\u06CC \u0627\u0633\u062A.',NODE_HAS_ACTIVE_OR_USED_ACCOUNTS:'\u0633\u0631\u0648\u0631 \u062F\u0627\u0631\u0627\u06CC \u0627\u0634\u062A\u0631\u0627\u06A9 \u0641\u0639\u0627\u0644 \u06CC\u0627 \u0645\u0635\u0631\u0641\u200C\u0634\u062F\u0647 \u0627\u0633\u062A. \u067E\u0627\u06A9\u200C\u0633\u0627\u0632\u06CC \u0628\u062F\u0648\u0646 \u062A\u0639\u06CC\u06CC\u0646 \u062A\u06A9\u0644\u06CC\u0641 \u0645\u0634\u062A\u0631\u06CC\u0627\u0646 \u0645\u062C\u0627\u0632 \u0646\u06CC\u0633\u062A.',NODE_HAS_LIVE_TRIAL:'\u0644\u06CC\u0646\u06A9 \u0622\u0632\u0645\u0627\u06CC\u0634\u06CC \u0647\u0646\u0648\u0632 \u0645\u0639\u062A\u0628\u0631 \u0627\u0633\u062A\u061B \u067E\u0633 \u0627\u0632 \u067E\u0627\u06CC\u0627\u0646 \u0627\u0639\u062A\u0628\u0627\u0631 \u0627\u0642\u062F\u0627\u0645 \u06A9\u0646.',NODE_HAS_PAID_ORDERS:'\u0633\u0641\u0627\u0631\u0634 \u067E\u0631\u062F\u0627\u062E\u062A\u200C\u0634\u062F\u0647 \u06CC\u0627 \u0631\u0633\u06CC\u062F \u062A\u0623\u06CC\u06CC\u062F\u0634\u062F\u0647 \u0628\u0647 \u0627\u06CC\u0646 \u0633\u0631\u0648\u0631 \u0648\u0627\u0628\u0633\u062A\u0647 \u0627\u0633\u062A.',RESET_HOST_MISMATCH:'IP \u062B\u0628\u062A\u200C\u0634\u062F\u0647 \u0628\u0631\u0627\u06CC \u0627\u06CC\u0646 \u0633\u0631\u0648\u0631 \u0628\u0627 \u0633\u0631\u0648\u0631 \u0645\u062A\u0635\u0644\u200C\u0634\u062F\u0647 \u0645\u0637\u0627\u0628\u0642\u062A \u0646\u062F\u0627\u0631\u062F.',RESET_EXPLICIT_CONSENT_REQUIRED:'\u062A\u0623\u06CC\u06CC\u062F \u0635\u0631\u06CC\u062D \u0646\u0627\u0645 \u0633\u0631\u0648\u0631 \u0648 \u062A\u0637\u0628\u06CC\u0642 \u0627\u062B\u0631 \u0627\u0646\u06AF\u0634\u062A \u0644\u0627\u0632\u0645 \u0627\u0633\u062A.',RESET_QUARANTINE_FAILED:'\u0627\u0645\u06A9\u0627\u0646 \u062C\u062F\u0627\u0633\u0627\u0632\u06CC \u0627\u06CC\u0645\u0646 \u0633\u0631\u0648\u0631 \u0627\u0632 \u0635\u062F\u0648\u0631 \u06A9\u0627\u0646\u0641\u06CC\u06AF \u0648\u062C\u0648\u062F \u0646\u062F\u0627\u0631\u062F.',RESET_BLOCKED:'\u067E\u0627\u06A9\u200C\u0633\u0627\u0632\u06CC \u0631\u0648\u06CC VPS \u0628\u0647\u200C\u062F\u0644\u06CC\u0644 \u0648\u062C\u0648\u062F \u062F\u0627\u062F\u0647 \u0645\u0635\u0631\u0641 \u06CC\u0627 \u0641\u0627\u06CC\u0644\u200C\u0647\u0627\u06CC \u0646\u0627\u0634\u0646\u0627\u0633 \u0645\u062A\u0648\u0642\u0641 \u0634\u062F.',RESET_PREFLIGHT_BLOCKED:'\u067E\u0627\u06A9\u200C\u0633\u0627\u0632\u06CC \u0642\u0628\u0644 \u0627\u0632 \u0647\u0631 \u062A\u063A\u06CC\u06CC\u0631\u06CC \u0631\u0648\u06CC VPS \u0645\u062A\u0648\u0642\u0641 \u0634\u062F. \u0648\u0636\u0639\u06CC\u062A \u0642\u0628\u0644\u06CC \u0633\u0631\u0648\u0631 \u0648 \u0627\u0637\u0644\u0627\u0639\u0627\u062A \u0622\u0646 \u062D\u0641\u0638 \u0634\u062F\u0646\u062F\u061B \u0633\u0644\u0627\u0645\u062A \u0627\u062A\u0635\u0627\u0644 \u0628\u0627\u06CC\u062F \u062F\u0648\u0628\u0627\u0631\u0647 \u062A\u0623\u06CC\u06CC\u062F \u0634\u0648\u062F.',RESET_CLEANUP_FAILED:'\u067E\u0627\u06A9\u200C\u0633\u0627\u0632\u06CC \u0631\u0648\u06CC \u0633\u0631\u0648\u0631 \u06A9\u0627\u0645\u0644 \u0646\u0634\u062F\u061B \u0648\u0636\u0639\u06CC\u062A \u0631\u0627 \u0642\u0628\u0644 \u0627\u0632 \u062A\u0644\u0627\u0634 \u0645\u062C\u062F\u062F \u0628\u0631\u0631\u0633\u06CC \u06A9\u0646.',RESET_DB_FINALIZATION_FAILED:'\u067E\u0627\u06A9\u200C\u0633\u0627\u0632\u06CC \u0633\u0645\u062A \u0633\u0631\u0648\u0631 \u06AF\u0632\u0627\u0631\u0634 \u0634\u062F \u0648\u0644\u06CC \u0628\u0633\u062A\u0646 \u0639\u0645\u0644\u06CC\u0627\u062A \u062F\u0631 \u062F\u06CC\u062A\u0627\u0628\u06CC\u0633 \u06A9\u0627\u0645\u0644 \u0646\u0634\u062F\u061B \u062F\u0648\u0628\u0627\u0631\u0647 \u0646\u0635\u0628 \u0646\u06A9\u0646.'};
async function api(path,data){const r=await fetch('/api/enrollment/'+path,{method:data?'POST':'GET',headers:{'content-type':'application/json','x-telegram-init-data':auth},...(data?{body:JSON.stringify(data)}:{})});const b=await r.json();if(!r.ok)throw Error(errors[b.error]||'\u0639\u0645\u0644\u06CC\u0627\u062A \u0627\u0646\u062C\u0627\u0645 \u0646\u0634\u062F\u061B \u062F\u0648\u0628\u0627\u0631\u0647 \u062A\u0644\u0627\u0634 \u06A9\u0646.');return b;}
const b64=b=>btoa(String.fromCharCode(...new Uint8Array(b)));
function restoreSpec(spec){
  if(!spec)return;
  for(const id of ['nodeId','provider','region','ip','username'])
    if(typeof spec[id]==='string')el(id).value=spec[id];
  for(const id of ['userLimit','capacityGb','port'])
    if(Number.isInteger(spec[id]))el(id).value=String(spec[id]);
}
async function restoreJob(){
  const {job,failedInstall}=await api('recent');
  if(!job)return status('\u0622\u0645\u0627\u062F\u0647 \u0628\u0631\u0631\u0633\u06CC \u0633\u0631\u0648\u0631.');
  restoreSpec(job.spec);
  if(job.cleanup&&job.state==='ready'&&job.safe_code==='RESET_COMPLETED'){
    installedProbe=false;
    el('credentials').hidden=true;
    const oldId=job.spec.nodeId;
    el('nodeId').value=oldId.slice(0,55)+'-new1';
    return status('\u067E\u0627\u06A9\u200C\u0633\u0627\u0632\u06CC \u0627\u062E\u062A\u0635\u0627\u0635\u06CC V2 \u062F\u0631 VPS \u062A\u0623\u06CC\u06CC\u062F \u0634\u062F \u0648 \u0633\u0631\u0648\u0631 \u0642\u0628\u0644\u06CC \u0628\u0627\u0632\u0646\u0634\u0633\u062A\u0647 \u0634\u062F. \u0627\u06A9\u0646\u0648\u0646 \u0634\u0646\u0627\u0633\u0647 \u062C\u062F\u06CC\u062F \u0631\u0627 \u0628\u0631\u0631\u0633\u06CC \u06A9\u0646 \u0648 \u0646\u0635\u0628 \u0631\u0627 \u0627\u0632 \u0627\u0628\u062A\u062F\u0627 \u0627\u0646\u062C\u0627\u0645 \u0628\u062F\u0647.');
  }
  if(job.kind==='v2-install'&&job.diagnostic&&job.state==='ready'&&
     job.safe_code==='DIAG_PRECHECK_OK'&&failedInstall?.id){
    showDiagnoseForInstall(failedInstall.id,failedInstall.fingerprint,job.spec.nodeId);
    diagnosticId=job.id;
    el('diagnose').hidden=true;el('diagnoseNote').hidden=true;
    el('clearFailed').hidden=false;el('clearFailed').disabled=false;
    return status('\u0639\u06CC\u0628\u200C\u06CC\u0627\u0628\u06CC \u0645\u0648\u0641\u0642 \u0628\u0648\u062F. \u0627\u06AF\u0631 VPS \u0647\u0645\u0627\u0646 \u0633\u0631\u0648\u0631 \u067E\u0627\u06A9 \u0648 \u0622\u0645\u0627\u062F\u0647 \u0627\u0633\u062A\u060C \u062B\u0628\u062A \u0646\u0635\u0628 \u0646\u0627\u0645\u0648\u0641\u0642 \u0631\u0627 \u067E\u0627\u06A9 \u06A9\u0646 \u0648 \u0627\u062A\u0635\u0627\u0644 \u0631\u0627 \u062F\u0648\u0628\u0627\u0631\u0647 \u0628\u0631\u0631\u0633\u06CC \u06A9\u0646.');
  }
  if(failedInstall?.id&&failedInstall?.fingerprint){
    showDiagnoseForInstall(failedInstall.id,failedInstall.fingerprint,job.spec.nodeId);
    return status('\u0646\u0635\u0628 \u0642\u0628\u0644\u06CC \u0627\u06CC\u0646 \u0634\u0646\u0627\u0633\u0647 \u0646\u0627\u0645\u0648\u0641\u0642 \u0628\u0648\u062F\u0647 \u0627\u0633\u062A: '+
      (installDetails[failedInstall.safe_code]||'\u0645\u0631\u062D\u0644\u0647 \u0646\u0635\u0628 \u0631\u0648\u06CC VPS \u0634\u06A9\u0633\u062A \u062E\u0648\u0631\u062F\u0647 \u0627\u0633\u062A.')+
      ' \u0628\u0631\u0627\u06CC \u062C\u0644\u0648\u06AF\u06CC\u0631\u06CC \u0627\u0632 \u0646\u0635\u0628 \u062A\u06A9\u0631\u0627\u0631\u06CC\u060C \u0627\u0628\u062A\u062F\u0627 \xAB\u0639\u06CC\u0628\u200C\u06CC\u0627\u0628\u06CC \u0628\u062F\u0648\u0646 \u0646\u0635\u0628\xBB \u0631\u0627 \u0628\u0632\u0646.');
  }
  if(job.kind==='probe'&&job.state==='ready'&&job.fingerprint){
    if(job.expires_ms<=Date.now()+5000)
      return status('\u0645\u0647\u0644\u062A \u0627\u0639\u062A\u0628\u0627\u0631 \u0628\u0631\u0631\u0633\u06CC \u0642\u0628\u0644\u06CC (\u06F1\u06F0 \u062F\u0642\u06CC\u0642\u0647) \u062A\u0645\u0627\u0645 \u0634\u062F\u0647 \u0627\u0633\u062A. \u062F\u0648\u0628\u0627\u0631\u0647 \xAB\u0628\u0631\u0631\u0633\u06CC \u0627\u062A\u0635\u0627\u0644\xBB \u0631\u0627 \u0628\u0632\u0646.');
    probeExpires=job.expires_ms;
    probeId=job.id;fingerprint=job.fingerprint;
    el('fingerprint').textContent=fingerprint;
    el('credentials').hidden=false;
    if((await api('jobs/'+job.id)).installed)return showInstalledProbe();
    el('install').disabled=false;
    return status('\u0628\u0631\u0631\u0633\u06CC \u0642\u0628\u0644\u06CC \u0628\u0627\u0632\u06CC\u0627\u0628\u06CC \u0634\u062F. \u0641\u0642\u0637 \u067E\u0633 \u0627\u0632 \u062A\u0637\u0628\u06CC\u0642 \u0627\u062B\u0631 \u0627\u0646\u06AF\u0634\u062A\u060C \u0646\u0635\u0628 \u0631\u0627 \u0627\u062F\u0627\u0645\u0647 \u0628\u062F\u0647.');
  }
  if(job.cleanup&&job.state==='failed'){
    installedProbe=false;
    return status(job.safe_code==='RESET_PREFLIGHT_BLOCKED'?'\u067E\u0627\u06A9\u200C\u0633\u0627\u0632\u06CC \u0642\u0628\u0644 \u0627\u0632 \u0647\u0631 \u062A\u063A\u06CC\u06CC\u0631\u06CC \u0631\u062F \u0634\u062F \u0648 \u0633\u0631\u0648\u0631 \u0628\u0647 \u0648\u0636\u0639\u06CC\u062A \u0642\u0628\u0644\u06CC \u0628\u0631\u06AF\u0634\u062A. \u0647\u06CC\u0686 \u062F\u0627\u062F\u0647\u200C\u0627\u06CC \u062D\u0630\u0641 \u0646\u0634\u062F\u061B \u067E\u06CC\u0634 \u0627\u0632 \u0635\u062F\u0648\u0631 \u06A9\u0627\u0646\u0641\u06CC\u06AF \u0633\u0644\u0627\u0645\u062A Agent \u0631\u0627 \u0628\u0631\u0631\u0633\u06CC \u06A9\u0646.':'\u067E\u0627\u06A9\u200C\u0633\u0627\u0632\u06CC \u0633\u0631\u0648\u0631 \u06A9\u0627\u0645\u0644 \u0646\u0634\u062F\u0647 \u0627\u0633\u062A. \u0633\u0631\u0648\u06CC\u0633 \u0645\u0645\u06A9\u0646 \u0627\u0633\u062A \u0646\u06CC\u0645\u0647\u200C\u067E\u0627\u06A9 \u0634\u062F\u0647 \u0628\u0627\u0634\u062F\u061B \u0628\u062F\u0648\u0646 \u0628\u0631\u0631\u0633\u06CC \u0648\u0636\u0639\u06CC\u062A VPS\u060C \u0646\u0635\u0628 \u0645\u062C\u062F\u062F \u0631\u0627 \u0622\u063A\u0627\u0632 \u0646\u06A9\u0646.');
  }
  if(job.kind==='v2-install'&&job.state==='failed'&&!job.diagnostic&&!job.cleanup&&job.fingerprint){
    showDiagnoseForInstall(job.id,job.fingerprint,job.spec.nodeId);
    return status('\u0646\u0635\u0628 \u0642\u0628\u0644\u06CC \u0646\u0627\u0645\u0648\u0641\u0642 \u0628\u0648\u062F: '+('\u062E\u0637\u0627\u06CC \u0646\u0627\u0645\u0634\u062E\u0635 \u062F\u0631 \u0646\u0635\u0628')+'. \u0628\u0631\u0627\u06CC \u0628\u0631\u0631\u0633\u06CC \u0628\u062F\u0648\u0646 \u0646\u0635\u0628 \u062F\u0648\u0628\u0627\u0631\u0647 \u0627\u0637\u0644\u0627\u0639\u0627\u062A \u0648\u0631\u0648\u062F \u0631\u0627 \u0648\u0627\u0631\u062F \u06A9\u0646.');
  }
  if(job.kind==='v2-install'&&job.diagnostic&&['failed','ready'].includes(job.state))
    return status(diagnosisMessage(job.safe_code));
  if(job.state==='queued'||job.state==='leased'){
    busy=true;el('probe').disabled=true;lock(true);
    status('\u062F\u0631\u062E\u0648\u0627\u0633\u062A \u0642\u0628\u0644\u06CC \u0628\u0627\u0632\u06CC\u0627\u0628\u06CC \u0634\u062F\u061B \u062F\u0631 \u062D\u0627\u0644 \u0628\u0631\u0631\u0633\u06CC \u0646\u062A\u06CC\u062C\u0647\u2026');
    return poll(job.id,job.kind==='probe'?'probe':job.cleanup?'cleanup':job.diagnostic?'diagnose':'install');
  }
  if(job.state==='failed')
    return status('\u0628\u0631\u0631\u0633\u06CC \u0642\u0628\u0644\u06CC \u0646\u0627\u0645\u0648\u0641\u0642 \u0628\u0648\u062F: '+'\u062E\u0637\u0627\u06CC \u0646\u0627\u0645\u0634\u062E\u0635 \u062F\u0631 \u0628\u0631\u0631\u0633\u06CC'+'. \u0645\u06CC\u200C\u062A\u0648\u0627\u0646\u06CC \u062F\u0648\u0628\u0627\u0631\u0647 \u0628\u0631\u0631\u0633\u06CC \u06A9\u0646\u06CC.');
  status('\u062F\u0631\u062E\u0648\u0627\u0633\u062A \u0642\u0628\u0644\u06CC \u067E\u0627\u06CC\u0627\u0646 \u06CC\u0627\u0641\u062A\u0647 \u0627\u0633\u062A\u061B \u0628\u0631\u0627\u06CC \u0633\u0631\u0648\u0631 \u062F\u06CC\u06AF\u0631\u060C \u0627\u0637\u0644\u0627\u0639\u0627\u062A \u0631\u0627 \u062A\u063A\u06CC\u06CC\u0631 \u0628\u062F\u0647.');
}
async function encrypt(value){const rsa=await crypto.subtle.importKey('jwk',publicKey,{name:'RSA-OAEP',hash:'SHA-256'},false,['encrypt']);const aes=await crypto.subtle.generateKey({name:'AES-GCM',length:256},true,['encrypt']);const iv=crypto.getRandomValues(new Uint8Array(12));const data=await crypto.subtle.encrypt({name:'AES-GCM',iv},aes,new TextEncoder().encode(JSON.stringify(value)));const key=await crypto.subtle.encrypt('RSA-OAEP',rsa,await crypto.subtle.exportKey('raw',aes));return {v:1,key:b64(key),iv:b64(iv),data:b64(data)};}
function lock(value){for(const id of ['nodeId','provider','region','userLimit','capacityGb','ip','port','username'])el(id).disabled=value;}
const diagnosticDetail={
  DIAG_RUNTIME_STARTED:'\u0639\u0627\u0645\u0644 \u0645\u062F\u0627\u0631 \u0631\u0627\u0647\u200C\u0627\u0646\u062F\u0627\u0632\u06CC \u0634\u062F. \u0648\u0636\u0639\u06CC\u062A \u0633\u0641\u0627\u0631\u0634 \u0631\u0627 \u062F\u0631 \u0631\u0628\u0627\u062A \u0628\u0631\u0631\u0633\u06CC \u06A9\u0646.',
  DIAG_RUNTIME_START_FAILED:'\u0639\u0627\u0645\u0644 \u0645\u062F\u0627\u0631 \u0631\u0627\u0647\u200C\u0627\u0646\u062F\u0627\u0632\u06CC \u0646\u0634\u062F.',
  DIAG_RUNTIME_ACTIVE:'\u0639\u0627\u0645\u0644 \u0648 Xray \u0641\u0639\u0627\u0644 \u0647\u0633\u062A\u0646\u062F \u0648 \u062E\u0637\u0627\u06CC \u062A\u0627\u0632\u0647\u200C\u0627\u06CC \u062F\u0631 \u0644\u0627\u06AF \u0639\u0627\u0645\u0644 \u062F\u06CC\u062F\u0647 \u0646\u0634\u062F.',
  DIAG_RUNTIME_DOWN:'\u0639\u0627\u0645\u0644 \u0645\u062F\u0627\u0631 \u0641\u0639\u0627\u0644 \u0646\u06CC\u0633\u062A.',
  DIAG_XRAY_DOWN:'\u0633\u0631\u0648\u06CC\u0633 Xray \u0641\u0639\u0627\u0644 \u0646\u06CC\u0633\u062A.',
  DIAG_RUNTIME_GENERATION:'\u0639\u0627\u0645\u0644 \u062A\u063A\u06CC\u06CC\u0631 \u067E\u0631\u062F\u0627\u0632\u0634 Xray \u0631\u0627 \u062A\u0634\u062E\u06CC\u0635 \u062F\u0627\u062F\u0647 \u0648 \u0634\u0645\u0627\u0631\u0634 \u0645\u0635\u0631\u0641 \u0646\u06CC\u0627\u0632 \u0628\u0647 \u0628\u0631\u0631\u0633\u06CC \u062F\u0627\u0631\u062F.',
  DIAG_RUNTIME_ERROR:'\u0639\u0627\u0645\u0644 \u0645\u062F\u0627\u0631 \u0627\u062E\u06CC\u0631\u0627\u064B \u062E\u0637\u0627\u06CC \u0627\u062C\u0631\u0627 \u06CC\u0627 \u0627\u0631\u062A\u0628\u0627\u0637 \u062B\u0628\u062A \u06A9\u0631\u062F\u0647 \u0627\u0633\u062A.',
  DIAG_EXISTING_VPN:'\u0631\u0648\u06CC \u0633\u0631\u0648\u0631 \u0641\u0627\u06CC\u0644 \u06CC\u0627 \u0633\u0631\u0648\u06CC\u0633 VPN \u0642\u0628\u0644\u06CC \u0648\u062C\u0648\u062F \u062F\u0627\u0631\u062F\u061B \u0646\u0635\u0628 \u0627\u06CC\u0645\u0646 \u0646\u06CC\u0627\u0632 \u0628\u0647 VPS \u062A\u0627\u0632\u0647 \u0648 \u062E\u0627\u0644\u06CC \u062F\u0627\u0631\u062F. \u0628\u062F\u0648\u0646 \u062D\u0630\u0641 \u062F\u0633\u062A\u06CC\u060C \u0627\u0632 \u0627\u0631\u0627\u0626\u0647\u200C\u062F\u0647\u0646\u062F\u0647 \u0628\u0627\u0632\u0633\u0627\u0632\u06CC \u0633\u0631\u0648\u0631 \u0631\u0627 \u062F\u0631\u062E\u0648\u0627\u0633\u062A \u06A9\u0646.',
  DIAG_PORT_443_BUSY:'\u067E\u0648\u0631\u062A 443 \u0633\u0631\u0648\u0631 \u062A\u0648\u0633\u0637 \u0633\u0631\u0648\u06CC\u0633 \u062F\u06CC\u06AF\u0631\u06CC \u0627\u0634\u063A\u0627\u0644 \u0634\u062F\u0647 \u0627\u0633\u062A.',
  DIAG_PORT_8443_BUSY:'\u067E\u0648\u0631\u062A 8443 \u0633\u0631\u0648\u0631 \u062A\u0648\u0633\u0637 \u0633\u0631\u0648\u06CC\u0633 \u062F\u06CC\u06AF\u0631\u06CC \u0627\u0634\u063A\u0627\u0644 \u0634\u062F\u0647 \u0627\u0633\u062A.',
  DIAG_UNSUPPORTED_OS:'\u0633\u06CC\u0633\u062A\u0645\u200C\u0639\u0627\u0645\u0644 \u0633\u0631\u0648\u0631 Ubuntu \u06CC\u0627 Debian \u0646\u06CC\u0633\u062A\u061B \u0646\u0635\u0628 \u0622\u0632\u0645\u0627\u06CC\u0634\u06CC V2 \u0641\u0642\u0637 \u0627\u06CC\u0646 \u062F\u0648 \u0631\u0627 \u067E\u0634\u062A\u06CC\u0628\u0627\u0646\u06CC \u0645\u06CC\u200C\u06A9\u0646\u062F.',
  DIAG_NO_ROOT:'\u062F\u0633\u062A\u0631\u0633\u06CC \u0631\u06CC\u0634\u0647 \u0628\u0631\u0627\u06CC \u0627\u062C\u0631\u0627\u06CC \u0646\u0635\u0628 \u0648\u062C\u0648\u062F \u0646\u062F\u0627\u0631\u062F.',
  DIAG_SYSTEMD_MISSING:'\u067E\u06CC\u0634\u200C\u0646\u06CC\u0627\u0632\u0647\u0627\u06CC systemd \u06CC\u0627 useradd \u0631\u0648\u06CC \u0633\u0631\u0648\u0631 \u0648\u062C\u0648\u062F \u0646\u062F\u0627\u0631\u0646\u062F.',
  DIAG_GITHUB_UNREACHABLE:'\u062F\u0631\u06CC\u0627\u0641\u062A \u0646\u0633\u062E\u0647 Xray \u0627\u0632 GitHub \u0627\u0632 \u062F\u0627\u062E\u0644 \u0633\u0631\u0648\u0631 \u0645\u0645\u06A9\u0646 \u0646\u06CC\u0633\u062A\u061B \u0645\u062D\u062F\u0648\u062F\u06CC\u062A \u0634\u0628\u06A9\u0647 \u062E\u0631\u0648\u062C\u06CC \u0631\u0627 \u0628\u0631\u0631\u0633\u06CC \u06A9\u0646.',
  DIAG_PRECHECK_OK:'\u067E\u06CC\u0634\u200C\u0646\u06CC\u0627\u0632\u0647\u0627\u06CC \u0627\u0648\u0644\u06CC\u0647 \u0628\u0631\u0642\u0631\u0627\u0631\u0646\u062F\u061B \u0634\u06A9\u0633\u062A \u0646\u0635\u0628 \u062F\u0631 \u0645\u0631\u062D\u0644\u0647 \u062F\u0627\u062E\u0644\u06CC \u062F\u06CC\u06AF\u0631\u06CC \u0631\u062E \u062F\u0627\u062F\u0647 \u0627\u0633\u062A \u0648 \u0646\u06CC\u0627\u0632 \u0628\u0647 \u0628\u0631\u0631\u0633\u06CC \u062F\u0642\u06CC\u0642\u200C\u062A\u0631 \u0627\u0633\u06A9\u0631\u06CC\u067E\u062A \u062F\u0627\u0631\u062F.',
  DIAG_REMOTE_FAILED:'\u0628\u0631\u0631\u0633\u06CC \u0627\u0632 \u062F\u0627\u062E\u0644 VPS \u06A9\u0627\u0645\u0644 \u0646\u0634\u062F. \u0627\u06CC\u0646 \u067E\u06CC\u0627\u0645 \u0628\u0647 \u0645\u0639\u0646\u06CC \u0627\u062C\u0631\u0627\u06CC \u0646\u0635\u0628 \u0646\u06CC\u0633\u062A.'
};
function diagnosisMessage(code){
  return '\u0646\u062A\u06CC\u062C\u0647 \u0639\u06CC\u0628\u200C\u06CC\u0627\u0628\u06CC \u0628\u062F\u0648\u0646 \u0646\u0635\u0628: '+(diagnosticDetail[code]||'\u062E\u0637\u0627\u06CC \u0646\u0627\u0645\u0634\u062E\u0635 \u062F\u0631 \u0639\u06CC\u0628\u200C\u06CC\u0627\u0628\u06CC \u0631\u062E \u062F\u0627\u062F.');
}
function showDiagnoseForInstall(id,fp,nodeId=el('nodeId').value.trim()){
  failedInstallId=id;failedNodeId=nodeId;fingerprint=fp;probeId=null;probeExpires=0;
  diagnosticId=null;el('clearFailed').hidden=true;el('clearFailed').disabled=true;
  el('fingerprint').textContent=fp;
  el('credentials').hidden=false;
  el('trust').checked=false;
  el('install').disabled=true;
  el('diagnose').hidden=false;
  el('diagnose').disabled=false;
  el('diagnoseNote').hidden=false;
}
const installDetails={SSH_TIMEOUT:'\u0645\u0647\u0644\u062A \u0627\u062A\u0635\u0627\u0644 SSH \u062A\u0645\u0627\u0645 \u0634\u062F.',SSH_REFUSED:'\u0627\u062A\u0635\u0627\u0644 SSH \u0631\u062F \u0634\u062F.',SSH_UNREACHABLE:'\u0645\u0633\u06CC\u0631 SSH \u062F\u0631 \u062F\u0633\u062A\u0631\u0633 \u0646\u06CC\u0633\u062A.',SSH_HANDSHAKE_FAILED:'\u067E\u0627\u0633\u062E SSH \u0645\u0639\u062A\u0628\u0631 \u062F\u0631\u06CC\u0627\u0641\u062A \u0646\u0634\u062F.',PROBE_EXPIRED:'\u0645\u0647\u0644\u062A \u0628\u0631\u0631\u0633\u06CC \u067E\u0627\u06CC\u0627\u0646 \u06CC\u0627\u0641\u062A.',SSH_PROBE_FAILED:'\u0628\u0631\u0631\u0633\u06CC SSH \u0646\u0627\u0645\u0648\u0641\u0642 \u0628\u0648\u062F.',SSH_AUTH_FAILED:'\u0646\u0627\u0645 \u06A9\u0627\u0631\u0628\u0631\u06CC \u06CC\u0627 \u0631\u0645\u0632 SSH \u067E\u0630\u06CC\u0631\u0641\u062A\u0647 \u0646\u0634\u062F.',SSH_LOGIN_FAILED:'\u0648\u0631\u0648\u062F SSH \u06A9\u0627\u0645\u0644 \u0646\u0634\u062F.',HOST_KEY_CHANGED:'\u0627\u062B\u0631 \u0627\u0646\u06AF\u0634\u062A \u0633\u0631\u0648\u0631 \u062A\u063A\u06CC\u06CC\u0631 \u06A9\u0631\u062F\u0647 \u0627\u0633\u062A.',INVALID_SSH_KEY:'\u06A9\u0644\u06CC\u062F SSH \u0645\u0639\u062A\u0628\u0631 \u0646\u06CC\u0633\u062A.',CREDENTIALS_EXPIRED:'\u0627\u0639\u062A\u0628\u0627\u0631 \u062F\u0631\u062E\u0648\u0627\u0633\u062A \u0646\u0635\u0628 \u067E\u0627\u06CC\u0627\u0646 \u06CC\u0627\u0641\u062A.',CREDENTIAL_DECRYPT_FAILED:'\u0627\u0637\u0644\u0627\u0639\u0627\u062A \u0648\u0631\u0648\u062F \u0631\u0645\u0632\u06AF\u0634\u0627\u06CC\u06CC \u0646\u0634\u062F.',REMOTE_INSTALL_FAILED:'\u0648\u0631\u0648\u062F SSH \u0645\u0648\u0641\u0642 \u0628\u0648\u062F \u0627\u0645\u0627 \u0627\u062C\u0631\u0627\u06CC \u0641\u0631\u0645\u0627\u0646 \u0646\u0635\u0628 \u0631\u0648\u06CC VPS \u0634\u06A9\u0633\u062A \u062E\u0648\u0631\u062F.',INSTALL_REPORT_FAILED:'\u0646\u062A\u06CC\u062C\u0647 \u0646\u0635\u0628 \u0642\u0627\u0628\u0644 \u062B\u0628\u062A \u0646\u0628\u0648\u062F.'};
Object.assign(installDetails,{
  REMOTE_PACKAGE_FAILED:'\u0622\u0645\u0627\u062F\u0647\u200C\u0633\u0627\u0632\u06CC \u0628\u0633\u062A\u0647 \u0646\u0635\u0628 \u0631\u0648\u06CC \u0633\u0631\u0648\u0631 \u06A9\u0627\u0645\u0644 \u0646\u0634\u062F.',
  REMOTE_BOOTSTRAP_FAILED:'\u0646\u0635\u0628 \u0627\u0648\u0644\u06CC\u0647 \u06CC\u0627 \u0631\u0627\u0647\u200C\u0627\u0646\u062F\u0627\u0632\u06CC \u0633\u0631\u0648\u06CC\u0633 REALITY \u0631\u0648\u06CC \u067E\u0648\u0631\u062A 8443 \u0646\u0627\u0645\u0648\u0641\u0642 \u0628\u0648\u062F.',
  REMOTE_DUAL_FAILED:'\u0641\u0639\u0627\u0644\u200C\u0633\u0627\u0632\u06CC \u0647\u0645\u200C\u0632\u0645\u0627\u0646 \u067E\u0648\u0631\u062A\u200C\u0647\u0627\u06CC 443 \u0648 8443 \u0646\u0627\u0645\u0648\u0641\u0642 \u0628\u0648\u062F\u061B \u0648\u0636\u0639\u06CC\u062A \u0628\u0627\u0632\u06AF\u0634\u062A \u0628\u0627\u06CC\u062F \u0628\u0631\u0631\u0633\u06CC \u0634\u0648\u062F.',
  REMOTE_METADATA_FAILED:'\u062E\u0648\u0627\u0646\u062F\u0646 \u0646\u062A\u06CC\u062C\u0647 \u0646\u0635\u0628 \u0628\u0631\u0627\u06CC \u062B\u0628\u062A \u062F\u0631 \u0645\u062F\u0627\u0631 \u0646\u0627\u0645\u0648\u0641\u0642 \u0628\u0648\u062F.'
});
function showInstalledProbe(){
  installedProbe=true;
  el('resetInstalled').hidden=false;el('resetInstalled').disabled=false;
  el('resetNote').hidden=false;
  el('fingerprint').textContent=fingerprint;
  el('credentials').hidden=false;
  el('install').disabled=true;
  el('diagnose').hidden=false;el('diagnose').disabled=false;
  el('diagnoseNote').hidden=true;
  status('\u0633\u0631\u0648\u0631 \u0642\u0628\u0644\u0627\u064B \u0646\u0635\u0628 \u0634\u062F\u0647 \u0627\u0633\u062A. \u0647\u0648\u06CC\u062A \u0633\u0631\u0648\u0631 \u0631\u0627 \u062A\u0623\u06CC\u06CC\u062F \u06A9\u0646 \u0648 \u0628\u0631\u0627\u06CC \u0628\u0631\u0631\u0633\u06CC \u0639\u0627\u0645\u0644\u060C \u06A9\u0644\u06CC\u062F \u0631\u0627 \u062F\u0631 \u0647\u0645\u06CC\u0646 \u0641\u0631\u0645 \u0648\u0627\u0631\u062F \u06A9\u0646.');
}
async function poll(id,kind){
  clearTimeout(timer);
  try{
    const b=await api('jobs/'+id);
    if(b.state==='failed'){
      busy=false;lock(false);el('probe').disabled=false;
      if(kind==='install'&&b.fingerprint)showDiagnoseForInstall(id,b.fingerprint);
      status(kind==='cleanup'?'\u067E\u0627\u06A9\u200C\u0633\u0627\u0632\u06CC \u06A9\u0627\u0645\u0644 \u0646\u0634\u062F: '+(errors[b.safe_code]||'\u0648\u0636\u0639\u06CC\u062A \u0633\u0631\u0648\u0631 \u0646\u06CC\u0627\u0632\u0645\u0646\u062F \u0628\u0631\u0631\u0633\u06CC \u0627\u0633\u062A. \u0627\u0632 \u062A\u06A9\u0631\u0627\u0631 \u062E\u0648\u062F\u06A9\u0627\u0631 \u062D\u0630\u0641 \u062E\u0648\u062F\u062F\u0627\u0631\u06CC \u06A9\u0646.'):kind==='diagnose'?diagnosisMessage(b.safe_code):
        '\u0639\u0645\u0644\u06CC\u0627\u062A \u0646\u0627\u0645\u0648\u0641\u0642 \u0628\u0648\u062F: '+(installDetails[b.safe_code]||'\u062E\u0637\u0627\u06CC \u0646\u0627\u0645\u0634\u062E\u0635 \u0647\u0646\u06AF\u0627\u0645 \u0646\u0635\u0628 \u0631\u062E \u062F\u0627\u062F.'));
      return;
    }
    if(b.state==='ready'){
      busy=false;lock(false);el('probe').disabled=false;
      if(kind==='probe'){
        probeId=id;fingerprint=b.fingerprint;
        probeExpires=Date.now()+9*60*1000;
        if(b.installed){
          showInstalledProbe();
        }else if(failedInstallId&&failedNodeId===el('nodeId').value.trim()){
          showDiagnoseForInstall(failedInstallId,fingerprint,failedNodeId);
          status('\u0627\u062A\u0635\u0627\u0644 \u0628\u0631\u0642\u0631\u0627\u0631 \u0627\u0633\u062A\u060C \u0627\u0645\u0627 \u062B\u0628\u062A \u0646\u0635\u0628 \u0646\u0627\u0645\u0648\u0641\u0642 \u0642\u0628\u0644\u06CC \u0647\u0646\u0648\u0632 \u0648\u062C\u0648\u062F \u062F\u0627\u0631\u062F. \u0627\u0628\u062A\u062F\u0627 \xAB\u0639\u06CC\u0628\u200C\u06CC\u0627\u0628\u06CC \u0628\u062F\u0648\u0646 \u0646\u0635\u0628\xBB \u0631\u0627 \u0628\u0632\u0646.');
        }else{
          failedInstallId=null;failedNodeId=null;el('diagnose').hidden=true;
          el('fingerprint').textContent=fingerprint;el('credentials').hidden=false;
          el('install').disabled=false;
          status('\u0627\u062A\u0635\u0627\u0644 \u0628\u0631\u0631\u0633\u06CC \u0634\u062F. \u0647\u0648\u06CC\u062A \u0633\u0631\u0648\u0631 \u0631\u0627 \u062A\u0623\u06CC\u06CC\u062F \u0648 \u0627\u0637\u0644\u0627\u0639\u0627\u062A \u0648\u0631\u0648\u062F \u0631\u0627 \u0648\u0627\u0631\u062F \u06A9\u0646.');
        }
      }else if(kind==='cleanup'){
        el('resetInstalled').disabled=false;
        el('resetInstalled').hidden=true;el('resetNote').hidden=true;
        el('credentials').hidden=true;
        installedProbe=false;runtimeDownId=null;probeId=null;probeExpires=0;
        el('nodeId').value=el('nodeId').value.slice(0,55)+'-new1';
        status('\u2705 \u067E\u0627\u06A9\u200C\u0633\u0627\u0632\u06CC \u0627\u062E\u062A\u0635\u0627\u0635\u06CC V2 \u0631\u0648\u06CC VPS \u062A\u0623\u06CC\u06CC\u062F \u0634\u062F. \u0633\u0627\u0628\u0642\u0647 \u0633\u0631\u0648\u0631 \u0642\u062F\u06CC\u0645\u06CC \u062D\u0641\u0638 \u0648 \u062F\u0633\u062A\u0631\u0633\u06CC \u0622\u0646 \u0628\u0627\u0632\u0646\u0634\u0633\u062A\u0647 \u0634\u062F. \u0634\u0646\u0627\u0633\u0647 \u062C\u062F\u06CC\u062F \u0622\u0645\u0627\u062F\u0647 \u0627\u0633\u062A\u061B \u062F\u06A9\u0645\u0647 \xAB\u0628\u0631\u0631\u0633\u06CC \u0627\u062A\u0635\u0627\u0644\xBB \u0631\u0627 \u0628\u0632\u0646 \u0648 \u0646\u0635\u0628 \u062C\u062F\u06CC\u062F \u0631\u0627 \u0627\u0646\u062C\u0627\u0645 \u0628\u062F\u0647.');
      }else if(kind==='diagnose'){
        if(installedProbe){
          runtimeDownId=b.safe_code==='DIAG_RUNTIME_DOWN'?id:null;
          el('diagnose').textContent=runtimeDownId?'\u0631\u0627\u0647\u200C\u0627\u0646\u062F\u0627\u0632\u06CC \u0639\u0627\u0645\u0644 \u0645\u062F\u0627\u0631':'\u0639\u06CC\u0628\u200C\u06CC\u0627\u0628\u06CC \u0628\u062F\u0648\u0646 \u0646\u0635\u0628 (\u0641\u0642\u0637 \u0628\u0631\u0631\u0633\u06CC)';
          el('diagnose').disabled=false;
          status(diagnosisMessage(b.safe_code)+(runtimeDownId?' \u0628\u0631\u0627\u06CC \u0631\u0627\u0647\u200C\u0627\u0646\u062F\u0627\u0632\u06CC \u0639\u0627\u0645\u0644\u060C \u06A9\u0644\u06CC\u062F \u0631\u0627 \u062F\u0648\u0628\u0627\u0631\u0647 \u0627\u0646\u062A\u062E\u0627\u0628 \u06A9\u0646.':''));
          return;
        }
        diagnosticId=b.safe_code==='DIAG_PRECHECK_OK'?id:null;
        el('clearFailed').hidden=!diagnosticId;
        el('clearFailed').disabled=!diagnosticId;
        el('diagnose').hidden=!!diagnosticId;
        el('diagnose').disabled=false;
        status(diagnosisMessage(b.safe_code)+
          (diagnosticId?' \u062F\u0631 \u0635\u0648\u0631\u062A \u0627\u0637\u0645\u06CC\u0646\u0627\u0646 \u0627\u0632 \u062E\u0627\u0644\u06CC \u0628\u0648\u062F\u0646 VPS\u060C \u062B\u0628\u062A \u0646\u0627\u0645\u0648\u0641\u0642 \u0631\u0627 \u067E\u0627\u06A9 \u06A9\u0646.':' \u0647\u06CC\u0686 \u0646\u0635\u0628 \u06CC\u0627 \u062D\u0630\u0641\u06CC \u0627\u062C\u0631\u0627 \u0646\u0634\u062F.'));
      }else{
        el('credentials').hidden=true;
        status('\u0646\u0635\u0628 \u062B\u0628\u062A \u0634\u062F. \u0628\u0647 \u0631\u0628\u0627\u062A \u0628\u0631\u06AF\u0631\u062F \u0648 \xAB\u0635\u062F\u0648\u0631 \u06A9\u0627\u0646\u0641\u06CC\u06AF \u062A\u0633\u062A\xBB \u0631\u0627 \u0628\u0632\u0646. \u0622\u0632\u0645\u0648\u0646 \u0627\u06CC\u0646\u062A\u0631\u0646\u062A \u0648 \u0633\u0647\u0645\u06CC\u0647 \u0647\u0646\u0648\u0632 \u062C\u062F\u0627\u06AF\u0627\u0646\u0647 \u0627\u0646\u062C\u0627\u0645 \u0645\u06CC\u200C\u0634\u0648\u062F.');
      }
      return;
    }
    status(kind==='probe'?'\u062F\u0631 \u062D\u0627\u0644 \u0628\u0631\u0631\u0633\u06CC \u0627\u062A\u0635\u0627\u0644\u2026':kind==='cleanup'?'\u062F\u0631 \u062D\u0627\u0644 \u067E\u0627\u06A9\u200C\u0633\u0627\u0632\u06CC \u0627\u0645\u0646 V2 \u0631\u0648\u06CC VPS\u2026':kind==='diagnose'?'\u062F\u0631 \u062D\u0627\u0644 \u0639\u06CC\u0628\u200C\u06CC\u0627\u0628\u06CC \u0641\u0642\u0637\u200C\u062E\u0648\u0627\u0646\u062F\u0646\u06CC \u0633\u0631\u0648\u0631\u2026':'\u0646\u0635\u0628 \u062F\u0631 \u062D\u0627\u0644 \u0627\u062C\u0631\u0627\u0633\u062A\u2026');
    timer=setTimeout(()=>poll(id,kind),3000);
  }catch(e){busy=false;status('\u0627\u0631\u062A\u0628\u0627\u0637 \u0628\u0627 \u0633\u0631\u0648\u06CC\u0633 \u0628\u0631\u0642\u0631\u0627\u0631 \u0646\u0634\u062F\u061B \u062F\u0648\u0628\u0627\u0631\u0647 \u062A\u0644\u0627\u0634 \u06A9\u0646\u06CC\u062F.');}
}
el('resetInstalled').onclick=async()=>{
  if(busy||!installedProbe||!probeId||!fingerprint||!el('trust').checked||Date.now()>=probeExpires){
    status('\u0628\u0631\u0627\u06CC \u067E\u0627\u06A9\u200C\u0633\u0627\u0632\u06CC\u060C \u0627\u0628\u062A\u062F\u0627 \u0628\u0631\u0631\u0633\u06CC \u0627\u062A\u0635\u0627\u0644 \u0648 \u062A\u0637\u0628\u06CC\u0642 \u0627\u062B\u0631 \u0627\u0646\u06AF\u0634\u062A SSH \u0631\u0627 \u0627\u0646\u062C\u0627\u0645 \u0628\u062F\u0647.');return;
  }
  const nodeId=el('nodeId').value.trim();
  busy=true;el('resetInstalled').disabled=true;
  let credentials=null;
  try{
    const gate=await api('reset-check?nodeId='+encodeURIComponent(nodeId));
    if(!gate.ok)throw Error(errors[gate.code]||'\u0628\u0647 \u0639\u0644\u062A \u0627\u0637\u0644\u0627\u0639\u0627\u062A \u0648\u0627\u0628\u0633\u062A\u0647 \u0631\u0648\u06CC \u0633\u0631\u0648\u0631\u060C \u067E\u0627\u06A9\u200C\u0633\u0627\u0632\u06CC \u0645\u062C\u0627\u0632 \u0646\u06CC\u0633\u062A.');
    const count=gate.willCancelPending||0;
    const consent=prompt('\u067E\u0627\u06A9\u200C\u0633\u0627\u0632\u06CC V2 \u0631\u0648\u06CC \u0633\u0631\u0648\u0631 '+nodeId+' \u063A\u06CC\u0631\u0642\u0627\u0628\u0644 \u0628\u0627\u0632\u06AF\u0634\u062A \u0627\u0633\u062A. '+
      (count?'\u062A\u0639\u062F\u0627\u062F '+count+' \u0633\u0641\u0627\u0631\u0634 \u0622\u0632\u0645\u0627\u06CC\u0634\u06CC\u0650 \u0646\u0635\u0628\u200C\u0646\u0634\u062F\u0647 \u0644\u063A\u0648 \u0645\u06CC\u200C\u0634\u0648\u062F. ':'')+
      '\u0641\u0642\u0637 \u0641\u0627\u06CC\u0644\u200C\u0647\u0627 \u0648 \u0633\u0631\u0648\u06CC\u0633\u200C\u0647\u0627\u06CC \u0627\u062E\u062A\u0635\u0627\u0635\u06CC \u0645\u062F\u0627\u0631 \u062D\u0630\u0641 \u0645\u06CC\u200C\u0634\u0648\u0646\u062F. \u0628\u0631\u0627\u06CC \u062A\u0623\u06CC\u06CC\u062F\u060C \u0646\u0627\u0645 \u0633\u0631\u0648\u0631 \u0631\u0627 \u062F\u0642\u06CC\u0642 \u0648\u0627\u0631\u062F \u06A9\u0646:');
    if(consent!==nodeId){busy=false;el('resetInstalled').disabled=false;status('\u067E\u0627\u06A9\u200C\u0633\u0627\u0632\u06CC \u0644\u063A\u0648 \u0634\u062F\u061B \u0647\u06CC\u0686 \u0641\u0631\u0645\u0627\u0646\u06CC \u0627\u062C\u0631\u0627 \u0646\u0634\u062F.');return;}
    credentials=el('method').value==='password'
      ?{method:'password',password:el('password').value}
      :{method:'key',key:await el('keyfile').files[0]?.text(),passphrase:el('password').value};
    if(credentials.method==='password'?!credentials.password:!credentials.key)
      throw Error('\u0631\u0645\u0632 \u06CC\u0627 \u06A9\u0644\u06CC\u062F SSH \u0631\u0627 \u062F\u0631 \u0641\u0631\u0645 \u0627\u0645\u0646 \u0648\u0627\u0631\u062F \u06A9\u0646.');
    const envelope=await encrypt(credentials);credentials=null;
    const job=await api('reset',{nodeId,confirmNodeId:nodeId,confirm:'RESET_V2_ONLY',
      probeId,fingerprint,trust:true,envelope});
    el('password').value='';el('keyfile').value='';
    status('\u062F\u0631\u062E\u0648\u0627\u0633\u062A \u067E\u0627\u06A9\u200C\u0633\u0627\u0632\u06CC \u0627\u0645\u0646 \u062B\u0628\u062A \u0634\u062F\u061B \u062F\u0631 \u062D\u0627\u0644 \u062A\u0623\u06CC\u06CC\u062F \u0639\u0645\u0644\u06CC\u0627\u062A \u0627\u0632 \u0633\u0631\u0648\u0631\u2026');
    poll(job.id,'cleanup');
  }catch(e){busy=false;el('resetInstalled').disabled=false;status('\u067E\u0627\u06A9\u200C\u0633\u0627\u0632\u06CC \u0622\u063A\u0627\u0632 \u0646\u0634\u062F: '+e.message);}
  finally{credentials=null;}
};
el('clearFailed').onclick=async()=>{
  if(busy||!failedInstallId||!diagnosticId)return;
  busy=true;el('clearFailed').disabled=true;
  try{
    const result=await api('clear-failed',{failedInstallId,diagnosticId});
    if(result.status!=='CLEARED')throw Error('\u067E\u0627\u06A9\u200C\u0633\u0627\u0632\u06CC \u062A\u0623\u06CC\u06CC\u062F \u0646\u0634\u062F.');
    failedInstallId=null;failedNodeId=null;diagnosticId=null;probeId=null;probeExpires=0;fingerprint=null;
    el('credentials').hidden=true;el('clearFailed').hidden=true;
    el('keyfile').value='';el('password').value='';el('trust').checked=false;
    el('probe').disabled=false;
    status('\u062B\u0628\u062A \u0646\u0635\u0628 \u0646\u0627\u0645\u0648\u0641\u0642 \u0627\u0632 \u0645\u062F\u0627\u0631 \u067E\u0627\u06A9 \u0634\u062F. \u062F\u0648\u0628\u0627\u0631\u0647 \xAB\u0628\u0631\u0631\u0633\u06CC \u0627\u062A\u0635\u0627\u0644\xBB \u0631\u0627 \u0628\u0632\u0646 \u0648 \u0633\u067E\u0633 \u0646\u0635\u0628 \u0631\u0627 \u0622\u063A\u0627\u0632 \u06A9\u0646.');
  }catch(e){el('clearFailed').disabled=false;status('\u067E\u0627\u06A9\u200C\u0633\u0627\u0632\u06CC \u0627\u0646\u062C\u0627\u0645 \u0646\u0634\u062F: '+e.message);}
  finally{busy=false;}
};
el('diagnose').onclick=async()=>{
  if(busy||(!failedInstallId&&!installedProbe)||!fingerprint||!el('trust').checked){
    status('\u0627\u0628\u062A\u062F\u0627 \u0627\u062B\u0631 \u0627\u0646\u06AF\u0634\u062A SSH \u0642\u0628\u0644\u06CC \u0631\u0627 \u062A\u0623\u06CC\u06CC\u062F \u06A9\u0646.');return;
  }
  if(runtimeDownId&&!confirm('\u0639\u0627\u0645\u0644 \u0645\u062F\u0627\u0631 \u0631\u0648\u06CC \u0647\u0645\u06CC\u0646 \u0633\u0631\u0648\u0631 \u0631\u0627\u0647\u200C\u0627\u0646\u062F\u0627\u0632\u06CC \u0634\u0648\u062F\u061F'))return;
  busy=true;el('diagnose').disabled=true;
  let credentials;
  try{
    credentials=el('method').value==='password'
      ?{method:'password',password:el('password').value}
      :{method:'key',key:await el('keyfile').files[0]?.text(),passphrase:el('password').value};
    if(credentials.method==='password'?!credentials.password:!credentials.key)
      throw Error('\u0627\u0637\u0644\u0627\u0639\u0627\u062A \u0648\u0631\u0648\u062F \u0631\u0627 \u062F\u0631 \u0641\u0631\u0645 \u0627\u0645\u0646 \u0648\u0627\u0631\u062F \u06A9\u0646.');
    const envelope=await encrypt(credentials);
    credentials=null;
    const job=await api(installedProbe?'diagnose-installed':'diagnose',{failedInstallId,probeId,fingerprint,trust:true,envelope,startRuntime:!!runtimeDownId,diagnosticId:runtimeDownId});
    el('password').value='';el('keyfile').value='';
    status('\u0639\u06CC\u0628\u200C\u06CC\u0627\u0628\u06CC \u0628\u062F\u0648\u0646 \u0646\u0635\u0628 \u0634\u0631\u0648\u0639 \u0634\u062F\u2026');
    poll(job.id,'diagnose');
  }catch(e){busy=false;el('diagnose').disabled=false;status('\u0639\u06CC\u0628\u200C\u06CC\u0627\u0628\u06CC \u0622\u063A\u0627\u0632 \u0646\u0634\u062F: '+e.message+' \u0641\u0627\u06CC\u0644 \u06A9\u0644\u06CC\u062F \u0631\u0627 \u062F\u0648\u0628\u0627\u0631\u0647 \u0627\u0646\u062A\u062E\u0627\u0628 \u0646\u06A9\u0646\u061B \u0647\u0645\u06CC\u0646\u200C\u062C\u0627 \u0645\u06CC\u200C\u062A\u0648\u0627\u0646\u06CC \u062A\u0644\u0627\u0634 \u06A9\u0646\u06CC.');}
  finally{credentials=null;}
};

el('pairRunner').onclick=async()=>{
  el('pairRunner').disabled=true;
  try{
    const r=await api('pair-runner',{});
    el('pairingStatus').textContent=r.status==='RUNNER_CONNECTED'
      ?'\u0631\u0627\u0646\u0631 V2 \u0627\u0632 \u0642\u0628\u0644 \u0645\u062A\u0635\u0644 \u0627\u0633\u062A\u061B \u0635\u0641\u062D\u0647 \u0631\u0627 \u0627\u0632 \u0631\u0628\u0627\u062A \u062F\u0648\u0628\u0627\u0631\u0647 \u0628\u0627\u0632 \u06A9\u0646.'
      :'\u0627\u062A\u0635\u0627\u0644 \u0631\u0645\u0632\u06AF\u0630\u0627\u0631\u06CC\u200C\u0634\u062F\u0647 \u0628\u0631\u0627\u06CC \u06F1\u06F0 \u062F\u0642\u06CC\u0642\u0647 \u0622\u0645\u0627\u062F\u0647 \u0634\u062F. \u0641\u0631\u0645\u0627\u0646 \u0646\u0635\u0628 \u06CC\u06A9\u200C\u0628\u0627\u0631\u0647 V2 \u0628\u0627\u06CC\u062F \u0631\u0648\u06CC \u0645\u06CC\u0632\u0628\u0627\u0646 \u0631\u0627\u0646\u0631 \u0642\u062F\u06CC\u0645\u06CC \u0627\u062C\u0631\u0627 \u0634\u0648\u062F\u061B \u0647\u06CC\u0686 \u0631\u0645\u0632 \u06CC\u0627 \u06A9\u0644\u06CC\u062F \u062E\u0635\u0648\u0635\u06CC \u0627\u0632 \u0622\u0646 \u062E\u0627\u0631\u062C \u0646\u0645\u06CC\u200C\u0634\u0648\u062F.';
  }catch(e){el('pairingStatus').textContent='\u0627\u062A\u0635\u0627\u0644 \u0627\u0645\u0646 \u0631\u0627\u0646\u0631 \u0628\u0631\u0642\u0631\u0627\u0631 \u0646\u0634\u062F\u061B \u062A\u0646\u0638\u06CC\u0645\u0627\u062A \u0631\u0627 \u0628\u0631\u0631\u0633\u06CC \u06A9\u0646\u06CC\u062F.';}
  finally{el('pairRunner').disabled=false;}
};
el('probe').onclick=async()=>{if(busy||!el('form').reportValidity())return;busy=true;if(failedNodeId!==el('nodeId').value.trim()){failedInstallId=null;failedNodeId=null;}probeId=null;probeExpires=0;installedProbe=false;runtimeDownId=null;el('resetInstalled').hidden=true;el('resetNote').hidden=true;el('diagnose').textContent='\u0639\u06CC\u0628\u200C\u06CC\u0627\u0628\u06CC \u0628\u062F\u0648\u0646 \u0646\u0635\u0628 (\u0641\u0642\u0637 \u0628\u0631\u0631\u0633\u06CC)';el('diagnose').hidden=true;el('diagnoseNote').hidden=true;el('probe').disabled=true;el('credentials').hidden=true;el('trust').checked=false;try{const b={};for(const id of ['nodeId','provider','region','ip','username'])b[id]=el(id).value.trim();for(const id of ['userLimit','capacityGb','port'])b[id]=Number(el(id).value);const job=await api('probe',b);lock(true);poll(job.id,'probe');}catch(e){busy=false;el('probe').disabled=false;status('\u0628\u0631\u0631\u0633\u06CC \u0627\u062A\u0635\u0627\u0644 \u0622\u063A\u0627\u0632 \u0646\u0634\u062F: '+e.message);}};
el('form').onsubmit=async e=>{
  e.preventDefault();
  if(busy||failedInstallId||installedProbe||!probeId||!el('trust').checked){
    status('\u0627\u0628\u062A\u062F\u0627 \u0627\u062B\u0631 \u0627\u0646\u06AF\u0634\u062A \u0633\u0631\u0648\u0631 \u0631\u0627 \u062A\u0623\u06CC\u06CC\u062F \u06A9\u0646. \u0628\u0631\u0627\u06CC \u0646\u0635\u0628 \u0642\u0628\u0644\u06CC \u0646\u0627\u0645\u0648\u0641\u0642\u060C \u06AF\u0632\u06CC\u0646\u0647 \u0639\u06CC\u0628\u200C\u06CC\u0627\u0628\u06CC \u0628\u062F\u0648\u0646 \u0646\u0635\u0628 \u0631\u0627 \u0628\u0632\u0646.');return;
  }
  if(Date.now()>=probeExpires){
    probeId=null;el('install').disabled=true;
    status('\u0645\u0647\u0644\u062A \u06F1\u06F0 \u062F\u0642\u06CC\u0642\u0647\u200C\u0627\u06CC \u0627\u062B\u0631 \u0627\u0646\u06AF\u0634\u062A \u067E\u0627\u06CC\u0627\u0646 \u06CC\u0627\u0641\u062A\u0647 \u0627\u0633\u062A. \u067E\u06CC\u0634 \u0627\u0632 \u0627\u0631\u0633\u0627\u0644 \u06A9\u0644\u06CC\u062F\u060C \u062F\u0648\u0628\u0627\u0631\u0647 \xAB\u0628\u0631\u0631\u0633\u06CC \u0627\u062A\u0635\u0627\u0644\xBB \u0631\u0627 \u0628\u0632\u0646.');return;
  }
  busy=true;el('install').disabled=true;
  let credentials;
  try{
    credentials=el('method').value==='password'
      ?{method:'password',password:el('password').value}
      :{method:'key',key:await el('keyfile').files[0]?.text(),passphrase:el('password').value};
    if(credentials.method==='password'?!credentials.password:!credentials.key)
      throw Error('\u0627\u0637\u0644\u0627\u0639\u0627\u062A \u0648\u0631\u0648\u062F \u0631\u0627 \u0648\u0627\u0631\u062F \u06A9\u0646.');
    const envelope=await encrypt(credentials);
    credentials=null;
    const job=await api('install',{probeId,fingerprint,trust:true,envelope});
    // Clear the local file picker only after the API accepts the job.
    el('password').value='';el('keyfile').value='';
    poll(job.id,'install');
  }catch(e){
    busy=false;el('install').disabled=false;
    status('\u0646\u0635\u0628 \u0622\u063A\u0627\u0632 \u0646\u0634\u062F: '+e.message+'
\u0641\u0627\u06CC\u0644 \u06A9\u0644\u06CC\u062F \u0627\u0646\u062A\u062E\u0627\u0628\u200C\u0634\u062F\u0647 \u062D\u0641\u0638 \u0634\u062F\u0647 \u0627\u0633\u062A\u061B \u0628\u0631\u0627\u06CC \u062A\u0644\u0627\u0634 \u0645\u062C\u062F\u062F \u0646\u06CC\u0627\u0632\u06CC \u0628\u0647 \u0627\u0646\u062A\u062E\u0627\u0628 \u062F\u0648\u0628\u0627\u0631\u0647 \u0646\u06CC\u0633\u062A.');
  }finally{credentials=null;}
};
if(!auth)status('\u0627\u06CC\u0646 \u0635\u0641\u062D\u0647 \u0631\u0627 \u0627\u0632 \u062F\u06A9\u0645\u0647 \u0627\u0641\u0632\u0648\u062F\u0646 \u0633\u0631\u0648\u0631 \u062F\u0631 \u0631\u0628\u0627\u062A V2 \u0628\u0627\u0632 \u06A9\u0646.');
else api('session').then(async s=>{
  publicKey=s.publicKey;el('probe').disabled=false;
  try{await restoreJob();}catch(e){status('\u0628\u0627\u0632\u06CC\u0627\u0628\u06CC \u0648\u0636\u0639\u06CC\u062A \u0642\u0628\u0644\u06CC \u0645\u0645\u06A9\u0646 \u0646\u0634\u062F\u061B \u062F\u0648\u0628\u0627\u0631\u0647 \u062A\u0644\u0627\u0634 \u06A9\u0646\u06CC\u062F.');}
}).catch(e=>{
  el('runnerPairing').hidden=false;
  status('\u0646\u0634\u0633\u062A \u0627\u0645\u0646 \u0645\u0646\u0642\u0636\u06CC \u0634\u062F\u0647 \u06CC\u0627 \u0627\u0631\u062A\u0628\u0627\u0637 \u0628\u0631\u0642\u0631\u0627\u0631 \u0646\u06CC\u0633\u062A\u061B \u0635\u0641\u062D\u0647 \u0631\u0627 \u0627\u0632 \u0631\u0628\u0627\u062A \u062F\u0648\u0628\u0627\u0631\u0647 \u0628\u0627\u0632 \u06A9\u0646\u06CC\u062F.');
});
<\/script></html>`], [`<!doctype html><html lang="fa" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>\u0627\u0641\u0632\u0648\u062F\u0646 \u0633\u0631\u0648\u0631 \u0645\u062F\u0627\u0631 V2</title>
<script src="https://telegram.org/js/telegram-web-app.js"><\/script>
<style>
:root{color-scheme:dark;--surface:#111f33;--surface2:#172b45;--line:#2d4564;--accent:#438df5;--muted:#a9bbd2}
*{box-sizing:border-box}
body{font:16px/1.9 system-ui,-apple-system,sans-serif;background:radial-gradient(ellipse at top,#18365a 0,#0b1628 48%,#07111f 100%);color:#eef4ff;max-width:600px;min-height:100vh;margin:0 auto;padding:28px 16px 40px}
h1{font-size:25px;line-height:1.5;margin:8px 0 12px;letter-spacing:-.4px}
body>p:first-of-type{color:#bdcce0;margin:0 0 20px}
form,details{background:linear-gradient(145deg,rgba(24,43,69,.96),rgba(14,28,46,.96));border:1px solid var(--line);border-radius:20px;padding:18px;margin:16px 0;box-shadow:0 18px 44px rgba(0,0,0,.22)}
label{display:block;font-weight:600;color:#dbe7f8}
input,select,button{box-sizing:border-box;display:block;width:100%;font:inherit;padding:12px 14px;margin:8px 0 16px;border:1px solid #385474;border-radius:13px;background:#0c1a2c;color:inherit;transition:border-color .15s,box-shadow .15s}
input:focus,select:focus{outline:none;border-color:#6aa7ff;box-shadow:0 0 0 3px rgba(67,141,245,.18)}
button{background:linear-gradient(135deg,#438df5,#2868c7);border:0;font-weight:750;cursor:pointer;box-shadow:0 8px 18px rgba(25,91,183,.22)}
button:disabled{opacity:.45;cursor:not-allowed;box-shadow:none}
fieldset{border:1px solid var(--line);border-radius:16px;padding:14px;margin-top:18px}
legend{padding:0 8px;color:#a9caff;font-weight:700}
summary{cursor:pointer;font-weight:700;color:#c7dcf7}
#status{white-space:pre-wrap;overflow-wrap:anywhere;background:rgba(8,20,35,.75);border:1px solid var(--line);border-radius:14px;padding:12px 14px;color:#d9e8ff;min-height:48px}
#fingerprint{direction:ltr;overflow-wrap:anywhere;background:#091727;border:1px dashed #54749a;border-radius:12px;padding:10px}
input[type=checkbox]{width:auto;display:inline;accent-color:#438df5}
</style>
<h1>\u0627\u0641\u0632\u0648\u062F\u0646 \u0633\u0631\u0648\u0631 \u0645\u062F\u0627\u0631 V2</h1><p>\u0627\u0637\u0644\u0627\u0639\u0627\u062A \u0633\u0631\u0648\u0631 \u0631\u0627 \u0648\u0627\u0631\u062F \u06A9\u0646\u061B \u0628\u0631\u0631\u0633\u06CC \u0627\u062A\u0635\u0627\u0644 \u0648 \u0646\u0635\u0628 \u0627\u0632 \u0647\u0645\u06CC\u0646 \u0635\u0641\u062D\u0647 \u0627\u0646\u062C\u0627\u0645 \u0645\u06CC\u200C\u0634\u0648\u062F. \u0631\u0645\u0632 \u0648 \u06A9\u0644\u06CC\u062F \u0631\u0627 \u062F\u0631 \u067E\u06CC\u0627\u0645 \u062A\u0644\u06AF\u0631\u0627\u0645 \u0646\u0641\u0631\u0633\u062A.</p>
<details id="runnerPairing" hidden><summary>\u0641\u0639\u0627\u0644\u200C\u0633\u0627\u0632\u06CC \u06CC\u06A9\u200C\u0628\u0627\u0631\u0647 \u0633\u0631\u0648\u06CC\u0633 \u0646\u0635\u0628 V2 (\u0641\u0642\u0637 \u0645\u062F\u06CC\u0631)</summary>
<p>\u0627\u06CC\u0646 \u06A9\u0627\u0631 \u0641\u0642\u0637 \u06CC\u06A9\u200C\u0628\u0627\u0631 \u0631\u0648\u06CC \u0645\u06CC\u0632\u0628\u0627\u0646 \u0631\u0627\u0646\u0631 \u0645\u0648\u062C\u0648\u062F \u0627\u0646\u062C\u0627\u0645 \u0645\u06CC\u200C\u0634\u0648\u062F\u060C \u0646\u0647 \u0647\u0646\u06AF\u0627\u0645 \u0627\u0641\u0632\u0648\u062F\u0646 \u0647\u0631 \u0633\u0631\u0648\u0631. \u0633\u0631\u0648\u06CC\u0633 V1 \u062A\u063A\u06CC\u06CC\u0631 \u0646\u0645\u06CC\u200C\u06A9\u0646\u062F.</p>
<button type="button" id="pairRunner">\u0622\u0645\u0627\u062F\u0647\u200C\u0633\u0627\u0632\u06CC \u0627\u062A\u0635\u0627\u0644 \u0627\u0645\u0646 \u0631\u0627\u0646\u0631</button><p id="pairingStatus" role="status"></p>
</details>
<form id="form">
<label>\u0634\u0646\u0627\u0633\u0647 \u0633\u0631\u0648\u0631<input id="nodeId" placeholder="webdade6" required minlength="3" maxlength="64" pattern="[A-Za-z][A-Za-z0-9_-]{2,63}" title="\u0634\u0646\u0627\u0633\u0647 \u06F3 \u062A\u0627 \u06F6\u06F4 \u06A9\u0627\u0631\u0627\u06A9\u062A\u0631\u061B \u0628\u0627 \u062D\u0631\u0641 \u0644\u0627\u062A\u06CC\u0646 \u0634\u0631\u0648\u0639 \u0634\u0648\u062F \u0648 \u0641\u0642\u0637 \u0634\u0627\u0645\u0644 \u062D\u0631\u0648\u0641 \u0644\u0627\u062A\u06CC\u0646\u060C \u0639\u062F\u062F\u060C \u062E\u0637 \u062A\u06CC\u0631\u0647 \u0648 \u0632\u06CC\u0631\u062E\u0637 \u0628\u0627\u0634\u062F."></label><small>\u0628\u0631\u0627\u06CC \u0645\u062B\u0627\u0644: webdade6 \u06CC\u0627 aws-eu1. \u067E\u06CC\u0634\u0648\u0646\u062F test- \u0627\u062C\u0628\u0627\u0631\u06CC \u0646\u06CC\u0633\u062A\u061B \u0646\u0627\u0645\u200C\u0647\u0627\u06CC \u0631\u0632\u0631\u0648\u0634\u062F\u0647 \u0645\u0627\u0646\u0646\u062F production \u0642\u0627\u0628\u0644 \u0627\u0633\u062A\u0641\u0627\u062F\u0647 \u0646\u06CC\u0633\u062A\u0646\u062F.</small>
<label>\u0627\u0631\u0627\u0626\u0647\u200C\u062F\u0647\u0646\u062F\u0647<input id="provider" value="aws" required></label><label>\u0645\u0646\u0637\u0642\u0647<input id="region" value="eu-north-1" required></label>
<label>\u0633\u0642\u0641 \u06A9\u0627\u0631\u0628\u0631<input id="userLimit" type="number" value="20" min="1" max="100000" required></label><label>\u0633\u0642\u0641 \u062D\u062C\u0645 \u06AF\u06CC\u06AF\u0627\u0628\u0627\u06CC\u062A<input id="capacityGb" type="number" value="500" min="1" max="200000" required></label>
<label>IP \u0633\u0631\u0648\u0631<input id="ip" dir="ltr" required></label><label>\u067E\u0648\u0631\u062A SSH<input id="port" type="number" value="22" min="1" max="65535" required></label><label>\u0646\u0627\u0645 \u06A9\u0627\u0631\u0628\u0631<input id="username" value="root" dir="ltr" required></label>
<button id="probe" type="button" disabled>\u06F1 \xB7 \u0628\u0631\u0631\u0633\u06CC \u0627\u062A\u0635\u0627\u0644</button>
<fieldset id="credentials" hidden><legend>\u06F2 \xB7 \u0648\u0631\u0648\u062F \u0627\u0645\u0646 \u0648 \u0646\u0635\u0628 \u062E\u0648\u062F\u06A9\u0627\u0631</legend><p id="fingerprint"></p><label><input id="trust" type="checkbox">\u0627\u062B\u0631 \u0627\u0646\u06AF\u0634\u062A \u0631\u0627 \u0628\u0627 \u067E\u0646\u0644 \u0627\u0631\u0627\u0626\u0647\u200C\u062F\u0647\u0646\u062F\u0647 \u0645\u0637\u0627\u0628\u0642\u062A \u062F\u0627\u062F\u0645</label>
<label>\u0631\u0648\u0634 \u0648\u0631\u0648\u062F<select id="method"><option value="password">\u0631\u0645\u0632 \u0633\u0631\u0648\u0631</option><option value="key">\u06A9\u0644\u06CC\u062F \u062E\u0635\u0648\u0635\u06CC SSH</option></select></label>
<label>\u0641\u0627\u06CC\u0644 \u06A9\u0644\u06CC\u062F \u062E\u0635\u0648\u0635\u06CC<input id="keyfile" type="file"></label><label>\u0631\u0645\u0632 \u0633\u0631\u0648\u0631 \u06CC\u0627 \u0631\u0645\u0632 \u0645\u062D\u0627\u0641\u0638 \u06A9\u0644\u06CC\u062F<input id="password" type="password" autocomplete="off"></label><button id="install" type="submit">\u0634\u0631\u0648\u0639 \u0646\u0635\u0628 \u062E\u0648\u062F\u06A9\u0627\u0631</button><button id="diagnose" type="button" hidden disabled>\u{1F50E} \u0639\u06CC\u0628\u200C\u06CC\u0627\u0628\u06CC \u0628\u062F\u0648\u0646 \u0646\u0635\u0628 (\u0641\u0642\u0637 \u0628\u0631\u0631\u0633\u06CC)</button><button id="clearFailed" type="button" hidden disabled>\u067E\u0627\u06A9\u200C\u0633\u0627\u0632\u06CC \u062B\u0628\u062A \u0646\u0635\u0628 \u0646\u0627\u0645\u0648\u0641\u0642 \u0648 \u0634\u0631\u0648\u0639 \u062F\u0648\u0628\u0627\u0631\u0647</button><button id="resetInstalled" type="button" hidden>\u{1F9F9} \u067E\u0627\u06A9\u200C\u0633\u0627\u0632\u06CC V2 \u0627\u0632 \u0633\u0631\u0648\u0631 \u0648 \u0646\u0635\u0628 \u062F\u0648\u0628\u0627\u0631\u0647</button><p id="resetNote" hidden>\u0641\u0642\u0637 \u0633\u0631\u0648\u06CC\u0633\u200C\u0647\u0627 \u0648 \u0641\u0627\u06CC\u0644\u200C\u0647\u0627\u06CC \u0627\u062E\u062A\u0635\u0627\u0635\u06CC V2 \u067E\u0627\u06A9 \u0645\u06CC\u200C\u0634\u0648\u0646\u062F. \u067E\u06CC\u0634 \u0627\u0632 \u0627\u0642\u062F\u0627\u0645\u060C \u0633\u0648\u0627\u0628\u0642 \u0627\u0634\u062A\u0631\u0627\u06A9 \u0648 \u0645\u06CC\u0632\u0627\u0646 \u0645\u0635\u0631\u0641 \u0628\u0631\u0631\u0633\u06CC \u0645\u06CC\u200C\u0634\u0648\u0646\u062F\u061B \u0628\u0631\u0627\u06CC \u0646\u0635\u0628 \u062C\u062F\u06CC\u062F \u0634\u0646\u0627\u0633\u0647 \u062A\u0627\u0632\u0647 \u0644\u0627\u0632\u0645 \u0627\u0633\u062A.</p><p id="diagnoseNote" hidden>\u0641\u0642\u0637 \u0627\u0637\u0644\u0627\u0639\u0627\u062A \u0633\u06CC\u0633\u062A\u0645 \u0648 \u062F\u0633\u062A\u0631\u0633\u06CC \u062F\u0627\u0646\u0644\u0648\u062F \u0628\u0631\u0631\u0633\u06CC \u0645\u06CC\u200C\u0634\u0648\u062F\u061B \u0647\u06CC\u0686 \u0646\u0635\u0628 \u06CC\u0627 \u062D\u0630\u0641\u06CC \u0627\u0646\u062C\u0627\u0645 \u0646\u0645\u06CC\u200C\u0634\u0648\u062F. \u0627\u0637\u0644\u0627\u0639\u0627\u062A SSH \u0641\u0642\u0637 \u0628\u0647\u200C\u0635\u0648\u0631\u062A \u0631\u0645\u0632\u06AF\u0630\u0627\u0631\u06CC\u200C\u0634\u062F\u0647 \u0627\u0631\u0633\u0627\u0644 \u0645\u06CC\u200C\u0634\u0648\u0646\u062F.</p></fieldset></form><p id="status" role="status" aria-live="polite"></p>
<script>
const tg=window.Telegram?.WebApp;tg?.ready();const el=id=>document.getElementById(id),auth=tg?.initData||'';let publicKey,probeId,fingerprint,timer,busy=false,failedInstallId=null,failedNodeId=null,installedProbe=false,runtimeDownId=null,diagnosticId=null,probeExpires=0;
const status=s=>el('status').textContent=s;
const errors={PAIRING_KEY_NOT_CONFIGURED:'\u06A9\u0644\u06CC\u062F \u0639\u0645\u0648\u0645\u06CC \u0631\u0627\u0646\u0631 \u0641\u0639\u0644\u06CC \u0647\u0646\u0648\u0632 \u062A\u0646\u0638\u06CC\u0645 \u0646\u0634\u062F\u0647 \u0627\u0633\u062A.',RUNNER_OFFLINE:'\u0627\u062C\u0631\u0627\u06A9\u0646\u0646\u062F\u0647 \u0645\u0633\u062A\u0642\u0644 V2 \u0647\u0646\u0648\u0632 \u0631\u0648\u06CC \u0645\u06CC\u0632\u0628\u0627\u0646 AWS \u0645\u062A\u0635\u0644 \u0646\u0634\u062F\u0647 \u0627\u0633\u062A\u061B \u0647\u06CC\u0686 \u0646\u0635\u0628\u06CC \u0634\u0631\u0648\u0639 \u0646\u0645\u06CC\u200C\u0634\u0648\u062F.',RUNNER_NOT_CONFIGURED:'\u0627\u062A\u0635\u0627\u0644 \u0627\u062C\u0631\u0627\u06A9\u0646\u0646\u062F\u0647 \u0647\u0646\u0648\u0632 \u062A\u0646\u0638\u06CC\u0645 \u0646\u0634\u062F\u0647 \u0627\u0633\u062A.',EXECUTOR_NOT_CONFIGURED:'\u0627\u062C\u0631\u0627\u06CC \u062F\u0631\u062E\u0648\u0627\u0633\u062A\u06CC \u0647\u0646\u0648\u0632 \u0628\u0647\u200C\u0637\u0648\u0631 \u0627\u0645\u0646 \u0641\u0639\u0627\u0644 \u0646\u0634\u062F\u0647 \u0627\u0633\u062A.',EXECUTOR_DISPATCH_FAILED:'\u0627\u062C\u0631\u0627\u06CC \u0646\u0635\u0628 \u062F\u0631 GitHub \u0634\u0631\u0648\u0639 \u0646\u0634\u062F\u061B \u0647\u06CC\u0686 \u062A\u063A\u06CC\u06CC\u0631\u06CC \u062F\u0631 \u0633\u0631\u0648\u0631 \u0627\u0646\u062C\u0627\u0645 \u0646\u0634\u062F.',AUTH_EXPIRED:'\u0627\u06CC\u0646 \u0635\u0641\u062D\u0647 \u0631\u0627 \u0628\u0628\u0646\u062F \u0648 \u0627\u0632 \u0631\u0628\u0627\u062A \u062F\u0648\u0628\u0627\u0631\u0647 \u0628\u0627\u0632 \u06A9\u0646.',INVALID_TARGET:'\u0645\u0634\u062E\u0635\u0627\u062A \u0633\u0631\u0648\u0631 \u0645\u0639\u062A\u0628\u0631 \u0646\u06CC\u0633\u062A.',NODE_ALREADY_EXISTS:'\u0627\u06CC\u0646 \u0634\u0646\u0627\u0633\u0647 \u0627\u0632 \u0646\u0635\u0628 \u0646\u0627\u0645\u0648\u0641\u0642 \u0642\u0628\u0644\u06CC \u062F\u0631 \u0645\u062F\u0627\u0631 \u062B\u0628\u062A \u0634\u062F\u0647 \u0627\u0633\u062A. \u067E\u06CC\u0634 \u0627\u0632 \u062A\u0644\u0627\u0634 \u0645\u062C\u062F\u062F\u060C \u0639\u06CC\u0628\u200C\u06CC\u0627\u0628\u06CC \u0628\u062F\u0648\u0646 \u0646\u0635\u0628 \u0631\u0627 \u0627\u062C\u0631\u0627 \u06A9\u0646.',PROBE_REQUIRED:'\u0645\u0647\u0644\u062A \u0628\u0631\u0631\u0633\u06CC \u0627\u062A\u0635\u0627\u0644 \u062A\u0645\u0627\u0645 \u0634\u062F\u0647 \u06CC\u0627 \u0627\u062B\u0631 \u0627\u0646\u06AF\u0634\u062A \u0645\u0639\u062A\u0628\u0631 \u0646\u06CC\u0633\u062A\u061B \u062F\u0648\u0628\u0627\u0631\u0647 \xAB\u0628\u0631\u0631\u0633\u06CC \u0627\u062A\u0635\u0627\u0644\xBB \u0631\u0627 \u0628\u0632\u0646.',CLEAN_DIAG_REQUIRED:'\u0627\u0628\u062A\u062F\u0627 \u0646\u062A\u06CC\u062C\u0647 \u0645\u0648\u0641\u0642 \u0639\u06CC\u0628\u200C\u06CC\u0627\u0628\u06CC \u0628\u062F\u0648\u0646 \u0646\u0635\u0628 \u0631\u0627 \u062F\u0631\u06CC\u0627\u0641\u062A \u06A9\u0646.',NODE_RESET_UNSAFE:'\u067E\u0627\u06A9\u200C\u0633\u0627\u0632\u06CC \u062E\u0648\u062F\u06A9\u0627\u0631 \u0627\u0645\u0646 \u0646\u06CC\u0633\u062A\u061B \u0627\u06CC\u0646 \u0633\u0631\u0648\u0631 \u062F\u0627\u062F\u0647 \u0648\u0627\u0628\u0633\u062A\u0647 \u062F\u0627\u0631\u062F \u0648 \u0628\u0627\u06CC\u062F \u0628\u0631\u0631\u0633\u06CC \u0634\u0648\u062F.',JOB_ALREADY_PENDING:'\u06CC\u06A9 \u06A9\u0627\u0631 \u062F\u0631 \u062D\u0627\u0644 \u0627\u062C\u0631\u0627 \u062F\u0627\u0631\u06CC.',FAILED_INSTALL_REQUIRED:'\u062F\u0631\u062E\u0648\u0627\u0633\u062A \u0646\u0635\u0628 \u0646\u0627\u0645\u0648\u0641\u0642 \u0642\u0628\u0644\u06CC \u067E\u06CC\u062F\u0627 \u0646\u0634\u062F\u061B \u0635\u0641\u062D\u0647 \u0631\u0627 \u0627\u0632 \u0631\u0628\u0627\u062A \u062F\u0648\u0628\u0627\u0631\u0647 \u0628\u0627\u0632 \u06A9\u0646.',NODE_NOT_INSTALLED:'\u0641\u0642\u0637 \u0633\u0631\u0648\u0631 \u0646\u0635\u0628\u200C\u0634\u062F\u0647 \u0645\u062A\u0639\u0644\u0642 \u0628\u0647 \u0627\u06CC\u0646 \u0645\u062F\u06CC\u0631 \u0642\u0627\u0628\u0644 \u067E\u0627\u06A9\u200C\u0633\u0627\u0632\u06CC \u0627\u0633\u062A.',NODE_HAS_ACTIVE_OR_USED_ACCOUNTS:'\u0633\u0631\u0648\u0631 \u062F\u0627\u0631\u0627\u06CC \u0627\u0634\u062A\u0631\u0627\u06A9 \u0641\u0639\u0627\u0644 \u06CC\u0627 \u0645\u0635\u0631\u0641\u200C\u0634\u062F\u0647 \u0627\u0633\u062A. \u067E\u0627\u06A9\u200C\u0633\u0627\u0632\u06CC \u0628\u062F\u0648\u0646 \u062A\u0639\u06CC\u06CC\u0646 \u062A\u06A9\u0644\u06CC\u0641 \u0645\u0634\u062A\u0631\u06CC\u0627\u0646 \u0645\u062C\u0627\u0632 \u0646\u06CC\u0633\u062A.',NODE_HAS_LIVE_TRIAL:'\u0644\u06CC\u0646\u06A9 \u0622\u0632\u0645\u0627\u06CC\u0634\u06CC \u0647\u0646\u0648\u0632 \u0645\u0639\u062A\u0628\u0631 \u0627\u0633\u062A\u061B \u067E\u0633 \u0627\u0632 \u067E\u0627\u06CC\u0627\u0646 \u0627\u0639\u062A\u0628\u0627\u0631 \u0627\u0642\u062F\u0627\u0645 \u06A9\u0646.',NODE_HAS_PAID_ORDERS:'\u0633\u0641\u0627\u0631\u0634 \u067E\u0631\u062F\u0627\u062E\u062A\u200C\u0634\u062F\u0647 \u06CC\u0627 \u0631\u0633\u06CC\u062F \u062A\u0623\u06CC\u06CC\u062F\u0634\u062F\u0647 \u0628\u0647 \u0627\u06CC\u0646 \u0633\u0631\u0648\u0631 \u0648\u0627\u0628\u0633\u062A\u0647 \u0627\u0633\u062A.',RESET_HOST_MISMATCH:'IP \u062B\u0628\u062A\u200C\u0634\u062F\u0647 \u0628\u0631\u0627\u06CC \u0627\u06CC\u0646 \u0633\u0631\u0648\u0631 \u0628\u0627 \u0633\u0631\u0648\u0631 \u0645\u062A\u0635\u0644\u200C\u0634\u062F\u0647 \u0645\u0637\u0627\u0628\u0642\u062A \u0646\u062F\u0627\u0631\u062F.',RESET_EXPLICIT_CONSENT_REQUIRED:'\u062A\u0623\u06CC\u06CC\u062F \u0635\u0631\u06CC\u062D \u0646\u0627\u0645 \u0633\u0631\u0648\u0631 \u0648 \u062A\u0637\u0628\u06CC\u0642 \u0627\u062B\u0631 \u0627\u0646\u06AF\u0634\u062A \u0644\u0627\u0632\u0645 \u0627\u0633\u062A.',RESET_QUARANTINE_FAILED:'\u0627\u0645\u06A9\u0627\u0646 \u062C\u062F\u0627\u0633\u0627\u0632\u06CC \u0627\u06CC\u0645\u0646 \u0633\u0631\u0648\u0631 \u0627\u0632 \u0635\u062F\u0648\u0631 \u06A9\u0627\u0646\u0641\u06CC\u06AF \u0648\u062C\u0648\u062F \u0646\u062F\u0627\u0631\u062F.',RESET_BLOCKED:'\u067E\u0627\u06A9\u200C\u0633\u0627\u0632\u06CC \u0631\u0648\u06CC VPS \u0628\u0647\u200C\u062F\u0644\u06CC\u0644 \u0648\u062C\u0648\u062F \u062F\u0627\u062F\u0647 \u0645\u0635\u0631\u0641 \u06CC\u0627 \u0641\u0627\u06CC\u0644\u200C\u0647\u0627\u06CC \u0646\u0627\u0634\u0646\u0627\u0633 \u0645\u062A\u0648\u0642\u0641 \u0634\u062F.',RESET_PREFLIGHT_BLOCKED:'\u067E\u0627\u06A9\u200C\u0633\u0627\u0632\u06CC \u0642\u0628\u0644 \u0627\u0632 \u0647\u0631 \u062A\u063A\u06CC\u06CC\u0631\u06CC \u0631\u0648\u06CC VPS \u0645\u062A\u0648\u0642\u0641 \u0634\u062F. \u0648\u0636\u0639\u06CC\u062A \u0642\u0628\u0644\u06CC \u0633\u0631\u0648\u0631 \u0648 \u0627\u0637\u0644\u0627\u0639\u0627\u062A \u0622\u0646 \u062D\u0641\u0638 \u0634\u062F\u0646\u062F\u061B \u0633\u0644\u0627\u0645\u062A \u0627\u062A\u0635\u0627\u0644 \u0628\u0627\u06CC\u062F \u062F\u0648\u0628\u0627\u0631\u0647 \u062A\u0623\u06CC\u06CC\u062F \u0634\u0648\u062F.',RESET_CLEANUP_FAILED:'\u067E\u0627\u06A9\u200C\u0633\u0627\u0632\u06CC \u0631\u0648\u06CC \u0633\u0631\u0648\u0631 \u06A9\u0627\u0645\u0644 \u0646\u0634\u062F\u061B \u0648\u0636\u0639\u06CC\u062A \u0631\u0627 \u0642\u0628\u0644 \u0627\u0632 \u062A\u0644\u0627\u0634 \u0645\u062C\u062F\u062F \u0628\u0631\u0631\u0633\u06CC \u06A9\u0646.',RESET_DB_FINALIZATION_FAILED:'\u067E\u0627\u06A9\u200C\u0633\u0627\u0632\u06CC \u0633\u0645\u062A \u0633\u0631\u0648\u0631 \u06AF\u0632\u0627\u0631\u0634 \u0634\u062F \u0648\u0644\u06CC \u0628\u0633\u062A\u0646 \u0639\u0645\u0644\u06CC\u0627\u062A \u062F\u0631 \u062F\u06CC\u062A\u0627\u0628\u06CC\u0633 \u06A9\u0627\u0645\u0644 \u0646\u0634\u062F\u061B \u062F\u0648\u0628\u0627\u0631\u0647 \u0646\u0635\u0628 \u0646\u06A9\u0646.'};
async function api(path,data){const r=await fetch('/api/enrollment/'+path,{method:data?'POST':'GET',headers:{'content-type':'application/json','x-telegram-init-data':auth},...(data?{body:JSON.stringify(data)}:{})});const b=await r.json();if(!r.ok)throw Error(errors[b.error]||'\u0639\u0645\u0644\u06CC\u0627\u062A \u0627\u0646\u062C\u0627\u0645 \u0646\u0634\u062F\u061B \u062F\u0648\u0628\u0627\u0631\u0647 \u062A\u0644\u0627\u0634 \u06A9\u0646.');return b;}
const b64=b=>btoa(String.fromCharCode(...new Uint8Array(b)));
function restoreSpec(spec){
  if(!spec)return;
  for(const id of ['nodeId','provider','region','ip','username'])
    if(typeof spec[id]==='string')el(id).value=spec[id];
  for(const id of ['userLimit','capacityGb','port'])
    if(Number.isInteger(spec[id]))el(id).value=String(spec[id]);
}
async function restoreJob(){
  const {job,failedInstall}=await api('recent');
  if(!job)return status('\u0622\u0645\u0627\u062F\u0647 \u0628\u0631\u0631\u0633\u06CC \u0633\u0631\u0648\u0631.');
  restoreSpec(job.spec);
  if(job.cleanup&&job.state==='ready'&&job.safe_code==='RESET_COMPLETED'){
    installedProbe=false;
    el('credentials').hidden=true;
    const oldId=job.spec.nodeId;
    el('nodeId').value=oldId.slice(0,55)+'-new1';
    return status('\u067E\u0627\u06A9\u200C\u0633\u0627\u0632\u06CC \u0627\u062E\u062A\u0635\u0627\u0635\u06CC V2 \u062F\u0631 VPS \u062A\u0623\u06CC\u06CC\u062F \u0634\u062F \u0648 \u0633\u0631\u0648\u0631 \u0642\u0628\u0644\u06CC \u0628\u0627\u0632\u0646\u0634\u0633\u062A\u0647 \u0634\u062F. \u0627\u06A9\u0646\u0648\u0646 \u0634\u0646\u0627\u0633\u0647 \u062C\u062F\u06CC\u062F \u0631\u0627 \u0628\u0631\u0631\u0633\u06CC \u06A9\u0646 \u0648 \u0646\u0635\u0628 \u0631\u0627 \u0627\u0632 \u0627\u0628\u062A\u062F\u0627 \u0627\u0646\u062C\u0627\u0645 \u0628\u062F\u0647.');
  }
  if(job.kind==='v2-install'&&job.diagnostic&&job.state==='ready'&&
     job.safe_code==='DIAG_PRECHECK_OK'&&failedInstall?.id){
    showDiagnoseForInstall(failedInstall.id,failedInstall.fingerprint,job.spec.nodeId);
    diagnosticId=job.id;
    el('diagnose').hidden=true;el('diagnoseNote').hidden=true;
    el('clearFailed').hidden=false;el('clearFailed').disabled=false;
    return status('\u0639\u06CC\u0628\u200C\u06CC\u0627\u0628\u06CC \u0645\u0648\u0641\u0642 \u0628\u0648\u062F. \u0627\u06AF\u0631 VPS \u0647\u0645\u0627\u0646 \u0633\u0631\u0648\u0631 \u067E\u0627\u06A9 \u0648 \u0622\u0645\u0627\u062F\u0647 \u0627\u0633\u062A\u060C \u062B\u0628\u062A \u0646\u0635\u0628 \u0646\u0627\u0645\u0648\u0641\u0642 \u0631\u0627 \u067E\u0627\u06A9 \u06A9\u0646 \u0648 \u0627\u062A\u0635\u0627\u0644 \u0631\u0627 \u062F\u0648\u0628\u0627\u0631\u0647 \u0628\u0631\u0631\u0633\u06CC \u06A9\u0646.');
  }
  if(failedInstall?.id&&failedInstall?.fingerprint){
    showDiagnoseForInstall(failedInstall.id,failedInstall.fingerprint,job.spec.nodeId);
    return status('\u0646\u0635\u0628 \u0642\u0628\u0644\u06CC \u0627\u06CC\u0646 \u0634\u0646\u0627\u0633\u0647 \u0646\u0627\u0645\u0648\u0641\u0642 \u0628\u0648\u062F\u0647 \u0627\u0633\u062A: '+
      (installDetails[failedInstall.safe_code]||'\u0645\u0631\u062D\u0644\u0647 \u0646\u0635\u0628 \u0631\u0648\u06CC VPS \u0634\u06A9\u0633\u062A \u062E\u0648\u0631\u062F\u0647 \u0627\u0633\u062A.')+
      ' \u0628\u0631\u0627\u06CC \u062C\u0644\u0648\u06AF\u06CC\u0631\u06CC \u0627\u0632 \u0646\u0635\u0628 \u062A\u06A9\u0631\u0627\u0631\u06CC\u060C \u0627\u0628\u062A\u062F\u0627 \xAB\u0639\u06CC\u0628\u200C\u06CC\u0627\u0628\u06CC \u0628\u062F\u0648\u0646 \u0646\u0635\u0628\xBB \u0631\u0627 \u0628\u0632\u0646.');
  }
  if(job.kind==='probe'&&job.state==='ready'&&job.fingerprint){
    if(job.expires_ms<=Date.now()+5000)
      return status('\u0645\u0647\u0644\u062A \u0627\u0639\u062A\u0628\u0627\u0631 \u0628\u0631\u0631\u0633\u06CC \u0642\u0628\u0644\u06CC (\u06F1\u06F0 \u062F\u0642\u06CC\u0642\u0647) \u062A\u0645\u0627\u0645 \u0634\u062F\u0647 \u0627\u0633\u062A. \u062F\u0648\u0628\u0627\u0631\u0647 \xAB\u0628\u0631\u0631\u0633\u06CC \u0627\u062A\u0635\u0627\u0644\xBB \u0631\u0627 \u0628\u0632\u0646.');
    probeExpires=job.expires_ms;
    probeId=job.id;fingerprint=job.fingerprint;
    el('fingerprint').textContent=fingerprint;
    el('credentials').hidden=false;
    if((await api('jobs/'+job.id)).installed)return showInstalledProbe();
    el('install').disabled=false;
    return status('\u0628\u0631\u0631\u0633\u06CC \u0642\u0628\u0644\u06CC \u0628\u0627\u0632\u06CC\u0627\u0628\u06CC \u0634\u062F. \u0641\u0642\u0637 \u067E\u0633 \u0627\u0632 \u062A\u0637\u0628\u06CC\u0642 \u0627\u062B\u0631 \u0627\u0646\u06AF\u0634\u062A\u060C \u0646\u0635\u0628 \u0631\u0627 \u0627\u062F\u0627\u0645\u0647 \u0628\u062F\u0647.');
  }
  if(job.cleanup&&job.state==='failed'){
    installedProbe=false;
    return status(job.safe_code==='RESET_PREFLIGHT_BLOCKED'?'\u067E\u0627\u06A9\u200C\u0633\u0627\u0632\u06CC \u0642\u0628\u0644 \u0627\u0632 \u0647\u0631 \u062A\u063A\u06CC\u06CC\u0631\u06CC \u0631\u062F \u0634\u062F \u0648 \u0633\u0631\u0648\u0631 \u0628\u0647 \u0648\u0636\u0639\u06CC\u062A \u0642\u0628\u0644\u06CC \u0628\u0631\u06AF\u0634\u062A. \u0647\u06CC\u0686 \u062F\u0627\u062F\u0647\u200C\u0627\u06CC \u062D\u0630\u0641 \u0646\u0634\u062F\u061B \u067E\u06CC\u0634 \u0627\u0632 \u0635\u062F\u0648\u0631 \u06A9\u0627\u0646\u0641\u06CC\u06AF \u0633\u0644\u0627\u0645\u062A Agent \u0631\u0627 \u0628\u0631\u0631\u0633\u06CC \u06A9\u0646.':'\u067E\u0627\u06A9\u200C\u0633\u0627\u0632\u06CC \u0633\u0631\u0648\u0631 \u06A9\u0627\u0645\u0644 \u0646\u0634\u062F\u0647 \u0627\u0633\u062A. \u0633\u0631\u0648\u06CC\u0633 \u0645\u0645\u06A9\u0646 \u0627\u0633\u062A \u0646\u06CC\u0645\u0647\u200C\u067E\u0627\u06A9 \u0634\u062F\u0647 \u0628\u0627\u0634\u062F\u061B \u0628\u062F\u0648\u0646 \u0628\u0631\u0631\u0633\u06CC \u0648\u0636\u0639\u06CC\u062A VPS\u060C \u0646\u0635\u0628 \u0645\u062C\u062F\u062F \u0631\u0627 \u0622\u063A\u0627\u0632 \u0646\u06A9\u0646.');
  }
  if(job.kind==='v2-install'&&job.state==='failed'&&!job.diagnostic&&!job.cleanup&&job.fingerprint){
    showDiagnoseForInstall(job.id,job.fingerprint,job.spec.nodeId);
    return status('\u0646\u0635\u0628 \u0642\u0628\u0644\u06CC \u0646\u0627\u0645\u0648\u0641\u0642 \u0628\u0648\u062F: '+('\u062E\u0637\u0627\u06CC \u0646\u0627\u0645\u0634\u062E\u0635 \u062F\u0631 \u0646\u0635\u0628')+'. \u0628\u0631\u0627\u06CC \u0628\u0631\u0631\u0633\u06CC \u0628\u062F\u0648\u0646 \u0646\u0635\u0628 \u062F\u0648\u0628\u0627\u0631\u0647 \u0627\u0637\u0644\u0627\u0639\u0627\u062A \u0648\u0631\u0648\u062F \u0631\u0627 \u0648\u0627\u0631\u062F \u06A9\u0646.');
  }
  if(job.kind==='v2-install'&&job.diagnostic&&['failed','ready'].includes(job.state))
    return status(diagnosisMessage(job.safe_code));
  if(job.state==='queued'||job.state==='leased'){
    busy=true;el('probe').disabled=true;lock(true);
    status('\u062F\u0631\u062E\u0648\u0627\u0633\u062A \u0642\u0628\u0644\u06CC \u0628\u0627\u0632\u06CC\u0627\u0628\u06CC \u0634\u062F\u061B \u062F\u0631 \u062D\u0627\u0644 \u0628\u0631\u0631\u0633\u06CC \u0646\u062A\u06CC\u062C\u0647\u2026');
    return poll(job.id,job.kind==='probe'?'probe':job.cleanup?'cleanup':job.diagnostic?'diagnose':'install');
  }
  if(job.state==='failed')
    return status('\u0628\u0631\u0631\u0633\u06CC \u0642\u0628\u0644\u06CC \u0646\u0627\u0645\u0648\u0641\u0642 \u0628\u0648\u062F: '+'\u062E\u0637\u0627\u06CC \u0646\u0627\u0645\u0634\u062E\u0635 \u062F\u0631 \u0628\u0631\u0631\u0633\u06CC'+'. \u0645\u06CC\u200C\u062A\u0648\u0627\u0646\u06CC \u062F\u0648\u0628\u0627\u0631\u0647 \u0628\u0631\u0631\u0633\u06CC \u06A9\u0646\u06CC.');
  status('\u062F\u0631\u062E\u0648\u0627\u0633\u062A \u0642\u0628\u0644\u06CC \u067E\u0627\u06CC\u0627\u0646 \u06CC\u0627\u0641\u062A\u0647 \u0627\u0633\u062A\u061B \u0628\u0631\u0627\u06CC \u0633\u0631\u0648\u0631 \u062F\u06CC\u06AF\u0631\u060C \u0627\u0637\u0644\u0627\u0639\u0627\u062A \u0631\u0627 \u062A\u063A\u06CC\u06CC\u0631 \u0628\u062F\u0647.');
}
async function encrypt(value){const rsa=await crypto.subtle.importKey('jwk',publicKey,{name:'RSA-OAEP',hash:'SHA-256'},false,['encrypt']);const aes=await crypto.subtle.generateKey({name:'AES-GCM',length:256},true,['encrypt']);const iv=crypto.getRandomValues(new Uint8Array(12));const data=await crypto.subtle.encrypt({name:'AES-GCM',iv},aes,new TextEncoder().encode(JSON.stringify(value)));const key=await crypto.subtle.encrypt('RSA-OAEP',rsa,await crypto.subtle.exportKey('raw',aes));return {v:1,key:b64(key),iv:b64(iv),data:b64(data)};}
function lock(value){for(const id of ['nodeId','provider','region','userLimit','capacityGb','ip','port','username'])el(id).disabled=value;}
const diagnosticDetail={
  DIAG_RUNTIME_STARTED:'\u0639\u0627\u0645\u0644 \u0645\u062F\u0627\u0631 \u0631\u0627\u0647\u200C\u0627\u0646\u062F\u0627\u0632\u06CC \u0634\u062F. \u0648\u0636\u0639\u06CC\u062A \u0633\u0641\u0627\u0631\u0634 \u0631\u0627 \u062F\u0631 \u0631\u0628\u0627\u062A \u0628\u0631\u0631\u0633\u06CC \u06A9\u0646.',
  DIAG_RUNTIME_START_FAILED:'\u0639\u0627\u0645\u0644 \u0645\u062F\u0627\u0631 \u0631\u0627\u0647\u200C\u0627\u0646\u062F\u0627\u0632\u06CC \u0646\u0634\u062F.',
  DIAG_RUNTIME_ACTIVE:'\u0639\u0627\u0645\u0644 \u0648 Xray \u0641\u0639\u0627\u0644 \u0647\u0633\u062A\u0646\u062F \u0648 \u062E\u0637\u0627\u06CC \u062A\u0627\u0632\u0647\u200C\u0627\u06CC \u062F\u0631 \u0644\u0627\u06AF \u0639\u0627\u0645\u0644 \u062F\u06CC\u062F\u0647 \u0646\u0634\u062F.',
  DIAG_RUNTIME_DOWN:'\u0639\u0627\u0645\u0644 \u0645\u062F\u0627\u0631 \u0641\u0639\u0627\u0644 \u0646\u06CC\u0633\u062A.',
  DIAG_XRAY_DOWN:'\u0633\u0631\u0648\u06CC\u0633 Xray \u0641\u0639\u0627\u0644 \u0646\u06CC\u0633\u062A.',
  DIAG_RUNTIME_GENERATION:'\u0639\u0627\u0645\u0644 \u062A\u063A\u06CC\u06CC\u0631 \u067E\u0631\u062F\u0627\u0632\u0634 Xray \u0631\u0627 \u062A\u0634\u062E\u06CC\u0635 \u062F\u0627\u062F\u0647 \u0648 \u0634\u0645\u0627\u0631\u0634 \u0645\u0635\u0631\u0641 \u0646\u06CC\u0627\u0632 \u0628\u0647 \u0628\u0631\u0631\u0633\u06CC \u062F\u0627\u0631\u062F.',
  DIAG_RUNTIME_ERROR:'\u0639\u0627\u0645\u0644 \u0645\u062F\u0627\u0631 \u0627\u062E\u06CC\u0631\u0627\u064B \u062E\u0637\u0627\u06CC \u0627\u062C\u0631\u0627 \u06CC\u0627 \u0627\u0631\u062A\u0628\u0627\u0637 \u062B\u0628\u062A \u06A9\u0631\u062F\u0647 \u0627\u0633\u062A.',
  DIAG_EXISTING_VPN:'\u0631\u0648\u06CC \u0633\u0631\u0648\u0631 \u0641\u0627\u06CC\u0644 \u06CC\u0627 \u0633\u0631\u0648\u06CC\u0633 VPN \u0642\u0628\u0644\u06CC \u0648\u062C\u0648\u062F \u062F\u0627\u0631\u062F\u061B \u0646\u0635\u0628 \u0627\u06CC\u0645\u0646 \u0646\u06CC\u0627\u0632 \u0628\u0647 VPS \u062A\u0627\u0632\u0647 \u0648 \u062E\u0627\u0644\u06CC \u062F\u0627\u0631\u062F. \u0628\u062F\u0648\u0646 \u062D\u0630\u0641 \u062F\u0633\u062A\u06CC\u060C \u0627\u0632 \u0627\u0631\u0627\u0626\u0647\u200C\u062F\u0647\u0646\u062F\u0647 \u0628\u0627\u0632\u0633\u0627\u0632\u06CC \u0633\u0631\u0648\u0631 \u0631\u0627 \u062F\u0631\u062E\u0648\u0627\u0633\u062A \u06A9\u0646.',
  DIAG_PORT_443_BUSY:'\u067E\u0648\u0631\u062A 443 \u0633\u0631\u0648\u0631 \u062A\u0648\u0633\u0637 \u0633\u0631\u0648\u06CC\u0633 \u062F\u06CC\u06AF\u0631\u06CC \u0627\u0634\u063A\u0627\u0644 \u0634\u062F\u0647 \u0627\u0633\u062A.',
  DIAG_PORT_8443_BUSY:'\u067E\u0648\u0631\u062A 8443 \u0633\u0631\u0648\u0631 \u062A\u0648\u0633\u0637 \u0633\u0631\u0648\u06CC\u0633 \u062F\u06CC\u06AF\u0631\u06CC \u0627\u0634\u063A\u0627\u0644 \u0634\u062F\u0647 \u0627\u0633\u062A.',
  DIAG_UNSUPPORTED_OS:'\u0633\u06CC\u0633\u062A\u0645\u200C\u0639\u0627\u0645\u0644 \u0633\u0631\u0648\u0631 Ubuntu \u06CC\u0627 Debian \u0646\u06CC\u0633\u062A\u061B \u0646\u0635\u0628 \u0622\u0632\u0645\u0627\u06CC\u0634\u06CC V2 \u0641\u0642\u0637 \u0627\u06CC\u0646 \u062F\u0648 \u0631\u0627 \u067E\u0634\u062A\u06CC\u0628\u0627\u0646\u06CC \u0645\u06CC\u200C\u06A9\u0646\u062F.',
  DIAG_NO_ROOT:'\u062F\u0633\u062A\u0631\u0633\u06CC \u0631\u06CC\u0634\u0647 \u0628\u0631\u0627\u06CC \u0627\u062C\u0631\u0627\u06CC \u0646\u0635\u0628 \u0648\u062C\u0648\u062F \u0646\u062F\u0627\u0631\u062F.',
  DIAG_SYSTEMD_MISSING:'\u067E\u06CC\u0634\u200C\u0646\u06CC\u0627\u0632\u0647\u0627\u06CC systemd \u06CC\u0627 useradd \u0631\u0648\u06CC \u0633\u0631\u0648\u0631 \u0648\u062C\u0648\u062F \u0646\u062F\u0627\u0631\u0646\u062F.',
  DIAG_GITHUB_UNREACHABLE:'\u062F\u0631\u06CC\u0627\u0641\u062A \u0646\u0633\u062E\u0647 Xray \u0627\u0632 GitHub \u0627\u0632 \u062F\u0627\u062E\u0644 \u0633\u0631\u0648\u0631 \u0645\u0645\u06A9\u0646 \u0646\u06CC\u0633\u062A\u061B \u0645\u062D\u062F\u0648\u062F\u06CC\u062A \u0634\u0628\u06A9\u0647 \u062E\u0631\u0648\u062C\u06CC \u0631\u0627 \u0628\u0631\u0631\u0633\u06CC \u06A9\u0646.',
  DIAG_PRECHECK_OK:'\u067E\u06CC\u0634\u200C\u0646\u06CC\u0627\u0632\u0647\u0627\u06CC \u0627\u0648\u0644\u06CC\u0647 \u0628\u0631\u0642\u0631\u0627\u0631\u0646\u062F\u061B \u0634\u06A9\u0633\u062A \u0646\u0635\u0628 \u062F\u0631 \u0645\u0631\u062D\u0644\u0647 \u062F\u0627\u062E\u0644\u06CC \u062F\u06CC\u06AF\u0631\u06CC \u0631\u062E \u062F\u0627\u062F\u0647 \u0627\u0633\u062A \u0648 \u0646\u06CC\u0627\u0632 \u0628\u0647 \u0628\u0631\u0631\u0633\u06CC \u062F\u0642\u06CC\u0642\u200C\u062A\u0631 \u0627\u0633\u06A9\u0631\u06CC\u067E\u062A \u062F\u0627\u0631\u062F.',
  DIAG_REMOTE_FAILED:'\u0628\u0631\u0631\u0633\u06CC \u0627\u0632 \u062F\u0627\u062E\u0644 VPS \u06A9\u0627\u0645\u0644 \u0646\u0634\u062F. \u0627\u06CC\u0646 \u067E\u06CC\u0627\u0645 \u0628\u0647 \u0645\u0639\u0646\u06CC \u0627\u062C\u0631\u0627\u06CC \u0646\u0635\u0628 \u0646\u06CC\u0633\u062A.'
};
function diagnosisMessage(code){
  return '\u0646\u062A\u06CC\u062C\u0647 \u0639\u06CC\u0628\u200C\u06CC\u0627\u0628\u06CC \u0628\u062F\u0648\u0646 \u0646\u0635\u0628: '+(diagnosticDetail[code]||'\u062E\u0637\u0627\u06CC \u0646\u0627\u0645\u0634\u062E\u0635 \u062F\u0631 \u0639\u06CC\u0628\u200C\u06CC\u0627\u0628\u06CC \u0631\u062E \u062F\u0627\u062F.');
}
function showDiagnoseForInstall(id,fp,nodeId=el('nodeId').value.trim()){
  failedInstallId=id;failedNodeId=nodeId;fingerprint=fp;probeId=null;probeExpires=0;
  diagnosticId=null;el('clearFailed').hidden=true;el('clearFailed').disabled=true;
  el('fingerprint').textContent=fp;
  el('credentials').hidden=false;
  el('trust').checked=false;
  el('install').disabled=true;
  el('diagnose').hidden=false;
  el('diagnose').disabled=false;
  el('diagnoseNote').hidden=false;
}
const installDetails={SSH_TIMEOUT:'\u0645\u0647\u0644\u062A \u0627\u062A\u0635\u0627\u0644 SSH \u062A\u0645\u0627\u0645 \u0634\u062F.',SSH_REFUSED:'\u0627\u062A\u0635\u0627\u0644 SSH \u0631\u062F \u0634\u062F.',SSH_UNREACHABLE:'\u0645\u0633\u06CC\u0631 SSH \u062F\u0631 \u062F\u0633\u062A\u0631\u0633 \u0646\u06CC\u0633\u062A.',SSH_HANDSHAKE_FAILED:'\u067E\u0627\u0633\u062E SSH \u0645\u0639\u062A\u0628\u0631 \u062F\u0631\u06CC\u0627\u0641\u062A \u0646\u0634\u062F.',PROBE_EXPIRED:'\u0645\u0647\u0644\u062A \u0628\u0631\u0631\u0633\u06CC \u067E\u0627\u06CC\u0627\u0646 \u06CC\u0627\u0641\u062A.',SSH_PROBE_FAILED:'\u0628\u0631\u0631\u0633\u06CC SSH \u0646\u0627\u0645\u0648\u0641\u0642 \u0628\u0648\u062F.',SSH_AUTH_FAILED:'\u0646\u0627\u0645 \u06A9\u0627\u0631\u0628\u0631\u06CC \u06CC\u0627 \u0631\u0645\u0632 SSH \u067E\u0630\u06CC\u0631\u0641\u062A\u0647 \u0646\u0634\u062F.',SSH_LOGIN_FAILED:'\u0648\u0631\u0648\u062F SSH \u06A9\u0627\u0645\u0644 \u0646\u0634\u062F.',HOST_KEY_CHANGED:'\u0627\u062B\u0631 \u0627\u0646\u06AF\u0634\u062A \u0633\u0631\u0648\u0631 \u062A\u063A\u06CC\u06CC\u0631 \u06A9\u0631\u062F\u0647 \u0627\u0633\u062A.',INVALID_SSH_KEY:'\u06A9\u0644\u06CC\u062F SSH \u0645\u0639\u062A\u0628\u0631 \u0646\u06CC\u0633\u062A.',CREDENTIALS_EXPIRED:'\u0627\u0639\u062A\u0628\u0627\u0631 \u062F\u0631\u062E\u0648\u0627\u0633\u062A \u0646\u0635\u0628 \u067E\u0627\u06CC\u0627\u0646 \u06CC\u0627\u0641\u062A.',CREDENTIAL_DECRYPT_FAILED:'\u0627\u0637\u0644\u0627\u0639\u0627\u062A \u0648\u0631\u0648\u062F \u0631\u0645\u0632\u06AF\u0634\u0627\u06CC\u06CC \u0646\u0634\u062F.',REMOTE_INSTALL_FAILED:'\u0648\u0631\u0648\u062F SSH \u0645\u0648\u0641\u0642 \u0628\u0648\u062F \u0627\u0645\u0627 \u0627\u062C\u0631\u0627\u06CC \u0641\u0631\u0645\u0627\u0646 \u0646\u0635\u0628 \u0631\u0648\u06CC VPS \u0634\u06A9\u0633\u062A \u062E\u0648\u0631\u062F.',INSTALL_REPORT_FAILED:'\u0646\u062A\u06CC\u062C\u0647 \u0646\u0635\u0628 \u0642\u0627\u0628\u0644 \u062B\u0628\u062A \u0646\u0628\u0648\u062F.'};
Object.assign(installDetails,{
  REMOTE_PACKAGE_FAILED:'\u0622\u0645\u0627\u062F\u0647\u200C\u0633\u0627\u0632\u06CC \u0628\u0633\u062A\u0647 \u0646\u0635\u0628 \u0631\u0648\u06CC \u0633\u0631\u0648\u0631 \u06A9\u0627\u0645\u0644 \u0646\u0634\u062F.',
  REMOTE_BOOTSTRAP_FAILED:'\u0646\u0635\u0628 \u0627\u0648\u0644\u06CC\u0647 \u06CC\u0627 \u0631\u0627\u0647\u200C\u0627\u0646\u062F\u0627\u0632\u06CC \u0633\u0631\u0648\u06CC\u0633 REALITY \u0631\u0648\u06CC \u067E\u0648\u0631\u062A 8443 \u0646\u0627\u0645\u0648\u0641\u0642 \u0628\u0648\u062F.',
  REMOTE_DUAL_FAILED:'\u0641\u0639\u0627\u0644\u200C\u0633\u0627\u0632\u06CC \u0647\u0645\u200C\u0632\u0645\u0627\u0646 \u067E\u0648\u0631\u062A\u200C\u0647\u0627\u06CC 443 \u0648 8443 \u0646\u0627\u0645\u0648\u0641\u0642 \u0628\u0648\u062F\u061B \u0648\u0636\u0639\u06CC\u062A \u0628\u0627\u0632\u06AF\u0634\u062A \u0628\u0627\u06CC\u062F \u0628\u0631\u0631\u0633\u06CC \u0634\u0648\u062F.',
  REMOTE_METADATA_FAILED:'\u062E\u0648\u0627\u0646\u062F\u0646 \u0646\u062A\u06CC\u062C\u0647 \u0646\u0635\u0628 \u0628\u0631\u0627\u06CC \u062B\u0628\u062A \u062F\u0631 \u0645\u062F\u0627\u0631 \u0646\u0627\u0645\u0648\u0641\u0642 \u0628\u0648\u062F.'
});
function showInstalledProbe(){
  installedProbe=true;
  el('resetInstalled').hidden=false;el('resetInstalled').disabled=false;
  el('resetNote').hidden=false;
  el('fingerprint').textContent=fingerprint;
  el('credentials').hidden=false;
  el('install').disabled=true;
  el('diagnose').hidden=false;el('diagnose').disabled=false;
  el('diagnoseNote').hidden=true;
  status('\u0633\u0631\u0648\u0631 \u0642\u0628\u0644\u0627\u064B \u0646\u0635\u0628 \u0634\u062F\u0647 \u0627\u0633\u062A. \u0647\u0648\u06CC\u062A \u0633\u0631\u0648\u0631 \u0631\u0627 \u062A\u0623\u06CC\u06CC\u062F \u06A9\u0646 \u0648 \u0628\u0631\u0627\u06CC \u0628\u0631\u0631\u0633\u06CC \u0639\u0627\u0645\u0644\u060C \u06A9\u0644\u06CC\u062F \u0631\u0627 \u062F\u0631 \u0647\u0645\u06CC\u0646 \u0641\u0631\u0645 \u0648\u0627\u0631\u062F \u06A9\u0646.');
}
async function poll(id,kind){
  clearTimeout(timer);
  try{
    const b=await api('jobs/'+id);
    if(b.state==='failed'){
      busy=false;lock(false);el('probe').disabled=false;
      if(kind==='install'&&b.fingerprint)showDiagnoseForInstall(id,b.fingerprint);
      status(kind==='cleanup'?'\u067E\u0627\u06A9\u200C\u0633\u0627\u0632\u06CC \u06A9\u0627\u0645\u0644 \u0646\u0634\u062F: '+(errors[b.safe_code]||'\u0648\u0636\u0639\u06CC\u062A \u0633\u0631\u0648\u0631 \u0646\u06CC\u0627\u0632\u0645\u0646\u062F \u0628\u0631\u0631\u0633\u06CC \u0627\u0633\u062A. \u0627\u0632 \u062A\u06A9\u0631\u0627\u0631 \u062E\u0648\u062F\u06A9\u0627\u0631 \u062D\u0630\u0641 \u062E\u0648\u062F\u062F\u0627\u0631\u06CC \u06A9\u0646.'):kind==='diagnose'?diagnosisMessage(b.safe_code):
        '\u0639\u0645\u0644\u06CC\u0627\u062A \u0646\u0627\u0645\u0648\u0641\u0642 \u0628\u0648\u062F: '+(installDetails[b.safe_code]||'\u062E\u0637\u0627\u06CC \u0646\u0627\u0645\u0634\u062E\u0635 \u0647\u0646\u06AF\u0627\u0645 \u0646\u0635\u0628 \u0631\u062E \u062F\u0627\u062F.'));
      return;
    }
    if(b.state==='ready'){
      busy=false;lock(false);el('probe').disabled=false;
      if(kind==='probe'){
        probeId=id;fingerprint=b.fingerprint;
        probeExpires=Date.now()+9*60*1000;
        if(b.installed){
          showInstalledProbe();
        }else if(failedInstallId&&failedNodeId===el('nodeId').value.trim()){
          showDiagnoseForInstall(failedInstallId,fingerprint,failedNodeId);
          status('\u0627\u062A\u0635\u0627\u0644 \u0628\u0631\u0642\u0631\u0627\u0631 \u0627\u0633\u062A\u060C \u0627\u0645\u0627 \u062B\u0628\u062A \u0646\u0635\u0628 \u0646\u0627\u0645\u0648\u0641\u0642 \u0642\u0628\u0644\u06CC \u0647\u0646\u0648\u0632 \u0648\u062C\u0648\u062F \u062F\u0627\u0631\u062F. \u0627\u0628\u062A\u062F\u0627 \xAB\u0639\u06CC\u0628\u200C\u06CC\u0627\u0628\u06CC \u0628\u062F\u0648\u0646 \u0646\u0635\u0628\xBB \u0631\u0627 \u0628\u0632\u0646.');
        }else{
          failedInstallId=null;failedNodeId=null;el('diagnose').hidden=true;
          el('fingerprint').textContent=fingerprint;el('credentials').hidden=false;
          el('install').disabled=false;
          status('\u0627\u062A\u0635\u0627\u0644 \u0628\u0631\u0631\u0633\u06CC \u0634\u062F. \u0647\u0648\u06CC\u062A \u0633\u0631\u0648\u0631 \u0631\u0627 \u062A\u0623\u06CC\u06CC\u062F \u0648 \u0627\u0637\u0644\u0627\u0639\u0627\u062A \u0648\u0631\u0648\u062F \u0631\u0627 \u0648\u0627\u0631\u062F \u06A9\u0646.');
        }
      }else if(kind==='cleanup'){
        el('resetInstalled').disabled=false;
        el('resetInstalled').hidden=true;el('resetNote').hidden=true;
        el('credentials').hidden=true;
        installedProbe=false;runtimeDownId=null;probeId=null;probeExpires=0;
        el('nodeId').value=el('nodeId').value.slice(0,55)+'-new1';
        status('\u2705 \u067E\u0627\u06A9\u200C\u0633\u0627\u0632\u06CC \u0627\u062E\u062A\u0635\u0627\u0635\u06CC V2 \u0631\u0648\u06CC VPS \u062A\u0623\u06CC\u06CC\u062F \u0634\u062F. \u0633\u0627\u0628\u0642\u0647 \u0633\u0631\u0648\u0631 \u0642\u062F\u06CC\u0645\u06CC \u062D\u0641\u0638 \u0648 \u062F\u0633\u062A\u0631\u0633\u06CC \u0622\u0646 \u0628\u0627\u0632\u0646\u0634\u0633\u062A\u0647 \u0634\u062F. \u0634\u0646\u0627\u0633\u0647 \u062C\u062F\u06CC\u062F \u0622\u0645\u0627\u062F\u0647 \u0627\u0633\u062A\u061B \u062F\u06A9\u0645\u0647 \xAB\u0628\u0631\u0631\u0633\u06CC \u0627\u062A\u0635\u0627\u0644\xBB \u0631\u0627 \u0628\u0632\u0646 \u0648 \u0646\u0635\u0628 \u062C\u062F\u06CC\u062F \u0631\u0627 \u0627\u0646\u062C\u0627\u0645 \u0628\u062F\u0647.');
      }else if(kind==='diagnose'){
        if(installedProbe){
          runtimeDownId=b.safe_code==='DIAG_RUNTIME_DOWN'?id:null;
          el('diagnose').textContent=runtimeDownId?'\u0631\u0627\u0647\u200C\u0627\u0646\u062F\u0627\u0632\u06CC \u0639\u0627\u0645\u0644 \u0645\u062F\u0627\u0631':'\u0639\u06CC\u0628\u200C\u06CC\u0627\u0628\u06CC \u0628\u062F\u0648\u0646 \u0646\u0635\u0628 (\u0641\u0642\u0637 \u0628\u0631\u0631\u0633\u06CC)';
          el('diagnose').disabled=false;
          status(diagnosisMessage(b.safe_code)+(runtimeDownId?' \u0628\u0631\u0627\u06CC \u0631\u0627\u0647\u200C\u0627\u0646\u062F\u0627\u0632\u06CC \u0639\u0627\u0645\u0644\u060C \u06A9\u0644\u06CC\u062F \u0631\u0627 \u062F\u0648\u0628\u0627\u0631\u0647 \u0627\u0646\u062A\u062E\u0627\u0628 \u06A9\u0646.':''));
          return;
        }
        diagnosticId=b.safe_code==='DIAG_PRECHECK_OK'?id:null;
        el('clearFailed').hidden=!diagnosticId;
        el('clearFailed').disabled=!diagnosticId;
        el('diagnose').hidden=!!diagnosticId;
        el('diagnose').disabled=false;
        status(diagnosisMessage(b.safe_code)+
          (diagnosticId?' \u062F\u0631 \u0635\u0648\u0631\u062A \u0627\u0637\u0645\u06CC\u0646\u0627\u0646 \u0627\u0632 \u062E\u0627\u0644\u06CC \u0628\u0648\u062F\u0646 VPS\u060C \u062B\u0628\u062A \u0646\u0627\u0645\u0648\u0641\u0642 \u0631\u0627 \u067E\u0627\u06A9 \u06A9\u0646.':' \u0647\u06CC\u0686 \u0646\u0635\u0628 \u06CC\u0627 \u062D\u0630\u0641\u06CC \u0627\u062C\u0631\u0627 \u0646\u0634\u062F.'));
      }else{
        el('credentials').hidden=true;
        status('\u0646\u0635\u0628 \u062B\u0628\u062A \u0634\u062F. \u0628\u0647 \u0631\u0628\u0627\u062A \u0628\u0631\u06AF\u0631\u062F \u0648 \xAB\u0635\u062F\u0648\u0631 \u06A9\u0627\u0646\u0641\u06CC\u06AF \u062A\u0633\u062A\xBB \u0631\u0627 \u0628\u0632\u0646. \u0622\u0632\u0645\u0648\u0646 \u0627\u06CC\u0646\u062A\u0631\u0646\u062A \u0648 \u0633\u0647\u0645\u06CC\u0647 \u0647\u0646\u0648\u0632 \u062C\u062F\u0627\u06AF\u0627\u0646\u0647 \u0627\u0646\u062C\u0627\u0645 \u0645\u06CC\u200C\u0634\u0648\u062F.');
      }
      return;
    }
    status(kind==='probe'?'\u062F\u0631 \u062D\u0627\u0644 \u0628\u0631\u0631\u0633\u06CC \u0627\u062A\u0635\u0627\u0644\u2026':kind==='cleanup'?'\u062F\u0631 \u062D\u0627\u0644 \u067E\u0627\u06A9\u200C\u0633\u0627\u0632\u06CC \u0627\u0645\u0646 V2 \u0631\u0648\u06CC VPS\u2026':kind==='diagnose'?'\u062F\u0631 \u062D\u0627\u0644 \u0639\u06CC\u0628\u200C\u06CC\u0627\u0628\u06CC \u0641\u0642\u0637\u200C\u062E\u0648\u0627\u0646\u062F\u0646\u06CC \u0633\u0631\u0648\u0631\u2026':'\u0646\u0635\u0628 \u062F\u0631 \u062D\u0627\u0644 \u0627\u062C\u0631\u0627\u0633\u062A\u2026');
    timer=setTimeout(()=>poll(id,kind),3000);
  }catch(e){busy=false;status('\u0627\u0631\u062A\u0628\u0627\u0637 \u0628\u0627 \u0633\u0631\u0648\u06CC\u0633 \u0628\u0631\u0642\u0631\u0627\u0631 \u0646\u0634\u062F\u061B \u062F\u0648\u0628\u0627\u0631\u0647 \u062A\u0644\u0627\u0634 \u06A9\u0646\u06CC\u062F.');}
}
el('resetInstalled').onclick=async()=>{
  if(busy||!installedProbe||!probeId||!fingerprint||!el('trust').checked||Date.now()>=probeExpires){
    status('\u0628\u0631\u0627\u06CC \u067E\u0627\u06A9\u200C\u0633\u0627\u0632\u06CC\u060C \u0627\u0628\u062A\u062F\u0627 \u0628\u0631\u0631\u0633\u06CC \u0627\u062A\u0635\u0627\u0644 \u0648 \u062A\u0637\u0628\u06CC\u0642 \u0627\u062B\u0631 \u0627\u0646\u06AF\u0634\u062A SSH \u0631\u0627 \u0627\u0646\u062C\u0627\u0645 \u0628\u062F\u0647.');return;
  }
  const nodeId=el('nodeId').value.trim();
  busy=true;el('resetInstalled').disabled=true;
  let credentials=null;
  try{
    const gate=await api('reset-check?nodeId='+encodeURIComponent(nodeId));
    if(!gate.ok)throw Error(errors[gate.code]||'\u0628\u0647 \u0639\u0644\u062A \u0627\u0637\u0644\u0627\u0639\u0627\u062A \u0648\u0627\u0628\u0633\u062A\u0647 \u0631\u0648\u06CC \u0633\u0631\u0648\u0631\u060C \u067E\u0627\u06A9\u200C\u0633\u0627\u0632\u06CC \u0645\u062C\u0627\u0632 \u0646\u06CC\u0633\u062A.');
    const count=gate.willCancelPending||0;
    const consent=prompt('\u067E\u0627\u06A9\u200C\u0633\u0627\u0632\u06CC V2 \u0631\u0648\u06CC \u0633\u0631\u0648\u0631 '+nodeId+' \u063A\u06CC\u0631\u0642\u0627\u0628\u0644 \u0628\u0627\u0632\u06AF\u0634\u062A \u0627\u0633\u062A. '+
      (count?'\u062A\u0639\u062F\u0627\u062F '+count+' \u0633\u0641\u0627\u0631\u0634 \u0622\u0632\u0645\u0627\u06CC\u0634\u06CC\u0650 \u0646\u0635\u0628\u200C\u0646\u0634\u062F\u0647 \u0644\u063A\u0648 \u0645\u06CC\u200C\u0634\u0648\u062F. ':'')+
      '\u0641\u0642\u0637 \u0641\u0627\u06CC\u0644\u200C\u0647\u0627 \u0648 \u0633\u0631\u0648\u06CC\u0633\u200C\u0647\u0627\u06CC \u0627\u062E\u062A\u0635\u0627\u0635\u06CC \u0645\u062F\u0627\u0631 \u062D\u0630\u0641 \u0645\u06CC\u200C\u0634\u0648\u0646\u062F. \u0628\u0631\u0627\u06CC \u062A\u0623\u06CC\u06CC\u062F\u060C \u0646\u0627\u0645 \u0633\u0631\u0648\u0631 \u0631\u0627 \u062F\u0642\u06CC\u0642 \u0648\u0627\u0631\u062F \u06A9\u0646:');
    if(consent!==nodeId){busy=false;el('resetInstalled').disabled=false;status('\u067E\u0627\u06A9\u200C\u0633\u0627\u0632\u06CC \u0644\u063A\u0648 \u0634\u062F\u061B \u0647\u06CC\u0686 \u0641\u0631\u0645\u0627\u0646\u06CC \u0627\u062C\u0631\u0627 \u0646\u0634\u062F.');return;}
    credentials=el('method').value==='password'
      ?{method:'password',password:el('password').value}
      :{method:'key',key:await el('keyfile').files[0]?.text(),passphrase:el('password').value};
    if(credentials.method==='password'?!credentials.password:!credentials.key)
      throw Error('\u0631\u0645\u0632 \u06CC\u0627 \u06A9\u0644\u06CC\u062F SSH \u0631\u0627 \u062F\u0631 \u0641\u0631\u0645 \u0627\u0645\u0646 \u0648\u0627\u0631\u062F \u06A9\u0646.');
    const envelope=await encrypt(credentials);credentials=null;
    const job=await api('reset',{nodeId,confirmNodeId:nodeId,confirm:'RESET_V2_ONLY',
      probeId,fingerprint,trust:true,envelope});
    el('password').value='';el('keyfile').value='';
    status('\u062F\u0631\u062E\u0648\u0627\u0633\u062A \u067E\u0627\u06A9\u200C\u0633\u0627\u0632\u06CC \u0627\u0645\u0646 \u062B\u0628\u062A \u0634\u062F\u061B \u062F\u0631 \u062D\u0627\u0644 \u062A\u0623\u06CC\u06CC\u062F \u0639\u0645\u0644\u06CC\u0627\u062A \u0627\u0632 \u0633\u0631\u0648\u0631\u2026');
    poll(job.id,'cleanup');
  }catch(e){busy=false;el('resetInstalled').disabled=false;status('\u067E\u0627\u06A9\u200C\u0633\u0627\u0632\u06CC \u0622\u063A\u0627\u0632 \u0646\u0634\u062F: '+e.message);}
  finally{credentials=null;}
};
el('clearFailed').onclick=async()=>{
  if(busy||!failedInstallId||!diagnosticId)return;
  busy=true;el('clearFailed').disabled=true;
  try{
    const result=await api('clear-failed',{failedInstallId,diagnosticId});
    if(result.status!=='CLEARED')throw Error('\u067E\u0627\u06A9\u200C\u0633\u0627\u0632\u06CC \u062A\u0623\u06CC\u06CC\u062F \u0646\u0634\u062F.');
    failedInstallId=null;failedNodeId=null;diagnosticId=null;probeId=null;probeExpires=0;fingerprint=null;
    el('credentials').hidden=true;el('clearFailed').hidden=true;
    el('keyfile').value='';el('password').value='';el('trust').checked=false;
    el('probe').disabled=false;
    status('\u062B\u0628\u062A \u0646\u0635\u0628 \u0646\u0627\u0645\u0648\u0641\u0642 \u0627\u0632 \u0645\u062F\u0627\u0631 \u067E\u0627\u06A9 \u0634\u062F. \u062F\u0648\u0628\u0627\u0631\u0647 \xAB\u0628\u0631\u0631\u0633\u06CC \u0627\u062A\u0635\u0627\u0644\xBB \u0631\u0627 \u0628\u0632\u0646 \u0648 \u0633\u067E\u0633 \u0646\u0635\u0628 \u0631\u0627 \u0622\u063A\u0627\u0632 \u06A9\u0646.');
  }catch(e){el('clearFailed').disabled=false;status('\u067E\u0627\u06A9\u200C\u0633\u0627\u0632\u06CC \u0627\u0646\u062C\u0627\u0645 \u0646\u0634\u062F: '+e.message);}
  finally{busy=false;}
};
el('diagnose').onclick=async()=>{
  if(busy||(!failedInstallId&&!installedProbe)||!fingerprint||!el('trust').checked){
    status('\u0627\u0628\u062A\u062F\u0627 \u0627\u062B\u0631 \u0627\u0646\u06AF\u0634\u062A SSH \u0642\u0628\u0644\u06CC \u0631\u0627 \u062A\u0623\u06CC\u06CC\u062F \u06A9\u0646.');return;
  }
  if(runtimeDownId&&!confirm('\u0639\u0627\u0645\u0644 \u0645\u062F\u0627\u0631 \u0631\u0648\u06CC \u0647\u0645\u06CC\u0646 \u0633\u0631\u0648\u0631 \u0631\u0627\u0647\u200C\u0627\u0646\u062F\u0627\u0632\u06CC \u0634\u0648\u062F\u061F'))return;
  busy=true;el('diagnose').disabled=true;
  let credentials;
  try{
    credentials=el('method').value==='password'
      ?{method:'password',password:el('password').value}
      :{method:'key',key:await el('keyfile').files[0]?.text(),passphrase:el('password').value};
    if(credentials.method==='password'?!credentials.password:!credentials.key)
      throw Error('\u0627\u0637\u0644\u0627\u0639\u0627\u062A \u0648\u0631\u0648\u062F \u0631\u0627 \u062F\u0631 \u0641\u0631\u0645 \u0627\u0645\u0646 \u0648\u0627\u0631\u062F \u06A9\u0646.');
    const envelope=await encrypt(credentials);
    credentials=null;
    const job=await api(installedProbe?'diagnose-installed':'diagnose',{failedInstallId,probeId,fingerprint,trust:true,envelope,startRuntime:!!runtimeDownId,diagnosticId:runtimeDownId});
    el('password').value='';el('keyfile').value='';
    status('\u0639\u06CC\u0628\u200C\u06CC\u0627\u0628\u06CC \u0628\u062F\u0648\u0646 \u0646\u0635\u0628 \u0634\u0631\u0648\u0639 \u0634\u062F\u2026');
    poll(job.id,'diagnose');
  }catch(e){busy=false;el('diagnose').disabled=false;status('\u0639\u06CC\u0628\u200C\u06CC\u0627\u0628\u06CC \u0622\u063A\u0627\u0632 \u0646\u0634\u062F: '+e.message+' \u0641\u0627\u06CC\u0644 \u06A9\u0644\u06CC\u062F \u0631\u0627 \u062F\u0648\u0628\u0627\u0631\u0647 \u0627\u0646\u062A\u062E\u0627\u0628 \u0646\u06A9\u0646\u061B \u0647\u0645\u06CC\u0646\u200C\u062C\u0627 \u0645\u06CC\u200C\u062A\u0648\u0627\u0646\u06CC \u062A\u0644\u0627\u0634 \u06A9\u0646\u06CC.');}
  finally{credentials=null;}
};

el('pairRunner').onclick=async()=>{
  el('pairRunner').disabled=true;
  try{
    const r=await api('pair-runner',{});
    el('pairingStatus').textContent=r.status==='RUNNER_CONNECTED'
      ?'\u0631\u0627\u0646\u0631 V2 \u0627\u0632 \u0642\u0628\u0644 \u0645\u062A\u0635\u0644 \u0627\u0633\u062A\u061B \u0635\u0641\u062D\u0647 \u0631\u0627 \u0627\u0632 \u0631\u0628\u0627\u062A \u062F\u0648\u0628\u0627\u0631\u0647 \u0628\u0627\u0632 \u06A9\u0646.'
      :'\u0627\u062A\u0635\u0627\u0644 \u0631\u0645\u0632\u06AF\u0630\u0627\u0631\u06CC\u200C\u0634\u062F\u0647 \u0628\u0631\u0627\u06CC \u06F1\u06F0 \u062F\u0642\u06CC\u0642\u0647 \u0622\u0645\u0627\u062F\u0647 \u0634\u062F. \u0641\u0631\u0645\u0627\u0646 \u0646\u0635\u0628 \u06CC\u06A9\u200C\u0628\u0627\u0631\u0647 V2 \u0628\u0627\u06CC\u062F \u0631\u0648\u06CC \u0645\u06CC\u0632\u0628\u0627\u0646 \u0631\u0627\u0646\u0631 \u0642\u062F\u06CC\u0645\u06CC \u0627\u062C\u0631\u0627 \u0634\u0648\u062F\u061B \u0647\u06CC\u0686 \u0631\u0645\u0632 \u06CC\u0627 \u06A9\u0644\u06CC\u062F \u062E\u0635\u0648\u0635\u06CC \u0627\u0632 \u0622\u0646 \u062E\u0627\u0631\u062C \u0646\u0645\u06CC\u200C\u0634\u0648\u062F.';
  }catch(e){el('pairingStatus').textContent='\u0627\u062A\u0635\u0627\u0644 \u0627\u0645\u0646 \u0631\u0627\u0646\u0631 \u0628\u0631\u0642\u0631\u0627\u0631 \u0646\u0634\u062F\u061B \u062A\u0646\u0638\u06CC\u0645\u0627\u062A \u0631\u0627 \u0628\u0631\u0631\u0633\u06CC \u06A9\u0646\u06CC\u062F.';}
  finally{el('pairRunner').disabled=false;}
};
el('probe').onclick=async()=>{if(busy||!el('form').reportValidity())return;busy=true;if(failedNodeId!==el('nodeId').value.trim()){failedInstallId=null;failedNodeId=null;}probeId=null;probeExpires=0;installedProbe=false;runtimeDownId=null;el('resetInstalled').hidden=true;el('resetNote').hidden=true;el('diagnose').textContent='\u0639\u06CC\u0628\u200C\u06CC\u0627\u0628\u06CC \u0628\u062F\u0648\u0646 \u0646\u0635\u0628 (\u0641\u0642\u0637 \u0628\u0631\u0631\u0633\u06CC)';el('diagnose').hidden=true;el('diagnoseNote').hidden=true;el('probe').disabled=true;el('credentials').hidden=true;el('trust').checked=false;try{const b={};for(const id of ['nodeId','provider','region','ip','username'])b[id]=el(id).value.trim();for(const id of ['userLimit','capacityGb','port'])b[id]=Number(el(id).value);const job=await api('probe',b);lock(true);poll(job.id,'probe');}catch(e){busy=false;el('probe').disabled=false;status('\u0628\u0631\u0631\u0633\u06CC \u0627\u062A\u0635\u0627\u0644 \u0622\u063A\u0627\u0632 \u0646\u0634\u062F: '+e.message);}};
el('form').onsubmit=async e=>{
  e.preventDefault();
  if(busy||failedInstallId||installedProbe||!probeId||!el('trust').checked){
    status('\u0627\u0628\u062A\u062F\u0627 \u0627\u062B\u0631 \u0627\u0646\u06AF\u0634\u062A \u0633\u0631\u0648\u0631 \u0631\u0627 \u062A\u0623\u06CC\u06CC\u062F \u06A9\u0646. \u0628\u0631\u0627\u06CC \u0646\u0635\u0628 \u0642\u0628\u0644\u06CC \u0646\u0627\u0645\u0648\u0641\u0642\u060C \u06AF\u0632\u06CC\u0646\u0647 \u0639\u06CC\u0628\u200C\u06CC\u0627\u0628\u06CC \u0628\u062F\u0648\u0646 \u0646\u0635\u0628 \u0631\u0627 \u0628\u0632\u0646.');return;
  }
  if(Date.now()>=probeExpires){
    probeId=null;el('install').disabled=true;
    status('\u0645\u0647\u0644\u062A \u06F1\u06F0 \u062F\u0642\u06CC\u0642\u0647\u200C\u0627\u06CC \u0627\u062B\u0631 \u0627\u0646\u06AF\u0634\u062A \u067E\u0627\u06CC\u0627\u0646 \u06CC\u0627\u0641\u062A\u0647 \u0627\u0633\u062A. \u067E\u06CC\u0634 \u0627\u0632 \u0627\u0631\u0633\u0627\u0644 \u06A9\u0644\u06CC\u062F\u060C \u062F\u0648\u0628\u0627\u0631\u0647 \xAB\u0628\u0631\u0631\u0633\u06CC \u0627\u062A\u0635\u0627\u0644\xBB \u0631\u0627 \u0628\u0632\u0646.');return;
  }
  busy=true;el('install').disabled=true;
  let credentials;
  try{
    credentials=el('method').value==='password'
      ?{method:'password',password:el('password').value}
      :{method:'key',key:await el('keyfile').files[0]?.text(),passphrase:el('password').value};
    if(credentials.method==='password'?!credentials.password:!credentials.key)
      throw Error('\u0627\u0637\u0644\u0627\u0639\u0627\u062A \u0648\u0631\u0648\u062F \u0631\u0627 \u0648\u0627\u0631\u062F \u06A9\u0646.');
    const envelope=await encrypt(credentials);
    credentials=null;
    const job=await api('install',{probeId,fingerprint,trust:true,envelope});
    // Clear the local file picker only after the API accepts the job.
    el('password').value='';el('keyfile').value='';
    poll(job.id,'install');
  }catch(e){
    busy=false;el('install').disabled=false;
    status('\u0646\u0635\u0628 \u0622\u063A\u0627\u0632 \u0646\u0634\u062F: '+e.message+'\\n\u0641\u0627\u06CC\u0644 \u06A9\u0644\u06CC\u062F \u0627\u0646\u062A\u062E\u0627\u0628\u200C\u0634\u062F\u0647 \u062D\u0641\u0638 \u0634\u062F\u0647 \u0627\u0633\u062A\u061B \u0628\u0631\u0627\u06CC \u062A\u0644\u0627\u0634 \u0645\u062C\u062F\u062F \u0646\u06CC\u0627\u0632\u06CC \u0628\u0647 \u0627\u0646\u062A\u062E\u0627\u0628 \u062F\u0648\u0628\u0627\u0631\u0647 \u0646\u06CC\u0633\u062A.');
  }finally{credentials=null;}
};
if(!auth)status('\u0627\u06CC\u0646 \u0635\u0641\u062D\u0647 \u0631\u0627 \u0627\u0632 \u062F\u06A9\u0645\u0647 \u0627\u0641\u0632\u0648\u062F\u0646 \u0633\u0631\u0648\u0631 \u062F\u0631 \u0631\u0628\u0627\u062A V2 \u0628\u0627\u0632 \u06A9\u0646.');
else api('session').then(async s=>{
  publicKey=s.publicKey;el('probe').disabled=false;
  try{await restoreJob();}catch(e){status('\u0628\u0627\u0632\u06CC\u0627\u0628\u06CC \u0648\u0636\u0639\u06CC\u062A \u0642\u0628\u0644\u06CC \u0645\u0645\u06A9\u0646 \u0646\u0634\u062F\u061B \u062F\u0648\u0628\u0627\u0631\u0647 \u062A\u0644\u0627\u0634 \u06A9\u0646\u06CC\u062F.');}
}).catch(e=>{
  el('runnerPairing').hidden=false;
  status('\u0646\u0634\u0633\u062A \u0627\u0645\u0646 \u0645\u0646\u0642\u0636\u06CC \u0634\u062F\u0647 \u06CC\u0627 \u0627\u0631\u062A\u0628\u0627\u0637 \u0628\u0631\u0642\u0631\u0627\u0631 \u0646\u06CC\u0633\u062A\u061B \u0635\u0641\u062D\u0647 \u0631\u0627 \u0627\u0632 \u0631\u0628\u0627\u062A \u062F\u0648\u0628\u0627\u0631\u0647 \u0628\u0627\u0632 \u06A9\u0646\u06CC\u062F.');
});
<\/script></html>`])));

// src/telegram-activation.mjs
var LEGACY_BOT_ID = 8905373112;
var V2_URL = "https://madar-v2-staging.alirezaanari117.workers.dev/telegram/webhook";
var API = "https://api.telegram.org/bot";
async function activateIsolatedBotWebhook(env, send = fetch) {
  if (env.V2_BOT_AUTO_ACTIVATE !== "true" || !env.TELEGRAM_WEBHOOK_SECRET || !env.BOT_TOKEN || !/^[a-zA-Z0-9_-]{32,128}$/.test(env.TELEGRAM_WEBHOOK_SECRET) || !/^\d{5,20}(?:,\d{5,20})*$/.test(env.ADMIN_TELEGRAM_IDS ?? ""))
    return { state: "disabled" };
  const request = /* @__PURE__ */ __name(async (method, params = {}) => {
    const url = API + env.BOT_TOKEN + "/" + method;
    const response4 = await send(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(8e3)
    });
    if (!response4.ok) throw Error("telegram_api_failed");
    const body3 = await response4.json();
    if (body3?.ok !== true) throw Error("telegram_api_failed");
    return body3.result;
  }, "request");
  try {
    const me = await request("getMe");
    if (!Number.isSafeInteger(me?.id) || me.id === LEGACY_BOT_ID || me.is_bot !== true)
      return { state: "legacy_or_invalid_bot" };
    const hook = await request("getWebhookInfo");
    if (typeof hook?.url !== "string" || hook.url !== "" && hook.url !== V2_URL)
      return { state: "existing_other_webhook" };
    if (hook.url === V2_URL) return { state: "ready" };
    const installed = await request("setWebhook", {
      url: V2_URL,
      secret_token: env.TELEGRAM_WEBHOOK_SECRET,
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: false,
      max_connections: 8
    });
    return { state: installed === true ? "installed" : "failed" };
  } catch {
    return { state: "unavailable" };
  }
}
__name(activateIsolatedBotWebhook, "activateIsolatedBotWebhook");

// src/bot-activation.mjs
var API2 = "https://api.telegram.org/bot";
function channelConfig(env) {
  const id = String(env.MADAR_CHANNEL_ID ?? "").trim();
  const url = String(env.MADAR_CHANNEL_URL ?? "").trim();
  const validId = /^(?:-100\d{5,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/.test(id);
  let validUrl = false;
  try {
    const parsed = new URL(url);
    validUrl = parsed.protocol === "https:" && parsed.hostname === "t.me" && !parsed.username && !parsed.password && !parsed.search && !parsed.hash && /^\/(?:[A-Za-z][A-Za-z0-9_]{4,31}|\+[A-Za-z0-9_-]{8,}|joinchat\/[A-Za-z0-9_-]{8,})\/?$/.test(parsed.pathname);
  } catch {
  }
  return validId && validUrl ? { id, url } : null;
}
__name(channelConfig, "channelConfig");
function channelActivationConfigured(env) {
  return !!channelConfig(env) && typeof env.BOT_TOKEN === "string" && env.BOT_TOKEN.length > 20;
}
__name(channelActivationConfigured, "channelActivationConfigured");
async function isBotActivated(db, telegramId) {
  if (!db || !/^\d{1,20}$/.test(String(telegramId ?? ""))) return false;
  const row = await db.prepare(
    "SELECT 1 AS active FROM telegram_bot_activations WHERE telegram_id=?"
  ).bind(String(telegramId)).first();
  return !!row;
}
__name(isBotActivated, "isBotActivated");
async function checkAndActivateBot(env, telegramId, now = Date.now(), send = fetch) {
  if (!env.DB || !/^\d{5,20}$/.test(String(telegramId ?? "")) || typeof env.BOT_TOKEN !== "string" || env.BOT_TOKEN.length < 20)
    return { state: "unavailable" };
  const config = channelConfig(env);
  if (!config) return { state: "unconfigured" };
  let data;
  try {
    const response4 = await send(API2 + env.BOT_TOKEN + "/getChatMember", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: config.id, user_id: Number(telegramId) }),
      signal: AbortSignal.timeout(8e3)
    });
    data = await response4.json().catch(() => null);
    if (!response4.ok || data?.ok !== true || !data?.result) return { state: "unavailable" };
  } catch {
    return { state: "unavailable" };
  }
  const member = data.result;
  const joined = ["creator", "administrator", "member"].includes(member.status) || member.status === "restricted" && member.is_member === true;
  if (!joined) {
    await env.DB.prepare(
      "DELETE FROM telegram_bot_activations WHERE telegram_id=?"
    ).bind(String(telegramId)).run();
    return { state: "not_member", channelUrl: config.url };
  }
  await env.DB.prepare(
    "INSERT INTO customers(telegram_id,locale) VALUES(?,'fa') ON CONFLICT(telegram_id) DO UPDATE SET locale='fa'"
  ).bind(String(telegramId)).run();
  await env.DB.prepare(
    "INSERT INTO telegram_bot_activations(telegram_id,channel_id,activated_ms,last_verified_ms) VALUES(?,?,?,?) ON CONFLICT(telegram_id) DO UPDATE SET channel_id=excluded.channel_id,last_verified_ms=excluded.last_verified_ms"
  ).bind(String(telegramId), config.id, now, now).run();
  return { state: "activated", channelUrl: config.url };
}
__name(checkAndActivateBot, "checkAndActivateBot");
function activationKeyboard(env, callbackData) {
  const config = channelConfig(env);
  if (!config) return null;
  return { inline_keyboard: [
    [{ text: "\u{1F4E2} \u0639\u0636\u0648\u06CC\u062A \u062F\u0631 \u06A9\u0627\u0646\u0627\u0644 \u0627\u0637\u0644\u0627\u0639\u200C\u0631\u0633\u0627\u0646\u06CC \u0645\u062F\u0627\u0631", url: config.url }],
    [{ text: "\u2705 \u0628\u0631\u0631\u0633\u06CC \u0639\u0636\u0648\u06CC\u062A \u0648 \u0627\u062F\u0627\u0645\u0647", callback_data: callbackData }]
  ] };
}
__name(activationKeyboard, "activationKeyboard");
function activationPrompt(env, callbackData, context = "bot") {
  const app = context === "app";
  const markup = activationKeyboard(env, callbackData);
  if (!channelConfig(env)) return {
    text: "\u26A0\uFE0F \u0641\u0639\u0627\u0644\u200C\u0633\u0627\u0632\u06CC \u0645\u062F\u0627\u0631 \u0647\u0646\u0648\u0632 \u067E\u06CC\u06A9\u0631\u0628\u0646\u062F\u06CC \u0646\u0634\u062F\u0647 \u0627\u0633\u062A. \u0644\u0637\u0641\u0627\u064B \u06A9\u0645\u06CC \u0628\u0639\u062F \u062F\u0648\u0628\u0627\u0631\u0647 \u062A\u0644\u0627\u0634 \u06A9\u0646\u06CC\u062F \u06CC\u0627 \u0628\u0627 \u067E\u0634\u062A\u06CC\u0628\u0627\u0646\u06CC \u0645\u062F\u0627\u0631 \u062A\u0645\u0627\u0633 \u0628\u06AF\u06CC\u0631\u06CC\u062F.",
    replyMarkup: null
  };
  return {
    text: app ? "\u{1F510} \u0628\u0631\u0627\u06CC \u0648\u0631\u0648\u062F \u0628\u0647 \u0627\u067E \u0645\u062F\u0627\u0631\u060C \u0627\u0628\u062A\u062F\u0627 \u0631\u0628\u0627\u062A \u0631\u0627 \u0641\u0639\u0627\u0644 \u06A9\u0646\u06CC\u062F.\n\n\u06F1. \u0627\u0632 \u062F\u06A9\u0645\u0647 \u0632\u06CC\u0631 \u0639\u0636\u0648 \u06A9\u0627\u0646\u0627\u0644 \u0627\u0637\u0644\u0627\u0639\u200C\u0631\u0633\u0627\u0646\u06CC \u0645\u062F\u0627\u0631 \u0634\u0648\u06CC\u062F.\n\u06F2. \u0628\u0647 \u0647\u0645\u06CC\u0646 \u06AF\u0641\u062A\u200C\u0648\u06AF\u0648 \u0628\u0631\u06AF\u0631\u062F\u06CC\u062F \u0648 \xAB\u0628\u0631\u0631\u0633\u06CC \u0639\u0636\u0648\u06CC\u062A \u0648 \u0627\u062F\u0627\u0645\u0647\xBB \u0631\u0627 \u0628\u0632\u0646\u06CC\u062F.\n\u06F3. \u067E\u0633 \u0627\u0632 \u062A\u0623\u06CC\u06CC\u062F\u060C \u06A9\u062F \u06CC\u06A9\u200C\u0628\u0627\u0631\u0645\u0635\u0631\u0641 \u0648\u0631\u0648\u062F \u0628\u0631\u0627\u06CC\u062A\u0627\u0646 \u0627\u0631\u0633\u0627\u0644 \u0645\u06CC\u200C\u0634\u0648\u062F." : "\u{1F310} \u0628\u0631\u0627\u06CC \u0641\u0639\u0627\u0644\u200C\u0633\u0627\u0632\u06CC \u0631\u0628\u0627\u062A \u0645\u062F\u0627\u0631\u060C \u0639\u0636\u0648\u06CC\u062A \u062F\u0631 \u06A9\u0627\u0646\u0627\u0644 \u0627\u0637\u0644\u0627\u0639\u200C\u0631\u0633\u0627\u0646\u06CC \u0645\u062F\u0627\u0631 \u0627\u0644\u0632\u0627\u0645\u06CC \u0627\u0633\u062A.\n\n\u06F1. \u0639\u0636\u0648 \u06A9\u0627\u0646\u0627\u0644 \u0634\u0648\u06CC\u062F.\n\u06F2. \u0633\u067E\u0633 \xAB\u0628\u0631\u0631\u0633\u06CC \u0639\u0636\u0648\u06CC\u062A\xBB \u0631\u0627 \u0628\u0632\u0646\u06CC\u062F \u062A\u0627 \u062D\u0633\u0627\u0628 \u0634\u0645\u0627 \u0641\u0639\u0627\u0644 \u0634\u0648\u062F.",
    replyMarkup: markup
  };
}
__name(activationPrompt, "activationPrompt");
function activationUnavailableReply(env, callbackData) {
  return {
    text: "\u26A0\uFE0F \u062F\u0631 \u062D\u0627\u0644 \u062D\u0627\u0636\u0631 \u0627\u0645\u06A9\u0627\u0646 \u0628\u0631\u0631\u0633\u06CC \u0639\u0636\u0648\u06CC\u062A \u062F\u0631 \u06A9\u0627\u0646\u0627\u0644 \u0648\u062C\u0648\u062F \u0646\u062F\u0627\u0631\u062F. \u0686\u0646\u062F \u0644\u062D\u0638\u0647 \u062F\u06CC\u06AF\u0631 \u062F\u0648\u0628\u0627\u0631\u0647 \xAB\u0628\u0631\u0631\u0633\u06CC \u0639\u0636\u0648\u06CC\u062A\xBB \u0631\u0627 \u0628\u0632\u0646\u06CC\u062F.",
    replyMarkup: activationKeyboard(env, callbackData)
  };
}
__name(activationUnavailableReply, "activationUnavailableReply");

// src/android-login.mjs
var ID3 = /^[A-Za-z0-9_-]{24}$/;
var BOT = /^[A-Za-z][A-Za-z0-9_]{4,31}$/;
var OTP = /^\d{6}$/;
var encoder2 = new TextEncoder();
var random = /* @__PURE__ */ __name((size) => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(size)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""), "random");
var base64url = /* @__PURE__ */ __name((bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""), "base64url");
var fromBase64url = /* @__PURE__ */ __name((value) => {
  const clean = value.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(clean + "=".repeat((4 - clean.length % 4) % 4)), (x) => x.charCodeAt(0));
}, "fromBase64url");
var hex3 = /* @__PURE__ */ __name((bytes) => Array.from(bytes).map((x) => x.toString(16).padStart(2, "0")).join(""), "hex");
var json2 = /* @__PURE__ */ __name((data, status = 200) => new Response(JSON.stringify(data), { status, headers: {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "private, no-store",
  "pragma": "no-cache",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer"
} }), "json");
var botUsername = /* @__PURE__ */ __name((env) => env.BOT_USERNAME ?? env.BOT_USERNAME_SECRET ?? "", "botUsername");
var enabled2 = /* @__PURE__ */ __name((env) => (env.ANDROID_LOGIN_ENABLED === "true" || env.ANDROID_LOGIN_ENABLED_SECRET === "true") && !!env.DB && typeof env.TELEGRAM_WEBHOOK_SECRET === "string" && env.TELEGRAM_WEBHOOK_SECRET.length >= 32 && BOT.test(botUsername(env)), "enabled");
async function clientDigest(request, env) {
  const ip = (request.headers.get("cf-connecting-ip") ?? "unknown").trim().slice(0, 64) || "unknown";
  const key = await crypto.subtle.importKey(
    "raw",
    encoder2.encode(env.TELEGRAM_WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder2.encode(ip)));
  return hex3(mac);
}
__name(clientDigest, "clientDigest");
async function allowChallengeStart(request, env, now) {
  const digest2 = await clientDigest(request, env);
  const windowStart = Math.floor(now / 3e5) * 3e5;
  const result = await env.DB.prepare(
    "INSERT INTO android_login_rate_limits(ip_hash,window_start_ms,request_count) VALUES(?,?,1) ON CONFLICT(ip_hash,window_start_ms) DO UPDATE SET request_count=request_count+1 WHERE request_count<30"
  ).bind(digest2, windowStart).run();
  return result.meta?.changes === 1;
}
__name(allowChallengeStart, "allowChallengeStart");
var expired = /* @__PURE__ */ __name((time, now) => !Number.isSafeInteger(time) || time <= now, "expired");
async function otpHash(env, id, code) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder2.encode(env.TELEGRAM_WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return hex3(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder2.encode(id + ":" + code))));
}
__name(otpHash, "otpHash");
async function otpEncryptionKey(env) {
  const raw = await crypto.subtle.digest(
    "SHA-256",
    encoder2.encode("madar:android-login:otp-encryption:" + env.TELEGRAM_WEBHOOK_SECRET)
  );
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}
__name(otpEncryptionKey, "otpEncryptionKey");
async function encryptOtp(env, id, code) {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const key = await otpEncryptionKey(env);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({
    name: "AES-GCM",
    iv: nonce,
    additionalData: encoder2.encode(id)
  }, key, encoder2.encode(code)));
  return { nonce: base64url(nonce), ciphertext: base64url(ciphertext) };
}
__name(encryptOtp, "encryptOtp");
async function decryptOtp(env, id, row) {
  try {
    if (typeof row.otp_nonce !== "string" || typeof row.otp_ciphertext !== "string") return null;
    const key = await otpEncryptionKey(env);
    const clear3 = await crypto.subtle.decrypt({
      name: "AES-GCM",
      iv: fromBase64url(row.otp_nonce),
      additionalData: encoder2.encode(id)
    }, key, fromBase64url(row.otp_ciphertext));
    const code = new TextDecoder("utf-8", { fatal: true }).decode(clear3);
    return OTP.test(code) ? code : null;
  } catch {
    return null;
  }
}
__name(decryptOtp, "decryptOtp");
function sameText(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}
__name(sameText, "sameText");
function newOtp() {
  return String(crypto.getRandomValues(new Uint32Array(1))[0] % 1e6).padStart(6, "0");
}
__name(newOtp, "newOtp");
var expiredOrUsed = /* @__PURE__ */ __name(() => "\u23F1 \u0627\u06CC\u0646 \u062F\u0631\u062E\u0648\u0627\u0633\u062A \u0645\u0646\u0642\u0636\u06CC \u0634\u062F\u0647 \u06CC\u0627 \u0642\u0628\u0644\u0627\u064B \u0627\u0633\u062A\u0641\u0627\u062F\u0647 \u0634\u062F\u0647 \u0627\u0633\u062A. \u062F\u0648\u0628\u0627\u0631\u0647 \u0627\u0632 \u062F\u0627\u062E\u0644 \u0627\u067E \u062A\u0644\u0627\u0634 \u06A9\u0646\u06CC\u062F.", "expiredOrUsed");
var otpMessage = /* @__PURE__ */ __name((code) => "\u{1F510} \u06A9\u062F \u062A\u0623\u06CC\u06CC\u062F \u0648\u0631\u0648\u062F \u0628\u0647 \u0627\u067E \u0645\u062F\u0627\u0631\n\n\u06A9\u062F \u0648\u0631\u0648\u062F \u0634\u0645\u0627:\n\n" + code + "\n\n\u23F3 \u0627\u06CC\u0646 \u06A9\u062F \u062A\u0627 \u06F3 \u062F\u0642\u06CC\u0642\u0647 \u0645\u0639\u062A\u0628\u0631 \u0627\u0633\u062A \u0648 \u0641\u0642\u0637 \u06CC\u06A9\u200C\u0628\u0627\u0631 \u0627\u0633\u062A\u0641\u0627\u062F\u0647 \u0645\u06CC\u200C\u0634\u0648\u062F.\n\u06A9\u062F \u0631\u0627 \u0641\u0642\u0637 \u062F\u0631 \u0627\u067E \u0645\u062F\u0627\u0631 \u0648\u0627\u0631\u062F \u06A9\u0646\u06CC\u062F \u0648 \u0622\u0646 \u0631\u0627 \u0628\u0631\u0627\u06CC \u0647\u06CC\u0686\u200C\u06A9\u0633 \u0646\u0641\u0631\u0633\u062A\u06CC\u062F.", "otpMessage");
async function readChallenge(env, id) {
  return env.DB.prepare(
    "SELECT state,telegram_id,expires_ms,otp_hash,otp_nonce,otp_ciphertext,otp_expires_ms,otp_attempts FROM android_login_challenges WHERE id=?"
  ).bind(id).first();
}
__name(readChallenge, "readChallenge");
async function androidLoginRoute(request, env, now = Date.now()) {
  const route = new URL(request.url).pathname;
  if (request.method !== "POST") return json2({ error: "method_not_allowed" }, 405);
  if (route === "/api/v2/android/logout") {
    if (!env.DB)
      return json2({ error: "not_ready" }, 503);
    const payload2 = await body2(request);
    if (!payload2 || Object.keys(payload2).length) return json2({ error: "bad_request" }, 400);
    const header = request.headers.get("authorization") ?? "";
    if (!header.startsWith("Bearer ")) return json2({ error: "unauthorized" }, 401);
    const digest2 = await tokenDigest2(header.slice(7));
    if (!digest2) return json2({ error: "unauthorized" }, 401);
    await revokeAppSession(env.DB, digest2);
    await env.DB.prepare(
      "UPDATE subscription_tokens SET revoked=1 WHERE token_hash=?"
    ).bind(digest2).run();
    return json2({ status: "signed_out" });
  }
  if (!enabled2(env)) return json2({ error: "not_ready" }, 503);
  const payload = await body2(request);
  if (!payload) return json2({ error: "bad_request" }, 400);
  if (route === "/api/v2/android/login/start") {
    if (Object.keys(payload).length) return json2({ error: "bad_request" }, 400);
    if (!await allowChallengeStart(request, env, now))
      return json2({ error: "rate_limited" }, 429);
    const id = random(18), verifier = random(32);
    const hash = await tokenDigest2(verifier);
    await env.DB.prepare(
      "INSERT INTO android_login_challenges(id,verifier_hash,created_ms,expires_ms) VALUES(?,?,?,?)"
    ).bind(id, hash, now, now + 6e5).run();
    return json2({
      id,
      verifier,
      expires_at: now + 6e5,
      login_url: "https://t.me/" + botUsername(env) + "?start=app_" + id
    });
  }
  if (route === "/api/v2/android/login/verify" || route === "/api/v2/android/login/complete") {
    const id = payload.id, verifier = payload.verifier, code = payload.code;
    if (Object.keys(payload).some((key) => !["id", "verifier", "code"].includes(key)) || !ID3.test(id ?? "") || !await tokenDigest2(verifier) || !OTP.test(code ?? ""))
      return json2({ error: "bad_request" }, 400);
    const verifierHash = await tokenDigest2(verifier);
    const row = await env.DB.prepare(
      "SELECT state,telegram_id,expires_ms,otp_hash,otp_expires_ms,otp_attempts FROM android_login_challenges WHERE id=? AND verifier_hash=?"
    ).bind(id, verifierHash).first();
    if (!row) return json2({ error: "invalid_challenge" }, 403);
    if (expired(row.expires_ms, now)) return json2({ error: "expired" }, 410);
    if (row.state === "pending") return json2({ status: "pending" }, 202);
    if (row.state === "rejected") return json2({ error: "subscription_inactive" }, 403);
    if (row.state === "failed") return json2({ error: "subscription_not_ready" }, 403);
    if (row.state !== "code_sent") return json2({ error: "already_used" }, 410);
    if (expired(row.otp_expires_ms, now)) return json2({ error: "expired" }, 410);
    if (!row.otp_hash) return json2({ error: "invalid_challenge" }, 403);
    if (row.otp_attempts >= 5) return json2({ error: "too_many_attempts" }, 429);
    const counted = await env.DB.prepare(
      "UPDATE android_login_challenges SET otp_attempts=otp_attempts+1 WHERE id=? AND verifier_hash=? AND state='code_sent' AND expires_ms>? AND otp_expires_ms>? AND otp_attempts<5"
    ).bind(id, verifierHash, now, now).run();
    if (counted.meta?.changes !== 1) {
      const latest = await readChallenge(env, id);
      if (latest?.otp_attempts >= 5) return json2({ error: "too_many_attempts" }, 429);
      return json2({ error: "expired" }, 410);
    }
    const suppliedHash = await otpHash(env, id, code);
    if (!sameText(suppliedHash, row.otp_hash)) {
      const latest = await readChallenge(env, id);
      return latest?.otp_attempts >= 5 ? json2({ error: "too_many_attempts" }, 429) : json2({ error: "invalid_code" }, 401);
    }
    const claimed = await env.DB.prepare(
      "UPDATE android_login_challenges SET state='redeeming' WHERE id=? AND verifier_hash=? AND state='code_sent' AND otp_hash=? AND expires_ms>? AND otp_expires_ms>?"
    ).bind(id, verifierHash, row.otp_hash, now, now).run();
    if (claimed.meta?.changes !== 1) return json2({ error: "already_used" }, 410);
    const issued = await issueAppSession(env, row.telegram_id, now);
    await env.DB.prepare(
      "UPDATE android_login_challenges SET state=? WHERE id=? AND state='redeeming'"
    ).bind(issued ? "used" : "failed", id).run();
    if (!issued) return json2({ error: "account_not_ready" }, 403);
    return json2({
      status: "authorized",
      access_token: issued.token,
      expires_at: issued.expires_at
    });
  }
  return json2({ error: "not_found" }, 404);
}
__name(androidLoginRoute, "androidLoginRoute");
async function body2(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers.get("content-type") ?? ""))
    return null;
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > 512) return null;
  try {
    const raw = await request.text();
    if (raw.length > 512) return null;
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}
__name(body2, "body");
async function approveAndroidLogin(env, event, now = Date.now()) {
  if (!event) return null;
  const startMatch = event.key === "/start" ? /^\/start(?:@[A-Za-z0-9_]+)?\s+app_([A-Za-z0-9_-]{24})\s*$/.exec(event.inputText ?? "") : null;
  const callbackMatch = typeof event.key === "string" ? /^app:activate:([A-Za-z0-9_-]{24})$/.exec(event.key) : null;
  if (!startMatch && !callbackMatch) return null;
  const reply4 = /* @__PURE__ */ __name((message, replyMarkup = null) => ({
    text: "\u{1F310}  \u0645\u0640\u0640\u062F\u0627\u0631\n\n" + message,
    replyMarkup
  }), "reply");
  if (!enabled2(env)) return reply4("\u0648\u0631\u0648\u062F \u0628\u0647 \u0627\u067E \u062F\u0631 \u0627\u06CC\u0646 \u0645\u062D\u06CC\u0637 \u0647\u0646\u0648\u0632 \u0641\u0639\u0627\u0644 \u0646\u06CC\u0633\u062A.");
  if (!/^\d{5,20}$/.test(event.actorId ?? "") || event.chatId !== void 0 && event.chatId !== event.actorId)
    return reply4("\u062F\u0631\u062E\u0648\u0627\u0633\u062A \u0648\u0631\u0648\u062F \u0646\u0627\u0645\u0639\u062A\u0628\u0631 \u0627\u0633\u062A.");
  const id = (startMatch ?? callbackMatch)[1];
  const challenge = await readChallenge(env, id);
  if (!challenge || expired(challenge.expires_ms, now)) return reply4(expiredOrUsed());
  if (challenge.state === "code_sent" && challenge.telegram_id === event.actorId && !expired(challenge.otp_expires_ms, now)) {
    const code2 = await decryptOtp(env, id, challenge);
    return reply4(code2 ? otpMessage(code2) : expiredOrUsed());
  }
  if (challenge.state !== "pending") return reply4(expiredOrUsed());
  if (!await isBotActivated(env.DB, event.actorId)) {
    const activation = await checkAndActivateBot(env, event.actorId, now);
    if (activation.state === "not_member") {
      const prompt2 = activationPrompt(env, "v2:app:activate:" + id, "app");
      return reply4(prompt2.text, prompt2.replyMarkup);
    }
    if (activation.state === "unconfigured") {
      const prompt2 = activationPrompt(env, "v2:app:activate:" + id, "app");
      return reply4(prompt2.text, prompt2.replyMarkup);
    }
    if (activation.state !== "activated") {
      const retry = activationUnavailableReply(env, "v2:app:activate:" + id);
      return reply4(retry.text, retry.replyMarkup);
    }
  }
  const customer = await env.DB.prepare(
    "SELECT state FROM customers WHERE telegram_id=?"
  ).bind(event.actorId).first();
  if (customer?.state !== "active")
    return reply4("\u26D4 \u062D\u0633\u0627\u0628 \u0634\u0645\u0627 \u062A\u0639\u0644\u06CC\u0642 \u0634\u062F\u0647 \u0627\u0633\u062A. \u0628\u0631\u0627\u06CC \u067E\u06CC\u06AF\u06CC\u0631\u06CC \u0627\u0632 \u067E\u0634\u062A\u06CC\u0628\u0627\u0646\u06CC \u0645\u062F\u0627\u0631 \u0627\u0633\u062A\u0641\u0627\u062F\u0647 \u06A9\u0646\u06CC\u062F.");
  const code = newOtp();
  const codeHash = await otpHash(env, id, code);
  const encrypted = await encryptOtp(env, id, code);
  const codeExpires = Math.min(now + 18e4, challenge.expires_ms);
  const updated = await env.DB.prepare(
    "UPDATE android_login_challenges SET state='code_sent',telegram_id=?,otp_hash=?,otp_nonce=?,otp_ciphertext=?,otp_expires_ms=?,otp_attempts=0 WHERE id=? AND state='pending' AND expires_ms>?"
  ).bind(event.actorId, codeHash, encrypted.nonce, encrypted.ciphertext, codeExpires, id, now).run();
  if (updated.meta?.changes === 1) return reply4(otpMessage(code));
  const current = await readChallenge(env, id);
  if (current?.state === "code_sent" && current.telegram_id === event.actorId && !expired(current.otp_expires_ms, now)) {
    const previous = await decryptOtp(env, id, current);
    if (previous) return reply4(otpMessage(previous));
  }
  return reply4(expiredOrUsed());
}
__name(approveAndroidLogin, "approveAndroidLogin");
async function purgeAndroidLogins(db, now = Date.now()) {
  await db.prepare("DELETE FROM android_login_challenges WHERE expires_ms<?").bind(now - 864e5).run();
  await db.prepare("DELETE FROM android_login_rate_limits WHERE window_start_ms<?").bind(now - 864e5).run();
}
__name(purgeAndroidLogins, "purgeAndroidLogins");

// src/field-evidence.mjs
var NODE = /^[A-Za-z][A-Za-z0-9_-]{2,63}$/;
var ID4 = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8a-f][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
var NONCE = /^[a-f0-9]{32}$/;
var HEX = /^[a-f0-9]{64}$/;
var MAX_AGE = 10 * 60 * 1e3;
var encoder3 = new TextEncoder();
var json3 = /* @__PURE__ */ __name((body3, status = 200) => new Response(JSON.stringify(body3), { status, headers: {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer"
} }), "json");
var hex4 = /* @__PURE__ */ __name((bytes) => Array.from(new Uint8Array(bytes), (n) => n.toString(16).padStart(2, "0")).join(""), "hex");
var same = /* @__PURE__ */ __name((a, b) => {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}, "same");
function validateFieldSample(sample, nowMs) {
  if (!sample || typeof sample !== "object" || Array.isArray(sample) || Object.keys(sample).sort().join(",") !== "authenticated,downloadBytes,nodeId,observedMs,operator,port,probeId,revision,uploadBytes")
    return null;
  if (!NODE.test(sample.nodeId ?? "") || !ID4.test(sample.probeId ?? "") || !Number.isSafeInteger(sample.revision) || sample.revision < 1 || !Number.isSafeInteger(sample.observedMs) || sample.observedMs < nowMs - 12e4 || sample.observedMs > nowMs + 3e4 || !(sample.operator === "mci" && sample.port === 443 || sample.operator === "irancell" && sample.port === 8443) || sample.authenticated !== true || !Number.isSafeInteger(sample.uploadBytes) || sample.uploadBytes < 128 || !Number.isSafeInteger(sample.downloadBytes) || sample.downloadBytes < 128)
    return null;
  return sample;
}
__name(validateFieldSample, "validateFieldSample");
function completePair(rows, revision, nowMs) {
  if (!Array.isArray(rows)) return null;
  const selected = {};
  for (const row of rows) {
    if (row.revision !== revision || !Number.isSafeInteger(row.observed_ms) || row.observed_ms < nowMs - MAX_AGE || row.observed_ms > nowMs + 3e4 || !(row.operator === "mci" && row.port === 443 || row.operator === "irancell" && row.port === 8443)) continue;
    if (!selected[row.operator] || selected[row.operator].observed_ms < row.observed_ms)
      selected[row.operator] = row;
  }
  return selected.mci && selected.irancell ? selected : null;
}
__name(completePair, "completePair");
async function fieldProbeRoute(request, env, nowMs = Date.now()) {
  if (request.method !== "POST" || new URL(request.url).pathname !== "/api/v2/field/accept")
    return json3({ error: "not_found" }, 404);
  if (env.FIELD_PROBE_ENABLED !== "true" || !env.DB || typeof env.FIELD_PROBE_SECRET !== "string" || env.FIELD_PROBE_SECRET.length < 32) return json3({ error: "not_configured" }, 503);
  if (!/^application\/json(?:;|$)/i.test(request.headers.get("content-type") ?? ""))
    return json3({ error: "bad_content_type" }, 415);
  const timestamp = request.headers.get("x-madar-field-timestamp") ?? "";
  const nonce = request.headers.get("x-madar-field-nonce") ?? "";
  const signature = request.headers.get("x-madar-field-signature") ?? "";
  if (!/^[0-9]{13}$/.test(timestamp) || !NONCE.test(nonce) || !HEX.test(signature) || Math.abs(nowMs - Number(timestamp)) > 12e4) return json3({ error: "unauthorized" }, 401);
  let raw;
  try {
    raw = await request.text();
    if (encoder3.encode(raw).byteLength > 2048) return json3({ error: "too_large" }, 413);
  } catch {
    return json3({ error: "bad_request" }, 400);
  }
  const key = await crypto.subtle.importKey(
    "raw",
    encoder3.encode(env.FIELD_PROBE_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const expected = hex4(await crypto.subtle.sign(
    "HMAC",
    key,
    encoder3.encode(timestamp + "\n" + nonce + "\n" + raw)
  ));
  if (!same(expected, signature)) return json3({ error: "unauthorized" }, 401);
  let sample;
  try {
    sample = validateFieldSample(JSON.parse(raw), nowMs);
  } catch {
    return json3({ error: "bad_request" }, 400);
  }
  if (!sample) return json3({ error: "invalid_field_proof" }, 400);
  const ready = await env.DB.prepare(
    "SELECT n.id FROM nodes n JOIN node_bootstrap_jobs j ON j.node_id=n.id AND j.state='installed' JOIN routes r ON r.node_id=n.id AND r.id=n.id||'_reality' JOIN route_carrier_variants v ON v.route_id=r.id AND v.operator=? AND v.port=? WHERE n.id=? AND n.lifecycle IN ('provisioning','ready','degraded') AND n.desired_revision=? AND n.acked_revision=? AND EXISTS(SELECT 1 FROM node_acks a WHERE a.node_id=n.id AND a.revision=? AND a.status='accepted')"
  ).bind(
    sample.operator,
    sample.port,
    sample.nodeId,
    sample.revision,
    sample.revision,
    sample.revision
  ).first();
  if (!ready) return json3({ error: "not_commissioned" }, 409);
  const inserted = await env.DB.prepare(
    "INSERT OR IGNORE INTO field_probes(id,node_id,operator,port,revision,observed_ms,upload_bytes,download_bytes) VALUES(?,?,?,?,?,?,?,?)"
  ).bind(
    sample.probeId,
    sample.nodeId,
    sample.operator,
    sample.port,
    sample.revision,
    sample.observedMs,
    sample.uploadBytes,
    sample.downloadBytes
  ).run();
  if (inserted.meta?.changes !== 1) return json3({ error: "replay" }, 409);
  const rows = (await env.DB.prepare(
    "SELECT operator,port,revision,observed_ms FROM field_probes WHERE node_id=? AND revision=? AND observed_ms BETWEEN ? AND ? ORDER BY observed_ms DESC LIMIT 16"
  ).bind(sample.nodeId, sample.revision, nowMs - MAX_AGE, nowMs + 3e4).all()).results ?? [];
  const pair = completePair(rows, sample.revision, nowMs);
  if (!pair) return json3({ accepted: true, ready: false, missing: sample.operator === "mci" ? "irancell" : "mci" }, 202);
  const route = sample.nodeId + "_reality";
  const results = await env.DB.batch([
    env.DB.prepare("UPDATE route_carrier_variants SET published=1,verified_ms=? WHERE route_id=? AND operator='mci' AND port=443").bind(pair.mci.observed_ms, route),
    env.DB.prepare("UPDATE route_carrier_variants SET published=1,verified_ms=? WHERE route_id=? AND operator='irancell' AND port=8443").bind(pair.irancell.observed_ms, route),
    env.DB.prepare("UPDATE routes SET state='ready',verified_ms=? WHERE id=? AND state IN ('checking','ready','degraded') AND EXISTS(SELECT 1 FROM nodes n WHERE n.id=routes.node_id AND n.desired_revision=? AND n.acked_revision=? AND n.lifecycle IN ('provisioning','ready','degraded'))").bind(
      Math.min(pair.mci.observed_ms, pair.irancell.observed_ms),
      route,
      sample.revision,
      sample.revision
    ),
    env.DB.prepare("UPDATE nodes SET lifecycle='ready' WHERE id=? AND desired_revision=? AND acked_revision=? AND lifecycle IN ('provisioning','ready','degraded') AND EXISTS(SELECT 1 FROM routes r WHERE r.node_id=nodes.id AND r.state='ready')").bind(sample.nodeId, sample.revision, sample.revision)
  ]);
  if (results.some((x) => x.meta?.changes !== 1)) return json3({ accepted: true, ready: false, error: "state_changed" }, 409);
  return json3({ accepted: true, ready: true, revision: sample.revision });
}
__name(fieldProbeRoute, "fieldProbeRoute");

// src/provisioning.mjs
var validOrder = /* @__PURE__ */ __name((id) => typeof id === "string" && id.length > 0 && id.length <= 80, "validOrder");
async function reserveApprovedOrder(env, orderId3, nowMs = Date.now(), targetNodeId = null) {
  if (!env.DB || !env.SUBSCRIPTION_CREDENTIAL_KEY || !validOrder(orderId3))
    return { status: "not_configured" };
  if (targetNodeId !== null && !/^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$/.test(targetNodeId))
    return { status: "bad_target_node" };
  const db = env.DB;
  const order = await db.prepare(
    "SELECT o.id,o.customer_telegram_id,p.quota_bytes,p.duration_days FROM orders o JOIN plans p ON p.id=o.plan_id JOIN customers c ON c.telegram_id=o.customer_telegram_id WHERE o.id=? AND o.state='approved' AND c.state='active'"
  ).bind(orderId3).first();
  if (!order) return { status: "not_approved" };
  const node = await db.prepare(
    "SELECT n.id FROM nodes n JOIN routes r ON r.node_id=n.id AND r.id=n.id||'_reality' JOIN route_carrier_variants m ON m.route_id=r.id AND m.operator='mci' AND m.port=443 AND m.published=1 AND m.verified_ms BETWEEN ? AND ? JOIN route_carrier_variants i ON i.route_id=r.id AND i.operator='irancell' AND i.port=8443 AND i.published=1 AND i.verified_ms BETWEEN ? AND ? WHERE n.lifecycle='ready' AND n.desired_revision=n.acked_revision AND r.state='ready' AND r.verified_ms BETWEEN ? AND ? AND n.user_limit>(SELECT COUNT(*) FROM node_allocations a WHERE a.node_id=n.id AND a.state IN ('reserved','active')) AND n.byte_limit-(SELECT COALESCE(SUM(a.quota_bytes),0) FROM node_allocations a WHERE a.node_id=n.id AND a.state IN ('reserved','active'))>=? AND EXISTS(SELECT 1 FROM node_health h WHERE h.node_id=n.id AND h.revision=n.desired_revision AND h.xray_healthy=1 AND h.stats_healthy=1 AND h.observed_ms BETWEEN ? AND ?) " + (targetNodeId === null ? "" : "AND n.id=? ") + "ORDER BY n.id LIMIT 1"
  ).bind(
    nowMs - 6e5,
    nowMs,
    nowMs - 6e5,
    nowMs,
    nowMs - 6e5,
    nowMs,
    order.quota_bytes,
    nowMs - 6e5,
    nowMs,
    ...targetNodeId === null ? [] : [targetNodeId]
  ).first();
  if (!node) return { status: "no_verified_capacity" };
  const subId = crypto.randomUUID(), allocationId = crypto.randomUUID(), uuid = crypto.randomUUID();
  const credential = await wrapClientUuid(uuid, env.SUBSCRIPTION_CREDENTIAL_KEY);
  try {
    const changes = await db.batch([
      db.prepare(
        "UPDATE orders SET state='provisioning',updated_at=CURRENT_TIMESTAMP WHERE id=? AND state='approved'"
      ).bind(orderId3),
      db.prepare(
        "INSERT INTO subscriptions(id,owner_telegram_id,state,expires_at,order_id,max_bytes,used_bytes) SELECT ?,?,'pending',0,?,?,0 WHERE EXISTS(SELECT 1 FROM orders WHERE id=? AND state='provisioning')"
      ).bind(subId, order.customer_telegram_id, orderId3, order.quota_bytes, orderId3),
      db.prepare(
        "INSERT INTO subscription_credentials(subscription_id,ciphertext_b64,nonce_b64,key_version) VALUES(?,?,?,1)"
      ).bind(subId, credential.ciphertext_b64, credential.nonce_b64),
      db.prepare(
        "INSERT INTO node_allocations(id,node_id,subscription_id,quota_bytes,state) VALUES(?,?,?,?,'reserved')"
      ).bind(allocationId, node.id, subId, order.quota_bytes)
    ]);
    if (changes[0]?.meta?.changes !== 1) return { status: "concurrent_change" };
  } catch {
    return { status: "reservation_rejected" };
  }
  return { status: "reserved", subscriptionId: subId, nodeId: node.id };
}
__name(reserveApprovedOrder, "reserveApprovedOrder");
async function reconcileApprovedOrders(env, nowMs = Date.now(), limit = 3) {
  if (!enabled(env, "PROVISIONING_ENABLED") || !env.DB || !env.SUBSCRIPTION_CREDENTIAL_KEY)
    return [];
  const pending = (await env.DB.prepare(
    "SELECT id FROM orders WHERE state='approved' ORDER BY updated_at,id LIMIT ?"
  ).bind(Math.min(10, Math.max(1, limit))).all()).results ?? [];
  const outcomes = [];
  for (const order of pending) outcomes.push({
    id: order.id,
    ...await reserveApprovedOrder(env, order.id, nowMs)
  });
  return outcomes;
}
__name(reconcileApprovedOrders, "reconcileApprovedOrders");

// src/usage-telemetry.mjs
var JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
var reply2 = /* @__PURE__ */ __name((value, status = 200) => new Response(JSON.stringify(value), { status, headers: JSON_HEADERS }), "reply");
var MAX = 9007199254740991;
var safeInt = /* @__PURE__ */ __name((n) => Number.isSafeInteger(n) && n >= 0 && n <= MAX, "safeInt");
var SUB_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
function validateUsageReport(data, nowMs) {
  if (!data || typeof data !== "object" || Array.isArray(data) || !Number.isSafeInteger(data.revision) || data.revision < 1 || !Array.isArray(data.reports) || data.reports.length < 1 || data.reports.length > 20) return null;
  const seen = /* @__PURE__ */ new Set();
  for (const r of data.reports) {
    if (!r || typeof r !== "object" || Array.isArray(r) || Object.keys(r).sort().join(",") !== "cumulative_bytes,observed_ms,sequence,subscription_id" || !SUB_ID.test(r.subscription_id ?? "") || seen.has(r.subscription_id) || !Number.isSafeInteger(r.sequence) || r.sequence < 1 || !safeInt(r.cumulative_bytes) || !Number.isSafeInteger(r.observed_ms) || r.observed_ms > nowMs + 3e4 || r.observed_ms < nowMs - 12e4) return null;
    seen.add(r.subscription_id);
  }
  return data;
}
__name(validateUsageReport, "validateUsageReport");
async function usageRoute(request, env, nowMs = Date.now()) {
  const path = new URL(request.url).pathname;
  if (request.method !== "POST" || !["/api/node/v1/usage", "/api/node/v1/clients/revoked"].includes(path))
    return reply2({ error: "not_found" }, 404);
  const auth = await authenticatedNode(request, env, nowMs);
  if (auth.error) return auth.error;
  if (auth.node.lifecycle !== "ready" || auth.node.desired_revision !== auth.node.acked_revision)
    return reply2({ error: "node_not_ready" }, 409);
  let b;
  try {
    b = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(auth.raw));
  } catch {
    return reply2({ error: "bad_json" }, 400);
  }
  if (path === "/api/node/v1/clients/revoked") return revokeRemovedClients(env.DB, auth, b, nowMs);
  const doc = validateUsageReport(b, nowMs);
  if (!doc || doc.revision !== auth.node.desired_revision) return reply2({ error: "bad_report" }, 400);
  const result = [];
  for (const row of doc.reports) {
    const allowed = await env.DB.prepare(
      "SELECT a.id FROM node_allocations a JOIN subscriptions s ON s.id=a.subscription_id WHERE a.node_id=? AND a.subscription_id=? AND a.state IN ('reserved','active')"
    ).bind(auth.id, row.subscription_id).first();
    if (!allowed) return reply2({ error: "allocation_not_found" }, 409);
    const [saved] = await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO node_usage_reports(node_id,subscription_id,sequence,cumulative_bytes,observed_ms) VALUES(?,?,?,?,?) ON CONFLICT(node_id,subscription_id) DO UPDATE SET sequence=excluded.sequence,cumulative_bytes=excluded.cumulative_bytes,observed_ms=excluded.observed_ms WHERE excluded.sequence>node_usage_reports.sequence AND excluded.cumulative_bytes>=node_usage_reports.cumulative_bytes"
      ).bind(auth.id, row.subscription_id, row.sequence, row.cumulative_bytes, row.observed_ms),
      env.DB.prepare(
        "UPDATE subscriptions SET used_bytes=MIN(max_bytes,MAX(used_bytes,(SELECT COALESCE(SUM(cumulative_bytes),0) FROM node_usage_reports WHERE subscription_id=?))) WHERE id=?"
      ).bind(row.subscription_id, row.subscription_id)
    ]);
    const actual = await env.DB.prepare(
      "SELECT sequence,cumulative_bytes FROM node_usage_reports WHERE node_id=? AND subscription_id=?"
    ).bind(auth.id, row.subscription_id).first();
    if (!actual) return reply2({ error: "checkpoint_failed" }, 503);
    if (Number(saved.meta?.changes) !== 1 && (actual.sequence !== row.sequence || actual.cumulative_bytes !== row.cumulative_bytes))
      return reply2({ error: "stale_or_regressed_usage" }, 409);
    result.push({
      subscription_id: row.subscription_id,
      cumulative_bytes: actual.cumulative_bytes,
      sequence: actual.sequence
    });
  }
  return reply2({ ok: true, received: result });
}
__name(usageRoute, "usageRoute");
async function revokeRemovedClients(db, auth, payload, nowMs) {
  if (!payload || payload.revision !== auth.node.desired_revision || !Array.isArray(payload.subscription_ids) || payload.subscription_ids.length > 100 || !payload.subscription_ids.every((id) => SUB_ID.test(id ?? "")) || new Set(payload.subscription_ids).size !== payload.subscription_ids.length)
    return reply2({ error: "bad_request" }, 400);
  let released = 0;
  for (const id of payload.subscription_ids) {
    const query = await db.prepare(
      "UPDATE node_allocations SET state='released' WHERE node_id=? AND subscription_id=? AND state IN ('reserved','active') AND EXISTS(SELECT 1 FROM subscriptions s WHERE s.id=node_allocations.subscription_id AND (s.state IN ('expired','suspended','revoked') OR (s.state='active' AND (s.expires_at<=? OR s.used_bytes>=s.max_bytes))))"
    ).bind(auth.id, id, nowMs).run();
    released += Number(query.meta?.changes) === 1 ? 1 : 0;
  }
  return reply2({ ok: true, released });
}
__name(revokeRemovedClients, "revokeRemovedClients");

// src/node-health.mjs
var json4 = /* @__PURE__ */ __name((obj, status = 200) => new Response(JSON.stringify(obj), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
}), "json");
function validHealth(doc, nowMs) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc) || Object.keys(doc).sort().join(",") !== "observed_ms,ports,revision,stats_healthy,xray_healthy" || !Number.isSafeInteger(doc.revision) || doc.revision < 1 || !Number.isSafeInteger(doc.observed_ms) || doc.observed_ms < nowMs - 3e4 || doc.observed_ms > nowMs + 3e4 || doc.xray_healthy !== true || doc.stats_healthy !== true || !Array.isArray(doc.ports) || doc.ports.length !== 2 || doc.ports[0] !== 443 || doc.ports[1] !== 8443) return false;
  return true;
}
__name(validHealth, "validHealth");
async function nodeHealthRoute(request, env, nowMs = Date.now()) {
  if (request.method !== "POST" || new URL(request.url).pathname !== "/api/node/v1/health")
    return json4({ error: "not_found" }, 404);
  const auth = await authenticatedNode(request, env, nowMs);
  if (auth.error) return auth.error;
  let doc;
  try {
    doc = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(auth.raw));
  } catch {
    return json4({ error: "bad_request" }, 400);
  }
  if (!validHealth(doc, nowMs) || auth.node.lifecycle !== "ready" || auth.node.desired_revision !== auth.node.acked_revision || doc.revision !== auth.node.desired_revision)
    return json4({ error: "not_ready" }, 409);
  const routeId = auth.id + "_reality";
  const fields = (await env.DB.prepare(
    "SELECT operator,port FROM field_probes WHERE node_id=? AND revision=? AND observed_ms BETWEEN 1 AND ? AND ((operator='mci' AND port=443) OR (operator='irancell' AND port=8443)) GROUP BY operator,port"
  ).bind(auth.id, doc.revision, nowMs + 3e4).all()).results ?? [];
  const independent = fields.length === 2 && fields.some((x) => x.operator === "mci" && x.port === 443) && fields.some((x) => x.operator === "irancell" && x.port === 8443);
  const manual = !independent && manualAttestationEnabled(env) && await manualPair(env.DB, auth.id, doc.revision, nowMs, true);
  if (!independent && !manual) return json4({ error: "carrier_not_accepted" }, 409);
  const ready = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM route_carrier_variants v JOIN routes r ON r.id=v.route_id WHERE v.route_id=? AND r.state='ready' AND v.published=1 AND ((v.operator='mci' AND v.port=443) OR (v.operator='irancell' AND v.port=8443))"
  ).bind(routeId).first();
  if (Number(ready?.n) !== 2) return json4({ error: "route_not_ready" }, 409);
  const results = await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO node_health(node_id,revision,observed_ms,xray_healthy,stats_healthy) VALUES(?,?,?,1,1) ON CONFLICT(node_id) DO UPDATE SET revision=excluded.revision,observed_ms=excluded.observed_ms,xray_healthy=1,stats_healthy=1 WHERE excluded.observed_ms>=node_health.observed_ms"
    ).bind(auth.id, doc.revision, doc.observed_ms),
    env.DB.prepare(
      "UPDATE routes SET verified_ms=? WHERE id=? AND state='ready'"
    ).bind(doc.observed_ms, routeId),
    env.DB.prepare(
      "UPDATE route_carrier_variants SET verified_ms=? WHERE route_id=? AND published=1 AND ((operator='mci' AND port=443) OR (operator='irancell' AND port=8443))"
    ).bind(doc.observed_ms, routeId)
  ]);
  if (results[0]?.meta?.changes !== 1 || results[1]?.meta?.changes !== 1 || results[2]?.meta?.changes !== 2) return json4({ error: "state_changed" }, 409);
  return json4({
    ok: true,
    health_fresh: true,
    carrier_proofs: independent ? "initial_independent_acceptance" : "owner_manual_attestation"
  });
}
__name(nodeHealthRoute, "nodeHealthRoute");

// src/subscription-lifecycle.mjs
async function expireEntitlements(env, nowMs = Date.now()) {
  if (!env.DB) return { expired: 0 };
  const result = await env.DB.prepare(
    "UPDATE subscriptions SET state='expired' WHERE state='active' AND (expires_at<=? OR max_bytes<=used_bytes)"
  ).bind(nowMs).run();
  await env.DB.prepare(
    "DELETE FROM subscription_tokens WHERE expires_at<=? OR EXISTS(SELECT 1 FROM subscriptions s WHERE s.id=subscription_tokens.subscription_id AND s.state IN ('expired','revoked'))"
  ).bind(nowMs).run();
  return { expired: Number(result.meta?.changes ?? 0) };
}
__name(expireEntitlements, "expireEntitlements");

// src/plan-wizard.mjs
var STEPS = ["title", "gb", "days", "price", "review"];
var CODE = /^[A-Za-z0-9][A-Za-z0-9_-]{1,30}$/;
var SESSION_MS = 10 * 60 * 1e3;
var action = /* @__PURE__ */ __name((text, key) => [{ text, callback_data: "v2:admin:plan:" + key }], "action");
var plansButton = [{ text: "\u{1F6CD} \u0645\u062F\u06CC\u0631\u06CC\u062A \u067E\u0644\u0646\u200C\u0647\u0627", callback_data: "v2:admin:plans" }];
var panel2 = /* @__PURE__ */ __name((message, buttons = []) => ({
  text: frameMessage(message),
  replyMarkup: { inline_keyboard: buttons }
}), "panel");
function localizedDigits(input) {
  return String(input).replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 1776)).replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 1632));
}
__name(localizedDigits, "localizedDigits");
function numberField(input, min, max) {
  if (typeof input !== "string" || input.length > 40) return null;
  const n = localizedDigits(input.trim()).replace(/[\s,\u066c]/g, "");
  if (!/^(0|[1-9][0-9]*)$/.test(n)) return null;
  const value = Number(n);
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : null;
}
__name(numberField, "numberField");
function titleField(input) {
  if (typeof input !== "string") return null;
  const name = input.trim();
  return name.length >= 2 && name.length <= 64 && /[\u0621-\u064a\u067e\u0686\u0698\u06a9\u06af\u06cc\u06be]/u.test(name) && !/[\r\n|<>]/.test(name) ? name : null;
}
__name(titleField, "titleField");
function fromSession(session) {
  if (!session || session.mode !== "plan_draft" || typeof session.context_id !== "string" || session.context_id.length > 512) return null;
  try {
    const d = JSON.parse(session.context_id);
    return d.version === 1 && STEPS.includes(d.step) && CODE.test(d.id) ? d : null;
  } catch {
    return null;
  }
}
__name(fromSession, "fromSession");
function question(d, warning = "") {
  const current = d.step === "title" ? d.title : d[d.step];
  const repeat = current === void 0 ? "" : "\n\u0645\u0642\u062F\u0627\u0631 \u0642\u0628\u0644\u06CC: " + (d.step === "title" ? current : faNumber(current));
  const queries = {
    title: "\u0646\u0627\u0645 \u0641\u0627\u0631\u0633\u06CC \u0627\u06CC\u0646 \u067E\u0644\u0646 \u0686\u06CC\u0633\u062A\u061F\n\u0645\u062B\u0627\u0644: \u0627\u0634\u062A\u0631\u0627\u06A9 \u06CC\u06A9\u200C\u0645\u0627\u0647\u0647",
    gb: "\u062D\u062C\u0645 \u067E\u0644\u0646 \u0686\u0646\u062F \u06AF\u06CC\u06AF\u0627\u0628\u0627\u06CC\u062A \u0628\u0627\u0634\u062F\u061F\n\u0639\u062F\u062F \u0628\u06CC\u0646 \u06F1 \u062A\u0627 \u06F2\u06F0\u06F0\u06F0 \u0648\u0627\u0631\u062F \u06A9\u0646\u06CC\u062F.",
    days: "\u0627\u0639\u062A\u0628\u0627\u0631 \u067E\u0644\u0646 \u0686\u0646\u062F \u0631\u0648\u0632 \u0628\u0627\u0634\u062F\u061F\n\u0639\u062F\u062F \u0628\u06CC\u0646 \u06F1 \u062A\u0627 \u06F3\u06F6\u06F6 \u0648\u0627\u0631\u062F \u06A9\u0646\u06CC\u062F.",
    price: "\u0642\u06CC\u0645\u062A \u067E\u0644\u0646 \u0628\u0647 \u062A\u0648\u0645\u0627\u0646 \u0686\u0642\u062F\u0631 \u0628\u0627\u0634\u062F\u061F\n\u0645\u062B\u0627\u0644: \u06F3\u06F0\u06F0\u066C\u06F0\u06F0\u06F0"
  };
  const summary = d.step === "review" ? "\u{1F4CB} \u0627\u0637\u0644\u0627\u0639\u0627\u062A \u067E\u0644\u0646 \u0631\u0627 \u0628\u0631\u0631\u0633\u06CC \u06A9\u0646:\n\n\u{1F6CD} \u0646\u0627\u0645: " + d.title + "\n\u{1F4E6} \u062D\u062C\u0645: " + faNumber(d.gb) + " \u06AF\u06CC\u06AF\u0627\u0628\u0627\u06CC\u062A\n\u{1F4C5} \u0645\u062F\u062A: " + faNumber(d.days) + " \u0631\u0648\u0632\n\u{1F4B3} \u0642\u06CC\u0645\u062A: " + faNumber(d.price) + " \u062A\u0648\u0645\u0627\u0646\n\u{1F50E} \u0634\u0646\u0627\u0633\u0647 \u062E\u0648\u062F\u06A9\u0627\u0631: " + d.id + "\n\n\u{1F512} \u067E\u0644\u0646 \u0641\u0642\u0637 \u0628\u0647\u200C\u0635\u0648\u0631\u062A \u063A\u06CC\u0631\u0641\u0639\u0627\u0644 \u062B\u0628\u062A \u0645\u06CC\u200C\u0634\u0648\u062F." : queries[d.step] + repeat;
  const controls = [];
  if (d.step === "review") controls.push(action("\u2705 \u062A\u0623\u06CC\u06CC\u062F \u0648 \u062B\u0628\u062A \u067E\u0644\u0646", "save"));
  if (d.step !== "title") controls.push(action("\u2B05\uFE0F \u0645\u0631\u062D\u0644\u0647 \u0642\u0628\u0644", "back"));
  controls.push(action("\u274C \u0644\u063A\u0648 \u0633\u0627\u062E\u062A \u067E\u0644\u0646", "cancel"));
  return panel2("\u{1F6CD} \u0633\u0627\u062E\u062A \u067E\u0644\u0646 \u062C\u062F\u06CC\u062F\n" + (d.step === "review" ? "\u067E\u06CC\u0634\u200C\u0646\u0645\u0627\u06CC\u0634 \u0646\u0647\u0627\u06CC\u06CC" : "\u0645\u0631\u062D\u0644\u0647 " + faNumber(STEPS.indexOf(d.step) + 1) + " \u0627\u0632 \u06F4") + (warning ? "\n\n\u26A0\uFE0F " + warning : "") + "\n\n" + summary + "\n\n\u23F3 \u0645\u0647\u0644\u062A \u067E\u0627\u0633\u062E\u200C\u06AF\u0648\u06CC\u06CC: \u06F1\u06F0 \u062F\u0642\u06CC\u0642\u0647", controls);
}
__name(question, "question");
async function store(db, e, d, nowMs) {
  await db.prepare(
    "INSERT INTO v2_bot_input_sessions(telegram_id,mode,context_id,expires_ms) VALUES(?,'plan_draft',?,?) ON CONFLICT(telegram_id) DO UPDATE SET mode='plan_draft',context_id=excluded.context_id,expires_ms=excluded.expires_ms"
  ).bind(e.actorId, JSON.stringify(d), nowMs + SESSION_MS).run();
}
__name(store, "store");
async function clear(db, e) {
  await db.prepare("DELETE FROM v2_bot_input_sessions WHERE telegram_id=? AND mode='plan_draft'").bind(e.actorId).run();
}
__name(clear, "clear");
async function load(db, e, nowMs) {
  const s = await db.prepare("SELECT mode,context_id,expires_ms FROM v2_bot_input_sessions WHERE telegram_id=? AND mode='plan_draft'").bind(e.actorId).first();
  if (!s) return null;
  if (s.expires_ms <= nowMs) {
    await clear(db, e);
    return null;
  }
  const d = fromSession(s);
  if (!d) await clear(db, e);
  return d;
}
__name(load, "load");
var expired2 = /* @__PURE__ */ __name(() => panel2("\u231B \u0641\u0631\u0645 \u067E\u0644\u0646 \u0641\u0639\u0627\u0644 \u0646\u06CC\u0633\u062A \u06CC\u0627 \u0632\u0645\u0627\u0646 \u0622\u0646 \u067E\u0627\u06CC\u0627\u0646 \u06CC\u0627\u0641\u062A\u0647 \u0627\u0633\u062A.\n\u0627\u0632 \u0645\u062F\u06CC\u0631\u06CC\u062A \u067E\u0644\u0646\u200C\u0647\u0627 \u062F\u0648\u0628\u0627\u0631\u0647 \u0634\u0631\u0648\u0639 \u06A9\u0646\u06CC\u062F.", [plansButton]), "expired");
async function planWizardAction(db, e, nowMs = Date.now()) {
  const key = e.key ?? "";
  if (key === "admin:plan:new") {
    if (!Number.isSafeInteger(e.updateId) || e.updateId < 0) return panel2("\u26A0\uFE0F \u0634\u0646\u0627\u0633\u0647 \u062F\u0631\u062E\u0648\u0627\u0633\u062A \u0645\u0639\u062A\u0628\u0631 \u0646\u06CC\u0633\u062A.");
    const d2 = { version: 1, step: "title", id: "p" + e.updateId };
    if (!CODE.test(d2.id)) return panel2("\u26A0\uFE0F \u0633\u0627\u062E\u062A \u0634\u0646\u0627\u0633\u0647 \u067E\u0644\u0646 \u0645\u0645\u06A9\u0646 \u0646\u06CC\u0633\u062A.");
    await store(db, e, d2, nowMs);
    return question(d2);
  }
  if (key === "admin:plan:cancel") {
    await clear(db, e);
    return panel2("\u2705 \u0633\u0627\u062E\u062A \u067E\u0644\u0646 \u0644\u063A\u0648 \u0634\u062F. \u0647\u06CC\u0686 \u067E\u0644\u0646\u06CC \u062B\u0628\u062A \u0646\u0634\u062F\u0647 \u0627\u0633\u062A.", [plansButton]);
  }
  const d = await load(db, e, nowMs);
  if (!d) return expired2();
  if (key === "admin:plan:back") {
    const index = STEPS.indexOf(d.step);
    if (index > 0) d.step = STEPS[index - 1];
    await store(db, e, d, nowMs);
    return question(d);
  }
  if (key !== "admin:plan:save") return null;
  if (d.step !== "review" || titleField(d.title) === null || numberField(String(d.gb), 1, 2e3) === null || numberField(String(d.days), 1, 366) === null || numberField(String(d.price), 0, 1e11) === null)
    return question(d, "\u0627\u0628\u062A\u062F\u0627 \u062A\u0645\u0627\u0645 \u0645\u0631\u0627\u062D\u0644 \u0631\u0627 \u062A\u06A9\u0645\u06CC\u0644 \u06A9\u0646\u06CC\u062F.");
  const results = await db.batch([
    db.prepare("INSERT OR IGNORE INTO plans(id,title_fa,title_en,price_amount,price_currency,quota_bytes,duration_days,active) VALUES(?,?,?,?,?,?,?,0)").bind(d.id, d.title, d.title, d.price, "IRT", d.gb * 1073741824, d.days),
    db.prepare("INSERT OR IGNORE INTO audit_events(event_id,actor_id,object_type,object_id,verb) VALUES(?,?,?,?,?)").bind("plan:wizard:" + d.id, e.actorId, "plan", d.id, "create:disabled"),
    db.prepare("DELETE FROM v2_bot_input_sessions WHERE telegram_id=? AND mode='plan_draft'").bind(e.actorId)
  ]);
  return panel2(
    results[0]?.meta?.changes === 1 ? "\u2705 \u067E\u0644\u0646 \u063A\u06CC\u0631\u0641\u0639\u0627\u0644 \u062B\u0628\u062A \u0634\u062F: " + d.title + "\n\u0641\u0639\u0627\u0644\u200C\u0633\u0627\u0632\u06CC \u0641\u0631\u0648\u0634 \u0628\u0647 \u062A\u0623\u06CC\u06CC\u062F \u0638\u0631\u0641\u06CC\u062A \u0648 \u062A\u0646\u0638\u06CC\u0645\u0627\u062A \u067E\u0631\u062F\u0627\u062E\u062A \u0648\u0627\u0628\u0633\u062A\u0647 \u0627\u0633\u062A." : "\u2139\uFE0F \u0634\u0646\u0627\u0633\u0647 \u0627\u06CC\u0646 \u067E\u0644\u0646 \u0642\u0628\u0644\u0627\u064B \u062B\u0628\u062A \u0634\u062F\u0647 \u0627\u0633\u062A\u061B \u067E\u0644\u0646 \u062A\u06A9\u0631\u0627\u0631\u06CC \u0633\u0627\u062E\u062A\u0647 \u0646\u0634\u062F.",
    [plansButton]
  );
}
__name(planWizardAction, "planWizardAction");
async function planWizardInput(db, e, session, nowMs = Date.now()) {
  const d = fromSession(session);
  if (!d) {
    await clear(db, e);
    return expired2();
  }
  if (d.step === "review") return question(d, "\u0628\u0631\u0627\u06CC \u062B\u0628\u062A \u067E\u0644\u0646\u060C \u062F\u06A9\u0645\u0647 \xAB\u062A\u0623\u06CC\u06CC\u062F \u0648 \u062B\u0628\u062A \u067E\u0644\u0646\xBB \u0631\u0627 \u0628\u0632\u0646\u06CC\u062F.");
  const raw = e.inputText;
  let value = null, warning = "";
  if (d.step === "title") {
    value = titleField(raw);
    if (value === null) warning = "\u0646\u0627\u0645 \u0628\u0627\u06CC\u062F \u0641\u0627\u0631\u0633\u06CC\u060C \u06CC\u06A9\u200C\u062E\u0637\u06CC \u0648 \u0628\u06CC\u0646 \u06F2 \u062A\u0627 \u06F6\u06F4 \u0646\u0648\u06CC\u0633\u0647 \u0628\u0627\u0634\u062F.";
  } else if (d.step === "gb") {
    value = numberField(raw, 1, 2e3);
    if (value === null) warning = "\u062D\u062C\u0645 \u0628\u0627\u06CC\u062F \u0639\u062F\u062F\u06CC \u0628\u06CC\u0646 \u06F1 \u062A\u0627 \u06F2\u06F0\u06F0\u06F0 \u0628\u0627\u0634\u062F.";
  } else if (d.step === "days") {
    value = numberField(raw, 1, 366);
    if (value === null) warning = "\u0645\u062F\u062A \u0628\u0627\u06CC\u062F \u0639\u062F\u062F\u06CC \u0628\u06CC\u0646 \u06F1 \u062A\u0627 \u06F3\u06F6\u06F6 \u0631\u0648\u0632 \u0628\u0627\u0634\u062F.";
  } else if (d.step === "price") {
    value = numberField(raw, 0, 1e11);
    if (value === null) warning = "\u0642\u06CC\u0645\u062A \u0628\u0627\u06CC\u062F \u0639\u062F\u062F \u0645\u0639\u062A\u0628\u0631 \u0628\u0647 \u062A\u0648\u0645\u0627\u0646 \u0628\u0627\u0634\u062F.";
  }
  if (warning) return question(d, warning);
  d[d.step] = value;
  d.step = STEPS[STEPS.indexOf(d.step) + 1];
  await store(db, e, d, nowMs);
  return question(d);
}
__name(planWizardInput, "planWizardInput");

// src/admin-direct.mjs
var TTL = 15 * 60 * 1e3;
var ID5 = /^di-[a-f0-9]{24}$/;
var REF = /^[a-f0-9]{24}$/;
var AMOUNTS = [10, 30, 50, 100, 200];
var DAYS = [7, 15, 30, 60, 90];
var MAX_GB2 = 1e3;
var validAdmin = /* @__PURE__ */ __name((env, actor) => env.ADMIN_DIRECT_ISSUE_ENABLED === "true" && /^[0-9]{5,20}$/.test(actor ?? "") && typeof env.ADMIN_TELEGRAM_IDS === "string" && env.ADMIN_TELEGRAM_IDS.split(",").map((s) => s.trim()).includes(actor), "validAdmin");
var button = /* @__PURE__ */ __name((text, action2) => [{ text, callback_data: "v2:admin:configs:direct:" + action2 }], "button");
var panel3 = /* @__PURE__ */ __name((text, buttons = []) => ({
  text: frameMessage(text),
  replyMarkup: { inline_keyboard: [
    ...buttons,
    [{ text: "\u21A9\uFE0F \u0635\u062F\u0648\u0631 \u06A9\u0627\u0646\u0641\u06CC\u06AF", callback_data: "v2:admin:configs:home" }]
  ] }
}), "panel");
var hex5 = /* @__PURE__ */ __name((n) => Array.from(
  crypto.getRandomValues(new Uint8Array(n)),
  (x) => x.toString(16).padStart(2, "0")
).join(""), "hex");
function label(input) {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (trimmed.length < 2 || trimmed.length > 60 || /[\x00-\x1f\x7f<>|\u202a-\u202e\u2066-\u2069]/u.test(trimmed))
    return null;
  return trimmed;
}
__name(label, "label");
function number(input, min, max) {
  if (typeof input !== "string" || input.length > 32) return null;
  const ascii2 = input.trim().replace(/[۰-۹]/g, (x) => String(x.charCodeAt(0) - 1776)).replace(/[٠-٩]/g, (x) => String(x.charCodeAt(0) - 1632)).replace(/[,\u066c\u2009\s]/g, "");
  if (!/^[1-9]\d{0,4}$/.test(ascii2)) return null;
  const n = Number(ascii2);
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : null;
}
__name(number, "number");
var orderId = /* @__PURE__ */ __name((id) => "do-" + id.slice(3), "orderId");
var planId = /* @__PURE__ */ __name((gb, days) => "dp-" + gb + "-" + days, "planId");
function decode(row) {
  if (typeof row?.context_id !== "string" || row.context_id.length > 700) return null;
  try {
    const v = JSON.parse(row.context_id);
    return v.version === 1 && ID5.test(v.id ?? "") && ["name", "node", "gb", "days", "review", "issued"].includes(v.step) ? v : null;
  } catch {
    return null;
  }
}
__name(decode, "decode");
async function save(db, actor, v, now) {
  await db.prepare(
    "INSERT INTO admin_direct_drafts(telegram_id,context_id,expires_ms) VALUES(?,?,?) ON CONFLICT(telegram_id) DO UPDATE SET context_id=excluded.context_id,expires_ms=excluded.expires_ms"
  ).bind(actor, JSON.stringify(v), now + TTL).run();
}
__name(save, "save");
async function load2(db, actor, now) {
  const row = await db.prepare(
    "SELECT context_id,expires_ms FROM admin_direct_drafts WHERE telegram_id=?"
  ).bind(actor).first();
  if (!row) return null;
  if (row.expires_ms <= now) {
    await clear2(db, actor);
    return null;
  }
  return decode(row);
}
__name(load2, "load");
async function clear2(db, actor) {
  await db.prepare(
    "DELETE FROM admin_direct_drafts WHERE telegram_id=?"
  ).bind(actor).run();
}
__name(clear2, "clear");
async function ownReadyNode(env, actor, ref, nowMs) {
  if (!REF.test(ref ?? "")) return null;
  const n = await nodeFromRef(env.DB, ref);
  if (!n || n.lifecycle !== "ready" || n.desired_revision !== n.acked_revision) return null;
  const row = await env.DB.prepare(
    "SELECT 1 ok FROM node_bootstrap_jobs j JOIN node_health h ON h.node_id=j.node_id WHERE j.node_id=? AND j.state='installed' AND j.owner_id=? AND h.revision=? AND h.xray_healthy=1 AND h.stats_healthy=1 AND h.observed_ms BETWEEN ? AND ?"
  ).bind(n.id, actor, n.desired_revision, nowMs - 6e5, nowMs).first();
  return row ? n : null;
}
__name(ownReadyNode, "ownReadyNode");
async function nodeButtons(env, actor, nowMs) {
  const rows = (await env.DB.prepare(
    "SELECT n.id,n.lifecycle,n.desired_revision,n.acked_revision,n.user_limit,h.revision AS health_revision,h.observed_ms,h.xray_healthy,h.stats_healthy,(SELECT COUNT(*) FROM node_allocations a WHERE a.node_id=n.id AND a.state IN ('reserved','active')) AS allocations FROM nodes n JOIN node_bootstrap_jobs j ON j.node_id=n.id AND j.state='installed' LEFT JOIN node_health h ON h.node_id=n.id WHERE j.owner_id=? AND n.lifecycle='ready' ORDER BY n.id LIMIT 12"
  ).bind(actor).all()).results ?? [];
  const buttons = [], blocked = [];
  for (const n of rows) {
    if (n.desired_revision !== n.acked_revision) {
      blocked.push("\u{1F7E0} " + n.id + ": \u062A\u0623\u06CC\u06CC\u062F \u062A\u0646\u0638\u06CC\u0645\u0627\u062A \u0639\u0627\u0645\u0644 \u0642\u062F\u06CC\u0645\u06CC \u0627\u0633\u062A.");
      continue;
    }
    if (n.health_revision !== n.desired_revision || n.xray_healthy !== 1 || n.stats_healthy !== 1 || !Number.isFinite(n.observed_ms) || n.observed_ms < nowMs - 6e5 || n.observed_ms > nowMs) {
      const age = Number.isFinite(n.observed_ms) ? Math.max(0, Math.floor((nowMs - n.observed_ms) / 6e4)) : null;
      blocked.push("\u{1F7E0} " + n.id + ": \u062A\u0623\u06CC\u06CC\u062F \u0627\u0648\u0644\u06CC\u0647 \u0645\u062D\u0641\u0648\u0638 \u0627\u0633\u062A\u061B \u0622\u062E\u0631\u06CC\u0646 \u06AF\u0632\u0627\u0631\u0634 \u0633\u0644\u0627\u0645\u062A \u0639\u0627\u0645\u0644 " + (age === null ? "\u062B\u0628\u062A \u0646\u0634\u062F\u0647." : faNumber(age) + " \u062F\u0642\u06CC\u0642\u0647 \u067E\u06CC\u0634 \u0628\u0648\u062F\u0647.") + " \u062A\u0633\u062A \u062F\u0648\u0628\u0627\u0631\u0647\u0654 \u0627\u067E\u0631\u0627\u062A\u0648\u0631\u0647\u0627 \u0644\u0627\u0632\u0645 \u0646\u06CC\u0633\u062A.");
      continue;
    }
    if (n.allocations >= n.user_limit) {
      blocked.push("\u23F8 " + n.id + ": \u0638\u0631\u0641\u06CC\u062A \u062A\u0639\u062F\u0627\u062F \u06A9\u0627\u0646\u0641\u06CC\u06AF \u062A\u06A9\u0645\u06CC\u0644 \u0634\u062F\u0647 \u0627\u0633\u062A.");
      continue;
    }
    buttons.push(button("\u{1F7E2} " + n.id, "node:" + await nodeUiRef(n.id)));
  }
  return { buttons, blocked };
}
__name(nodeButtons, "nodeButtons");
async function question2(env, actor, v, nowMs, warning = "") {
  const step = v.step;
  const title = step === "review" ? "\u0628\u0631\u0631\u0633\u06CC \u0646\u0647\u0627\u06CC\u06CC" : step === "issued" ? "\u0635\u062F\u0648\u0631 \u062B\u0628\u062A \u0634\u062F" : "\u0645\u0631\u062D\u0644\u0647 " + faNumber(["name", "node", "gb", "days"].indexOf(step) + 1) + " \u0627\u0632 \u06F4";
  let text = "";
  const controls = [];
  if (step === "name")
    text = "\u{1F464} \u0646\u0627\u0645 \u06CC\u0627 \u0628\u0631\u0686\u0633\u0628 \u0645\u0634\u062A\u0631\u06CC \u0631\u0627 \u0628\u0646\u0648\u06CC\u0633 (\u06F2 \u062A\u0627 \u06F6\u06F0 \u0646\u0648\u06CC\u0633\u0647).\n\u0645\u062B\u0627\u0644: \u0639\u0644\u06CC \u0631\u0636\u0627\u06CC\u06CC";
  else if (step === "node") {
    text = "\u{1F310} \u0633\u0631\u0648\u0631 \u0622\u0645\u0627\u062F\u0647\u0654 \u0645\u0648\u0631\u062F\u0646\u0638\u0631 \u0631\u0627 \u0627\u0646\u062A\u062E\u0627\u0628 \u06A9\u0646.\n\u0633\u0631\u0648\u0631 \u0641\u0642\u0637 \u06CC\u06A9 \u0628\u0627\u0631 \u0647\u0646\u06AF\u0627\u0645 \u0646\u0635\u0628 \u062A\u0623\u06CC\u06CC\u062F \u0634\u062F\u0647 \u0627\u0633\u062A.";
    const nodes = await nodeButtons(env, actor, nowMs);
    controls.push(...nodes.buttons);
    if (nodes.blocked.length) text += "\n\n" + nodes.blocked.join("\n");
    if (!controls.length) text += "\n\n\u23F8 \u0635\u062F\u0648\u0631 \u0627\u06CC\u0645\u0646 \u0641\u0639\u0644\u0627\u064B \u0645\u0645\u06A9\u0646 \u0646\u06CC\u0633\u062A. \u0646\u06CC\u0627\u0632\u06CC \u0628\u0647 \u062A\u06A9\u0631\u0627\u0631 \u062A\u0633\u062A \u067E\u0648\u0631\u062A\u200C\u0647\u0627 \u0646\u06CC\u0633\u062A\u061B \u0628\u0627\u06CC\u062F \u06AF\u0632\u0627\u0631\u0634 \u0633\u0644\u0627\u0645\u062A \u0639\u0627\u0645\u0644 \u0628\u0627\u0632\u06CC\u0627\u0628\u06CC \u0634\u0648\u062F.";
  } else if (step === "gb") {
    text = "\u{1F4E6} \u062D\u062C\u0645 \u0627\u0634\u062A\u0631\u0627\u06A9 \u0686\u0646\u062F \u06AF\u06CC\u06AF\u0627\u0628\u0627\u06CC\u062A \u0628\u0627\u0634\u062F\u061F\n\u0627\u0632 \u062F\u06A9\u0645\u0647\u200C\u0647\u0627 \u0627\u0646\u062A\u062E\u0627\u0628 \u06A9\u0646 \u06CC\u0627 \u0639\u062F\u062F \u06F1 \u062A\u0627 \u06F1\u06F0\u06F0\u06F0 \u0628\u0641\u0631\u0633\u062A.";
    for (const n of AMOUNTS) controls.push(button(faNumber(n) + " \u06AF\u06CC\u06AF\u0627\u0628\u0627\u06CC\u062A", "gb:" + n));
  } else if (step === "days") {
    text = "\u{1F4C5} \u0645\u062F\u062A \u0627\u0639\u062A\u0628\u0627\u0631 \u0686\u0646\u062F \u0631\u0648\u0632 \u0628\u0627\u0634\u062F\u061F\n\u0627\u0632 \u062F\u06A9\u0645\u0647\u200C\u0647\u0627 \u0627\u0646\u062A\u062E\u0627\u0628 \u06A9\u0646 \u06CC\u0627 \u0639\u062F\u062F \u06F1 \u062A\u0627 \u06F3\u06F6\u06F5 \u0628\u0641\u0631\u0633\u062A.";
    for (const n of DAYS) controls.push(button(faNumber(n) + " \u0631\u0648\u0632", "days:" + n));
  } else if (step === "review") {
    text = "\u{1F464} \u0645\u0634\u062A\u0631\u06CC: " + v.label + "\n\u{1F310} \u0633\u0631\u0648\u0631: " + v.node_id + "\n\u{1F4E6} \u062D\u062C\u0645: " + faNumber(v.gb) + " \u06AF\u06CC\u06AF\u0627\u0628\u0627\u06CC\u062A\n\u{1F4C5} \u0645\u062F\u062A: " + faNumber(v.days) + " \u0631\u0648\u0632\n\u{1F4B3} \u0645\u0628\u0644\u063A \u062F\u0631\u06CC\u0627\u0641\u062A\u06CC \u062F\u0631 \u0645\u062F\u0627\u0631: \u0635\u0641\u0631 (\u0635\u062F\u0648\u0631 \u062F\u0633\u062A\u06CC \u0645\u062F\u06CC\u0631)\n\n\u0628\u0627 \u062A\u0623\u06CC\u06CC\u062F\u060C UUID \u0627\u062E\u062A\u0635\u0627\u0635\u06CC \u0628\u0647\u200C\u0635\u0648\u0631\u062A \u0627\u0645\u0646 \u0627\u06CC\u062C\u0627\u062F \u0648 \u0628\u0631\u0627\u06CC \u0646\u0635\u0628 \u062E\u0648\u062F\u06A9\u0627\u0631 \u0628\u0647 \u0639\u0627\u0645\u0644 \u0633\u0631\u0648\u0631 \u0627\u0631\u0633\u0627\u0644 \u0645\u06CC\u200C\u0634\u0648\u062F.\n\u{1F512} \u0644\u06CC\u0646\u06A9 \u0641\u0642\u0637 \u067E\u0633 \u0627\u0632 \u062A\u0623\u06CC\u06CC\u062F \u0648\u0627\u0642\u0639\u06CC \u0646\u0635\u0628 \u062A\u0648\u0633\u0637 Xray \u062A\u062D\u0648\u06CC\u0644 \u062F\u0627\u062F\u0647 \u062E\u0648\u0627\u0647\u062F \u0634\u062F.";
    controls.push(button("\u2705 \u062A\u0623\u06CC\u06CC\u062F \u0648 \u0635\u062F\u0648\u0631 \u06A9\u0627\u0646\u0641\u06CC\u06AF", "save"));
  } else if (step === "issued") return directStatus(env, actor, v.id, nowMs);
  if (step !== "name") controls.push(button("\u2B05\uFE0F \u0645\u0631\u062D\u0644\u0647 \u0642\u0628\u0644", "back"));
  controls.push(button("\u274C \u0627\u0646\u0635\u0631\u0627\u0641", "cancel"));
  return panel3(panelHeading("\u{1F517}", "\u0635\u062F\u0648\u0631 \u06A9\u0627\u0646\u0641\u06CC\u06AF \u062C\u062F\u06CC\u062F", title) + (warning ? "\n\n\u26A0\uFE0F " + warning : "") + "\n\n" + text, controls);
}
__name(question2, "question");
async function issueRow(db, actor, id) {
  if (!ID5.test(id ?? "")) return null;
  return db.prepare(
    "SELECT i.id,i.node_id,i.label,i.quota_bytes,i.duration_days,i.order_id,o.state order_state,s.id subscription_id,s.state subscription_state,s.expires_at,s.used_bytes,a.state allocation_state,ac.observed_ms client_ack FROM admin_direct_issues i JOIN orders o ON o.id=i.order_id LEFT JOIN subscriptions s ON s.order_id=o.id LEFT JOIN node_allocations a ON a.subscription_id=s.id AND a.node_id=i.node_id LEFT JOIN node_client_acks ac ON ac.subscription_id=s.id AND ac.node_id=i.node_id WHERE i.id=? AND i.actor_id=? AND o.customer_telegram_id=? LIMIT 1"
  ).bind(id, actor, actor).first();
}
__name(issueRow, "issueRow");
async function ensureReservation(env, actor, v, nowMs) {
  const db = env.DB;
  const existing = await issueRow(db, actor, v.id);
  if (existing) {
    if (existing.subscription_id || existing.order_state !== "approved") return { status: "already_created" };
    return reserveApprovedOrder(env, existing.order_id, nowMs, existing.node_id);
  }
  const n = await ownReadyNode(env, actor, v.node_ref, nowMs);
  if (!n || n.id !== v.node_id) return { status: "node_unavailable" };
  if (label(v.label) === null || number(String(v.gb), 1, MAX_GB2) === null || number(String(v.days), 1, 365) === null) return { status: "invalid_fields" };
  const quota = v.gb * 1073741824, plan = planId(v.gb, v.days), order = orderId(v.id);
  try {
    const writes = await db.batch([
      db.prepare(
        "INSERT OR IGNORE INTO plans(id,title_fa,title_en,price_amount,price_currency,quota_bytes,duration_days,active) VALUES(?,'\u0635\u062F\u0648\u0631 \u062F\u0633\u062A\u06CC \u0645\u062F\u06CC\u0631','Admin direct issue',0,'IRT',?,?,0)"
      ).bind(plan, quota, v.days),
      db.prepare(
        "INSERT OR IGNORE INTO orders(id,customer_telegram_id,plan_id,idempotency_key,quoted_amount,quoted_currency,state) SELECT ?,?,?,?,0,'IRT','approved' FROM customers c JOIN plans p ON p.id=? WHERE c.telegram_id=? AND c.state='active' AND p.price_amount=0 AND p.active=0 AND p.quota_bytes=? AND p.duration_days=?"
      ).bind(order, actor, plan, "direct:" + v.id, plan, actor, quota, v.days),
      db.prepare(
        "INSERT OR IGNORE INTO admin_direct_issues(id,actor_id,order_id,node_id,label,quota_bytes,duration_days,created_ms) VALUES(?,?,?,?,?,?,?,?)"
      ).bind(v.id, actor, order, n.id, v.label, quota, v.days, nowMs)
    ]);
    if (Number(writes[2]?.meta?.changes) !== 1 && !await issueRow(db, actor, v.id))
      return { status: "create_rejected" };
  } catch {
    return { status: "create_rejected" };
  }
  return reserveApprovedOrder(env, order, nowMs, n.id);
}
__name(ensureReservation, "ensureReservation");
async function directStatus(env, actor, id, nowMs = Date.now(), refreshed = false) {
  if (!validAdmin(env, actor)) return panel3("\u26D4 \u062F\u0633\u062A\u0631\u0633\u06CC \u0628\u0647 \u0635\u062F\u0648\u0631 \u0645\u0633\u062A\u0642\u06CC\u0645 \u0645\u062C\u0627\u0632 \u0646\u06CC\u0633\u062A.");
  const row = await issueRow(env.DB, actor, id);
  if (!row) return panel3("\u26A0\uFE0F \u0627\u06CC\u0646 \u06A9\u0627\u0646\u0641\u06CC\u06AF \u062F\u0631 \u062D\u0633\u0627\u0628 \u0645\u062F\u06CC\u0631 \u0648\u062C\u0648\u062F \u0646\u062F\u0627\u0631\u062F.", [
    button("\u{1F4CB} \u06A9\u0627\u0646\u0641\u06CC\u06AF\u200C\u0647\u0627\u06CC \u0635\u0627\u062F\u0631\u0634\u062F\u0647", "list")
  ]);
  const ack2 = Number(row.client_ack ?? 0) >= nowMs - 6e5;
  const ready = row.order_state === "fulfilled" && row.subscription_state === "active" && row.allocation_state === "active" && ack2;
  const text = panelHeading("\u{1F517}", "\u06A9\u0627\u0646\u0641\u06CC\u06AF \u0645\u0634\u062A\u0631\u06CC", row.label) + "\n\u{1F310} \u0633\u0631\u0648\u0631: " + row.node_id + "\n\u{1F4E6} \u062D\u062C\u0645: " + faNumber(row.quota_bytes / 1073741824) + " \u06AF\u06CC\u06AF\u0627\u0628\u0627\u06CC\u062A\n\u{1F4C5} \u0645\u062F\u062A: " + faNumber(row.duration_days) + " \u0631\u0648\u0632\n\u{1F4CB} \u0633\u0641\u0627\u0631\u0634: " + row.order_state + "\n\u{1F510} \u0646\u0635\u0628 UUID: " + (ack2 ? "\u2705 \u062A\u0623\u06CC\u06CC\u062F \u0648\u0627\u0642\u0639\u06CC \u062F\u0631\u06CC\u0627\u0641\u062A \u0634\u062F" : "\u23F3 \u062F\u0631 \u0627\u0646\u062A\u0638\u0627\u0631 \u062A\u0623\u06CC\u06CC\u062F \u0639\u0627\u0645\u0644") + "\n\n" + (ready ? "\u2705 \u06A9\u0627\u0646\u0641\u06CC\u06AF \u0646\u0635\u0628 \u0634\u062F\u0647 \u0648 \u0628\u0631\u0627\u06CC \u062F\u0631\u06CC\u0627\u0641\u062A \u0622\u0645\u0627\u062F\u0647 \u0627\u0633\u062A." : row.subscription_state === "revoked" ? "\u26D4 \u0627\u0634\u062A\u0631\u0627\u06A9 \u0644\u063A\u0648 \u0634\u062F\u0647 \u0627\u0633\u062A." : "\u23F3 \u0645\u062F\u0627\u0631 \u062F\u0631 \u062D\u0627\u0644 \u0646\u0635\u0628 \u062E\u0648\u062F\u06A9\u0627\u0631 UUID \u062C\u062F\u06CC\u062F \u0627\u0633\u062A. \u0646\u06CC\u0627\u0632\u06CC \u0628\u0647 \u062A\u0633\u062A \u0645\u062C\u062F\u062F \u0633\u0631\u0648\u0631 \u0646\u06CC\u0633\u062A.");
  const checkedAt = refreshed ? new Intl.DateTimeFormat("fa-IR", {
    timeZone: "Asia/Tehran",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).format(nowMs) : null;
  return panel3(text + (checkedAt ? "\n\n\u{1F552} \u0622\u062E\u0631\u06CC\u0646 \u0628\u0631\u0631\u0633\u06CC: " + checkedAt + " \u0628\u0647 \u0648\u0642\u062A \u062A\u0647\u0631\u0627\u0646" : ""), [
    ...ready ? [button("\u{1F517} \u062F\u0631\u06CC\u0627\u0641\u062A \u0644\u06CC\u0646\u06A9 \u062F\u0648 \u0627\u067E\u0631\u0627\u062A\u0648\u0631", "link:" + id)] : [],
    ...row.subscription_state !== "revoked" && row.order_state !== "cancelled" ? [button("\u{1F6D1} \u0644\u063A\u0648 \u0627\u06CC\u0646 \u06A9\u0627\u0646\u0641\u06CC\u06AF", "end:" + id)] : [],
    button("\u{1F504} \u062A\u0627\u0632\u0647\u200C\u0633\u0627\u0632\u06CC", "status:" + id),
    button("\u{1F4CB} \u06A9\u0627\u0646\u0641\u06CC\u06AF\u200C\u0647\u0627\u06CC \u0645\u0646", "list")
  ]);
}
__name(directStatus, "directStatus");
async function directList(env, actor, nowMs = Date.now()) {
  if (!validAdmin(env, actor)) return panel3("\u26D4 \u062F\u0633\u062A\u0631\u0633\u06CC \u0628\u0647 \u0627\u06CC\u0646 \u0628\u062E\u0634 \u0645\u062C\u0627\u0632 \u0646\u06CC\u0633\u062A.");
  const rows = (await env.DB.prepare(
    "SELECT id,label,node_id FROM admin_direct_issues WHERE actor_id=? ORDER BY created_ms DESC LIMIT 12"
  ).bind(actor).all()).results ?? [];
  return panel3(panelHeading("\u{1F4CB}", "\u06A9\u0627\u0646\u0641\u06CC\u06AF\u200C\u0647\u0627\u06CC \u0635\u0627\u062F\u0631\u0634\u062F\u0647", "\u06A9\u0627\u0646\u0641\u06CC\u06AF\u200C\u0647\u0627\u06CC \u0647\u0645\u06CC\u0646 \u0645\u062F\u06CC\u0631") + "\n\n" + (rows.length ? "\u06CC\u06A9 \u06A9\u0627\u0646\u0641\u06CC\u06AF \u0631\u0627 \u0627\u0646\u062A\u062E\u0627\u0628 \u06A9\u0646." : "\u0647\u0646\u0648\u0632 \u06A9\u0627\u0646\u0641\u06CC\u06AF\u06CC \u062B\u0628\u062A \u0646\u0634\u062F\u0647 \u0627\u0633\u062A."), [
    ...rows.map((r) => button(
      "\u{1F464} " + r.label.slice(0, 32) + " \xB7 " + r.node_id.slice(0, 15),
      "status:" + r.id
    )),
    button("\u2795 \u0635\u062F\u0648\u0631 \u06A9\u0627\u0646\u0641\u06CC\u06AF \u062C\u062F\u06CC\u062F", "new")
  ]);
}
__name(directList, "directList");
async function directAction(env, e, nowMs = Date.now()) {
  if (!validAdmin(env, e.actorId)) return panel3("\u26D4 \u062F\u0633\u062A\u0631\u0633\u06CC \u0628\u0647 \u0635\u062F\u0648\u0631 \u0645\u0633\u062A\u0642\u06CC\u0645 \u0645\u062C\u0627\u0632 \u0646\u06CC\u0633\u062A.");
  const key = e.key ?? "", db = env.DB, actor = e.actorId;
  if (key === "admin:configs:direct:new") {
    const v2 = { version: 1, id: "di-" + hex5(12), step: "name" };
    await db.prepare(
      "DELETE FROM v2_bot_input_sessions WHERE telegram_id=? AND mode='plan_draft'"
    ).bind(actor).run();
    await save(db, actor, v2, nowMs);
    return question2(env, actor, v2, nowMs);
  }
  if (key === "admin:configs:direct:list") return directList(env, actor, nowMs);
  if (key === "admin:configs:direct:cancel") {
    await clear2(db, actor);
    return panel3("\u2705 \u0635\u062F\u0648\u0631 \u062C\u062F\u06CC\u062F \u0644\u063A\u0648 \u0634\u062F\u061B \u0647\u06CC\u0686 \u0633\u0641\u0627\u0631\u0634 \u062C\u062F\u06CC\u062F\u06CC \u0633\u0627\u062E\u062A\u0647 \u0646\u0634\u062F.", [
      button("\u2795 \u0635\u062F\u0648\u0631 \u06A9\u0627\u0646\u0641\u06CC\u06AF", "new")
    ]);
  }
  const operation = key.match(/^admin:configs:direct:(status|link|end|revoke):((?:di-)[a-f0-9]{24})$/);
  if (operation) {
    const [, action2, id] = operation, row = await issueRow(db, actor, id);
    if (!row) return panel3("\u26D4 \u0627\u06CC\u0646 \u06A9\u0627\u0646\u0641\u06CC\u06AF \u0645\u062A\u0639\u0644\u0642 \u0628\u0647 \u0645\u062F\u06CC\u0631 \u0646\u06CC\u0633\u062A.");
    if (action2 === "status") return directStatus(env, actor, id, nowMs, true);
    if (action2 === "end") return panel3("\u0622\u06CC\u0627 \u06A9\u0627\u0646\u0641\u06CC\u06AF " + row.label + " \u0644\u063A\u0648 \u0634\u0648\u062F\u061F \u0644\u06CC\u0646\u06A9 \u0622\u0646 \u0628\u06CC\u200C\u0627\u0639\u062A\u0628\u0627\u0631 \u0645\u06CC\u200C\u0634\u0648\u062F \u0648 \u0639\u0627\u0645\u0644 \u0633\u0631\u0648\u0631 \u062D\u0630\u0641 UUID \u0631\u0627 \u0627\u0646\u062C\u0627\u0645 \u0645\u06CC\u200C\u062F\u0647\u062F.", [
      button("\u2705 \u062A\u0623\u06CC\u06CC\u062F \u0644\u063A\u0648", "revoke:" + id),
      button("\u21A9\uFE0F \u0627\u0646\u0635\u0631\u0627\u0641", "status:" + id)
    ]);
    if (action2 === "revoke") {
      await db.batch([
        db.prepare("UPDATE subscriptions SET state='revoked' WHERE id=? AND owner_telegram_id=? AND state IN ('active','pending')").bind(row.subscription_id, actor),
        db.prepare("UPDATE subscription_tokens SET revoked=1 WHERE subscription_id=?").bind(row.subscription_id),
        db.prepare("UPDATE orders SET state='cancelled' WHERE id=? AND state IN ('approved','provisioning')").bind(row.order_id)
      ]);
      return directStatus(env, actor, id, nowMs);
    }
    if (row.order_state !== "fulfilled" || row.subscription_state !== "active" || row.allocation_state !== "active" || Number(row.client_ack ?? 0) < nowMs - 6e5)
      return directStatus(env, actor, id, nowMs);
    const link = await issueCarrierLink(env, row.subscription_id, nowMs);
    return panel3(link ? "\u{1F517} \u06A9\u0627\u0646\u0641\u06CC\u06AF " + row.label + "\n\n" + link.url + "\n\n\u0627\u06CC\u0646 \u0644\u06CC\u0646\u06A9 \u062E\u0635\u0648\u0635\u06CC \u0634\u0627\u0645\u0644 \u0647\u0631 \u062F\u0648 \u0645\u0633\u06CC\u0631 \u0647\u0645\u0631\u0627\u0647 \u0627\u0648\u0644 \u0648 \u0627\u06CC\u0631\u0627\u0646\u0633\u0644 \u0628\u0627 \u062D\u062C\u0645 \u0645\u0634\u062A\u0631\u06A9 \u0627\u0633\u062A." : "\u23F3 \u0644\u06CC\u0646\u06A9 \u0647\u0646\u0648\u0632 \u0642\u0627\u0628\u0644 \u0627\u0646\u062A\u0634\u0627\u0631 \u0646\u06CC\u0633\u062A\u061B \u0646\u0635\u0628 UUID \u0648 \u0633\u0644\u0627\u0645\u062A \u0647\u0631 \u062F\u0648 \u0645\u0633\u06CC\u0631 \u0628\u0627\u06CC\u062F \u0645\u0639\u062A\u0628\u0631 \u0628\u0627\u0634\u0646\u062F.", [
      button("\u{1F504} \u0648\u0636\u0639\u06CC\u062A", "status:" + id)
    ]);
  }
  let v = await load2(db, actor, nowMs);
  if (!v) return panel3("\u231B \u0641\u0631\u0645 \u0635\u062F\u0648\u0631 \u0645\u0646\u0642\u0636\u06CC \u0634\u062F\u0647 \u0627\u0633\u062A. \u062F\u0648\u0628\u0627\u0631\u0647 \u0634\u0631\u0648\u0639 \u06A9\u0646.", [
    button("\u2795 \u0635\u062F\u0648\u0631 \u062C\u062F\u06CC\u062F", "new")
  ]);
  if (key === "admin:configs:direct:back") {
    const steps = ["name", "node", "gb", "days", "review"];
    const index = steps.indexOf(v.step);
    if (index > 0) v.step = steps[index - 1];
    await save(db, actor, v, nowMs);
    return question2(env, actor, v, nowMs);
  }
  const n = key.match(/^admin:configs:direct:node:([a-f0-9]{24})$/);
  if (n && v.step === "node") {
    const node = await ownReadyNode(env, actor, n[1], nowMs);
    if (!node) return question2(env, actor, v, nowMs, "\u0627\u06CC\u0646 \u0633\u0631\u0648\u0631 \u0622\u0645\u0627\u062F\u0647 \u0646\u06CC\u0633\u062A\u061B \u0633\u0631\u0648\u0631 \u062F\u06CC\u06AF\u0631\u06CC \u0627\u0646\u062A\u062E\u0627\u0628 \u06A9\u0646.");
    v.node_id = node.id;
    v.node_ref = n[1];
    v.step = "gb";
    await save(db, actor, v, nowMs);
    return question2(env, actor, v, nowMs);
  }
  const gb = key.match(/^admin:configs:direct:gb:(\d{1,4})$/);
  if (gb && v.step === "gb") {
    const amount = number(gb[1], 1, MAX_GB2);
    if (amount === null) return question2(env, actor, v, nowMs, "\u062D\u062C\u0645 \u0646\u0627\u0645\u0639\u062A\u0628\u0631 \u0627\u0633\u062A.");
    v.gb = amount;
    v.step = "days";
    await save(db, actor, v, nowMs);
    return question2(env, actor, v, nowMs);
  }
  const days = key.match(/^admin:configs:direct:days:(\d{1,3})$/);
  if (days && v.step === "days") {
    const amount = number(days[1], 1, 365);
    if (amount === null) return question2(env, actor, v, nowMs, "\u0645\u062F\u062A \u0646\u0627\u0645\u0639\u062A\u0628\u0631 \u0627\u0633\u062A.");
    v.days = amount;
    v.step = "review";
    await save(db, actor, v, nowMs);
    return question2(env, actor, v, nowMs);
  }
  if (key === "admin:configs:direct:save") {
    if (v.step !== "review" || !v.node_id || !v.node_ref || label(v.label) === null || number(String(v.gb), 1, MAX_GB2) === null || number(String(v.days), 1, 365) === null)
      return question2(env, actor, v, nowMs, "\u0627\u0637\u0644\u0627\u0639\u0627\u062A \u0635\u062F\u0648\u0631 \u06A9\u0627\u0645\u0644 \u0646\u06CC\u0633\u062A.");
    const result = await ensureReservation(env, actor, v, nowMs);
    if (!["reserved", "already_created", "concurrent_change"].includes(result.status)) {
      const row = await issueRow(db, actor, v.id);
      if (!row) return question2(env, actor, v, nowMs, "\u062B\u0628\u062A \u062F\u0631\u062E\u0648\u0627\u0633\u062A \u0627\u0646\u062C\u0627\u0645 \u0646\u0634\u062F: " + result.status);
    }
    v.step = "issued";
    await save(db, actor, v, nowMs);
    return directStatus(env, actor, v.id, nowMs);
  }
  return question2(env, actor, v, nowMs, "\u0627\u06CC\u0646 \u062F\u06A9\u0645\u0647 \u0645\u0631\u0628\u0648\u0637 \u0628\u0647 \u0645\u0631\u062D\u0644\u0647\u0654 \u0641\u0639\u0644\u06CC \u0646\u06CC\u0633\u062A.");
}
__name(directAction, "directAction");
async function directInput(env, e, session, nowMs = Date.now()) {
  if (!validAdmin(env, e.actorId)) return null;
  const v = decode(session);
  if (!v) return null;
  const raw = e.inputText;
  if (typeof raw !== "string" || raw.startsWith("/") || raw.length > 150) return null;
  if (v.step === "name") {
    const value = label(raw);
    if (value === null) return question2(
      env,
      e.actorId,
      v,
      nowMs,
      "\u0646\u0627\u0645 \u0645\u0634\u062A\u0631\u06CC \u0628\u0627\u06CC\u062F \u06CC\u06A9 \u062E\u0637 \u0648 \u0628\u06CC\u0646 \u06F2 \u062A\u0627 \u06F6\u06F0 \u0646\u0648\u06CC\u0633\u0647 \u0628\u0627\u0634\u062F."
    );
    v.label = value;
    v.step = "node";
  } else if (v.step === "gb") {
    const value = number(raw, 1, MAX_GB2);
    if (value === null) return question2(
      env,
      e.actorId,
      v,
      nowMs,
      "\u062D\u062C\u0645 \u0628\u0627\u06CC\u062F \u0639\u062F\u062F \u0635\u062D\u06CC\u062D \u0628\u06CC\u0646 \u06F1 \u062A\u0627 \u06F1\u06F0\u06F0\u06F0 \u06AF\u06CC\u06AF\u0627\u0628\u0627\u06CC\u062A \u0628\u0627\u0634\u062F."
    );
    v.gb = value;
    v.step = "days";
  } else if (v.step === "days") {
    const value = number(raw, 1, 365);
    if (value === null) return question2(
      env,
      e.actorId,
      v,
      nowMs,
      "\u0645\u062F\u062A \u0628\u0627\u06CC\u062F \u0639\u062F\u062F \u0635\u062D\u06CC\u062D \u0628\u06CC\u0646 \u06F1 \u062A\u0627 \u06F3\u06F6\u06F5 \u0631\u0648\u0632 \u0628\u0627\u0634\u062F."
    );
    v.days = value;
    v.step = "review";
  } else return question2(env, e.actorId, v, nowMs, "\u0627\u0632 \u062F\u06A9\u0645\u0647\u200C\u0647\u0627\u06CC \u0647\u0645\u06CC\u0646 \u0645\u0631\u062D\u0644\u0647 \u0627\u0633\u062A\u0641\u0627\u062F\u0647 \u06A9\u0646.");
  await save(env.DB, e.actorId, v, nowMs);
  return question2(env, e.actorId, v, nowMs);
}
__name(directInput, "directInput");

// src/bot-panels.mjs
var NAT2 = /^[0-9]{1,20}$/;
var TICKET = /^tg-[0-9]{1,20}$/;
var panel4 = /* @__PURE__ */ __name((s, locale = "fa", buttons = [], audience = "customer") => ({
  text: frameMessage(String(s).slice(0, 3300)),
  replyMarkup: { inline_keyboard: [...buttons, ...sectionNavigation(audience)] }
}), "panel");
var adminPanel = /* @__PURE__ */ __name((s, buttons = [], locale = "fa") => panel4(s, locale, buttons, "admin"), "adminPanel");
var supportPanel = /* @__PURE__ */ __name((s, buttons = [], locale = "fa") => panel4(s, locale, buttons, "support"), "supportPanel");
var idAdmin = /* @__PURE__ */ __name((env, id) => typeof env.ADMIN_TELEGRAM_IDS === "string" && NAT2.test(id ?? "") && env.ADMIN_TELEGRAM_IDS.split(",").map((x) => x.trim()).includes(id), "idAdmin");
var button2 = /* @__PURE__ */ __name((text, key) => [{ text, callback_data: "v2:" + key }], "button");
async function count2(db, sql, ...args) {
  const x = await db.prepare(sql).bind(...args).first();
  return Number(x?.n ?? 0);
}
__name(count2, "count");
async function adminDashboard(env, e, nowMs = Date.now()) {
  if (!idAdmin(env, e.actorId)) return adminPanel("\u26D4 \u062F\u0633\u062A\u0631\u0633\u06CC \u0628\u0647 \u0627\u06CC\u0646 \u0628\u062E\u0634 \u0645\u062C\u0627\u0632 \u0646\u06CC\u0633\u062A.", [], e.locale);
  const db = env.DB;
  const [customers, orders, receipts, tickets, nodes, installed, fieldAccepted, ready, subs] = await Promise.all([
    count2(db, "SELECT COUNT(*) AS n FROM customers"),
    count2(db, "SELECT COUNT(*) AS n FROM orders WHERE state IN ('pending','receipt_submitted','approved','provisioning')"),
    count2(db, "SELECT COUNT(*) AS n FROM orders WHERE state='receipt_submitted'"),
    count2(db, "SELECT COUNT(*) AS n FROM support_tickets WHERE state IN ('open','waiting')"),
    count2(db, "SELECT COUNT(*) AS n FROM nodes"),
    count2(db, "SELECT COUNT(*) AS n FROM node_bootstrap_jobs WHERE state='installed'"),
    count2(db, "SELECT COUNT(*) AS n FROM nodes WHERE lifecycle='ready'"),
    // Field acceptance and current runtime health are different gates.
    count2(db, "SELECT COUNT(*) AS n FROM nodes n WHERE n.lifecycle='ready' AND n.desired_revision=n.acked_revision AND EXISTS (SELECT 1 FROM node_bootstrap_jobs j WHERE j.node_id=n.id AND j.state='installed') AND EXISTS (SELECT 1 FROM node_health h WHERE h.node_id=n.id AND h.revision=n.desired_revision AND h.xray_healthy=1 AND h.stats_healthy=1 AND h.observed_ms BETWEEN ? AND ?) AND (SELECT COUNT(*) FROM node_allocations a WHERE a.node_id=n.id AND a.state IN ('reserved','active'))<n.user_limit", nowMs - 6e5, nowMs),
    count2(db, "SELECT COUNT(*) AS n FROM subscriptions WHERE state='active'")
  ]);
  const salesReady = env.SHOP_ENABLED === "true" && env.PROVISIONING_ENABLED === "true" && typeof env.PAYMENT_INSTRUCTIONS === "string" && env.PAYMENT_INSTRUCTIONS.trim().length >= 12 && env.PAYMENT_INSTRUCTIONS.length <= 700;
  const actionNeeded = receipts > 0 ? "\u{1F9FE} " + faNumber(receipts) + " \u0631\u0633\u06CC\u062F \u062F\u0631 \u0635\u0641 \u0628\u0631\u0631\u0633\u06CC" : tickets > 0 ? "\u{1F4AC} " + faNumber(tickets) + " \u062F\u0631\u062E\u0648\u0627\u0633\u062A \u067E\u0634\u062A\u06CC\u0628\u0627\u0646\u06CC \u0628\u0627\u0632" : ready === 0 ? fieldAccepted > 0 ? "\u26A0\uFE0F \u0633\u0631\u0648\u0631 \u062A\u0623\u06CC\u06CC\u062F\u0634\u062F\u0647\u060C \u06AF\u0632\u0627\u0631\u0634 \u0633\u0644\u0627\u0645\u062A \u062A\u0627\u0632\u0647 \u06CC\u0627 \u0638\u0631\u0641\u06CC\u062A \u0635\u062F\u0648\u0631 \u0646\u062F\u0627\u0631\u062F" : "\u26A0\uFE0F \u0633\u0631\u0648\u0631 \u0622\u0645\u0627\u062F\u0647 \u0648\u062C\u0648\u062F \u0646\u062F\u0627\u0631\u062F" : "\u2705 \u0645\u0648\u0631\u062F \u0641\u0648\u0631\u06CC \u062F\u0631 \u0635\u0641 \u0646\u06CC\u0633\u062A";
  const body3 = [
    panelHeading("\u{1F4CA}", "\u067E\u06CC\u0634\u062E\u0648\u0627\u0646 \u0645\u062F\u06CC\u0631\u06CC\u062A", "\u062E\u0644\u0627\u0635\u0647 \u0648\u0636\u0639\u06CC\u062A \u0645\u062F\u0627\u0631"),
    "",
    "\u{1F465} \u0645\u0634\u062A\u0631\u06CC\u0627\u0646: " + faNumber(customers),
    "\u{1F517} \u0627\u0634\u062A\u0631\u0627\u06A9 \u0641\u0639\u0627\u0644: " + faNumber(subs),
    "\u{1F9FE} \u0633\u0641\u0627\u0631\u0634 \u0628\u0627\u0632: " + faNumber(orders),
    "\u{1F4E9} \u0631\u0633\u06CC\u062F \u062F\u0631 \u0627\u0646\u062A\u0638\u0627\u0631: " + faNumber(receipts),
    "\u{1F4AC} \u067E\u0634\u062A\u06CC\u0628\u0627\u0646\u06CC \u0628\u0627\u0632: " + faNumber(tickets),
    "",
    "\u{1F5A5} \u06A9\u0644 \u0633\u0631\u0648\u0631\u0647\u0627: " + faNumber(nodes),
    "\u{1F6E0} \u0646\u0635\u0628\u200C\u0634\u062F\u0647: " + faNumber(installed),
    "\u2705 \u0622\u0645\u0627\u062F\u0647 \u0628\u0631\u0627\u06CC \u0635\u062F\u0648\u0631: " + faNumber(ready),
    "\u{1F9EA} \u062A\u0623\u06CC\u06CC\u062F \u0627\u0648\u0644\u06CC\u0647: " + faNumber(fieldAccepted),
    "",
    "\u{1F6D2} \u0641\u0631\u0648\u0634 \u0639\u0645\u0648\u0645\u06CC: " + (salesReady ? "\u062F\u0631 \u062D\u0627\u0644 \u067E\u06CC\u06A9\u0631\u0628\u0646\u062F\u06CC" : "\u063A\u06CC\u0631\u0641\u0639\u0627\u0644"),
    actionNeeded
  ].join("\n");
  return { text: frameMessage(body3), photoId: BRAND_BANNER_URL, replyMarkup: { inline_keyboard: [
    [{ text: "\u{1F464} \u0645\u0634\u0627\u0647\u062F\u0647 \u0646\u0645\u0627\u06CC \u0645\u0634\u062A\u0631\u06CC", callback_data: "v2:customer:home" }],
    ...adminMenu().inline_keyboard
  ] } };
}
__name(adminDashboard, "adminDashboard");
async function customerTickets(env, e, page = 0) {
  if (Number.isSafeInteger(e.messageId) && e.messageId > 0)
    await env.DB.prepare("DELETE FROM customer_sessions WHERE telegram_id=? AND mode='support'").bind(e.actorId).run();
  const pageIndex = Number.isInteger(page) && page >= 0 && page <= 1e3 ? page : 0;
  const rows = (await env.DB.prepare(
    "SELECT id,subject,state,created_at FROM support_tickets WHERE customer_telegram_id=? ORDER BY created_at DESC,id DESC LIMIT 7 OFFSET ?"
  ).bind(e.actorId, pageIndex * 6).all()).results ?? [];
  const visible = rows.slice(0, 6), next = rows.length > 6;
  if (!visible.length) return panel4(
    panelHeading("\u{1F4AC}", "\u067E\u0634\u062A\u06CC\u0628\u0627\u0646\u06CC \u0645\u062F\u0627\u0631", "\u0647\u0645\u0631\u0627\u0647 \u0634\u0645\u0627 \u0628\u0631\u0627\u06CC \u062D\u0644 \u0645\u0634\u06A9\u0644"),
    e.locale,
    [button2("\u2795 \u062B\u0628\u062A \u062F\u0631\u062E\u0648\u0627\u0633\u062A \u062C\u062F\u06CC\u062F", "support")]
  );
  const controls = visible.map((x) => button2(
    statusSymbol(x.state) + " " + shortCode(x.id, 12) + " \xB7 " + faStatus(x.state),
    "customer:ticket:" + x.id
  ));
  const pages3 = [];
  if (pageIndex > 0) pages3.push({ text: "\u25C0\uFE0F \u0642\u0628\u0644\u06CC", callback_data: "v2:customer:tickets:" + (pageIndex - 1) });
  if (next) pages3.push({ text: "\u0628\u0639\u062F\u06CC \u25B6\uFE0F", callback_data: "v2:customer:tickets:" + (pageIndex + 1) });
  if (pages3.length) controls.push(pages3);
  controls.push(button2("\u2795 \u062F\u0631\u062E\u0648\u0627\u0633\u062A \u062C\u062F\u06CC\u062F", "support"));
  return panel4(
    panelHeading("\u{1F4AC}", "\u062F\u0631\u062E\u0648\u0627\u0633\u062A\u200C\u0647\u0627\u06CC \u067E\u0634\u062A\u06CC\u0628\u0627\u0646\u06CC", "\u06AF\u0641\u062A\u200C\u0648\u06AF\u0648\u0647\u0627\u06CC \u0634\u0645\u0627 \u0628\u0627 \u062A\u06CC\u0645 \u0645\u062F\u0627\u0631") + "\n\u0635\u0641\u062D\u0647 " + faNumber(pageIndex + 1) + "\n\n" + visible.map(
      (x, i) => faNumber(pageIndex * 6 + i + 1) + ". " + statusSymbol(x.state) + " " + faStatus(x.state) + "\n" + x.subject.slice(0, 85) + "\n\u06A9\u062F \u067E\u06CC\u06AF\u06CC\u0631\u06CC: " + x.id
    ).join("\n\n\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n\n"),
    e.locale,
    controls
  );
}
__name(customerTickets, "customerTickets");
async function thread(env, e, id, ownerOnly, page = 0) {
  if (!TICKET.test(id)) return panel4("\u26A0\uFE0F \u0634\u0646\u0627\u0633\u0647 \u062F\u0631\u062E\u0648\u0627\u0633\u062A \u0645\u0639\u062A\u0628\u0631 \u0646\u06CC\u0633\u062A.", e.locale);
  const db = env.DB;
  const ticket = await db.prepare(
    "SELECT id,customer_telegram_id,state,subject FROM support_tickets WHERE id=?" + (ownerOnly ? " AND customer_telegram_id=?" : "")
  ).bind(...ownerOnly ? [id, e.actorId] : [id]).first();
  if (!ticket) return panel4("\u062F\u0631\u062E\u0648\u0627\u0633\u062A \u0645\u0648\u0631\u062F\u0646\u0638\u0631 \u067E\u06CC\u062F\u0627 \u0646\u0634\u062F.", e.locale);
  if (ownerOnly && Number.isSafeInteger(e.messageId) && e.messageId > 0)
    await db.prepare("DELETE FROM v2_bot_input_sessions WHERE telegram_id=? AND mode='ticket_reply'").bind(e.actorId).run();
  page = Number.isSafeInteger(page) && page >= 0 && page <= 1e3 ? page : 0;
  const total = (await db.prepare("SELECT COUNT(*) n FROM support_messages WHERE ticket_id=?").bind(id).first())?.n ?? 0;
  const maxPage = Math.max(0, Math.ceil(Number(total) / 5) - 1);
  page = Math.min(page, maxPage);
  const rows = (await db.prepare(
    "SELECT id,role,body,telegram_file_id FROM support_messages WHERE ticket_id=? ORDER BY created_at DESC,id DESC LIMIT 5 OFFSET ?"
  ).bind(id, page * 5).all()).results ?? [];
  const messages = rows.reverse().map((x) => (x.role === "customer" ? "\u{1F464} \u0634\u0645\u0627" : "\u{1F9D1}\u200D\u{1F4BC} \u067E\u0634\u062A\u06CC\u0628\u0627\u0646\u06CC") + "\n" + x.body.slice(0, 350));
  const controls = ticket.state === "closed" ? [button2("\u2795 \u062B\u0628\u062A \u062F\u0631\u062E\u0648\u0627\u0633\u062A \u062C\u062F\u06CC\u062F", "support")] : [button2("\u2709\uFE0F \u067E\u0627\u0633\u062E \u0628\u0647 \u062F\u0631\u062E\u0648\u0627\u0633\u062A", "customer:ticket:reply:" + id)];
  controls.push(...rows.filter((x) => x.telegram_file_id && /^support-media:[0-9]{1,20}$/.test(x.id)).map((x) => button2("\u{1F5BC} \u0645\u0634\u0627\u0647\u062F\u0647 \u062A\u0635\u0648\u06CC\u0631 \u067E\u06CC\u0648\u0633\u062A", "customer:ticket:media:" + x.id.slice(14))));
  const nav = [];
  if (page < maxPage) nav.push({ text: "\u25C0\uFE0F \u0642\u062F\u06CC\u0645\u06CC\u200C\u062A\u0631", callback_data: "v2:customer:ticket:page:" + id + ":" + (page + 1) });
  if (page > 0) nav.push({ text: "\u062C\u062F\u06CC\u062F\u062A\u0631 \u25B6\uFE0F", callback_data: "v2:customer:ticket:page:" + id + ":" + (page - 1) });
  if (nav.length) controls.push(nav);
  controls.push(button2("\u{1F4CB} \u0628\u0627\u0632\u06AF\u0634\u062A \u0628\u0647 \u062F\u0631\u062E\u0648\u0627\u0633\u062A\u200C\u0647\u0627", "customer:tickets"));
  return panel4(
    panelHeading("\u{1F4AC}", "\u06AF\u0641\u062A\u200C\u0648\u06AF\u0648\u06CC \u067E\u0634\u062A\u06CC\u0628\u0627\u0646\u06CC", ticket.subject.slice(0, 90)) + "\n\u06A9\u062F \u067E\u06CC\u06AF\u06CC\u0631\u06CC: " + ticket.id + "\n\u0648\u0636\u0639\u06CC\u062A: " + statusSymbol(ticket.state) + " " + faStatus(ticket.state) + "\n\u{1F4DC} \u067E\u06CC\u0627\u0645\u200C\u0647\u0627 \xB7 \u0635\u0641\u062D\u0647 " + faNumber(page + 1) + " \u0627\u0632 " + faNumber(maxPage + 1) + (messages.length ? "\n\n" + messages.join("\n\n\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n\n") : "\n\n\u0647\u0646\u0648\u0632 \u067E\u06CC\u0627\u0645\u06CC \u062B\u0628\u062A \u0646\u0634\u062F\u0647 \u0627\u0633\u062A."),
    e.locale,
    controls
  );
}
__name(thread, "thread");
async function staffTicketDetails(env, e, id, page = 0) {
  if (!TICKET.test(id)) return panel4("\u26A0\uFE0F \u0634\u0646\u0627\u0633\u0647 \u062F\u0631\u062E\u0648\u0627\u0633\u062A \u0645\u0639\u062A\u0628\u0631 \u0646\u06CC\u0633\u062A.", e.locale);
  const db = env.DB;
  const isAdministrator = idAdmin(env, e.actorId);
  const authorized = isAdministrator || !!await db.prepare(
    "SELECT 1 AS ok FROM staff_roles sr JOIN customers c ON c.telegram_id=sr.telegram_id WHERE sr.telegram_id=? AND sr.role='support' AND c.state='active'"
  ).bind(e.actorId).first();
  if (!authorized) return panel4("\u26D4 \u062F\u0633\u062A\u0631\u0633\u06CC \u0628\u0647 \u0627\u06CC\u0646 \u0628\u062E\u0634 \u0645\u062C\u0627\u0632 \u0646\u06CC\u0633\u062A.", e.locale);
  if (Number.isSafeInteger(e.messageId) && e.messageId > 0)
    await db.prepare("DELETE FROM support_staff_sessions WHERE telegram_id=?").bind(e.actorId).run();
  const staffPanel = isAdministrator ? adminPanel : supportPanel;
  const ticket = await db.prepare(
    "SELECT id,customer_telegram_id,state,subject FROM support_tickets WHERE id=?"
  ).bind(id).first();
  if (!ticket) return staffPanel("\u062F\u0631\u062E\u0648\u0627\u0633\u062A \u0645\u0648\u0631\u062F\u0646\u0638\u0631 \u067E\u06CC\u062F\u0627 \u0646\u0634\u062F.", [], e.locale);
  page = Number.isSafeInteger(page) && page >= 0 && page <= 1e3 ? page : 0;
  const total = (await db.prepare("SELECT COUNT(*) n FROM support_messages WHERE ticket_id=?").bind(id).first())?.n ?? 0;
  const maxPage = Math.max(0, Math.ceil(Number(total) / 5) - 1);
  page = Math.min(page, maxPage);
  const messages = (await db.prepare(
    "SELECT id,role,body,telegram_file_id FROM support_messages WHERE ticket_id=? ORDER BY created_at DESC,id DESC LIMIT 5 OFFSET ?"
  ).bind(id, page * 5).all()).results ?? [];
  const conversation = messages.reverse().map((x) => (x.role === "customer" ? "\u{1F464} \u0645\u0634\u062A\u0631\u06CC" : "\u{1F9D1}\u200D\u{1F4BC} \u067E\u0634\u062A\u06CC\u0628\u0627\u0646") + "\n" + x.body.slice(0, 350)).join("\n\n\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n\n");
  const navigation = [];
  if (page < maxPage) navigation.push({ text: "\u25C0\uFE0F \u0642\u062F\u06CC\u0645\u06CC\u200C\u062A\u0631", callback_data: "v2:ticket:page:" + id + ":" + (page + 1) });
  if (page > 0) navigation.push({ text: "\u062C\u062F\u06CC\u062F\u062A\u0631 \u25B6\uFE0F", callback_data: "v2:ticket:page:" + id + ":" + (page - 1) });
  return staffPanel(
    panelHeading("\u{1F4AC}", "\u062C\u0632\u0626\u06CC\u0627\u062A \u062F\u0631\u062E\u0648\u0627\u0633\u062A", ticket.subject.slice(0, 90)) + "\n\u06A9\u062F \u067E\u06CC\u06AF\u06CC\u0631\u06CC: " + ticket.id + "\n\u0634\u0646\u0627\u0633\u0647 \u0645\u0634\u062A\u0631\u06CC: " + ticket.customer_telegram_id + "\n\u0648\u0636\u0639\u06CC\u062A: " + statusSymbol(ticket.state) + " " + faStatus(ticket.state) + "\n\u{1F4DC} \u067E\u06CC\u0627\u0645\u200C\u0647\u0627 \xB7 \u0635\u0641\u062D\u0647 " + faNumber(page + 1) + " \u0627\u0632 " + faNumber(maxPage + 1) + (conversation ? "\n\n" + conversation : "\n\n\u0647\u0646\u0648\u0632 \u067E\u06CC\u0627\u0645\u06CC \u062B\u0628\u062A \u0646\u0634\u062F\u0647 \u0627\u0633\u062A."),
    [
      ...ticket.state === "closed" ? [] : [
        button2("\u2709\uFE0F \u067E\u0627\u0633\u062E \u0628\u0647 \u0645\u0634\u062A\u0631\u06CC", "ticket:reply:" + id),
        button2("\u{1F512} \u0628\u0633\u062A\u0646 \u062F\u0631\u062E\u0648\u0627\u0633\u062A", "ticket:confirm-close:" + id)
      ],
      ...messages.filter((x) => x.telegram_file_id && /^support-media:[0-9]{1,20}$/.test(x.id)).map((x) => button2("\u{1F5BC} \u0645\u0634\u0627\u0647\u062F\u0647 \u062A\u0635\u0648\u06CC\u0631 \u067E\u06CC\u0648\u0633\u062A", "ticket:media:" + x.id.slice(14))),
      ...navigation.length ? [navigation] : [],
      button2("\u{1F4CB} \u0628\u0627\u0632\u06AF\u0634\u062A \u0628\u0647 \u0635\u0646\u062F\u0648\u0642", "admin:tickets")
    ],
    e.locale
  );
}
__name(staffTicketDetails, "staffTicketDetails");
async function startSession(db, e, mode, context, nowMs) {
  await db.prepare(
    "INSERT INTO v2_bot_input_sessions(telegram_id,mode,context_id,expires_ms) VALUES(?,?,?,?) ON CONFLICT(telegram_id) DO UPDATE SET mode=excluded.mode,context_id=excluded.context_id,expires_ms=excluded.expires_ms"
  ).bind(e.actorId, mode, context, nowMs + 10 * 60 * 1e3).run();
}
__name(startSession, "startSession");
async function customerTicketAction(env, e, nowMs = Date.now()) {
  const key = e.key ?? "";
  if (key === "customer:tickets" || key === "/tickets") return customerTickets(env, e);
  const threadPage = key.match(/^customer:ticket:page:(tg-[0-9]{1,20}):([0-9]{1,4})$/);
  if (threadPage) return thread(env, e, threadPage[1], true, Number(threadPage[2]));
  if (/^customer:tickets:[0-9]{1,4}$/.test(key))
    return customerTickets(env, e, Number(key.slice("customer:tickets:".length)));
  if (key.startsWith("customer:ticket:reply:")) {
    const id = key.slice("customer:ticket:reply:".length);
    if (!TICKET.test(id)) return panel4("\u26A0\uFE0F \u0634\u0646\u0627\u0633\u0647 \u062F\u0631\u062E\u0648\u0627\u0633\u062A \u0645\u0639\u062A\u0628\u0631 \u0646\u06CC\u0633\u062A.", e.locale);
    const row = await env.DB.prepare(
      "SELECT id FROM support_tickets WHERE id=? AND customer_telegram_id=? AND state IN ('open','waiting')"
    ).bind(id, e.actorId).first();
    if (!row) return panel4("\u0627\u06CC\u0646 \u062F\u0631\u062E\u0648\u0627\u0633\u062A \u0628\u0631\u0627\u06CC \u067E\u0627\u0633\u062E\u200C\u062F\u0627\u062F\u0646 \u0628\u0627\u0632 \u0646\u06CC\u0633\u062A.", e.locale);
    await startSession(env.DB, e, "ticket_reply", id, nowMs);
    return panel4("\u2709\uFE0F \u067E\u0627\u0633\u062E \u062E\u0648\u062F \u0631\u0627 \u062F\u0631 \u06CC\u06A9 \u067E\u06CC\u0627\u0645 \u0628\u0641\u0631\u0633\u062A\u06CC\u062F.\n\u0645\u0647\u0644\u062A \u067E\u0627\u0633\u062E\u200C\u06AF\u0648\u06CC\u06CC: \u06F1\u06F0 \u062F\u0642\u06CC\u0642\u0647.\n\u0628\u0631\u0627\u06CC \u0644\u063A\u0648\u060C /cancel \u0631\u0627 \u0628\u0641\u0631\u0633\u062A\u06CC\u062F.", e.locale);
  }
  if (key.startsWith("customer:ticket:")) return thread(env, e, key.slice("customer:ticket:".length), true);
  return null;
}
__name(customerTicketAction, "customerTicketAction");
async function adminPanelAction(env, e, nowMs = Date.now()) {
  const key = e.key ?? "";
  if (!key.startsWith("admin:customers") && !key.startsWith("admin:customer:") && !key.startsWith("admin:staff") && !["admin:plan:new", "admin:plan:back", "admin:plan:cancel", "admin:plan:save"].includes(key))
    return null;
  if (!idAdmin(env, e.actorId)) return adminPanel("\u26D4 \u062F\u0633\u062A\u0631\u0633\u06CC \u0628\u0647 \u0627\u06CC\u0646 \u0628\u062E\u0634 \u0645\u062C\u0627\u0632 \u0646\u06CC\u0633\u062A.", [], e.locale);
  const db = env.DB;
  if (["admin:plan:new", "admin:plan:back", "admin:plan:cancel", "admin:plan:save"].includes(key))
    return planWizardAction(db, e, nowMs);
  if (key === "admin:customers" || /^admin:customers:[0-9]{1,4}$/.test(key)) {
    const page = key === "admin:customers" ? 0 : Math.min(1e3, Number(key.slice("admin:customers:".length)));
    const rows = (await db.prepare(
      "SELECT telegram_id,state,locale,created_at FROM customers ORDER BY created_at DESC,telegram_id DESC LIMIT 7 OFFSET ?"
    ).bind(page * 6).all()).results ?? [];
    const shown = rows.slice(0, 6);
    const suspended = await count2(db, "SELECT COUNT(*) AS n FROM customers WHERE state='suspended'");
    const controls = shown.map((x) => button2("\u{1F464} " + x.telegram_id + " \xB7 " + faStatus(x.state), "admin:customer:" + x.telegram_id));
    const pages3 = [];
    if (page > 0) pages3.push({ text: "\u25C0\uFE0F \u0642\u0628\u0644\u06CC", callback_data: "v2:admin:customers:" + (page - 1) });
    if (rows.length > 6) pages3.push({ text: "\u0628\u0639\u062F\u06CC \u25B6\uFE0F", callback_data: "v2:admin:customers:" + (page + 1) });
    if (pages3.length) controls.push(pages3);
    return adminPanel(
      "\u{1F465}  \u0645\u062F\u06CC\u0631\u06CC\u062A \u0645\u0634\u062A\u0631\u06CC\u0627\u0646\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n\u0635\u0641\u062D\u0647 " + faNumber(page + 1) + "  |  \u062D\u0633\u0627\u0628\u200C\u0647\u0627\u06CC \u062A\u0639\u0644\u06CC\u0642\u200C\u0634\u062F\u0647: " + faNumber(suspended) + "\n\u0628\u0631\u0627\u06CC \u0645\u0634\u0627\u0647\u062F\u0647 \u062C\u0632\u0626\u06CC\u0627\u062A\u060C \u06CC\u06A9 \u0645\u0634\u062A\u0631\u06CC \u0631\u0627 \u0627\u0646\u062A\u062E\u0627\u0628 \u06A9\u0646\u06CC\u062F.\n\n" + (shown.map((x) => statusSymbol(x.state) + " " + x.telegram_id + "  \xB7  " + faStatus(x.state)).join("\n") || "\u062F\u0631 \u0627\u06CC\u0646 \u0635\u0641\u062D\u0647 \u0645\u0634\u062A\u0631\u06CC\u200C\u0627\u06CC \u0648\u062C\u0648\u062F \u0646\u062F\u0627\u0631\u062F."),
      controls,
      e.locale
    );
  }
  if (key.startsWith("admin:customer:")) {
    const tail = key.slice("admin:customer:".length);
    const confirmed = tail.startsWith("confirm:");
    const target = confirmed ? tail.slice("confirm:".length) : tail;
    const action2 = target.startsWith("suspend:") ? "suspend" : target.startsWith("activate:") ? "activate" : null;
    const id = action2 ? target.slice(action2.length + 1) : target;
    if (!NAT2.test(id)) return adminPanel("\u26A0\uFE0F \u0634\u0646\u0627\u0633\u0647 \u0645\u0634\u062A\u0631\u06CC \u0645\u0639\u062A\u0628\u0631 \u0646\u06CC\u0633\u062A.", [], e.locale);
    const row = await db.prepare("SELECT telegram_id,state,locale,seller_telegram_id FROM customers WHERE telegram_id=?").bind(id).first();
    if (!row) return adminPanel("\u0645\u0634\u062A\u0631\u06CC \u0645\u0648\u0631\u062F\u0646\u0638\u0631 \u067E\u06CC\u062F\u0627 \u0646\u0634\u062F.", [], e.locale);
    if (action2) {
      if (idAdmin(env, id)) return adminPanel("\u26D4 \u0648\u0636\u0639\u06CC\u062A \u062D\u0633\u0627\u0628 \u0645\u062F\u06CC\u0631 \u0627\u0632 \u0627\u06CC\u0646 \u0628\u062E\u0634 \u0642\u0627\u0628\u0644 \u062A\u063A\u06CC\u06CC\u0631 \u0646\u06CC\u0633\u062A.", [], e.locale);
      if (!confirmed) return adminPanel(
        "\u26A0\uFE0F  \u062A\u0623\u06CC\u06CC\u062F \u062A\u063A\u06CC\u06CC\u0631 \u0648\u0636\u0639\u06CC\u062A \u0645\u0634\u062A\u0631\u06CC\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n\u0622\u06CC\u0627 \u0627\u0632 " + (action2 === "suspend" ? "\u062A\u0639\u0644\u06CC\u0642" : "\u0641\u0639\u0627\u0644\u200C\u0633\u0627\u0632\u06CC") + " \u062D\u0633\u0627\u0628 " + id + " \u0645\u0637\u0645\u0626\u0646 \u0647\u0633\u062A\u06CC\u062F\u061F",
        [
          button2("\u2705 \u0628\u0644\u0647\u060C \u062A\u0623\u06CC\u06CC\u062F \u0645\u06CC\u200C\u06A9\u0646\u0645", "admin:customer:confirm:" + action2 + ":" + id),
          button2("\u21A9\uFE0F \u0627\u0646\u0635\u0631\u0627\u0641", "admin:customer:" + id)
        ],
        e.locale
      );
      const state = action2 === "suspend" ? "suspended" : "active";
      await db.batch([
        db.prepare("UPDATE customers SET state=? WHERE telegram_id=? AND state<>?").bind(state, id, state),
        db.prepare("INSERT OR IGNORE INTO audit_events(event_id,actor_id,object_type,object_id,verb) VALUES(?,?,?,?,?)").bind("customer:state:" + e.updateId, e.actorId, "customer", id, "state:" + state)
      ]);
      return adminPanel(
        "\u2705 \u0648\u0636\u0639\u06CC\u062A \u0645\u0634\u062A\u0631\u06CC \u0628\u0647\u200C\u0631\u0648\u0632\u0631\u0633\u0627\u0646\u06CC \u0634\u062F.\n\u0634\u0646\u0627\u0633\u0647: " + id + "\n\u0648\u0636\u0639\u06CC\u062A \u062C\u062F\u06CC\u062F: " + faStatus(state),
        [button2("\u{1F464} \u0645\u0634\u0627\u0647\u062F\u0647 \u0645\u0634\u062A\u0631\u06CC", "admin:customer:" + id)],
        e.locale
      );
    }
    const [orders, subs, tickets] = await Promise.all([
      count2(db, "SELECT COUNT(*) AS n FROM orders WHERE customer_telegram_id=?", id),
      count2(db, "SELECT COUNT(*) AS n FROM subscriptions WHERE owner_telegram_id=?", id),
      count2(db, "SELECT COUNT(*) AS n FROM support_tickets WHERE customer_telegram_id=?", id)
    ]);
    const buttons = [];
    if (idAdmin(env, id)) buttons.push(button2("\u{1F512} \u062D\u0633\u0627\u0628 \u0645\u062F\u06CC\u0631", "admin:customers"));
    else if (row.state === "active") buttons.push(button2("\u26D4 \u062A\u0639\u0644\u06CC\u0642 \u0645\u0634\u062A\u0631\u06CC", "admin:customer:suspend:" + id));
    else buttons.push(button2("\u2705 \u0641\u0639\u0627\u0644\u200C\u0633\u0627\u0632\u06CC \u0645\u0634\u062A\u0631\u06CC", "admin:customer:activate:" + id));
    buttons.push(button2("\u{1F465} \u0628\u0627\u0632\u06AF\u0634\u062A \u0628\u0647 \u0641\u0647\u0631\u0633\u062A \u0645\u0634\u062A\u0631\u06CC\u0627\u0646", "admin:customers"));
    return adminPanel(
      "\u{1F464}  \u067E\u0631\u0648\u0646\u062F\u0647 \u0645\u0634\u062A\u0631\u06CC\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n\u0634\u0646\u0627\u0633\u0647 \u062A\u0644\u06AF\u0631\u0627\u0645: " + id + "\n\u0648\u0636\u0639\u06CC\u062A \u062D\u0633\u0627\u0628: " + faStatus(row.state) + "\n\u0633\u0641\u0627\u0631\u0634\u200C\u0647\u0627: " + faNumber(orders) + "  |  \u0627\u0634\u062A\u0631\u0627\u06A9\u200C\u0647\u0627: " + faNumber(subs) + "  |  \u062F\u0631\u062E\u0648\u0627\u0633\u062A\u200C\u0647\u0627: " + faNumber(tickets) + (row.seller_telegram_id ? "\n\u0634\u0646\u0627\u0633\u0647 \u0641\u0631\u0648\u0634\u0646\u062F\u0647: " + row.seller_telegram_id : ""),
      buttons,
      e.locale
    );
  }
  if (key === "admin:staff") {
    if (Number.isSafeInteger(e.messageId) && e.messageId > 0)
      await db.prepare("DELETE FROM v2_bot_input_sessions WHERE telegram_id=? AND mode IN ('grant_seller','grant_support','revoke_seller','revoke_support')").bind(e.actorId).run();
    const rows = (await db.prepare(
      "SELECT sr.telegram_id,sr.role FROM staff_roles sr JOIN customers c ON c.telegram_id=sr.telegram_id WHERE sr.role IN ('seller','support') ORDER BY sr.role,sr.telegram_id LIMIT 25"
    ).all()).results ?? [];
    return adminPanel(
      "\u{1F9D1}\u200D\u{1F4BC}  \u062F\u0633\u062A\u0631\u0633\u06CC \u0647\u0645\u06A9\u0627\u0631\u0627\u0646\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n\u0646\u0642\u0634 \u0647\u0631 \u0647\u0645\u06A9\u0627\u0631 \u0631\u0627 \u0627\u0632 \u0641\u0647\u0631\u0633\u062A \u0632\u06CC\u0631 \u0628\u0631\u0631\u0633\u06CC \u0648 \u0645\u062F\u06CC\u0631\u06CC\u062A \u06A9\u0646\u06CC\u062F.\n\n" + (rows.map((x) => "\u2022 " + faRole(x.role) + "  |  " + x.telegram_id).join("\n") || "\u0647\u0646\u0648\u0632 \u0647\u0645\u06A9\u0627\u0631 \u06CC\u0627 \u0641\u0631\u0648\u0634\u0646\u062F\u0647\u200C\u0627\u06CC \u062B\u0628\u062A \u0646\u0634\u062F\u0647 \u0627\u0633\u062A."),
      [
        button2("\u2795 \u0627\u0641\u0632\u0648\u062F\u0646 \u0641\u0631\u0648\u0634\u0646\u062F\u0647", "admin:staff:grant:seller"),
        button2("\u2795 \u0627\u0641\u0632\u0648\u062F\u0646 \u067E\u0634\u062A\u06CC\u0628\u0627\u0646", "admin:staff:grant:support"),
        button2("\u{1F6AB} \u062D\u0630\u0641 \u062F\u0633\u062A\u0631\u0633\u06CC \u0641\u0631\u0648\u0634\u0646\u062F\u0647", "admin:staff:revoke:seller"),
        button2("\u{1F6AB} \u062D\u0630\u0641 \u062F\u0633\u062A\u0631\u0633\u06CC \u067E\u0634\u062A\u06CC\u0628\u0627\u0646", "admin:staff:revoke:support")
      ],
      e.locale
    );
  }
  const m = key.match(/^admin:staff:(grant|revoke):(seller|support)$/);
  if (m) {
    await startSession(db, e, m[1] + "_" + m[2], null, nowMs);
    return adminPanel(
      "\u{1F9D1}\u200D\u{1F4BC}  " + (m[1] === "grant" ? "\u0627\u0641\u0632\u0648\u062F\u0646 \u0647\u0645\u06A9\u0627\u0631" : "\u062D\u0630\u0641 \u062F\u0633\u062A\u0631\u0633\u06CC \u0647\u0645\u06A9\u0627\u0631") + "\n\u0634\u0646\u0627\u0633\u0647 \u0639\u062F\u062F\u06CC \u062A\u0644\u06AF\u0631\u0627\u0645 \u0641\u0631\u062F \u0631\u0627 \u0627\u0631\u0633\u0627\u0644 \u06A9\u0646\u06CC\u062F.\n\u0645\u0647\u0644\u062A \u0627\u0646\u062C\u0627\u0645: \u06F1\u06F0 \u062F\u0642\u06CC\u0642\u0647.\n\u0628\u0631\u0627\u06CC \u0644\u063A\u0648\u060C /cancel \u0631\u0627 \u0628\u0641\u0631\u0633\u062A\u06CC\u062F.",
      [],
      e.locale
    );
  }
  return adminPanel("\u0627\u06CC\u0646 \u06AF\u0632\u06CC\u0646\u0647 \u062F\u0631 \u062F\u0633\u062A\u0631\u0633 \u0646\u06CC\u0633\u062A.", [], e.locale);
}
__name(adminPanelAction, "adminPanelAction");
async function notifySupport(env, e, ticketId, nowMs = Date.now()) {
  const db = env.DB;
  const recipients = new Set((env.ADMIN_TELEGRAM_IDS ?? "").split(",").map((x) => x.trim()).filter((x) => NAT2.test(x) && x !== e.actorId));
  const staff = (await db.prepare(
    "SELECT sr.telegram_id FROM staff_roles sr JOIN customers c ON c.telegram_id=sr.telegram_id WHERE sr.role='support' AND c.state='active' LIMIT 20"
  ).all()).results ?? [];
  for (const s of staff) {
    if (NAT2.test(s.telegram_id) && s.telegram_id !== e.actorId) recipients.add(s.telegram_id);
  }
  for (const id of recipients) await db.prepare(
    "INSERT OR IGNORE INTO telegram_notifications(id,chat_id,body,state,due_ms) VALUES(?,?,?,'pending',?)"
  ).bind(
    "ticket:" + ticketId + ":" + e.updateId + ":" + id,
    id,
    "\u{1F4AC} \u062F\u0631\u062E\u0648\u0627\u0633\u062A \u062A\u0627\u0632\u0647 \u067E\u0634\u062A\u06CC\u0628\u0627\u0646\u06CC\n\u0634\u0646\u0627\u0633\u0647: " + ticketId + "\n\u0628\u0631\u0627\u06CC \u0645\u0634\u0627\u0647\u062F\u0647 \u0648 \u067E\u0627\u0633\u062E\u060C \u0635\u0646\u062F\u0648\u0642 \u067E\u0634\u062A\u06CC\u0628\u0627\u0646\u06CC \u0631\u0627 \u062F\u0631 \u0631\u0628\u0627\u062A \u0628\u0627\u0632 \u06A9\u0646\u06CC\u062F.",
    nowMs
  ).run();
}
__name(notifySupport, "notifySupport");
async function consumePanelInput(env, e, nowMs = Date.now()) {
  const db = env.DB;
  if ((e.key ?? "") === "/cancel") {
    const [removed, direct] = await db.batch([
      db.prepare("DELETE FROM v2_bot_input_sessions WHERE telegram_id=?").bind(e.actorId),
      db.prepare("DELETE FROM admin_direct_drafts WHERE telegram_id=?").bind(e.actorId)
    ]);
    return removed.meta?.changes || direct.meta?.changes ? panel4("\u2705 \u0639\u0645\u0644\u06CC\u0627\u062A \u0644\u063A\u0648 \u0634\u062F.", e.locale) : null;
  }
  const raw = e.inputText;
  if (typeof raw !== "string" || !raw.trim() || raw.startsWith("/") || raw.startsWith("v2:")) return null;
  const session = await db.prepare(
    "SELECT mode,context_id,expires_ms FROM v2_bot_input_sessions WHERE telegram_id=?"
  ).bind(e.actorId).first();
  if (!session) {
    if (!idAdmin(env, e.actorId)) return null;
    const draft = await db.prepare(
      "SELECT context_id,expires_ms FROM admin_direct_drafts WHERE telegram_id=?"
    ).bind(e.actorId).first();
    if (!draft) return null;
    if (draft.expires_ms <= nowMs) {
      await db.prepare("DELETE FROM admin_direct_drafts WHERE telegram_id=?").bind(e.actorId).run();
      return panel4("\u231B \u0645\u0647\u0644\u062A \u0635\u062F\u0648\u0631 \u06A9\u0627\u0646\u0641\u06CC\u06AF \u067E\u0627\u06CC\u0627\u0646 \u06CC\u0627\u0641\u062A\u061B \u0627\u0632 \u0627\u0628\u062A\u062F\u0627 \u0634\u0631\u0648\u0639 \u06A9\u0646\u06CC\u062F.", e.locale);
    }
    return directInput(env, e, draft, nowMs);
  }
  if (session.expires_ms <= nowMs) {
    await db.prepare("DELETE FROM v2_bot_input_sessions WHERE telegram_id=?").bind(e.actorId).run();
    return panel4("\u231B \u0645\u0647\u0644\u062A \u0639\u0645\u0644\u06CC\u0627\u062A \u067E\u0627\u06CC\u0627\u0646 \u06CC\u0627\u0641\u062A. \u062F\u0648\u0628\u0627\u0631\u0647 \u0627\u0632 \u0645\u0646\u0648\u06CC \u0645\u0631\u0628\u0648\u0637 \u0634\u0631\u0648\u0639 \u06A9\u0646\u06CC\u062F.", e.locale);
  }
  if (session.mode === "ticket_reply") {
    if (!TICKET.test(session.context_id ?? "")) return panel4("\u26A0\uFE0F \u0646\u0634\u0633\u062A \u067E\u0627\u0633\u062E\u200C\u06AF\u0648\u06CC\u06CC \u0645\u0639\u062A\u0628\u0631 \u0646\u06CC\u0633\u062A.", e.locale);
    const ticket = await db.prepare(
      "SELECT id FROM support_tickets WHERE id=? AND customer_telegram_id=? AND state IN ('open','waiting')"
    ).bind(session.context_id, e.actorId).first();
    if (!ticket) return panel4("\u0627\u06CC\u0646 \u062F\u0631\u062E\u0648\u0627\u0633\u062A \u062F\u06CC\u06AF\u0631 \u0628\u0631\u0627\u06CC \u067E\u0627\u0633\u062E\u200C\u062F\u0627\u062F\u0646 \u0628\u0627\u0632 \u0646\u06CC\u0633\u062A.", e.locale);
    const message = raw.trim().slice(0, 1e3);
    if (!message) return panel4("\u067E\u06CC\u0627\u0645 \u0646\u0645\u06CC\u200C\u062A\u0648\u0627\u0646\u062F \u062E\u0627\u0644\u06CC \u0628\u0627\u0634\u062F.", e.locale);
    await db.batch([
      db.prepare("INSERT OR IGNORE INTO support_messages(id,ticket_id,sender_telegram_id,body,role) VALUES(?,?,?,?,'customer')").bind("customer-reply:" + e.updateId, ticket.id, e.actorId, message),
      db.prepare("UPDATE support_tickets SET state='open' WHERE id=? AND state='waiting'").bind(ticket.id),
      db.prepare("DELETE FROM v2_bot_input_sessions WHERE telegram_id=?").bind(e.actorId)
    ]);
    await notifySupport(env, e, ticket.id, nowMs);
    return panel4(
      "\u2705 \u067E\u0627\u0633\u062E \u0634\u0645\u0627 \u062F\u0631 \u062F\u0631\u062E\u0648\u0627\u0633\u062A \u067E\u0634\u062A\u06CC\u0628\u0627\u0646\u06CC \u062B\u0628\u062A \u0634\u062F.",
      e.locale,
      [button2("\u{1F4AC} \u0645\u0634\u0627\u0647\u062F\u0647 \u06AF\u0641\u062A\u200C\u0648\u06AF\u0648", "customer:ticket:" + ticket.id)]
    );
  }
  if (!idAdmin(env, e.actorId)) return adminPanel("\u26D4 \u062F\u0633\u062A\u0631\u0633\u06CC \u0628\u0647 \u0627\u06CC\u0646 \u0628\u062E\u0634 \u0645\u062C\u0627\u0632 \u0646\u06CC\u0633\u062A.", [], e.locale);
  if (session.mode === "plan_draft") return planWizardInput(db, e, session, nowMs);
  const match = session.mode.match(/^(grant|revoke)_(seller|support)$/);
  if (match) {
    const id = raw.trim(), mode = match[1], role = match[2];
    if (!NAT2.test(id)) return adminPanel("\u26A0\uFE0F \u0641\u0642\u0637 \u0634\u0646\u0627\u0633\u0647 \u0639\u062F\u062F\u06CC \u0645\u0639\u062A\u0628\u0631 \u062A\u0644\u06AF\u0631\u0627\u0645 \u0631\u0627 \u0648\u0627\u0631\u062F \u06A9\u0646\u06CC\u062F.", [], e.locale);
    if (idAdmin(env, id)) return adminPanel("\u26D4 \u062F\u0633\u062A\u0631\u0633\u06CC \u0645\u062F\u06CC\u0631 \u0627\u0632 \u0627\u06CC\u0646 \u0645\u0633\u06CC\u0631 \u062A\u063A\u06CC\u06CC\u0631 \u0646\u0645\u06CC\u200C\u06A9\u0646\u062F.", [], e.locale);
    if (mode === "grant") {
      await db.batch([
        db.prepare("INSERT OR IGNORE INTO customers(telegram_id) VALUES(?)").bind(id),
        db.prepare("INSERT OR IGNORE INTO staff_roles(telegram_id,role,granted_by) VALUES(?,?,?)").bind(id, role, e.actorId),
        db.prepare("INSERT OR IGNORE INTO audit_events(event_id,actor_id,object_type,object_id,verb) VALUES(?,?,?,?,?)").bind("staff:bot:" + e.updateId, e.actorId, "staff", id, "grant:" + role),
        db.prepare("DELETE FROM v2_bot_input_sessions WHERE telegram_id=?").bind(e.actorId)
      ]);
    } else {
      await db.batch([
        db.prepare("DELETE FROM staff_roles WHERE telegram_id=? AND role=?").bind(id, role),
        db.prepare("INSERT OR IGNORE INTO audit_events(event_id,actor_id,object_type,object_id,verb) VALUES(?,?,?,?,?)").bind("staff:bot:" + e.updateId, e.actorId, "staff", id, "revoke:" + role),
        db.prepare("DELETE FROM v2_bot_input_sessions WHERE telegram_id=?").bind(e.actorId)
      ]);
    }
    return adminPanel(
      "\u2705 \u062F\u0633\u062A\u0631\u0633\u06CC " + faRole(role) + " \u0628\u0631\u0627\u06CC \u0634\u0646\u0627\u0633\u0647 " + id + " " + (mode === "grant" ? "\u0641\u0639\u0627\u0644 \u0634\u062F." : "\u0628\u0631\u062F\u0627\u0634\u062A\u0647 \u0634\u062F."),
      [button2("\u{1F9D1}\u200D\u{1F4BC} \u0628\u0627\u0632\u06AF\u0634\u062A \u0628\u0647 \u0645\u062F\u06CC\u0631\u06CC\u062A \u06A9\u0627\u0631\u06A9\u0646\u0627\u0646", "admin:staff")],
      e.locale
    );
  }
  return null;
}
__name(consumePanelInput, "consumePanelInput");

// src/support-media.mjs
var ID6 = /^[0-9]{1,20}$/;
var mediaId = /* @__PURE__ */ __name((e) => "support-media:" + e.updateId, "mediaId");
var button3 = /* @__PURE__ */ __name((label2, key) => [{ text: label2, callback_data: "v2:" + key }], "button");
var reply3 = /* @__PURE__ */ __name((message, buttons = [], role = "customer") => ({
  text: frameMessage(message),
  replyMarkup: { inline_keyboard: [...buttons, ...sectionNavigation(role)] }
}), "reply");
function admin(env, id) {
  return ID6.test(id ?? "") && typeof env.ADMIN_TELEGRAM_IDS === "string" && env.ADMIN_TELEGRAM_IDS.split(",").map((x) => x.trim()).includes(id);
}
__name(admin, "admin");
async function canSupport(env, e) {
  if (admin(env, e.actorId)) return true;
  const allowed = await env.DB.prepare(
    "SELECT 1 AS ok FROM staff_roles sr JOIN customers c ON c.telegram_id=sr.telegram_id WHERE sr.telegram_id=? AND sr.role='support' AND c.state='active'"
  ).bind(e.actorId).first();
  return allowed?.ok === 1;
}
__name(canSupport, "canSupport");
var caption = /* @__PURE__ */ __name((e) => (typeof e.inputText === "string" ? e.inputText.trim() : "").slice(0, 1e3) || "\u{1F4F7} \u062A\u0635\u0648\u06CC\u0631 \u067E\u06CC\u0648\u0633\u062A", "caption");
async function receiveSupportPhoto(env, e, nowMs = Date.now()) {
  if (typeof e.photoId !== "string" || e.photoId.length < 5 || e.photoId.length > 512) return null;
  const db = env.DB, id = mediaId(e), body3 = caption(e);
  const prior = await db.prepare("SELECT ticket_id,role FROM support_messages WHERE id=? AND telegram_file_id=?").bind(id, e.photoId).first();
  if (prior) {
    if (prior.role === "customer") await notifySupport(env, e, prior.ticket_id, nowMs);
    return reply3("\u2705 \u062A\u0635\u0648\u06CC\u0631 \u0642\u0628\u0644\u0627\u064B \u0628\u0647 \u06AF\u0641\u062A\u200C\u0648\u06AF\u0648\u06CC \u067E\u0634\u062A\u06CC\u0628\u0627\u0646\u06CC \u0627\u0636\u0627\u0641\u0647 \u0634\u062F\u0647 \u0627\u0633\u062A.", [
      button3("\u{1F4AC} \u0645\u0634\u0627\u0647\u062F\u0647 \u06AF\u0641\u062A\u200C\u0648\u06AF\u0648", prior.role === "support" ? "ticket:view:" + prior.ticket_id : "customer:ticket:" + prior.ticket_id)
    ], prior.role === "support" ? "support" : "customer");
  }
  const initial = await db.prepare(
    "SELECT expires_ms FROM customer_sessions WHERE telegram_id=? AND mode='support'"
  ).bind(e.actorId).first();
  if (initial) {
    if (initial.expires_ms <= nowMs) {
      await db.prepare("DELETE FROM customer_sessions WHERE telegram_id=? AND mode='support'").bind(e.actorId).run();
      return reply3("\u231B \u0645\u0647\u0644\u062A \u062B\u0628\u062A \u062F\u0631\u062E\u0648\u0627\u0633\u062A \u062A\u0645\u0627\u0645 \u0634\u062F\u061B \u0627\u0632 \u0628\u062E\u0634 \u067E\u0634\u062A\u06CC\u0628\u0627\u0646\u06CC \u062F\u0648\u0628\u0627\u0631\u0647 \u0634\u0631\u0648\u0639 \u06A9\u0646\u06CC\u062F.");
    }
    const ticketId = "tg-" + e.updateId;
    await db.batch([
      db.prepare("INSERT OR IGNORE INTO support_tickets(id,customer_telegram_id,subject) VALUES(?,?,?)").bind(ticketId, e.actorId, body3 === "\u{1F4F7} \u062A\u0635\u0648\u06CC\u0631 \u067E\u06CC\u0648\u0633\u062A" ? "\u062F\u0631\u062E\u0648\u0627\u0633\u062A \u062A\u0635\u0648\u06CC\u0631\u06CC" : body3.slice(0, 140)),
      db.prepare("INSERT OR IGNORE INTO support_messages(id,ticket_id,sender_telegram_id,body,role,telegram_file_id) VALUES(?,?,?,?,'customer',?)").bind(id, ticketId, e.actorId, body3, e.photoId),
      db.prepare("DELETE FROM customer_sessions WHERE telegram_id=? AND mode='support'").bind(e.actorId)
    ]);
    await notifySupport(env, e, ticketId, nowMs);
    return reply3("\u2705 \u062F\u0631\u062E\u0648\u0627\u0633\u062A \u062A\u0635\u0648\u06CC\u0631\u06CC \u062B\u0628\u062A \u0634\u062F.\n\u06A9\u062F \u067E\u06CC\u06AF\u06CC\u0631\u06CC: " + ticketId, [
      button3("\u{1F4AC} \u0645\u0634\u0627\u0647\u062F\u0647 \u062F\u0631\u062E\u0648\u0627\u0633\u062A", "customer:ticket:" + ticketId)
    ]);
  }
  const customer = await db.prepare(
    "SELECT context_id,expires_ms FROM v2_bot_input_sessions WHERE telegram_id=? AND mode='ticket_reply'"
  ).bind(e.actorId).first();
  if (customer) {
    if (customer.expires_ms <= nowMs) {
      await db.prepare("DELETE FROM v2_bot_input_sessions WHERE telegram_id=? AND mode='ticket_reply'").bind(e.actorId).run();
      return reply3("\u231B \u0645\u0647\u0644\u062A \u067E\u0627\u0633\u062E \u062A\u0635\u0648\u06CC\u0631\u06CC \u062A\u0645\u0627\u0645 \u0634\u062F\u061B \u062F\u0631\u062E\u0648\u0627\u0633\u062A \u0631\u0627 \u062F\u0648\u0628\u0627\u0631\u0647 \u0628\u0627\u0632 \u06A9\u0646\u06CC\u062F.");
    }
    const ticket2 = await db.prepare(
      "SELECT id FROM support_tickets WHERE id=? AND customer_telegram_id=? AND state IN ('open','waiting')"
    ).bind(customer.context_id, e.actorId).first();
    if (!ticket2) return reply3("\u26D4 \u0627\u0645\u06A9\u0627\u0646 \u0627\u0641\u0632\u0648\u062F\u0646 \u062A\u0635\u0648\u06CC\u0631 \u0628\u0647 \u0627\u06CC\u0646 \u06AF\u0641\u062A\u200C\u0648\u06AF\u0648 \u0648\u062C\u0648\u062F \u0646\u062F\u0627\u0631\u062F.");
    await db.batch([
      db.prepare("INSERT OR IGNORE INTO support_messages(id,ticket_id,sender_telegram_id,body,role,telegram_file_id) VALUES(?,?,?,?,'customer',?)").bind(id, ticket2.id, e.actorId, body3, e.photoId),
      db.prepare("UPDATE support_tickets SET state='open' WHERE id=? AND state='waiting'").bind(ticket2.id),
      db.prepare("DELETE FROM v2_bot_input_sessions WHERE telegram_id=? AND mode='ticket_reply'").bind(e.actorId)
    ]);
    await notifySupport(env, e, ticket2.id, nowMs);
    return reply3("\u2705 \u062A\u0635\u0648\u06CC\u0631 \u0628\u0647 \u062F\u0631\u062E\u0648\u0627\u0633\u062A \u067E\u0634\u062A\u06CC\u0628\u0627\u0646\u06CC \u0627\u0636\u0627\u0641\u0647 \u0634\u062F.", [
      button3("\u{1F4AC} \u0645\u0634\u0627\u0647\u062F\u0647 \u06AF\u0641\u062A\u200C\u0648\u06AF\u0648", "customer:ticket:" + ticket2.id)
    ]);
  }
  const agent = await db.prepare(
    "SELECT ticket_id,expires_ms FROM support_staff_sessions WHERE telegram_id=?"
  ).bind(e.actorId).first();
  if (!agent) return null;
  if (agent.expires_ms <= nowMs) {
    await db.prepare("DELETE FROM support_staff_sessions WHERE telegram_id=?").bind(e.actorId).run();
    return reply3("\u231B \u0645\u0647\u0644\u062A \u0627\u0631\u0633\u0627\u0644 \u062A\u0635\u0648\u06CC\u0631 \u067E\u0627\u06CC\u0627\u0646 \u06CC\u0627\u0641\u062A\u0647 \u0627\u0633\u062A.", [], "support");
  }
  if (!await canSupport(env, e)) return reply3("\u26D4 \u062F\u0633\u062A\u0631\u0633\u06CC \u067E\u0634\u062A\u06CC\u0628\u0627\u0646\u06CC \u0646\u062F\u0627\u0631\u06CC\u062F.", [], "support");
  const ticket = await db.prepare(
    "SELECT id,customer_telegram_id FROM support_tickets WHERE id=? AND state IN ('open','waiting')"
  ).bind(agent.ticket_id).first();
  if (!ticket) return reply3("\u26D4 \u062F\u0631\u062E\u0648\u0627\u0633\u062A \u0628\u0633\u062A\u0647 \u0634\u062F\u0647 \u06CC\u0627 \u062F\u0631 \u062F\u0633\u062A\u0631\u0633 \u0646\u06CC\u0633\u062A.", [], "support");
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO support_messages(id,ticket_id,sender_telegram_id,body,role,telegram_file_id) VALUES(?,?,?,?,'support',?)").bind(id, ticket.id, e.actorId, body3, e.photoId),
    db.prepare("UPDATE support_tickets SET state='waiting' WHERE id=? AND state='open'").bind(ticket.id),
    db.prepare("DELETE FROM support_staff_sessions WHERE telegram_id=?").bind(e.actorId),
    db.prepare("INSERT OR IGNORE INTO telegram_notifications(id,chat_id,body,state,due_ms) VALUES(?,?,?,'pending',?)").bind(
      "support:photo:" + e.updateId,
      ticket.customer_telegram_id,
      "\u{1F4F7} \u06CC\u06A9 \u062A\u0635\u0648\u06CC\u0631 \u062C\u062F\u06CC\u062F \u0627\u0632 \u067E\u0634\u062A\u06CC\u0628\u0627\u0646\u06CC \u062F\u0631 \u062F\u0631\u062E\u0648\u0627\u0633\u062A " + ticket.id + " \u062B\u0628\u062A \u0634\u062F.\n\u0628\u0631\u0627\u06CC \u062F\u06CC\u062F\u0646 \u0622\u0646\u060C \u06AF\u0641\u062A\u200C\u0648\u06AF\u0648 \u0631\u0627 \u062F\u0631 \u0631\u0628\u0627\u062A \u0628\u0627\u0632 \u06A9\u0646\u06CC\u062F.",
      nowMs
    ),
    db.prepare("INSERT OR IGNORE INTO audit_events(event_id,actor_id,object_type,object_id,verb) VALUES(?,?,?,?,?)").bind("support:photo:" + e.updateId, e.actorId, "support_ticket", ticket.id, "reply:media")
  ]);
  return reply3("\u2705 \u062A\u0635\u0648\u06CC\u0631 \u062F\u0631 \u06AF\u0641\u062A\u200C\u0648\u06AF\u0648 \u062B\u0628\u062A \u0648 \u0628\u0647 \u0645\u0634\u062A\u0631\u06CC \u0627\u0637\u0644\u0627\u0639 \u062F\u0627\u062F\u0647 \u0634\u062F.", [
    button3("\u{1F4AC} \u0645\u0634\u0627\u0647\u062F\u0647 \u062F\u0631\u062E\u0648\u0627\u0633\u062A", "ticket:view:" + ticket.id)
  ], "support");
}
__name(receiveSupportPhoto, "receiveSupportPhoto");
async function viewSupportPhoto(env, e, updateId, ownerOnly = true) {
  if (!ID6.test(updateId ?? "")) return reply3("\u26A0\uFE0F \u062A\u0635\u0648\u06CC\u0631 \u062F\u0631\u062E\u0648\u0627\u0633\u062A\u06CC \u0645\u0639\u062A\u0628\u0631 \u0646\u06CC\u0633\u062A.");
  if (!ownerOnly && !await canSupport(env, e)) return reply3("\u26D4 \u062F\u0633\u062A\u0631\u0633\u06CC \u067E\u0634\u062A\u06CC\u0628\u0627\u0646\u06CC \u0646\u062F\u0627\u0631\u06CC\u062F.");
  const row = await env.DB.prepare(
    "SELECT m.body,m.telegram_file_id,m.ticket_id,t.customer_telegram_id FROM support_messages m JOIN support_tickets t ON t.id=m.ticket_id WHERE m.id=? AND m.telegram_file_id IS NOT NULL " + (ownerOnly ? "AND t.customer_telegram_id=?" : "")
  ).bind(...ownerOnly ? ["support-media:" + updateId, e.actorId] : ["support-media:" + updateId]).first();
  if (!row) return reply3("\u26A0\uFE0F \u062A\u0635\u0648\u06CC\u0631 \u06CC\u0627\u0641\u062A \u0646\u0634\u062F \u06CC\u0627 \u0627\u062C\u0627\u0632\u0647 \u0645\u0634\u0627\u0647\u062F\u0647 \u0622\u0646 \u0631\u0627 \u0646\u062F\u0627\u0631\u06CC\u062F.");
  const parent = (ownerOnly ? "customer:ticket:" : "ticket:view:") + row.ticket_id;
  return {
    text: frameMessage("\u{1F5BC} \u062A\u0635\u0648\u06CC\u0631 \u067E\u0634\u062A\u06CC\u0628\u0627\u0646\u06CC\n\u06A9\u062F \u067E\u06CC\u06AF\u06CC\u0631\u06CC: " + row.ticket_id + "\n" + row.body.slice(0, 500)),
    photoId: row.telegram_file_id,
    replyMarkup: { inline_keyboard: [button3("\u21A9\uFE0F \u0628\u0627\u0632\u06AF\u0634\u062A \u0628\u0647 \u06AF\u0641\u062A\u200C\u0648\u06AF\u0648", parent)] }
  };
}
__name(viewSupportPhoto, "viewSupportPhoto");

// src/admin-e2e.mjs
var REF2 = /^[a-f0-9]{24}$/;
var TEST_PLAN = "v2-admin-e2e-100mb-1day";
var QUOTA = 100 * 1024 * 1024;
var btn = /* @__PURE__ */ __name((label2, key) => [{ text: label2, callback_data: "v2:admin:configs:e2e:" + key }], "btn");
var view = /* @__PURE__ */ __name((message, buttons = []) => ({ text: frameMessage(message), replyMarkup: { inline_keyboard: [
  ...buttons,
  [{ text: "\u21A9\uFE0F \u0635\u062F\u0648\u0631 \u06A9\u0627\u0646\u0641\u06CC\u06AF", callback_data: "v2:admin:configs" }]
] } }), "view");
function enabled3(env) {
  return env.ADMIN_E2E_TEST_ENABLED === "true";
}
__name(enabled3, "enabled");
var admin2 = /* @__PURE__ */ __name((env, actor) => typeof actor === "string" && /^[0-9]{5,20}$/.test(actor) && typeof env.ADMIN_TELEGRAM_IDS === "string" && env.ADMIN_TELEGRAM_IDS.split(",").includes(actor), "admin");
async function ownerNode(env, actor, ref) {
  if (!enabled3(env) || !admin2(env, actor) || !REF2.test(ref ?? "") || !env.DB) return null;
  const node = await nodeFromRef(env.DB, ref);
  if (!node) return null;
  const job = await env.DB.prepare(
    "SELECT state,owner_id FROM node_bootstrap_jobs WHERE node_id=?"
  ).bind(node.id).first();
  if (!job || job.state !== "installed" || job.owner_id !== actor) return null;
  return node;
}
__name(ownerNode, "ownerNode");
function orderId2(ref) {
  return "e2e-" + ref;
}
__name(orderId2, "orderId");
async function testState(db, ref, actor) {
  return db.prepare(
    "SELECT o.id AS order_id,o.state AS order_state,o.plan_id,o.quoted_amount,s.id AS subscription_id,s.state AS subscription_state,s.expires_at,s.max_bytes,s.used_bytes,a.state AS allocation_state,nc.observed_ms AS client_ack FROM orders o LEFT JOIN subscriptions s ON s.order_id=o.id LEFT JOIN node_allocations a ON a.subscription_id=s.id LEFT JOIN node_client_acks nc ON nc.subscription_id=s.id AND nc.node_id=a.node_id WHERE o.id=? AND o.customer_telegram_id=? AND o.plan_id=? AND o.quoted_amount=0 LIMIT 1"
  ).bind(orderId2(ref), actor, TEST_PLAN).first();
}
__name(testState, "testState");
async function listE2e(env, actor, nowMs = Date.now()) {
  if (!enabled3(env) || !admin2(env, actor)) return view("\u26D4 \u0622\u0632\u0645\u0648\u0646 \u0635\u062F\u0648\u0631 \u0627\u062E\u062A\u0635\u0627\u0635\u06CC \u062F\u0631 \u0627\u06CC\u0646 \u0645\u062D\u06CC\u0637 \u0641\u0639\u0627\u0644 \u0646\u06CC\u0633\u062A.");
  const rows = (await env.DB.prepare(
    "SELECT n.id FROM nodes n JOIN node_bootstrap_jobs j ON j.node_id=n.id JOIN node_health h ON h.node_id=n.id AND h.revision=n.desired_revision WHERE j.owner_id=? AND j.state='installed' AND n.lifecycle='ready' AND n.desired_revision=n.acked_revision AND h.xray_healthy=1 AND h.stats_healthy=1 AND h.observed_ms BETWEEN ? AND ? ORDER BY n.id LIMIT 12"
  ).bind(actor, nowMs - 6e5, nowMs).all()).results ?? [];
  const buttons = [];
  for (const r of rows) buttons.push(btn("\u{1F9EA} " + r.id, "view:" + await nodeUiRef(r.id)));
  return view(panelHeading("\u{1F9EA}", "\u0622\u0632\u0645\u0648\u0646 \u0648\u0627\u0642\u0639\u06CC \u0635\u062F\u0648\u0631", "\u0628\u062F\u0648\u0646 \u067E\u0631\u062F\u0627\u062E\u062A \u0648 \u0628\u062F\u0648\u0646 \u0641\u0639\u0627\u0644\u200C\u0633\u0627\u0632\u06CC \u0641\u0631\u0648\u0634") + "\n\n\u{1F4E6} \u062D\u062C\u0645: \u06F1\u06F0\u06F0 \u0645\u06AF\u0627\u0628\u0627\u06CC\u062A \xB7 \u0645\u062F\u062A: \u06F1 \u0631\u0648\u0632 \xB7 \u0642\u06CC\u0645\u062A: \u0635\u0641\u0631\n\u{1F510} \u0635\u0631\u0641\u0627\u064B \u0628\u0631\u0627\u06CC \u062D\u0633\u0627\u0628 \u0645\u062F\u06CC\u0631 \u0648 \u0633\u0631\u0648\u0631\u06CC \u06A9\u0647 \u062E\u0648\u062F\u0634 \u062B\u0628\u062A \u06A9\u0631\u062F\u0647 \u0627\u0633\u062A.\n\n" + (buttons.length ? "\u06CC\u06A9 \u0633\u0631\u0648\u0631 \u0622\u0645\u0627\u062F\u0647 \u0631\u0627 \u0627\u0646\u062A\u062E\u0627\u0628 \u06A9\u0646\u06CC\u062F." : "\u0633\u0631\u0648\u0631 \u0622\u0645\u0627\u062F\u0647\u200C\u0627\u06CC \u0628\u0627 \u0633\u0644\u0627\u0645\u062A \u062A\u0627\u0632\u0647 \u0648\u062C\u0648\u062F \u0646\u062F\u0627\u0631\u062F."), buttons);
}
__name(listE2e, "listE2e");
async function e2eAction(env, actor, action2, ref, nowMs = Date.now()) {
  const node = await ownerNode(env, actor, ref);
  if (!node) return view("\u26D4 \u0633\u0631\u0648\u0631 \u0622\u0645\u0627\u062F\u0647\u060C \u0645\u0627\u0644\u06A9\u06CC\u062A \u0645\u062F\u06CC\u0631 \u06CC\u0627 \u0642\u0627\u0628\u0644\u06CC\u062A \u062A\u0633\u062A \u0645\u0639\u062A\u0628\u0631 \u0646\u06CC\u0633\u062A.");
  const db = env.DB;
  const state = await testState(db, ref, actor);
  if (["view", "start", "link"].includes(action2) && (node.lifecycle !== "ready" || node.desired_revision !== node.acked_revision))
    return view("\u23F8 \u0633\u0631\u0648\u0631 \u0627\u06A9\u0646\u0648\u0646 \u0622\u0645\u0627\u062F\u0647 \u0646\u06CC\u0633\u062A\u061B \u062A\u0633\u062A \u062C\u062F\u06CC\u062F \u06CC\u0627 \u0635\u062F\u0648\u0631 \u0644\u06CC\u0646\u06A9 \u0645\u062C\u0627\u0632 \u0646\u06CC\u0633\u062A. \u0644\u063A\u0648 \u062A\u0633\u062A \u0642\u0628\u0644\u06CC \u0647\u0645\u0686\u0646\u0627\u0646 \u0645\u0645\u06A9\u0646 \u0627\u0633\u062A.", [
      btn("\u{1F504} \u0645\u0634\u0627\u0647\u062F\u0647 \u0648\u0636\u0639\u06CC\u062A", "status:" + ref)
    ]);
  if (action2 === "view") {
    if (state) return e2eAction(env, actor, "status", ref, nowMs);
    return view(panelHeading("\u{1F9EA}", "\u062A\u0633\u062A \u0635\u062F\u0648\u0631 \u0648\u0627\u0642\u0639\u06CC", node.id) + "\n\n\u0628\u0631\u0627\u06CC \u0622\u0632\u0645\u0648\u0646 \u0646\u0635\u0628 \u06CC\u06A9 UUID \u0648\u0627\u0642\u0639\u06CC \u0631\u0648\u06CC \u0647\u0631 \u062F\u0648 \u062F\u0631\u06AF\u0627\u0647 REALITY\u060C \u06CC\u06A9 \u0627\u0634\u062A\u0631\u0627\u06A9 \u0622\u0632\u0645\u0627\u06CC\u0634\u06CC \u0631\u0627\u06CC\u06AF\u0627\u0646 \u0628\u0627 \u0638\u0631\u0641\u06CC\u062A \u06F1\u06F0\u06F0 \u0645\u06AF\u0627\u0628\u0627\u06CC\u062A \u0648 \u0645\u062F\u062A \u06F1 \u0631\u0648\u0632 \u0627\u06CC\u062C\u0627\u062F \u0645\u06CC\u200C\u0634\u0648\u062F.\n\n\u0641\u0631\u0648\u0634 \u0639\u0645\u0648\u0645\u06CC \u0647\u0645\u0686\u0646\u0627\u0646 \u0628\u0633\u062A\u0647 \u0627\u0633\u062A. \u0627\u06CC\u0646 \u0639\u0645\u0644\u06CC\u0627\u062A Xray \u0631\u0627 \u0627\u0632 \u0637\u0631\u06CC\u0642 \u0639\u0627\u0645\u0644 \u0627\u0645\u0636\u0627\u0634\u062F\u0647 \u062A\u063A\u06CC\u06CC\u0631 \u0645\u06CC\u200C\u062F\u0647\u062F.\n\n\u0641\u0642\u0637 \u0627\u06AF\u0631 \u0627\u06CC\u0646 \u0633\u0631\u0648\u0631 \u0622\u0632\u0645\u0627\u06CC\u0634\u06CC \u0645\u062A\u0639\u0644\u0642 \u0628\u0647 \u062E\u0648\u062F\u062A\u0627\u0646 \u0627\u0633\u062A \u062A\u0623\u06CC\u06CC\u062F \u06A9\u0646\u06CC\u062F.", [
      btn("\u2705 \u0633\u0627\u062E\u062A \u0627\u0634\u062A\u0631\u0627\u06A9 \u0622\u0632\u0645\u0627\u06CC\u0634\u06CC \u0648\u0627\u0642\u0639\u06CC", "start:" + ref),
      btn("\u21A9\uFE0F \u0633\u0631\u0648\u0631\u0647\u0627\u06CC \u0622\u0645\u0627\u062F\u0647", "list")
    ]);
  }
  if (action2 === "start") {
    if (!state) {
      const changes = await db.batch([
        db.prepare(
          "INSERT OR IGNORE INTO plans(id,title_fa,title_en,price_amount,price_currency,quota_bytes,duration_days,active) VALUES(?,'\u062A\u0633\u062A \u062F\u0627\u062E\u0644\u06CC \u0645\u062F\u0627\u0631','Madar Internal Test',0,'IRT',?,1,0)"
        ).bind(TEST_PLAN, QUOTA),
        db.prepare(
          "INSERT OR IGNORE INTO orders(id,customer_telegram_id,plan_id,idempotency_key,quoted_amount,quoted_currency,state) SELECT ?,?,?,?,0,'IRT','approved' FROM plans p JOIN customers c ON c.telegram_id=? WHERE p.id=? AND p.price_amount=0 AND p.active=0 AND p.quota_bytes=? AND p.duration_days=1 AND c.state='active'"
        ).bind(orderId2(ref), actor, TEST_PLAN, "admin-e2e:" + ref, actor, TEST_PLAN, QUOTA)
      ]);
      if (Number(changes[1]?.meta?.changes) !== 1 && !await testState(db, ref, actor))
        return view("\u26D4 \u0627\u0645\u06A9\u0627\u0646 \u0627\u06CC\u062C\u0627\u062F \u062A\u0633\u062A \u0631\u0627\u06CC\u06AF\u0627\u0646 \u0648\u062C\u0648\u062F \u0646\u062F\u0627\u0631\u062F. \u0648\u0636\u0639\u06CC\u062A \u0645\u062F\u06CC\u0631 \u0648 \u0637\u0631\u062D \u0622\u0632\u0645\u0627\u06CC\u0634\u06CC \u0631\u0627 \u0628\u0631\u0631\u0633\u06CC \u06A9\u0646\u06CC\u062F.");
    }
    const current = await testState(db, ref, actor);
    if (!current) return view("\u26D4 \u0633\u0641\u0627\u0631\u0634 \u0622\u0632\u0645\u0627\u06CC\u0634\u06CC \u0645\u0639\u062A\u0628\u0631 \u0646\u06CC\u0633\u062A.");
    if (current.order_state === "approved" && !current.subscription_id) {
      const result = await reserveApprovedOrder(env, current.order_id, nowMs, node.id);
      if (result.status !== "reserved")
        return view("\u23F8 \u062F\u0631\u062E\u0648\u0627\u0633\u062A \u0630\u062E\u06CC\u0631\u0647 \u0634\u062F\u060C \u0627\u0645\u0627 \u0635\u062F\u0648\u0631 \u0647\u0646\u0648\u0632 \u0627\u0646\u062C\u0627\u0645 \u0646\u0634\u062F\u0647 \u0627\u0633\u062A. \u0639\u0644\u062A: " + result.status + "\n\u067E\u0633 \u0627\u0632 \u0628\u0647\u0628\u0648\u062F \u0633\u0644\u0627\u0645\u062A \u0633\u0631\u0648\u0631\u060C \u062F\u0648\u0628\u0627\u0631\u0647 \u0647\u0645\u06CC\u0646 \u0622\u0632\u0645\u0648\u0646 \u0631\u0627 \u0627\u0646\u062A\u062E\u0627\u0628 \u06A9\u0646\u06CC\u062F.", [
          btn("\u{1F504} \u062A\u0644\u0627\u0634 \u0645\u062C\u062F\u062F", "start:" + ref)
        ]);
    }
    return e2eAction(env, actor, "status", ref, nowMs);
  }
  if (!state) return view("\u23F3 \u0647\u0646\u0648\u0632 \u0622\u0632\u0645\u0648\u0646 \u0648\u0627\u0642\u0639\u06CC \u0628\u0631\u0627\u06CC \u0627\u06CC\u0646 \u0633\u0631\u0648\u0631 \u062B\u0628\u062A \u0646\u0634\u062F\u0647 \u0627\u0633\u062A.", [
    btn("\u{1F9EA} \u0627\u06CC\u062C\u0627\u062F \u0622\u0632\u0645\u0648\u0646", "view:" + ref)
  ]);
  if (action2 === "end") return view(panelHeading("\u26A0\uFE0F", "\u0644\u063A\u0648 \u0627\u0634\u062A\u0631\u0627\u06A9 \u0622\u0632\u0645\u0627\u06CC\u0634\u06CC", node.id) + "\n\n\u0627\u06CC\u0646 \u0627\u0642\u062F\u0627\u0645 \u0627\u0634\u062A\u0631\u0627\u06A9 \u062A\u0633\u062A \u0631\u0627 \u0644\u063A\u0648 \u0648 \u0647\u0645\u0647 \u0644\u06CC\u0646\u06A9\u200C\u0647\u0627\u06CC\u0634 \u0631\u0627 \u0628\u0627\u0637\u0644 \u0645\u06CC\u200C\u06A9\u0646\u062F.\n\u0639\u0627\u0645\u0644 \u0633\u0631\u0648\u0631 \u062F\u0631 \u0686\u0631\u062E\u0647\u0654 \u0628\u0639\u062F\u06CC \u0628\u0627\u06CC\u062F UUID \u0631\u0627 \u0627\u0632 Xray \u062D\u0630\u0641 \u0648 \u062D\u0630\u0641 \u0622\u0646 \u0631\u0627 \u062A\u0623\u06CC\u06CC\u062F \u06A9\u0646\u062F.", [
    btn("\u2705 \u0644\u063A\u0648 \u0642\u0637\u0639\u06CC \u062A\u0633\u062A", "revoke:" + ref),
    btn("\u21A9\uFE0F \u0627\u0646\u0635\u0631\u0627\u0641", "status:" + ref)
  ]);
  if (action2 === "revoke") {
    if (state.subscription_id) {
      await db.batch([
        db.prepare("UPDATE subscriptions SET state='revoked' WHERE id=? AND owner_telegram_id=? AND state IN ('active','pending')").bind(state.subscription_id, actor),
        db.prepare("UPDATE subscription_tokens SET revoked=1 WHERE subscription_id=?").bind(state.subscription_id)
      ]);
    } else if (state.order_state === "approved") {
      await db.prepare("UPDATE orders SET state='cancelled' WHERE id=? AND state='approved'").bind(state.order_id).run();
    }
    return view("\u2705 \u0644\u063A\u0648 \u0622\u0632\u0645\u0627\u06CC\u0634 \u062B\u0628\u062A \u0634\u062F. \u0644\u06CC\u0646\u06A9\u200C\u0647\u0627 \u0628\u0627\u0637\u0644 \u0634\u062F\u0646\u062F\u061B \u062A\u0623\u06CC\u06CC\u062F \u062D\u0630\u0641 UUID \u0628\u0627\u06CC\u062F \u0627\u0632 \u0639\u0627\u0645\u0644 \u0633\u0631\u0648\u0631 \u062F\u0631\u06CC\u0627\u0641\u062A \u0634\u0648\u062F.", [
      btn("\u{1F504} \u0648\u0636\u0639\u06CC\u062A \u0644\u063A\u0648", "status:" + ref)
    ]);
  }
  if (action2 === "link") {
    if (state.subscription_state !== "active" || !state.subscription_id || state.allocation_state !== "active")
      return view("\u23F3 UUID \u0647\u0646\u0648\u0632 \u0631\u0648\u06CC \u0646\u0648\u062F \u0646\u0635\u0628 \u0648 \u062A\u0648\u0633\u0637 \u0639\u0627\u0645\u0644 \u062A\u0623\u06CC\u06CC\u062F \u0646\u0634\u062F\u0647 \u0627\u0633\u062A.", [
        btn("\u{1F504} \u0628\u0631\u0631\u0633\u06CC \u062F\u0648\u0628\u0627\u0631\u0647", "status:" + ref)
      ]);
    const routes = await activeRoutes(db, state.subscription_id, nowMs);
    if (!carrierPair(routes.map((r) => ({ id: r.route_id, transport: r.transport, operator_hint: r.operator_hint, host: r.host, port: r.port }))))
      return view("\u23F3 \u062F\u0648 \u0645\u0633\u06CC\u0631 \u062A\u0623\u06CC\u06CC\u062F\u0634\u062F\u0647 \u0628\u0631\u0627\u06CC \u0627\u06CC\u0646 UUID \u0647\u0646\u0648\u0632 \u0622\u0645\u0627\u062F\u0647 \u0646\u06CC\u0633\u062A\u0646\u062F.", [
        btn("\u{1F504} \u0628\u0631\u0631\u0633\u06CC \u062F\u0648\u0628\u0627\u0631\u0647", "status:" + ref)
      ]);
    const link = await issueCarrierLink(env, state.subscription_id, nowMs);
    return view(link ? "\u2705 \u0644\u06CC\u0646\u06A9 \u062E\u0635\u0648\u0635\u06CC \u0622\u0632\u0645\u0627\u06CC\u0634\u06CC\u060C \u0641\u0642\u0637 \u0628\u0631\u0627\u06CC \u0645\u062F\u06CC\u0631:\n" + link.url + "\n\n\u0634\u0627\u0645\u0644 \u062F\u0648 \u0645\u0633\u06CC\u0631 \u0647\u0645\u0631\u0627\u0647 \u0627\u0648\u0644 (\u06F4\u06F4\u06F3) \u0648 \u0627\u06CC\u0631\u0627\u0646\u0633\u0644 (\u06F8\u06F4\u06F4\u06F3) \u0628\u0627 \u06CC\u06A9 \u0633\u0642\u0641 \u0645\u0635\u0631\u0641 \u0645\u0634\u062A\u0631\u06A9." : "\u23F3 \u0645\u0633\u06CC\u0631 \u0648\u0627\u0642\u0639\u06CC \u0622\u0645\u0627\u062F\u0647 \u0627\u0633\u062A \u0648\u0644\u06CC \u0633\u0631\u0648\u06CC\u0633 \u0644\u06CC\u0646\u06A9 \u0647\u0646\u0648\u0632 \u063A\u06CC\u0631\u0641\u0639\u0627\u0644 \u06CC\u0627 \u0646\u0627\u0645\u0639\u062A\u0628\u0631 \u0627\u0633\u062A.", [
      btn("\u{1F504} \u0648\u0636\u0639\u06CC\u062A", "status:" + ref)
    ]);
  }
  if (action2 !== "status") return view("\u26A0\uFE0F \u0639\u0645\u0644\u06CC\u0627\u062A \u0622\u0632\u0645\u0648\u0646 \u0645\u0639\u062A\u0628\u0631 \u0646\u06CC\u0633\u062A.");
  const ack2 = Number(state.client_ack ?? 0) > nowMs - 6e5;
  const active = state.subscription_state === "active" && state.allocation_state === "active" && ack2;
  const text = panelHeading("\u{1F9EA}", "\u0648\u0636\u0639\u06CC\u062A \u062A\u0633\u062A \u0648\u0627\u0642\u0639\u06CC", node.id) + "\n\n\u0633\u0641\u0627\u0631\u0634: " + (state.order_state ?? "\u0646\u0627\u0645\u0634\u062E\u0635") + "\n\u0627\u0634\u062A\u0631\u0627\u06A9: " + (state.subscription_state ?? "\u062F\u0631 \u0627\u0646\u062A\u0638\u0627\u0631 \u0631\u0632\u0631\u0648") + "\n\u0646\u0635\u0628 UUID \u0627\u062E\u062A\u0635\u0627\u0635\u06CC: " + (ack2 ? "\u2705 ACK \u0648\u0627\u0642\u0639\u06CC \u062F\u0631\u06CC\u0627\u0641\u062A \u0634\u062F" : "\u23F3 \u0647\u0646\u0648\u0632 ACK \u062A\u0627\u0632\u0647 \u062F\u0631\u06CC\u0627\u0641\u062A \u0646\u0634\u062F\u0647") + "\n\u062D\u062C\u0645 \u0627\u0633\u062A\u0641\u0627\u062F\u0647\u200C\u0634\u062F\u0647: " + faNumber(state.used_bytes ?? 0) + " \u0627\u0632 " + faNumber(QUOTA) + " \u0628\u0627\u06CC\u062A\n\n" + (active ? "\u2705 UUID \u0646\u0635\u0628 \u0648 \u062A\u0623\u06CC\u06CC\u062F \u0634\u062F\u0647\u061B \u0645\u06CC\u200C\u062A\u0648\u0627\u0646\u06CC\u062F \u0644\u06CC\u0646\u06A9 \u062E\u0635\u0648\u0635\u06CC \u0628\u06AF\u06CC\u0631\u06CC\u062F." : state.subscription_state === "revoked" ? "\u26D4 \u062A\u0633\u062A \u0644\u063A\u0648 \u0634\u062F\u0647\u061B \u0645\u0646\u062A\u0638\u0631 \u062A\u0623\u06CC\u06CC\u062F \u062D\u0630\u0641 \u0627\u0632 \u0646\u0648\u062F." : "\u23F3 \u0639\u0627\u0645\u0644 \u0645\u062F\u06CC\u0631\u06CC\u062A \u0628\u0627\u06CC\u062F \u06A9\u0627\u0646\u0641\u06CC\u06AF \u062C\u062F\u06CC\u062F \u0631\u0627 \u0648\u0627\u0642\u0639\u0627\u064B \u0631\u0648\u06CC Xray \u0627\u0639\u0645\u0627\u0644 \u06A9\u0646\u062F.");
  const buttons = [
    ...active ? [btn("\u{1F517} \u062F\u0631\u06CC\u0627\u0641\u062A \u0644\u06CC\u0646\u06A9 \u062F\u0648 \u0627\u067E\u0631\u0627\u062A\u0648\u0631", "link:" + ref)] : [],
    ...state.subscription_state !== "revoked" && state.order_state !== "cancelled" ? [btn("\u{1F6D1} \u067E\u0627\u06CC\u0627\u0646 \u0648 \u0644\u063A\u0648 \u062A\u0633\u062A", "end:" + ref)] : [],
    btn("\u{1F504} \u062A\u0627\u0632\u0647\u200C\u0633\u0627\u0632\u06CC", "status:" + ref)
  ];
  return view(text, buttons);
}
__name(e2eAction, "e2eAction");

// src/bot-config.mjs
var HEX2 = /^[a-f0-9]{24}$/;
var PAGE = 6;
var btn2 = /* @__PURE__ */ __name((label2, key) => [{ text: label2, callback_data: "v2:admin:configs:" + key }], "btn");
var view2 = /* @__PURE__ */ __name((text, buttons = []) => ({
  text: frameMessage(text),
  replyMarkup: { inline_keyboard: [
    ...buttons,
    [{ text: "\u21A9\uFE0F \u067E\u06CC\u0634\u062E\u0648\u0627\u0646 \u0645\u062F\u06CC\u0631\u06CC\u062A", callback_data: "v2:admin:home" }]
  ] }
}), "view");
async function refFor(value) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(bytes.slice(0, 12), (b) => b.toString(16).padStart(2, "0")).join("");
}
__name(refFor, "refFor");
async function subscriptionByRef(db, ref) {
  if (!HEX2.test(ref ?? "")) return null;
  const rows = (await db.prepare(
    "SELECT id FROM subscriptions ORDER BY id LIMIT 5001"
  ).all()).results ?? [];
  if (rows.length > 5e3) return null;
  let id = null;
  for (const row of rows)
    if (await refFor(row.id) === ref) {
      if (id !== null) return null;
      id = row.id;
    }
  return id;
}
__name(subscriptionByRef, "subscriptionByRef");
function pages2(type, page, count3) {
  const controls = [];
  if (page > 0) controls.push({ text: "\u25C0\uFE0F \u0642\u0628\u0644\u06CC", callback_data: "v2:admin:configs:" + type + ":" + (page - 1) });
  if ((page + 1) * PAGE < count3) controls.push({ text: "\u0628\u0639\u062F\u06CC \u25B6\uFE0F", callback_data: "v2:admin:configs:" + type + ":" + (page + 1) });
  return controls.length ? [controls] : [];
}
__name(pages2, "pages");
var instructions = "\u{1F510} \u0644\u06CC\u0646\u06A9 \u0627\u062A\u0635\u0627\u0644 \u062E\u0635\u0648\u0635\u06CC \u0627\u0633\u062A \u0648 \u0646\u0628\u0627\u06CC\u062F \u062F\u0631 \u06AF\u0631\u0648\u0647 \u0639\u0645\u0648\u0645\u06CC \u0645\u0646\u062A\u0634\u0631 \u0634\u0648\u062F. \u062F\u0648 \u0645\u0633\u06CC\u0631 \u0647\u0645\u0631\u0627\u0647 \u0627\u0648\u0644 \u0648 \u0627\u06CC\u0631\u0627\u0646\u0633\u0644 \u0627\u0632 \u06CC\u06A9 \u0633\u0647\u0645\u06CC\u0647 \u0627\u0633\u062A\u0641\u0627\u062F\u0647 \u0645\u06CC\u200C\u06A9\u0646\u0646\u062F.";
async function configHome(env, nowMs) {
  const db = env.DB;
  const [installed, sub] = await Promise.all([
    db.prepare("SELECT COUNT(*) n FROM node_bootstrap_jobs j JOIN nodes n ON n.id=j.node_id WHERE j.state='installed' AND n.lifecycle NOT IN ('retired','quarantined')").first(),
    db.prepare("SELECT COUNT(*) n FROM subscriptions s JOIN customers c ON c.telegram_id=s.owner_telegram_id WHERE s.state='active' AND c.state='active' AND s.expires_at>? AND s.max_bytes>s.used_bytes").bind(nowMs).first()
  ]);
  const real = enabled(env, "SUBSCRIPTION_API_ENABLED") && enabled(env, "SUBSCRIPTION_LINKS_ENABLED");
  return view2(panelHeading("\u{1F517}", "\u0635\u062F\u0648\u0631 \u06A9\u0627\u0646\u0641\u06CC\u06AF \u0645\u062F\u0627\u0631", "\u06CC\u06A9 \u0644\u06CC\u0646\u06A9 \u0627\u0634\u062A\u0631\u0627\u06A9 \u0628\u0627 \u062F\u0648 \u0645\u0633\u06CC\u0631 \u0627\u067E\u0631\u0627\u062A\u0648\u0631") + "\n\n\u{1F9EA} \u0633\u0631\u0648\u0631 \u0646\u0635\u0628\u200C\u0634\u062F\u0647 \u0628\u0631\u0627\u06CC \u0628\u0631\u0631\u0633\u06CC: " + faNumber(installed?.n ?? 0) + "\n\u{1F464} \u0627\u0634\u062A\u0631\u0627\u06A9 \u062F\u0627\u0631\u0627\u06CC \u0627\u0639\u062A\u0628\u0627\u0631: " + faNumber(sub?.n ?? 0) + "\n\u{1F512} \u0635\u062F\u0648\u0631 \u06A9\u0627\u0646\u0641\u06CC\u06AF \u0648\u0627\u0642\u0639\u06CC: " + (real ? "\u062F\u0631 \u0635\u0648\u0631\u062A \u062A\u0623\u06CC\u06CC\u062F \u0645\u0633\u06CC\u0631\u0647\u0627" : "\u063A\u06CC\u0631\u0641\u0639\u0627\u0644 \u062A\u0627 \u062A\u0623\u06CC\u06CC\u062F \u0633\u0631\u0648\u06CC\u0633") + "\n\n\u0628\u0631\u0627\u06CC \u06A9\u0627\u0646\u0641\u06CC\u06AF \u0622\u0632\u0645\u0627\u06CC\u0634\u06CC \u0633\u0631\u0648\u0631\u060C \u0645\u0633\u06CC\u0631 \u0627\u0648\u0644 \u0631\u0627 \u0627\u0646\u062A\u062E\u0627\u0628 \u06A9\u0646\u06CC\u062F. \u0644\u06CC\u0646\u06A9 \u0645\u0634\u062A\u0631\u06CC \u0641\u0642\u0637 \u0628\u0631\u0627\u06CC \u0627\u0634\u062A\u0631\u0627\u06A9 \u0641\u0639\u0627\u0644 \u0628\u0627 \u0645\u0633\u06CC\u0631\u0647\u0627\u06CC \u0645\u0633\u062A\u0642\u0644 \u062A\u0623\u06CC\u06CC\u062F\u0634\u062F\u0647 \u0635\u0627\u062F\u0631 \u0645\u06CC\u200C\u0634\u0648\u062F.", [
    ...env.ADMIN_DIRECT_ISSUE_ENABLED === "true" ? [btn2("\u2795 \u0635\u062F\u0648\u0631 \u06A9\u0627\u0646\u0641\u06CC\u06AF \u062C\u062F\u06CC\u062F", "direct:new"), btn2("\u{1F4CB} \u06A9\u0627\u0646\u0641\u06CC\u06AF\u200C\u0647\u0627\u06CC \u0635\u0627\u062F\u0631\u0634\u062F\u0647", "direct:list")] : [],
    btn2("\u{1F9EA} \u0635\u062F\u0648\u0631 \u0644\u06CC\u0646\u06A9 \u062A\u0633\u062A \u0633\u0631\u0648\u0631", "trials:0"),
    ...enabled3(env) ? [btn2("\u{1F52C} \u062A\u0633\u062A \u0635\u062F\u0648\u0631 \u0648\u0627\u0642\u0639\u06CC UUID \xB7 \u0648\u06CC\u0698\u0647 \u0645\u062F\u06CC\u0631", "e2e:list")] : [],
    btn2("\u{1F517} \u0635\u062F\u0648\u0631 \u0644\u06CC\u0646\u06A9 \u0627\u0634\u062A\u0631\u0627\u06A9 \u0641\u0639\u0627\u0644", "subscriptions:0")
  ]);
}
__name(configHome, "configHome");
async function trialList(env, e, page) {
  page = Number.isSafeInteger(page) && page >= 0 && page <= 1e3 ? page : 0;
  const owner = e.actorId, db = env.DB;
  const total = Number((await db.prepare(
    "SELECT COUNT(*) n FROM node_bootstrap_jobs j JOIN nodes n ON n.id=j.node_id WHERE j.owner_id=? AND j.state='installed' AND n.lifecycle NOT IN ('retired','quarantined')"
  ).bind(owner).first())?.n ?? 0);
  const max = Math.max(0, Math.ceil(total / PAGE) - 1);
  page = Math.min(page, max);
  const nodes = (await db.prepare(
    "SELECT j.node_id,n.provider,n.region,n.lifecycle FROM node_bootstrap_jobs j JOIN nodes n ON n.id=j.node_id WHERE j.owner_id=? AND j.state='installed' AND n.lifecycle NOT IN ('retired','quarantined') ORDER BY j.created_ms DESC LIMIT 6 OFFSET ?"
  ).bind(owner, page * PAGE).all()).results ?? [];
  const buttons = [];
  for (const n of nodes) buttons.push(btn2(
    "\u{1F9EA} " + shortCode(n.node_id, 26) + " \xB7 " + faStatus(n.lifecycle),
    "trial:" + await nodeUiRef(n.node_id)
  ));
  return view2(panelHeading("\u{1F9EA}", "\u06A9\u0627\u0646\u0641\u06CC\u06AF \u0622\u0632\u0645\u0627\u06CC\u0634\u06CC", "\u0641\u0642\u0637 \u0633\u0631\u0648\u0631\u0647\u0627\u06CC \u0646\u0635\u0628\u200C\u0634\u062F\u0647 \u062E\u0648\u062F \u0645\u062F\u06CC\u0631") + "\n\n\u0635\u0641\u062D\u0647 " + faNumber(page + 1) + " \u0627\u0632 " + faNumber(max + 1) + "\n" + (nodes.length ? "\u06CC\u06A9 \u0633\u0631\u0648\u0631 \u0631\u0627 \u0627\u0646\u062A\u062E\u0627\u0628 \u06A9\u0646\u06CC\u062F." : "\u0633\u0631\u0648\u0631 \u0646\u0635\u0628\u200C\u0634\u062F\u0647\u200C\u0627\u06CC \u0628\u0631\u0627\u06CC \u0635\u062F\u0648\u0631 \u062A\u0633\u062A \u0648\u062C\u0648\u062F \u0646\u062F\u0627\u0631\u062F.") + "\n\n\u0644\u06CC\u0646\u06A9 \u0622\u0632\u0645\u0627\u06CC\u0634\u06CC \u06CC\u06A9\u200C\u0633\u0627\u0639\u062A\u0647 \u0627\u0633\u062A \u0648 \u0645\u062C\u0648\u0632 \u0641\u0631\u0648\u0634 \u0645\u062D\u0633\u0648\u0628 \u0646\u0645\u06CC\u200C\u0634\u0648\u062F.", [
    ...buttons,
    ...pages2("trials", page, total),
    btn2("\u21A9\uFE0F \u0628\u0627\u0632\u06AF\u0634\u062A \u0628\u0647 \u0635\u062F\u0648\u0631 \u06A9\u0627\u0646\u0641\u06CC\u06AF", "home")
  ]);
}
__name(trialList, "trialList");
async function subscriptionList(env, nowMs, page) {
  page = Number.isSafeInteger(page) && page >= 0 && page <= 1e3 ? page : 0;
  const db = env.DB;
  const where = "s.state='active' AND c.state='active' AND s.expires_at>? AND s.max_bytes>s.used_bytes";
  const count3 = Number((await db.prepare(
    "SELECT COUNT(*) n FROM subscriptions s JOIN customers c ON c.telegram_id=s.owner_telegram_id WHERE " + where
  ).bind(nowMs).first())?.n ?? 0);
  const max = Math.max(0, Math.ceil(count3 / PAGE) - 1);
  page = Math.min(page, max);
  const rows = (await db.prepare(
    "SELECT s.id,s.owner_telegram_id FROM subscriptions s JOIN customers c ON c.telegram_id=s.owner_telegram_id WHERE " + where + " ORDER BY s.expires_at DESC,s.id LIMIT 6 OFFSET ?"
  ).bind(nowMs, page * PAGE).all()).results ?? [];
  const controls = [];
  for (const row of rows) controls.push(btn2(
    "\u{1F464} " + shortCode(row.owner_telegram_id, 14) + " \xB7 " + shortCode(row.id, 19),
    "subscription:" + await refFor(row.id)
  ));
  return view2(panelHeading("\u{1F517}", "\u0627\u0634\u062A\u0631\u0627\u06A9\u200C\u0647\u0627\u06CC \u0641\u0639\u0627\u0644", "\u0628\u0631\u0627\u06CC \u0635\u062F\u0648\u0631 \u06CC\u06A9 \u0644\u06CC\u0646\u06A9 \u062E\u0635\u0648\u0635\u06CC\u060C \u0627\u0634\u062A\u0631\u0627\u06A9 \u0631\u0627 \u0627\u0646\u062A\u062E\u0627\u0628 \u06A9\u0646\u06CC\u062F") + "\n\n\u0635\u0641\u062D\u0647 " + faNumber(page + 1) + " \u0627\u0632 " + faNumber(max + 1) + "\n" + (rows.length ? "\u0644\u06CC\u0646\u06A9 \u0641\u0642\u0637 \u067E\u0633 \u0627\u0632 \u062A\u0623\u06CC\u06CC\u062F \u062F\u0648 \u0645\u0633\u06CC\u0631 \u0648 \u0633\u0647\u0645\u06CC\u0647 \u0635\u0627\u062F\u0631 \u0645\u06CC\u200C\u0634\u0648\u062F." : "\u0627\u0634\u062A\u0631\u0627\u06A9 \u0641\u0639\u0627\u0644 \u0648 \u0645\u0639\u062A\u0628\u0631 \u0628\u0631\u0627\u06CC \u0635\u062F\u0648\u0631 \u0648\u062C\u0648\u062F \u0646\u062F\u0627\u0631\u062F."), [
    ...controls,
    ...pages2("subscriptions", page, count3),
    btn2("\u21A9\uFE0F \u0628\u0627\u0632\u06AF\u0634\u062A \u0628\u0647 \u0635\u062F\u0648\u0631 \u06A9\u0627\u0646\u0641\u06CC\u06AF", "home")
  ]);
}
__name(subscriptionList, "subscriptionList");
async function trialIssue(env, e, ref, nowMs) {
  if (!HEX2.test(ref ?? "")) return view2("\u26A0\uFE0F \u0634\u0646\u0627\u0633\u0647 \u0633\u0631\u0648\u0631 \u0645\u0639\u062A\u0628\u0631 \u0646\u06CC\u0633\u062A.");
  const node = await nodeFromRef(env.DB, ref);
  if (!node) return view2("\u26A0\uFE0F \u0633\u0631\u0648\u0631 \u0645\u0648\u0631\u062F\u0646\u0638\u0631 \u067E\u06CC\u062F\u0627 \u0646\u0634\u062F.");
  const [job, credential, variants] = await Promise.all([
    env.DB.prepare("SELECT state,owner_id FROM node_bootstrap_jobs WHERE node_id=?").bind(node.id).first(),
    env.DB.prepare("SELECT node_id FROM node_trial_credentials WHERE node_id=?").bind(node.id).first(),
    env.DB.prepare("SELECT operator,host,port FROM route_carrier_variants WHERE route_id=?").bind(node.id + "_reality").all()
  ]);
  const rs = variants.results ?? [];
  const two = rs.length === 2 && new Set(rs.map((x) => x.operator)).size === 2 && rs.some((x) => x.operator === "mci") && rs.some((x) => x.operator === "irancell") && rs.every((x) => Number.isInteger(x.port) && x.port >= 1 && x.port <= 65535) && rs[0].host === rs[1].host && rs[0].port !== rs[1].port;
  if (!job || job.state !== "installed" || job.owner_id !== e.actorId || !credential || !two || ["quarantined", "retired"].includes(node.lifecycle))
    return view2("\u26D4 \u0627\u0645\u06A9\u0627\u0646 \u0635\u062F\u0648\u0631 \u062A\u0633\u062A \u0648\u062C\u0648\u062F \u0646\u062F\u0627\u0631\u062F.\n\u0646\u0635\u0628 \u06A9\u0627\u0645\u0644\u060C \u0645\u0627\u0644\u06A9\u06CC\u062A \u0645\u062F\u06CC\u0631 \u0648 \u062F\u0648 \u0645\u0633\u06CC\u0631 \u0645\u062C\u0632\u0627\u06CC \u0647\u0645\u0631\u0627\u0647 \u0627\u0648\u0644 \u0648 \u0627\u06CC\u0631\u0627\u0646\u0633\u0644 \u0628\u0627\u06CC\u062F \u0645\u0648\u062C\u0648\u062F \u0628\u0627\u0634\u0646\u062F.", [
      btn2("\u{1F9EA} \u0628\u0627\u0632\u06AF\u0634\u062A \u0628\u0647 \u0633\u0631\u0648\u0631\u0647\u0627", "trials:0")
    ]);
  const url = await issueTrialLink(env, e.actorId, node.id, nowMs);
  return view2(url ? "\u2705 \u0644\u06CC\u0646\u06A9 \u062A\u0633\u062A \u06CC\u06A9\u200C\u0633\u0627\u0639\u062A\u0647 \u0633\u0631\u0648\u0631 " + node.id + "\n\n" + url + "\n\n\u06CC\u06A9 \u0644\u06CC\u0646\u06A9 \u0634\u0627\u0645\u0644 \u0645\u0633\u06CC\u0631 \u0647\u0645\u0631\u0627\u0647 \u0627\u0648\u0644 \u0648 \u0627\u06CC\u0631\u0627\u0646\u0633\u0644 \u0627\u0633\u062A.\n" + instructions : "\u23F8 \u0644\u06CC\u0646\u06A9 \u062A\u0633\u062A \u0635\u0627\u062F\u0631 \u0646\u0634\u062F. \u062A\u0646\u0638\u06CC\u0645\u0627\u062A \u0631\u0645\u0632\u0646\u06AF\u0627\u0631\u06CC \u0648 \u0646\u0634\u0627\u0646\u06CC \u0627\u0634\u062A\u0631\u0627\u06A9 \u0631\u0627 \u0628\u0631\u0631\u0633\u06CC \u06A9\u0646\u06CC\u062F.", [
    btn2("\u{1F9EA} \u0633\u0631\u0648\u0631\u0647\u0627\u06CC \u0622\u0632\u0645\u0627\u06CC\u0634\u06CC", "trials:0")
  ]);
}
__name(trialIssue, "trialIssue");
async function subscriptionAction(env, ref, nowMs, issue) {
  const db = env.DB, id = await subscriptionByRef(db, ref);
  if (!id) return view2("\u26A0\uFE0F \u0627\u0634\u062A\u0631\u0627\u06A9 \u067E\u06CC\u062F\u0627 \u0646\u0634\u062F \u06CC\u0627 \u0644\u06CC\u0646\u06A9 \u0627\u0646\u062A\u062E\u0627\u0628 \u0622\u0646 \u0645\u0646\u0642\u0636\u06CC \u0634\u062F\u0647 \u0627\u0633\u062A.");
  const row = await db.prepare(
    "SELECT s.id,s.owner_telegram_id,s.state,s.expires_at,s.max_bytes,s.used_bytes,c.state owner_state FROM subscriptions s JOIN customers c ON c.telegram_id=s.owner_telegram_id WHERE s.id=?"
  ).bind(id).first();
  if (!row || row.state !== "active" || row.owner_state !== "active" || row.expires_at <= nowMs || row.max_bytes <= 0 || row.used_bytes >= row.max_bytes)
    return view2("\u26D4 \u0627\u0634\u062A\u0631\u0627\u06A9 \u0641\u0639\u0627\u0644 \u0648 \u062F\u0627\u0631\u0627\u06CC \u0633\u0647\u0645\u06CC\u0647 \u0646\u06CC\u0633\u062A\u061B \u0644\u06CC\u0646\u06A9\u06CC \u0635\u0627\u062F\u0631 \u0646\u0634\u062F.");
  if (!issue) return view2(panelHeading("\u{1F517}", "\u062A\u0623\u06CC\u06CC\u062F \u0635\u062F\u0648\u0631 \u06A9\u0627\u0646\u0641\u06CC\u06AF", id) + "\n\n\u{1F464} \u0645\u0634\u062A\u0631\u06CC: " + row.owner_telegram_id + "\n\u{1F4E6} \u0627\u0639\u062A\u0628\u0627\u0631 \u062D\u062C\u0645\u06CC \u0628\u0627\u0642\u06CC\u200C\u0645\u0627\u0646\u062F\u0647: " + faNumber(Math.floor((row.max_bytes - row.used_bytes) / 1073741824)) + " \u06AF\u06CC\u06AF\u0627\u0628\u0627\u06CC\u062A\n\n\u0627\u06CC\u0646 \u062F\u06A9\u0645\u0647 \u0641\u0642\u0637 \u0628\u0631\u0627\u06CC \u0627\u0634\u062A\u0631\u0627\u06A9 \u062A\u0623\u06CC\u06CC\u062F\u0634\u062F\u0647 \u0628\u0627 \u062F\u0648 \u0645\u0633\u06CC\u0631 \u0645\u0633\u062A\u0642\u0644 \u0648 \u0641\u0639\u0627\u0644 \u06A9\u0627\u0631 \u0645\u06CC\u200C\u06A9\u0646\u062F.", [
    btn2("\u2705 \u062A\u0623\u06CC\u06CC\u062F \u0635\u062F\u0648\u0631 \u0644\u06CC\u0646\u06A9", "issue:" + ref),
    btn2("\u21A9\uFE0F \u0627\u0634\u062A\u0631\u0627\u06A9\u200C\u0647\u0627\u06CC \u0641\u0639\u0627\u0644", "subscriptions:0")
  ]);
  const link = await issueCarrierLink(env, id, nowMs);
  return view2(link ? "\u2705 \u0644\u06CC\u0646\u06A9 \u062E\u0635\u0648\u0635\u06CC \u0627\u0634\u062A\u0631\u0627\u06A9 " + id + "\n\n" + link.url + "\n\n" + instructions : "\u26D4 \u06A9\u0627\u0646\u0641\u06CC\u06AF \u0635\u0627\u062F\u0631 \u0646\u0634\u062F. \u0633\u0631\u0648\u06CC\u0633 \u0627\u0634\u062A\u0631\u0627\u06A9 \u0641\u0639\u0627\u0644 \u0646\u06CC\u0633\u062A \u06CC\u0627 \u0647\u0646\u0648\u0632 \u0647\u0631 \u062F\u0648 \u0645\u0633\u06CC\u0631 \u062A\u0623\u06CC\u06CC\u062F\u0634\u062F\u0647\u060C \u0638\u0631\u0641\u06CC\u062A \u0648 \u0627\u0639\u062A\u0628\u0627\u0631 \u0644\u0627\u0632\u0645 \u0631\u0627 \u0646\u062F\u0627\u0631\u0646\u062F.", [
    btn2("\u21A9\uFE0F \u0627\u0634\u062A\u0631\u0627\u06A9\u200C\u0647\u0627\u06CC \u0641\u0639\u0627\u0644", "subscriptions:0")
  ]);
}
__name(subscriptionAction, "subscriptionAction");
async function adminConfigAction(env, e, nowMs = Date.now()) {
  const key = e.key ?? "";
  if (key === "admin:configs" || key === "admin:configs:home") return configHome(env, nowMs);
  if (key.startsWith("admin:configs:direct:")) return directAction(env, e, nowMs);
  if (key === "admin:configs:e2e:list") return listE2e(env, e.actorId, nowMs);
  const e2e = key.match(/^admin:configs:e2e:(view|start|status|link|end|revoke):([a-f0-9]{24})$/);
  if (e2e) return e2eAction(env, e.actorId, e2e[1], e2e[2], nowMs);
  const list = key.match(/^admin:configs:(trials|subscriptions):([0-9]{1,4})$/);
  if (list) return list[1] === "trials" ? trialList(env, e, Number(list[2])) : subscriptionList(env, nowMs, Number(list[2]));
  const trial = key.match(/^admin:configs:trial:([a-f0-9]{24})$/);
  if (trial) return trialIssue(env, e, trial[1], nowMs);
  const sub = key.match(/^admin:configs:(subscription|issue):([a-f0-9]{24})$/);
  if (sub) return subscriptionAction(env, sub[2], nowMs, sub[1] === "issue");
  return view2("\u26A0\uFE0F \u062F\u0631\u062E\u0648\u0627\u0633\u062A \u0635\u062F\u0648\u0631 \u06A9\u0627\u0646\u0641\u06CC\u06AF \u0645\u0639\u062A\u0628\u0631 \u0646\u06CC\u0633\u062A.");
}
__name(adminConfigAction, "adminConfigAction");

// src/node-wizard.mjs
var prompt = panelHeading("\u{1F5A5}", "\u0627\u0641\u0632\u0648\u062F\u0646 \u062E\u0648\u062F\u06A9\u0627\u0631 \u0633\u0631\u0648\u0631", "\u0631\u0627\u0647\u200C\u0627\u0646\u062F\u0627\u0632\u06CC \u0627\u0645\u0646 \u0627\u0632 \u062F\u0627\u062E\u0644 \u067E\u0646\u0644 \u0645\u062F\u06CC\u0631\u06CC\u062A") + "\n\n\u0627\u0637\u0644\u0627\u0639\u0627\u062A \u0632\u06CC\u0631 \u0631\u0627 \u0628\u0647 \u0647\u0645\u06CC\u0646 \u062A\u0631\u062A\u06CC\u0628 \u0648 \u0628\u0627 \u0639\u0644\u0627\u0645\u062A | \u0627\u0632 \u0647\u0645 \u062C\u062F\u0627 \u06A9\u0646\u06CC\u062F:\n\u0634\u0646\u0627\u0633\u0647 \u0641\u0646\u06CC | \u0627\u0631\u0627\u0626\u0647\u200C\u062F\u0647\u0646\u062F\u0647 | \u0645\u0646\u0637\u0642\u0647 | \u0633\u0642\u0641 \u06A9\u0627\u0631\u0628\u0631 | \u0638\u0631\u0641\u06CC\u062A \u06AF\u06CC\u06AF\u0627\u0628\u0627\u06CC\u062A | \u0646\u0634\u0627\u0646\u06CC IP\n\n\u0646\u0645\u0648\u0646\u0647 \u0633\u0631\u0648\u0631 \u0622\u0632\u0645\u0627\u06CC\u0634\u06CC:\ntest-aria01 | arianet | eu | 20 | 500 | 86.54.42.66\n\n\u067E\u0633 \u0627\u0632 \u062B\u0628\u062A\u060C \u062F\u0631\u062E\u0648\u0627\u0633\u062A \u0646\u0635\u0628 \u0628\u0647 \u0627\u062C\u0631\u0627\u06A9\u0646\u0646\u062F\u0647 \u0627\u0645\u0646 \u0627\u0631\u0633\u0627\u0644 \u0645\u06CC\u200C\u0634\u0648\u062F.\n\u{1F510} \u0631\u0645\u0632 SSH\u060C \u0631\u0645\u0632 \u0639\u0628\u0648\u0631 \u06CC\u0627 \u06A9\u0644\u06CC\u062F \u062E\u0635\u0648\u0635\u06CC \u0631\u0627 \u062F\u0631 \u062A\u0644\u06AF\u0631\u0627\u0645 \u0627\u0631\u0633\u0627\u0644 \u0646\u06A9\u0646\u06CC\u062F.\n\u0628\u0631\u0627\u06CC \u0644\u063A\u0648\u060C \u062F\u06A9\u0645\u0647 \xAB\u0627\u0646\u0635\u0631\u0627\u0641\xBB \u0631\u0627 \u0628\u0632\u0646\u06CC\u062F.";
function newNodePrompt() {
  return { text: frameMessage(prompt), replyMarkup: { inline_keyboard: [
    [{ text: "\u274C \u0627\u0646\u0635\u0631\u0627\u0641", callback_data: "v2:admin:node:cancel" }],
    [{ text: "\u21A9\uFE0F \u0645\u062F\u06CC\u0631\u06CC\u062A \u0633\u0631\u0648\u0631\u0647\u0627", callback_data: "v2:admin:nodes" }]
  ] } };
}
__name(newNodePrompt, "newNodePrompt");
async function beginNodeWizard(db, actor, nowMs, env = null) {
  if (env?.RUNNER_ENROLLMENT_ENABLED === "true") return {
    text: frameMessage(panelHeading("\u{1F5A5}", "\u0627\u0641\u0632\u0648\u062F\u0646 \u0627\u0645\u0646 \u0633\u0631\u0648\u0631", "\u0641\u0631\u0627\u06CC\u0646\u062F \u0646\u0635\u0628 \u062E\u0648\u062F\u06A9\u0627\u0631 \u0648 \u06A9\u0646\u062A\u0631\u0644\u200C\u0634\u062F\u0647") + "\n\n\u0641\u0631\u0645 \u0627\u0645\u0646 \u0631\u0627 \u0628\u0627\u0632 \u06A9\u0646\u06CC\u062F\u061B \u0628\u0631\u0631\u0633\u06CC \u0627\u062A\u0635\u0627\u0644 \u0648 \u0646\u0635\u0628 \u062A\u0648\u0633\u0637 \u0627\u062C\u0631\u0627\u06A9\u0646\u0646\u062F\u0647 \u0627\u0646\u062C\u0627\u0645 \u0645\u06CC\u200C\u0634\u0648\u062F.\n\u{1F510} \u0631\u0645\u0632 \u0639\u0628\u0648\u0631 \u06CC\u0627 \u06A9\u0644\u06CC\u062F \u062E\u0635\u0648\u0635\u06CC \u0631\u0627 \u062F\u0631 \u067E\u06CC\u0627\u0645 \u062A\u0644\u06AF\u0631\u0627\u0645 \u0627\u0631\u0633\u0627\u0644 \u0646\u06A9\u0646\u06CC\u062F."),
    replyMarkup: { inline_keyboard: [
      [{ text: "\u{1F512} \u0628\u0627\u0632 \u06A9\u0631\u062F\u0646 \u0641\u0631\u0645 \u0627\u0645\u0646 \u0627\u0641\u0632\u0648\u062F\u0646 \u0633\u0631\u0648\u0631", web_app: { url: "https://madar-v2-staging.alirezaanari117.workers.dev/enroll" } }],
      [{ text: "\u21A9\uFE0F \u0645\u062F\u06CC\u0631\u06CC\u062A \u0633\u0631\u0648\u0631\u0647\u0627", callback_data: "v2:admin:nodes" }]
    ] }
  };
  await db.prepare(
    "INSERT INTO admin_node_sessions(telegram_id,mode,expires_ms) VALUES(?,'add',?) ON CONFLICT(telegram_id) DO UPDATE SET mode='add',expires_ms=excluded.expires_ms"
  ).bind(actor, nowMs + 10 * 60 * 1e3).run();
  return newNodePrompt();
}
__name(beginNodeWizard, "beginNodeWizard");
async function cancelNodeWizard(db, actor) {
  await db.prepare("DELETE FROM admin_node_sessions WHERE telegram_id=?").bind(actor).run();
  return { text: frameMessage("\u2705 \u0641\u0631\u0627\u06CC\u0646\u062F \u0627\u0641\u0632\u0648\u062F\u0646 \u0633\u0631\u0648\u0631 \u0644\u063A\u0648 \u0634\u062F."), replyMarkup: { inline_keyboard: [[{ text: "\u21A9\uFE0F \u0645\u062F\u06CC\u0631\u06CC\u062A \u0633\u0631\u0648\u0631\u0647\u0627", callback_data: "v2:admin:nodes" }]] } };
}
__name(cancelNodeWizard, "cancelNodeWizard");
async function consumeNodeWizard(db, actor, input, nowMs, env = null) {
  if (typeof input !== "string" || !input.trim() || input.startsWith("/") || input.startsWith("v2:")) return null;
  const session = await db.prepare(
    "SELECT mode,expires_ms FROM admin_node_sessions WHERE telegram_id=?"
  ).bind(actor).first();
  if (!session || session.mode !== "add") return null;
  if (session.expires_ms < nowMs) {
    await db.prepare("DELETE FROM admin_node_sessions WHERE telegram_id=?").bind(actor).run();
    return { text: frameMessage("\u231B \u0645\u0647\u0644\u062A \u062B\u0628\u062A \u0633\u0631\u0648\u0631 \u0628\u0647 \u067E\u0627\u06CC\u0627\u0646 \u0631\u0633\u06CC\u062F. \u0627\u0632 \u067E\u0646\u0644 \u0645\u062F\u06CC\u0631\u06CC\u062A \u062F\u0648\u0628\u0627\u0631\u0647 \u0634\u0631\u0648\u0639 \u06A9\u0646\u06CC\u062F."), replyMarkup: { inline_keyboard: [[{ text: "\u21A9\uFE0F \u0645\u062F\u06CC\u0631\u06CC\u062A \u0633\u0631\u0648\u0631\u0647\u0627", callback_data: "v2:admin:nodes" }]] } };
  }
  const parsed = parseAutoNode(input.trim());
  if (!parsed) return { text: frameMessage("\u26A0\uFE0F \u0627\u0637\u0644\u0627\u0639\u0627\u062A \u0648\u0627\u0631\u062F\u0634\u062F\u0647 \u0645\u0639\u062A\u0628\u0631 \u0646\u06CC\u0633\u062A. \u0634\u0634 \u0645\u0642\u062F\u0627\u0631 \u0631\u0627 \u0645\u0637\u0627\u0628\u0642 \u0646\u0645\u0648\u0646\u0647 \u0627\u0631\u0633\u0627\u0644 \u06A9\u0646\u06CC\u062F.\n\n" + prompt), replyMarkup: { inline_keyboard: [[{ text: "\u21A9\uFE0F \u0645\u062F\u06CC\u0631\u06CC\u062A \u0633\u0631\u0648\u0631\u0647\u0627", callback_data: "v2:admin:nodes" }]] } };
  if (!env) return { text: frameMessage("\u26A0\uFE0F \u0627\u062C\u0631\u0627\u06CC \u062E\u0648\u062F\u06A9\u0627\u0631 \u062A\u0646\u0638\u06CC\u0645 \u0646\u0634\u062F\u0647 \u0627\u0633\u062A\u061B \u0647\u06CC\u0686 \u0633\u0631\u0648\u0631\u06CC \u062B\u0628\u062A \u0646\u0634\u062F."), replyMarkup: { inline_keyboard: [[{ text: "\u21A9\uFE0F \u0645\u062F\u06CC\u0631\u06CC\u062A \u0633\u0631\u0648\u0631\u0647\u0627", callback_data: "v2:admin:nodes" }]] } };
  const result = await enqueueAutoNode(env, actor, input.trim(), nowMs);
  if (result.error) {
    const errors = {
      bad_input: "\u0627\u0637\u0644\u0627\u0639\u0627\u062A \u0633\u0631\u0648\u0631 \u0645\u0639\u062A\u0628\u0631 \u0646\u06CC\u0633\u062A.",
      not_ready: "\u067E\u0627\u06CC\u06AF\u0627\u0647 \u062F\u0627\u062F\u0647 \u0622\u0645\u0627\u062F\u0647 \u0646\u06CC\u0633\u062A.",
      automation_not_configured: "\u0627\u062A\u0635\u0627\u0644 \u0627\u062C\u0631\u0627\u06A9\u0646\u0646\u062F\u0647 \u0627\u0645\u0646 \u06A9\u0627\u0645\u0644 \u0646\u0634\u062F\u0647 \u0627\u0633\u062A.",
      already_exists: "\u0627\u06CC\u0646 \u0634\u0646\u0627\u0633\u0647 \u0633\u0631\u0648\u0631 \u0642\u0628\u0644\u0627\u064B \u062B\u0628\u062A \u0634\u062F\u0647 \u0627\u0633\u062A."
    };
    return { text: frameMessage("\u26A0\uFE0F \u062B\u0628\u062A \u0633\u0631\u0648\u0631 \u0627\u0646\u062C\u0627\u0645 \u0646\u0634\u062F.\n" + (errors[result.error] ?? "\u062E\u0637\u0627\u06CC \u067E\u06CC\u0634\u200C\u0628\u06CC\u0646\u06CC\u200C\u0646\u0634\u062F\u0647\u061B \u062A\u0646\u0638\u06CC\u0645\u0627\u062A \u0631\u0627 \u0628\u0631\u0631\u0633\u06CC \u06A9\u0646\u06CC\u062F.")), replyMarkup: { inline_keyboard: [[{ text: "\u21A9\uFE0F \u0645\u062F\u06CC\u0631\u06CC\u062A \u0633\u0631\u0648\u0631\u0647\u0627", callback_data: "v2:admin:nodes" }]] } };
  }
  await db.prepare("DELETE FROM admin_node_sessions WHERE telegram_id=?").bind(actor).run();
  const status = result.dispatched ? "\u{1F680} \u062F\u0631\u062E\u0648\u0627\u0633\u062A \u0646\u0635\u0628 \u0627\u0645\u0646 \u0628\u0647 \u0627\u062C\u0631\u0627\u06A9\u0646\u0646\u062F\u0647 \u0627\u0631\u0633\u0627\u0644 \u0634\u062F. \u0648\u0636\u0639\u06CC\u062A \u0631\u0627 \u0627\u0632 \u0628\u062E\u0634 \xAB\u0645\u062F\u06CC\u0631\u06CC\u062A \u0633\u0631\u0648\u0631\u0647\u0627\xBB \u067E\u06CC\u06AF\u06CC\u0631\u06CC \u06A9\u0646\u06CC\u062F." : "\u23F8 \u0633\u0631\u0648\u0631 \u062B\u0628\u062A \u0634\u062F\u060C \u0627\u0645\u0627 \u062F\u0633\u062A\u0631\u0633\u06CC \u0627\u0645\u0646 \u0627\u062C\u0631\u0627\u06A9\u0646\u0646\u062F\u0647 \u0647\u0646\u0648\u0632 \u0628\u0631\u0642\u0631\u0627\u0631 \u0646\u06CC\u0633\u062A\u061B \u0646\u0635\u0628 \u0622\u063A\u0627\u0632 \u0646\u0634\u062F.";
  return { text: frameMessage("\u2705 \u0633\u0631\u0648\u0631 " + parsed.id + " \u062B\u0628\u062A \u0634\u062F.\n" + status + "\n\n\u{1F512} \u062A\u0627 \u062A\u0623\u06CC\u06CC\u062F \u0648\u0627\u0642\u0639\u06CC \u0645\u0633\u06CC\u0631\u0647\u0627\u060C \u0635\u062F\u0648\u0631 \u06A9\u0627\u0646\u0641\u06CC\u06AF \u0628\u0631\u0627\u06CC \u0641\u0631\u0648\u0634 \u063A\u06CC\u0631\u0641\u0639\u0627\u0644 \u0645\u06CC\u200C\u0645\u0627\u0646\u062F."), replyMarkup: { inline_keyboard: [[{ text: "\u21A9\uFE0F \u0645\u062F\u06CC\u0631\u06CC\u062A \u0633\u0631\u0648\u0631\u0647\u0627", callback_data: "v2:admin:nodes" }]] } };
}
__name(consumeNodeWizard, "consumeNodeWizard");

// src/referrals.mjs
var response2 = /* @__PURE__ */ __name((text, locale = "fa", buttons = [], audience = "customer") => ({
  text: frameMessage(text),
  replyMarkup: { inline_keyboard: [
    ...buttons,
    ...(audience === "seller" ? sellerMenu() : botMenu()).inline_keyboard
  ] }
}), "response");
var sellerResponse = /* @__PURE__ */ __name((text, locale = "fa", buttons = []) => response2(text, locale, buttons, "seller"), "sellerResponse");
var lang = /* @__PURE__ */ __name((fa) => fa, "lang");
var ID7 = /^\d{1,20}$/;
var START_TOKEN = /^[a-f0-9]{32}$/;
function hex6(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}
__name(hex6, "hex");
async function hashInvite(token) {
  if (!START_TOKEN.test(token)) return null;
  return hex6(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))));
}
__name(hashInvite, "hashInvite");
async function linkSellerOnStart(db, e, nowMs = Date.now()) {
  const match = e.inputText?.match(/^\/start(?:@\w+)?\s+([a-f0-9]{32})$/i);
  if (!match) return null;
  const token = match[1].toLowerCase(), hash = await hashInvite(token);
  const row = await db.prepare(
    "SELECT si.seller_telegram_id FROM seller_invites si JOIN staff_roles sr ON sr.telegram_id=si.seller_telegram_id AND sr.role='seller' JOIN customers c ON c.telegram_id=sr.telegram_id AND c.state='active' WHERE si.token_hash=? AND si.disabled=0 AND si.expires_ms>? LIMIT 1"
  ).bind(hash, nowMs).first();
  if (!row || row.seller_telegram_id === e.actorId)
    return lang("\u06A9\u062F \u0645\u0639\u0631\u0641\u06CC \u0645\u0639\u062A\u0628\u0631 \u0646\u06CC\u0633\u062A \u06CC\u0627 \u0645\u0647\u0644\u062A \u0622\u0646 \u0628\u0647 \u067E\u0627\u06CC\u0627\u0646 \u0631\u0633\u06CC\u062F\u0647 \u0627\u0633\u062A.", "Referral code is invalid or expired.", e.locale);
  const result = await db.prepare(
    "UPDATE customers SET seller_telegram_id=? WHERE telegram_id=? AND seller_telegram_id IS NULL"
  ).bind(row.seller_telegram_id, e.actorId).run();
  return result.meta?.changes === 1 ? lang(
    "\u2705 \u06A9\u062F \u0645\u0639\u0631\u0641 \u062B\u0628\u062A \u0634\u062F. \u0641\u0631\u0648\u0634\u0646\u062F\u0647 \u0641\u0642\u0637 \u0633\u0641\u0627\u0631\u0634\u200C\u0647\u0627\u06CC \u0645\u0631\u062A\u0628\u0637 \u0628\u0627 \u0634\u0645\u0627 \u0631\u0627 \u0628\u0631\u0627\u06CC \u067E\u0634\u062A\u06CC\u0628\u0627\u0646\u06CC \u0645\u0634\u0627\u0647\u062F\u0647 \u0645\u06CC\u200C\u06A9\u0646\u062F.",
    "Referral saved. Your seller can see your associated orders for support.",
    e.locale
  ) : lang("\u062D\u0633\u0627\u0628 \u0634\u0645\u0627 \u0642\u0628\u0644\u0627\u064B \u0628\u0647 \u06CC\u06A9 \u0641\u0631\u0648\u0634\u0646\u062F\u0647 \u0645\u0631\u062A\u0628\u0637 \u0634\u062F\u0647 \u0627\u0633\u062A.", "Your account is already assigned to a seller.", e.locale);
}
__name(linkSellerOnStart, "linkSellerOnStart");
async function isSeller(db, userId) {
  const r = await db.prepare(
    "SELECT 1 AS ok FROM staff_roles WHERE telegram_id=? AND role='seller'"
  ).bind(userId).first();
  return r?.ok === 1;
}
__name(isSeller, "isSeller");
async function newInvite(db, e, env, nowMs) {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const token = hex6(bytes);
  const hash = await hashInvite(token);
  await db.prepare(
    "INSERT INTO seller_invites(token_hash,seller_telegram_id,expires_ms) VALUES(?,?,?)"
  ).bind(hash, e.actorId, nowMs + 30 * 24 * 60 * 60 * 1e3).run();
  const bot = typeof env.BOT_USERNAME === "string" && /^[a-zA-Z0-9_]{5,32}$/.test(env.BOT_USERNAME) ? "https://t.me/" + env.BOT_USERNAME + "?start=" + token : "/start " + token;
  return sellerResponse("\u{1F517}  \u0644\u06CC\u0646\u06A9 \u0645\u0639\u0631\u0641\u06CC \u0634\u0645\u0627\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n" + bot + "\n\n\u23F3 \u0627\u0639\u062A\u0628\u0627\u0631 \u0627\u06CC\u0646 \u0644\u06CC\u0646\u06A9: \u06F3\u06F0 \u0631\u0648\u0632\n\u0627\u06CC\u0646 \u0644\u06CC\u0646\u06A9 \u0641\u0642\u0637 \u06CC\u06A9\u200C\u0628\u0627\u0631 \u0646\u0645\u0627\u06CC\u0634 \u062F\u0627\u062F\u0647 \u0645\u06CC\u200C\u0634\u0648\u062F\u061B \u0622\u0646 \u0631\u0627 \u062F\u0631 \u0645\u062D\u0644 \u0627\u0645\u0646 \u0646\u06AF\u0647\u062F\u0627\u0631\u06CC \u06A9\u0646\u06CC\u062F.", e.locale);
}
__name(newInvite, "newInvite");
async function sellerOrders(db, e) {
  const rows = (await db.prepare(
    "SELECT id,state,quoted_amount,quoted_currency FROM orders WHERE seller_telegram_id=? ORDER BY created_at DESC LIMIT 15"
  ).bind(e.actorId).all()).results ?? [];
  if (!rows.length) return sellerResponse("\u{1F9FE} \u0647\u0646\u0648\u0632 \u0633\u0641\u0627\u0631\u0634\u06CC \u0628\u0647 \u062D\u0633\u0627\u0628 \u0641\u0631\u0648\u0634\u0646\u062F\u06AF\u06CC \u0634\u0645\u0627 \u0646\u0633\u0628\u062A \u062F\u0627\u062F\u0647 \u0646\u0634\u062F\u0647 \u0627\u0633\u062A.", e.locale);
  return sellerResponse("\u{1F9FE}  \u0633\u0641\u0627\u0631\u0634\u200C\u0647\u0627\u06CC \u0645\u0631\u062A\u0628\u0637 \u0628\u0627 \u0634\u0645\u0627\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n" + rows.map((o) => "\u0634\u0646\u0627\u0633\u0647: " + o.id.slice(0, 8) + "\u2026\n\u0648\u0636\u0639\u06CC\u062A: " + faStatus(o.state) + "\n\u0645\u0628\u0644\u063A: " + faMoney(o.quoted_amount, o.quoted_currency)).join("\n\n"), e.locale);
}
__name(sellerOrders, "sellerOrders");
async function handleSeller(env, e, nowMs = Date.now()) {
  const db = env.DB, key = e.key ?? "";
  if (key === "/seller" || key === "seller:home" || key === "seller:orders" || key === "seller:invite" || key === "seller:revoke") {
    if (!await isSeller(db, e.actorId))
      return response2("\u26D4 \u062F\u0633\u062A\u0631\u0633\u06CC \u0641\u0631\u0648\u0634\u0646\u062F\u06AF\u06CC \u0628\u0631\u0627\u06CC \u062D\u0633\u0627\u0628 \u0634\u0645\u0627 \u0641\u0639\u0627\u0644 \u0646\u06CC\u0633\u062A.", e.locale);
    if (key === "seller:invite") return newInvite(db, e, env, nowMs);
    if (key === "seller:revoke") {
      await db.prepare("UPDATE seller_invites SET disabled=1 WHERE seller_telegram_id=? AND disabled=0").bind(e.actorId).run();
      return sellerResponse("\u{1F512} \u062A\u0645\u0627\u0645 \u0644\u06CC\u0646\u06A9\u200C\u0647\u0627\u06CC \u0645\u0639\u0631\u0641\u06CC \u0642\u0628\u0644\u06CC \u063A\u06CC\u0631\u0641\u0639\u0627\u0644 \u0634\u062F\u0646\u062F.", e.locale);
    }
    if (key === "seller:orders") return sellerOrders(db, e);
    return sellerResponse("\u{1F9D1}\u200D\u{1F4BC}  \u067E\u06CC\u0634\u062E\u0648\u0627\u0646 \u0641\u0631\u0648\u0634\u0646\u062F\u0647\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n\u0627\u0632 \u06AF\u0632\u06CC\u0646\u0647\u200C\u0647\u0627\u06CC \u0632\u06CC\u0631 \u0628\u0631\u0627\u06CC \u0645\u062F\u06CC\u0631\u06CC\u062A \u0633\u0641\u0627\u0631\u0634\u200C\u0647\u0627 \u0648 \u0644\u06CC\u0646\u06A9\u200C\u0647\u0627\u06CC \u0645\u0639\u0631\u0641\u06CC \u0627\u0633\u062A\u0641\u0627\u062F\u0647 \u06A9\u0646\u06CC\u062F.", e.locale);
  }
  return null;
}
__name(handleSeller, "handleSeller");
async function grantStaffRole(db, e, role, subjectId) {
  if (!["seller", "support"].includes(role) || !ID7.test(subjectId)) return false;
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO customers(telegram_id) VALUES(?)").bind(subjectId),
    db.prepare("INSERT OR IGNORE INTO staff_roles(telegram_id,role,granted_by) VALUES(?,?,?)").bind(subjectId, role, e.actorId),
    db.prepare(
      "INSERT OR IGNORE INTO audit_events(event_id,actor_id,object_type,object_id,verb) VALUES(?,?,?,?,?)"
    ).bind("staff:" + role + ":" + subjectId, e.actorId, "staff", subjectId, "grant:" + role)
  ]);
  return true;
}
__name(grantStaffRole, "grantStaffRole");

// src/shop.mjs
var ORDER_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{1,48}$/;
var PLAN_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{1,30}$/;
var t = /* @__PURE__ */ __name((fa) => fa, "t");
var line = /* @__PURE__ */ __name((...parts) => parts.filter(Boolean).join("\n"), "line");
var response3 = /* @__PURE__ */ __name((text, locale = "fa", extra = [], audience = "customer") => ({
  text: frameMessage(String(text).slice(0, 3300)),
  replyMarkup: { inline_keyboard: [...extra, ...sectionNavigation(audience)] }
}), "response");
var adminResponse = /* @__PURE__ */ __name((text, locale = "fa", extra = []) => response3(text, locale, extra, "admin"), "adminResponse");
var supportResponse = /* @__PURE__ */ __name((text, locale = "fa", extra = []) => response3(text, locale, extra, "support"), "supportResponse");
var staffResponse = /* @__PURE__ */ __name((text, e, env, extra = []) => adminAllowed(env.ADMIN_TELEGRAM_IDS, e.actorId) ? adminResponse(text, e.locale, extra) : supportResponse(text, e.locale, extra), "staffResponse");
function money(amount, currency) {
  return faMoney(amount, currency);
}
__name(money, "money");
function adminAllowed(ids, userId) {
  if (typeof ids !== "string" || !/^[0-9]+$/.test(userId ?? "")) return false;
  return ids.split(",").map((s) => s.trim()).some((id) => id.length > 0 && id === userId);
}
__name(adminAllowed, "adminAllowed");
function salesConfigured(env) {
  return enabled(env, "SHOP_ENABLED") && enabled(env, "PROVISIONING_ENABLED") && typeof env.PAYMENT_INSTRUCTIONS === "string" && env.PAYMENT_INSTRUCTIONS.trim().length >= 12 && env.PAYMENT_INSTRUCTIONS.length <= 700;
}
__name(salesConfigured, "salesConfigured");
async function isCustomerActive(db, id) {
  const s = await db.prepare("SELECT state FROM customers WHERE telegram_id=?").bind(id).first();
  return s?.state === "active";
}
__name(isCustomerActive, "isCustomerActive");
async function upsertCustomer(db, e) {
  await db.prepare(
    "INSERT INTO customers(telegram_id,locale) VALUES (?,'fa') ON CONFLICT(telegram_id) DO UPDATE SET locale='fa'"
  ).bind(e.actorId).run();
}
__name(upsertCustomer, "upsertCustomer");
async function healthyNodeAvailable(db, quota, nowMs) {
  const from = nowMs - 6e5;
  const r = await db.prepare(
    "SELECT n.id FROM nodes n JOIN routes r ON r.node_id=n.id AND r.id=n.id||'_reality' JOIN route_carrier_variants m ON m.route_id=r.id AND m.operator='mci' AND m.port=443 AND m.published=1 AND m.verified_ms BETWEEN ? AND ? JOIN route_carrier_variants i ON i.route_id=r.id AND i.operator='irancell' AND i.port=8443 AND i.published=1 AND i.verified_ms BETWEEN ? AND ? WHERE n.lifecycle='ready' AND n.desired_revision=n.acked_revision AND r.transport='reality' AND r.state='ready' AND r.verified_ms BETWEEN ? AND ? AND n.user_limit > (SELECT COUNT(*) FROM node_allocations a WHERE a.node_id=n.id AND a.state IN ('reserved','active')) AND n.byte_limit - (SELECT COALESCE(SUM(a.quota_bytes),0) FROM node_allocations a WHERE a.node_id=n.id AND a.state IN ('reserved','active')) >= ? AND EXISTS(SELECT 1 FROM node_health h WHERE h.node_id=n.id AND h.revision=n.desired_revision AND h.xray_healthy=1 AND h.stats_healthy=1 AND h.observed_ms BETWEEN ? AND ?) AND EXISTS(SELECT 1 FROM node_acks a WHERE a.node_id=n.id AND a.revision=n.desired_revision AND a.status='accepted' AND a.observed_ms BETWEEN ? AND ?) ORDER BY n.id LIMIT 1"
  ).bind(
    from,
    nowMs,
    from,
    nowMs,
    from,
    nowMs,
    quota,
    from,
    nowMs,
    from,
    nowMs
  ).first();
  return r?.id ?? null;
}
__name(healthyNodeAvailable, "healthyNodeAvailable");
async function availableForSale(db, plan, nowMs) {
  if (!plan || !Number.isSafeInteger(plan.quota_bytes) || plan.quota_bytes <= 0) return false;
  return await healthyNodeAvailable(db, plan.quota_bytes, nowMs) !== null;
}
__name(availableForSale, "availableForSale");
async function listPlans(db, env, locale, nowMs) {
  const plans = (await db.prepare(
    "SELECT id,title_fa,price_amount,price_currency,quota_bytes,duration_days FROM plans WHERE active=1 ORDER BY price_amount,id LIMIT 12"
  ).all()).results ?? [];
  if (!plans.length) return response3(
    panelHeading("\u{1F6CD}", "\u0641\u0631\u0648\u0634\u06AF\u0627\u0647 \u0627\u0634\u062A\u0631\u0627\u06A9", "\u0628\u0633\u062A\u0647 \u0645\u0646\u0627\u0633\u0628 \u062E\u0648\u062F \u0631\u0627 \u062F\u0631 \u0627\u06CC\u0646 \u0628\u062E\u0634 \u0627\u0646\u062A\u062E\u0627\u0628 \u06A9\u0646\u06CC\u062F") + "\n\n\u062F\u0631 \u062D\u0627\u0644 \u062D\u0627\u0636\u0631 \u0628\u0633\u062A\u0647 \u0641\u0639\u0627\u0644\u06CC \u0628\u0631\u0627\u06CC \u062E\u0631\u06CC\u062F \u0645\u0646\u062A\u0634\u0631 \u0646\u0634\u062F\u0647 \u0627\u0633\u062A.\n\n\u0627\u0634\u062A\u0631\u0627\u06A9\u200C\u0647\u0627\u06CC \u0646\u0633\u062E\u0647 \u0642\u0628\u0644\u06CC \u0634\u0645\u0627 \u0645\u0633\u062A\u0642\u0644 \u0648 \u0645\u062D\u0641\u0648\u0638 \u0647\u0633\u062A\u0646\u062F.",
    locale
  );
  const items = [];
  const buttons = [];
  for (const p of plans) {
    const label2 = p.title_fa;
    items.push("\u250C " + label2 + "\n\u2502 \u23F1 \u0645\u062F\u062A: " + faNumber(p.duration_days) + " \u0631\u0648\u0632\n\u2502 \u{1F4E6} \u062D\u062C\u0645: " + faGB(p.quota_bytes / 1073741824) + "\n\u2514 \u{1F4B3} \u0642\u06CC\u0645\u062A: " + money(p.price_amount, p.price_currency));
    if (salesConfigured(env) && await availableForSale(db, p, nowMs)) {
      buttons.push([{ text: "\u{1F6D2} \u062E\u0631\u06CC\u062F \xB7 " + label2.slice(0, 18), callback_data: "v2:buy:" + p.id }]);
    }
  }
  const warning = buttons.length ? "\u067E\u0633 \u0627\u0632 \u067E\u0631\u062F\u0627\u062E\u062A\u060C \u062A\u0635\u0648\u06CC\u0631 \u0631\u0633\u06CC\u062F \u0631\u0627 \u0627\u0631\u0633\u0627\u0644 \u06A9\u0646\u06CC\u062F. \u0641\u0639\u0627\u0644\u200C\u0633\u0627\u0632\u06CC \u0641\u0642\u0637 \u0628\u0639\u062F \u0627\u0632 \u062A\u0623\u06CC\u06CC\u062F \u0645\u062F\u06CC\u0631 \u0648 \u0622\u0645\u0627\u062F\u0647\u200C\u0633\u0627\u0632\u06CC \u0633\u0631\u0648\u0631 \u0627\u0646\u062C\u0627\u0645 \u0645\u06CC\u200C\u0634\u0648\u062F." : "\u26D4 \u0641\u0631\u0648\u0634 \u0641\u0639\u0644\u0627\u064B \u063A\u06CC\u0631\u0641\u0639\u0627\u0644 \u0627\u0633\u062A \u06CC\u0627 \u0638\u0631\u0641\u06CC\u062A \u062A\u0623\u06CC\u06CC\u062F\u0634\u062F\u0647 \u06A9\u0627\u0641\u06CC \u0646\u06CC\u0633\u062A\u061B \u0644\u0637\u0641\u0627\u064B \u067E\u0631\u062F\u0627\u062E\u062A \u0646\u06A9\u0646\u06CC\u062F.";
  return response3(panelHeading("\u{1F6CD}", "\u0627\u0646\u062A\u062E\u0627\u0628 \u0627\u0634\u062A\u0631\u0627\u06A9", "\u0628\u0633\u062A\u0647\u200C\u0647\u0627 \u0631\u0627 \u0627\u0632 \u0646\u0638\u0631 \u062D\u062C\u0645\u060C \u0645\u062F\u062A \u0648 \u0642\u06CC\u0645\u062A \u0645\u0642\u0627\u06CC\u0633\u0647 \u06A9\u0646\u06CC\u062F") + "\n\n" + items.join("\n\n\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n\n") + "\n\n" + warning, locale, buttons);
}
__name(listPlans, "listPlans");
async function pendingOrder(db, id) {
  return db.prepare(
    "SELECT id,state,quoted_amount,quoted_currency FROM orders WHERE customer_telegram_id=? AND state IN ('pending','receipt_submitted','approved','provisioning') AND substr(idempotency_key,1,7) <> 'direct:' AND substr(idempotency_key,1,10) <> 'admin-e2e:' ORDER BY created_at DESC LIMIT 1"
  ).bind(id).first();
}
__name(pendingOrder, "pendingOrder");
async function purchase(db, env, e, planId2, nowMs) {
  if (!salesConfigured(env)) return response3(t(
    "\u062B\u0628\u062A \u0633\u0641\u0627\u0631\u0634 \u062F\u0631 \u0627\u06CC\u0646 \u0645\u062D\u06CC\u0637 \u063A\u06CC\u0631\u0641\u0639\u0627\u0644 \u0627\u0633\u062A\u061B \u0644\u0637\u0641\u0627\u064B \u067E\u0631\u062F\u0627\u062E\u062A \u0646\u06A9\u0646\u06CC\u062F.",
    "Checkout is disabled in this environment; do not pay.",
    e.locale
  ), e.locale);
  if (!PLAN_ID.test(planId2)) return response3(t("\u067E\u0644\u0646 \u0646\u0627\u0645\u0639\u062A\u0628\u0631 \u0627\u0633\u062A.", "Invalid plan.", e.locale), e.locale);
  const active = await pendingOrder(db, e.actorId);
  if (active) return response3("\u2139\uFE0F \u06CC\u06A9 \u0633\u0641\u0627\u0631\u0634 \u0628\u0627\u0632 \u062F\u0627\u0631\u06CC\u062F.\n\u0634\u0646\u0627\u0633\u0647: " + active.id + "\n\u0648\u0636\u0639\u06CC\u062A: " + faStatus(active.state), e.locale);
  const p = await db.prepare("SELECT * FROM plans WHERE id=? AND active=1").bind(planId2).first();
  if (!p) return response3(t("\u067E\u0644\u0646 \u067E\u06CC\u062F\u0627 \u0646\u0634\u062F.", "Plan not found.", e.locale), e.locale);
  if (!await availableForSale(db, p, nowMs)) return response3(t(
    "\u0641\u0639\u0644\u0627\u064B \u0633\u0631\u0648\u0631 \u0622\u0645\u0627\u062F\u0647 \u0628\u0627 \u0638\u0631\u0641\u06CC\u062A \u06A9\u0627\u0641\u06CC \u0646\u062F\u0627\u0631\u06CC\u0645\u061B \u0647\u06CC\u0686 \u067E\u0631\u062F\u0627\u062E\u062A\u06CC \u0627\u0646\u062C\u0627\u0645 \u0646\u062F\u0647\u06CC\u062F.",
    "No verified server has capacity. Please do not pay.",
    e.locale
  ), e.locale);
  const id = crypto.randomUUID();
  const idempotency = "telegram-update:" + e.updateId;
  try {
    await db.prepare(
      "INSERT INTO orders(id,customer_telegram_id,seller_telegram_id,plan_id,idempotency_key,quoted_amount,quoted_currency) SELECT ?,?,(SELECT seller_telegram_id FROM customers WHERE telegram_id=?),?,?,?,? WHERE EXISTS(SELECT 1 FROM plans WHERE id=? AND active=1)"
    ).bind(id, e.actorId, e.actorId, planId2, idempotency, p.price_amount, p.price_currency, planId2).run();
  } catch {
    const current = await pendingOrder(db, e.actorId);
    if (current) return response3(t("\u0633\u0641\u0627\u0631\u0634 \u0628\u0627\u0632 \u0634\u0645\u0627: ", "Your open order: ", e.locale) + current.id, e.locale);
    throw new Error("purchase_rejected");
  }
  return response3(line(
    t("\u2705 \u0633\u0641\u0627\u0631\u0634 \u062B\u0628\u062A \u0634\u062F\u061B \u0647\u0646\u0648\u0632 \u0647\u06CC\u0686 \u06A9\u0627\u0646\u0641\u06CC\u06AF\u06CC \u0635\u0627\u062F\u0631 \u0646\u0634\u062F\u0647 \u0627\u0633\u062A.", "\u2705 Order recorded; no VPN configuration has been issued.", e.locale),
    t("\u0634\u0646\u0627\u0633\u0647: ", "Order: ", e.locale) + id,
    t("\u0645\u0628\u0644\u063A: ", "Amount: ", e.locale) + money(p.price_amount, p.price_currency),
    "",
    env.PAYMENT_INSTRUCTIONS.trim(),
    "",
    t(
      "\u067E\u0633 \u0627\u0632 \u067E\u0631\u062F\u0627\u062E\u062A\u060C \u062A\u0635\u0648\u06CC\u0631 \u0631\u0633\u06CC\u062F \u0631\u0627 \u0647\u0645\u06CC\u0646\u200C\u062C\u0627 \u0628\u0641\u0631\u0633\u062A\u06CC\u062F. \u0628\u0631\u0631\u0633\u06CC \u062F\u0633\u062A\u06CC \u0627\u0633\u062A \u0648 \u067E\u0631\u062F\u0627\u062E\u062A \u0628\u0647\u200C\u062A\u0646\u0647\u0627\u06CC\u06CC \u0633\u0631\u0648\u06CC\u0633 \u0631\u0627 \u0641\u0639\u0627\u0644 \u0646\u0645\u06CC\u200C\u06A9\u0646\u062F.",
      "Send a receipt photo here after paying. Payment alone does not activate a service.",
      e.locale
    )
  ), e.locale);
}
__name(purchase, "purchase");
function validAdminIds(ids, customerId = "") {
  if (typeof ids !== "string") return [];
  return [...new Set(ids.split(",").map((s) => s.trim()).filter((x) => /^[0-9]{1,20}$/.test(x) && x !== customerId))].slice(0, 20);
}
__name(validAdminIds, "validAdminIds");
async function storeReceipt(db, e, env) {
  const order = await db.prepare(
    "SELECT id,state FROM orders WHERE customer_telegram_id=? AND state IN ('pending','receipt_submitted') ORDER BY created_at DESC LIMIT 1"
  ).bind(e.actorId).first();
  if (!order) return response3(t(
    "\u0633\u0641\u0627\u0631\u0634 \u062F\u0631 \u0627\u0646\u062A\u0638\u0627\u0631 \u0631\u0633\u06CC\u062F \u0646\u062F\u0627\u0631\u06CC\u062F. \u0627\u0632 \u0628\u062E\u0634 \u067E\u0644\u0646\u200C\u0647\u0627 \u0634\u0631\u0648\u0639 \u06A9\u0646\u06CC\u062F.",
    "No order is awaiting a receipt.",
    e.locale
  ), e.locale);
  if (typeof e.photoId !== "string" || e.photoId.length > 512 || e.photoId.length < 5)
    return response3(t("\u0631\u0633\u06CC\u062F \u0645\u0639\u062A\u0628\u0631 \u0646\u06CC\u0633\u062A\u061B \u0644\u0637\u0641\u0627\u064B \u062A\u0635\u0648\u06CC\u0631 \u0631\u0633\u06CC\u062F \u0631\u0627 \u0627\u0631\u0633\u0627\u0644 \u06A9\u0646\u06CC\u062F.", "Please send a valid receipt image.", e.locale), e.locale);
  if (order.state === "pending") {
    await db.batch([
      db.prepare(
        "INSERT OR IGNORE INTO receipts(id,order_id,telegram_file_id,upload_by_telegram_id) VALUES(?,?,?,?)"
      ).bind(crypto.randomUUID(), order.id, e.photoId, e.actorId),
      db.prepare(
        "UPDATE orders SET state='receipt_submitted',updated_at=CURRENT_TIMESTAMP WHERE id=? AND state='pending'"
      ).bind(order.id)
    ]);
  }
  for (const adminId of validAdminIds(env.ADMIN_TELEGRAM_IDS, e.actorId)) {
    await db.prepare(
      "INSERT OR IGNORE INTO telegram_notifications(id,chat_id,body,state,due_ms) VALUES(?,?,?,'pending',?)"
    ).bind(
      "receipt-review:" + order.id + ":" + adminId,
      adminId,
      "\u{1F9FE} \u0631\u0633\u06CC\u062F \u062A\u0627\u0632\u0647 \u0628\u0631\u0627\u06CC \u0628\u0631\u0631\u0633\u06CC\n\u0633\u0641\u0627\u0631\u0634: " + order.id + "\n\u0645\u0634\u062A\u0631\u06CC: " + e.actorId + "\n/admin \u0631\u0627 \u0628\u0627\u0632 \u06A9\u0646\u06CC\u062F.",
      Date.now()
    ).run();
  }
  return response3(t(
    "\u2705 \u0631\u0633\u06CC\u062F \u062B\u0628\u062A \u0634\u062F \u0648 \u0645\u0646\u062A\u0638\u0631 \u0628\u0631\u0631\u0633\u06CC \u0645\u062F\u06CC\u0631 \u0627\u0633\u062A. \u062A\u0627 \u062A\u0623\u06CC\u06CC\u062F \u0633\u0631\u0648\u06CC\u0633\u060C \u06A9\u0627\u0646\u0641\u06CC\u06AF\u06CC \u0635\u0627\u062F\u0631 \u0646\u0645\u06CC\u200C\u0634\u0648\u062F.",
    "\u2705 Receipt received for manual review. No VPN configuration has been issued.",
    e.locale
  ), e.locale);
}
__name(storeReceipt, "storeReceipt");
async function myOrders(db, e) {
  const orders = (await db.prepare(
    "SELECT id,state,quoted_amount,quoted_currency FROM orders WHERE customer_telegram_id=? ORDER BY created_at DESC LIMIT 5"
  ).bind(e.actorId).all()).results ?? [];
  if (!orders.length) return response3(
    panelHeading("\u{1F9FE}", "\u0633\u0641\u0627\u0631\u0634\u200C\u0647\u0627\u06CC \u0645\u0646", "\u067E\u06CC\u06AF\u06CC\u0631\u06CC \u062E\u0631\u06CC\u062F\u0647\u0627 \u0648 \u0648\u0636\u0639\u06CC\u062A \u067E\u0631\u062F\u0627\u062E\u062A") + "\n\n\u0647\u0646\u0648\u0632 \u0633\u0641\u0627\u0631\u0634\u06CC \u062B\u0628\u062A \u0646\u06A9\u0631\u062F\u0647\u200C\u0627\u06CC\u062F.\n\u0628\u0631\u0627\u06CC \u0634\u0631\u0648\u0639\u060C \u0628\u0633\u062A\u0647\u200C\u0647\u0627\u06CC \u0641\u0639\u0627\u0644 \u0631\u0627 \u0628\u0631\u0631\u0633\u06CC \u06A9\u0646\u06CC\u062F.",
    e.locale,
    [[{ text: "\u{1F6CD} \u0645\u0634\u0627\u0647\u062F\u0647 \u0628\u0633\u062A\u0647\u200C\u0647\u0627", callback_data: "v2:plans" }]]
  );
  return response3(
    panelHeading("\u{1F9FE}", "\u067E\u06CC\u06AF\u06CC\u0631\u06CC \u0633\u0641\u0627\u0631\u0634\u200C\u0647\u0627", "\u0622\u062E\u0631\u06CC\u0646 \u0633\u0641\u0627\u0631\u0634\u200C\u0647\u0627\u06CC \u062B\u0628\u062A\u200C\u0634\u062F\u0647 \u062F\u0631 \u062D\u0633\u0627\u0628 \u0634\u0645\u0627") + "\n\n" + orders.map((o, i) => faNumber(i + 1) + ". " + statusSymbol(o.state) + " " + faStatus(o.state) + "\n\u{1F4B3} \u0645\u0628\u0644\u063A: " + money(o.quoted_amount, o.quoted_currency) + "\n\u{1F50E} \u06A9\u062F \u067E\u06CC\u06AF\u06CC\u0631\u06CC: " + shortCode(o.id, 18)).join("\n\n\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n\n"),
    e.locale,
    orders.map((o) => [{
      text: "\u{1F441} \u0645\u0634\u0627\u0647\u062F\u0647 \xB7 " + shortCode(o.id, 10),
      callback_data: "v2:orders:view:" + o.id
    }])
  );
}
__name(myOrders, "myOrders");
async function orderDetails(db, e, id) {
  if (!ORDER_ID.test(id)) return response3("\u26A0\uFE0F \u0634\u0646\u0627\u0633\u0647 \u0633\u0641\u0627\u0631\u0634 \u0645\u0639\u062A\u0628\u0631 \u0646\u06CC\u0633\u062A.", e.locale);
  const order = await db.prepare(
    "SELECT id,state,quoted_amount,quoted_currency,created_at FROM orders WHERE id=? AND customer_telegram_id=?"
  ).bind(id, e.actorId).first();
  if (!order) return response3("\u0627\u06CC\u0646 \u0633\u0641\u0627\u0631\u0634 \u062F\u0631 \u062D\u0633\u0627\u0628 \u0634\u0645\u0627 \u067E\u06CC\u062F\u0627 \u0646\u0634\u062F.", e.locale);
  const step = {
    pending: "\u{1F4F7} \u062A\u0635\u0648\u06CC\u0631 \u0631\u0633\u06CC\u062F \u067E\u0631\u062F\u0627\u062E\u062A \u0631\u0627 \u0647\u0645\u06CC\u0646\u200C\u062C\u0627 \u062F\u0631 \u0631\u0628\u0627\u062A \u0628\u0641\u0631\u0633\u062A\u06CC\u062F. \u067E\u06CC\u0634 \u0627\u0632 \u067E\u0631\u062F\u0627\u062E\u062A\u060C \u0627\u0637\u0644\u0627\u0639\u0627\u062A \u0633\u0641\u0627\u0631\u0634 \u0631\u0627 \u0628\u0631\u0631\u0633\u06CC \u06A9\u0646\u06CC\u062F.",
    receipt_submitted: "\u23F3 \u0631\u0633\u06CC\u062F \u062F\u0631\u06CC\u0627\u0641\u062A \u0634\u062F\u0647 \u0648 \u062F\u0631 \u0635\u0641 \u0628\u0631\u0631\u0633\u06CC \u0645\u062F\u06CC\u0631 \u0627\u0633\u062A. \u0646\u06CC\u0627\u0632\u06CC \u0628\u0647 \u0627\u0631\u0633\u0627\u0644 \u062F\u0648\u0628\u0627\u0631\u0647 \u0646\u06CC\u0633\u062A.",
    approved: "\u2705 \u0631\u0633\u06CC\u062F \u062A\u0623\u06CC\u06CC\u062F \u0634\u062F\u0647 \u0627\u0633\u062A. \u0622\u0645\u0627\u062F\u0647\u200C\u0633\u0627\u0632\u06CC \u0627\u0634\u062A\u0631\u0627\u06A9 \u0628\u0647 \u062A\u0623\u06CC\u06CC\u062F \u0633\u0631\u0648\u0631 \u0628\u0633\u062A\u06AF\u06CC \u062F\u0627\u0631\u062F.",
    provisioning: "\u2699\uFE0F \u062F\u0631 \u062D\u0627\u0644 \u0622\u0645\u0627\u062F\u0647\u200C\u0633\u0627\u0632\u06CC \u0633\u0631\u0648\u06CC\u0633 \u0647\u0633\u062A\u06CC\u0645. \u0648\u0636\u0639\u06CC\u062A \u0631\u0627 \u0627\u0632 \u0647\u0645\u06CC\u0646 \u0635\u0641\u062D\u0647 \u067E\u06CC\u06AF\u06CC\u0631\u06CC \u06A9\u0646\u06CC\u062F.",
    fulfilled: "\u2705 \u0633\u0641\u0627\u0631\u0634 \u062A\u062D\u0648\u06CC\u0644 \u062F\u0627\u062F\u0647 \u0634\u062F\u0647 \u0627\u0633\u062A. \u062C\u0632\u0626\u06CC\u0627\u062A \u0627\u062A\u0635\u0627\u0644 \u0631\u0627 \u062F\u0631 \xAB\u0627\u0634\u062A\u0631\u0627\u06A9\u200C\u0647\u0627\u06CC \u0645\u0646\xBB \u0628\u0628\u06CC\u0646\u06CC\u062F.",
    cancelled: "\u0633\u0641\u0627\u0631\u0634 \u0644\u063A\u0648 \u0634\u062F\u0647 \u0627\u0633\u062A. \u0628\u0631\u0627\u06CC \u0633\u0641\u0627\u0631\u0634 \u062C\u062F\u06CC\u062F \u0628\u0647 \u0628\u062E\u0634 \u0628\u0633\u062A\u0647\u200C\u0647\u0627 \u0628\u0631\u06AF\u0631\u062F\u06CC\u062F.",
    refunded: "\u0648\u062C\u0647 \u0627\u06CC\u0646 \u0633\u0641\u0627\u0631\u0634 \u0628\u0627\u0632\u06AF\u0631\u062F\u0627\u0646\u062F\u0647 \u0634\u062F\u0647 \u0627\u0633\u062A. \u0628\u0631\u0627\u06CC \u067E\u06CC\u06AF\u06CC\u0631\u06CC \u0627\u0632 \u067E\u0634\u062A\u06CC\u0628\u0627\u0646\u06CC \u06A9\u0645\u06A9 \u0628\u06AF\u06CC\u0631\u06CC\u062F.",
    rejected: "\u274C \u0631\u0633\u06CC\u062F \u062A\u0623\u06CC\u06CC\u062F \u0646\u0634\u062F\u0647 \u0627\u0633\u062A. \u0628\u0631\u0627\u06CC \u067E\u06CC\u06AF\u06CC\u0631\u06CC \u062F\u0631\u062E\u0648\u0627\u0633\u062A \u067E\u0634\u062A\u06CC\u0628\u0627\u0646\u06CC \u062B\u0628\u062A \u06A9\u0646\u06CC\u062F."
  }[order.state] ?? "\u0628\u0631\u0627\u06CC \u067E\u06CC\u06AF\u06CC\u0631\u06CC \u0648\u0636\u0639\u06CC\u062A \u0627\u0632 \u0628\u062E\u0634 \u067E\u0634\u062A\u06CC\u0628\u0627\u0646\u06CC \u0627\u0633\u062A\u0641\u0627\u062F\u0647 \u06A9\u0646\u06CC\u062F.";
  const stage = { pending: 1, receipt_submitted: 2, approved: 3, provisioning: 4, fulfilled: 5 }[order.state] ?? 0;
  const stages = ["\u062B\u0628\u062A \u0633\u0641\u0627\u0631\u0634", "\u0627\u0631\u0633\u0627\u0644 \u0631\u0633\u06CC\u062F", "\u0628\u0631\u0631\u0633\u06CC \u067E\u0631\u062F\u0627\u062E\u062A", "\u0622\u0645\u0627\u062F\u0647\u200C\u0633\u0627\u0632\u06CC \u0633\u0631\u0648\u06CC\u0633", "\u062A\u062D\u0648\u06CC\u0644 \u0627\u0634\u062A\u0631\u0627\u06A9"];
  const timeline = stages.map((label2, i) => (stage > i ? "\u{1F7E2} " : "\u26AA ") + label2).join("\n");
  return response3(panelHeading("\u{1F9FE}", "\u062C\u0632\u0626\u06CC\u0627\u062A \u0633\u0641\u0627\u0631\u0634", "\u067E\u06CC\u06AF\u06CC\u0631\u06CC \u0645\u0631\u062D\u0644\u0647\u200C\u0628\u0647\u200C\u0645\u0631\u062D\u0644\u0647") + "\n\n\u{1F50E} \u06A9\u062F \u067E\u06CC\u06AF\u06CC\u0631\u06CC: " + order.id + "\n\u0648\u0636\u0639\u06CC\u062A: " + statusSymbol(order.state) + " " + faStatus(order.state) + "\n\u{1F4B3} \u0645\u0628\u0644\u063A: " + money(order.quoted_amount, order.quoted_currency) + "\n\u{1F4C5} \u062A\u0627\u0631\u06CC\u062E \u062B\u0628\u062A: " + faDate(order.created_at) + "\n\n\u0631\u0648\u0646\u062F \u0633\u0641\u0627\u0631\u0634\n" + timeline + "\n\n\u0645\u0631\u062D\u0644\u0647 \u0628\u0639\u062F\n" + step, e.locale, [
    [{ text: "\u{1F504} \u062A\u0627\u0632\u0647\u200C\u0633\u0627\u0632\u06CC \u0648\u0636\u0639\u06CC\u062A", callback_data: "v2:orders:view:" + id }]
  ]);
}
__name(orderDetails, "orderDetails");
async function mySubscriptions(db, e, env) {
  const rows = (await db.prepare(
    "SELECT id,state,expires_at,max_bytes,used_bytes FROM subscriptions WHERE owner_telegram_id=? ORDER BY expires_at DESC LIMIT 5"
  ).bind(e.actorId).all()).results ?? [];
  if (!rows.length) return response3(
    panelHeading("\u{1F4E6}", "\u0627\u0634\u062A\u0631\u0627\u06A9\u200C\u0647\u0627\u06CC \u0645\u0646", "\u0648\u0636\u0639\u06CC\u062A \u0648 \u0627\u0637\u0644\u0627\u0639\u0627\u062A \u0627\u062A\u0635\u0627\u0644 \u0633\u0631\u0648\u06CC\u0633 \u0634\u0645\u0627") + "\n\n\u0647\u0646\u0648\u0632 \u0627\u0634\u062A\u0631\u0627\u06A9 \u0641\u0639\u0627\u0644\u06CC \u062F\u0631 \u0645\u062F\u0627\u0631 V2 \u0646\u062F\u0627\u0631\u06CC\u062F.\n\u0627\u0634\u062A\u0631\u0627\u06A9 \u0646\u0633\u062E\u0647 \u0642\u0628\u0644\u06CC \u0634\u0645\u0627 \u0645\u0633\u062A\u0642\u0644 \u0648 \u0645\u062D\u0641\u0648\u0638 \u0627\u0633\u062A.",
    e.locale,
    [[{ text: "\u{1F6CD} \u0645\u0634\u0627\u0647\u062F\u0647 \u0628\u0633\u062A\u0647\u200C\u0647\u0627", callback_data: "v2:plans" }]]
  );
  const buttons = enabled(env, "SUBSCRIPTION_LINKS_ENABLED") ? rows.filter((x) => x.state === "active").map((x) => [{
    text: "\u{1F517} \u062F\u0631\u06CC\u0627\u0641\u062A \u0644\u06CC\u0646\u06A9 \u0627\u062A\u0635\u0627\u0644 \xB7 " + shortCode(x.id, 8),
    callback_data: "v2:my:link:" + x.id
  }]) : [];
  return response3(
    panelHeading("\u{1F4E6}", "\u0627\u0634\u062A\u0631\u0627\u06A9\u200C\u0647\u0627\u06CC \u0645\u0646", "\u0645\u0635\u0631\u0641\u060C \u0627\u0639\u062A\u0628\u0627\u0631 \u0648 \u0644\u06CC\u0646\u06A9 \u0627\u062A\u0635\u0627\u0644") + "\n\n" + rows.map((x, i) => faNumber(i + 1) + ". " + statusSymbol(x.state) + " " + faStatus(x.state) + "\n\u0634\u0646\u0627\u0633\u0647: " + shortCode(x.id, 18) + "\n\u{1F4CA} \u0645\u0635\u0631\u0641: " + faGB(x.used_bytes / 1073741824) + " \u0627\u0632 " + faGB(x.max_bytes / 1073741824) + "\n" + usageMeter(x.used_bytes, x.max_bytes) + "\n\u{1F4C5} \u067E\u0627\u06CC\u0627\u0646 \u0627\u0639\u062A\u0628\u0627\u0631: " + faDate(x.expires_at)).join("\n\n\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n\n") + "\n\n\u{1F510} \u0644\u06CC\u0646\u06A9 \u0627\u062A\u0635\u0627\u0644 \u062E\u0635\u0648\u0635\u06CC \u0627\u0633\u062A\u061B \u062D\u062C\u0645 \u062F\u0648 \u0645\u0633\u06CC\u0631 \u0647\u0645\u0631\u0627\u0647 \u0627\u0648\u0644 \u0648 \u0627\u06CC\u0631\u0627\u0646\u0633\u0644 \u0645\u0634\u062A\u0631\u06A9 \u0645\u062D\u0627\u0633\u0628\u0647 \u0645\u06CC\u200C\u0634\u0648\u062F.",
    e.locale,
    buttons
  );
}
__name(mySubscriptions, "mySubscriptions");
async function beginSupport(db, e, nowMs) {
  await db.prepare(
    "INSERT INTO customer_sessions(telegram_id,mode,expires_ms) VALUES(?,'support',?) ON CONFLICT(telegram_id) DO UPDATE SET mode='support',expires_ms=excluded.expires_ms"
  ).bind(e.actorId, nowMs + 10 * 60 * 1e3).run();
  return response3(panelHeading("\u{1F4AC}", "\u062B\u0628\u062A \u062F\u0631\u062E\u0648\u0627\u0633\u062A \u067E\u0634\u062A\u06CC\u0628\u0627\u0646\u06CC", "\u062A\u06CC\u0645 \u0645\u062F\u0627\u0631 \u062F\u0631 \u06A9\u0646\u0627\u0631 \u0634\u0645\u0627\u0633\u062A") + "\n\n\u0645\u0648\u0636\u0648\u0639 \u0648 \u0634\u0631\u062D \u0645\u0634\u06A9\u0644 \u0631\u0627 \u062F\u0631 \u06CC\u06A9 \u067E\u06CC\u0627\u0645 \u0628\u0646\u0648\u06CC\u0633\u06CC\u062F.\n\u0645\u0647\u0644\u062A \u0627\u0631\u0633\u0627\u0644: \u06F1\u06F0 \u062F\u0642\u06CC\u0642\u0647.\n\n\u{1F510} \u0631\u0645\u0632 \u0639\u0628\u0648\u0631\u060C \u0627\u0637\u0644\u0627\u0639\u0627\u062A \u0628\u0627\u0646\u06A9\u06CC \u06CC\u0627 \u06A9\u0644\u06CC\u062F \u062E\u0635\u0648\u0635\u06CC \u0627\u0631\u0633\u0627\u0644 \u0646\u06A9\u0646\u06CC\u062F.", e.locale);
}
__name(beginSupport, "beginSupport");
async function maybeRecordSupport(db, e, env, nowMs) {
  if (!e.inputText || e.inputText.startsWith("/") || e.inputText.startsWith("v2:")) return null;
  const s = await db.prepare("SELECT mode,expires_ms FROM customer_sessions WHERE telegram_id=?").bind(e.actorId).first();
  if (!s || s.mode !== "support" || s.expires_ms < nowMs) return null;
  const subject = e.inputText.trim().slice(0, 140);
  if (!subject) return response3("\u067E\u06CC\u0627\u0645 \u0646\u0645\u06CC\u200C\u062A\u0648\u0627\u0646\u062F \u062E\u0627\u0644\u06CC \u0628\u0627\u0634\u062F.", e.locale);
  const ticketId = "tg-" + e.updateId;
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO support_tickets(id,customer_telegram_id,subject) VALUES(?,?,?)").bind(ticketId, e.actorId, subject),
    db.prepare("INSERT OR IGNORE INTO support_messages(id,ticket_id,sender_telegram_id,body,role) VALUES(?,?,?,?,'customer')").bind("customer-initial:" + e.updateId, ticketId, e.actorId, e.inputText.trim().slice(0, 1e3)),
    db.prepare("DELETE FROM customer_sessions WHERE telegram_id=?").bind(e.actorId)
  ]);
  await notifySupport(env, e, ticketId, nowMs);
  return response3("\u2705 \u062F\u0631\u062E\u0648\u0627\u0633\u062A \u067E\u0634\u062A\u06CC\u0628\u0627\u0646\u06CC \u0634\u0645\u0627 \u062B\u0628\u062A \u0634\u062F.\n\u0634\u0646\u0627\u0633\u0647 \u067E\u06CC\u06AF\u06CC\u0631\u06CC: " + ticketId, e.locale, [[
    { text: "\u{1F4AC} \u0645\u0634\u0627\u0647\u062F\u0647 \u062F\u0631\u062E\u0648\u0627\u0633\u062A", callback_data: "v2:customer:ticket:" + ticketId }
  ]]);
}
__name(maybeRecordSupport, "maybeRecordSupport");
async function isStaff(db, e, role) {
  const r = await db.prepare(
    "SELECT 1 AS ok FROM staff_roles WHERE telegram_id=? AND role=?"
  ).bind(e.actorId, role).first();
  return r?.ok === 1;
}
__name(isStaff, "isStaff");
async function adminQueue(db, e) {
  const queue = (await db.prepare(
    "SELECT o.id,o.customer_telegram_id,o.quoted_amount,o.quoted_currency FROM orders o WHERE o.state='receipt_submitted' AND EXISTS(SELECT 1 FROM receipts r WHERE r.order_id=o.id AND r.state='pending') ORDER BY o.created_at LIMIT 8"
  ).all()).results ?? [];
  if (!queue.length) return adminResponse(
    panelHeading("\u{1F9FE}", "\u0628\u0631\u0631\u0633\u06CC \u067E\u0631\u062F\u0627\u062E\u062A\u200C\u0647\u0627", "\u0635\u0646\u062F\u0648\u0642 \u0631\u0633\u06CC\u062F\u0647\u0627\u06CC \u0627\u0631\u0633\u0627\u0644\u06CC") + "\n\n\u2705 \u0631\u0633\u06CC\u062F\u06CC \u0628\u0631\u0627\u06CC \u0628\u0631\u0631\u0633\u06CC \u0628\u0627\u0642\u06CC \u0646\u0645\u0627\u0646\u062F\u0647 \u0627\u0633\u062A.",
    e.locale
  );
  return adminResponse(
    panelHeading("\u{1F9FE}", "\u0635\u0646\u062F\u0648\u0642 \u0628\u0631\u0631\u0633\u06CC \u067E\u0631\u062F\u0627\u062E\u062A", "\u0631\u0633\u06CC\u062F\u0647\u0627\u06CC \u0645\u0646\u062A\u0638\u0631 \u062A\u0635\u0645\u06CC\u0645 \u0645\u062F\u06CC\u0631") + "\n\n" + queue.map((x, i) => faNumber(i + 1) + ". \u0633\u0641\u0627\u0631\u0634 " + shortCode(x.id, 16) + "\n\u{1F464} \u0645\u0634\u062A\u0631\u06CC: " + x.customer_telegram_id + "\n\u{1F4B3} \u0645\u0628\u0644\u063A: " + money(x.quoted_amount, x.quoted_currency)).join("\n\n\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n\n"),
    e.locale,
    queue.map((x) => [
      { text: "\u{1F441} \u0628\u0631\u0631\u0633\u06CC \u0631\u0633\u06CC\u062F \xB7 " + shortCode(x.id, 8), callback_data: "v2:admin:receipt:" + x.id }
    ])
  );
}
__name(adminQueue, "adminQueue");
async function adminReceipt(db, e, id) {
  if (!ORDER_ID.test(id)) return adminResponse("\u26A0\uFE0F \u0634\u0646\u0627\u0633\u0647 \u0633\u0641\u0627\u0631\u0634 \u0645\u0639\u062A\u0628\u0631 \u0646\u06CC\u0633\u062A.", e.locale);
  const receipt = await db.prepare(
    "SELECT r.telegram_file_id,o.id,o.state,o.quoted_amount,o.quoted_currency FROM receipts r JOIN orders o ON o.id=r.order_id WHERE o.id=? AND r.state='pending' AND o.state='receipt_submitted' LIMIT 1"
  ).bind(id).first();
  if (!receipt) return adminResponse("\u0631\u0633\u06CC\u062F \u0628\u0631\u0627\u06CC \u0628\u0631\u0631\u0633\u06CC \u062F\u0631 \u062F\u0633\u062A\u0631\u0633 \u0646\u06CC\u0633\u062A.", e.locale);
  return {
    text: frameMessage(panelHeading("\u{1F9FE}", "\u0628\u0631\u0631\u0633\u06CC \u0631\u0633\u06CC\u062F \u067E\u0631\u062F\u0627\u062E\u062A", "\u062A\u0635\u0648\u06CC\u0631 \u0648 \u0645\u0628\u0644\u063A \u0633\u0641\u0627\u0631\u0634 \u0631\u0627 \u0628\u0627 \u062F\u0642\u062A \u062A\u0637\u0628\u06CC\u0642 \u062F\u0647\u06CC\u062F") + "\n\n\u{1F50E} \u0634\u0646\u0627\u0633\u0647 \u0633\u0641\u0627\u0631\u0634: " + id + "\n\u{1F4B3} \u0645\u0628\u0644\u063A: " + money(receipt.quoted_amount, receipt.quoted_currency) + "\n\n\u067E\u0633 \u0627\u0632 \u0628\u0631\u0631\u0633\u06CC \u062A\u0635\u0648\u06CC\u0631\u060C \u062A\u0635\u0645\u06CC\u0645 \u062E\u0648\u062F \u0631\u0627 \u062B\u0628\u062A \u06A9\u0646\u06CC\u062F."),
    photoId: receipt.telegram_file_id,
    replyMarkup: { inline_keyboard: [
      [
        { text: "\u2705 \u062A\u0623\u06CC\u06CC\u062F \u0631\u0633\u06CC\u062F", callback_data: "v2:admin:review:approve:" + id },
        { text: "\u274C \u0631\u062F \u0631\u0633\u06CC\u062F", callback_data: "v2:admin:review:reject:" + id }
      ],
      [{ text: "\u21A9\uFE0F \u0635\u0641 \u0628\u0631\u0631\u0633\u06CC \u0631\u0633\u06CC\u062F\u0647\u0627", callback_data: "v2:admin:queue" }],
      ...sectionNavigation("admin")
    ] }
  };
}
__name(adminReceipt, "adminReceipt");
async function adminDecision(db, e, action2, id) {
  if (!ORDER_ID.test(id)) return adminResponse("\u26A0\uFE0F \u0634\u0646\u0627\u0633\u0647 \u0633\u0641\u0627\u0631\u0634 \u0645\u0639\u062A\u0628\u0631 \u0646\u06CC\u0633\u062A.", e.locale);
  const desired = action2 === "approve" ? "approved" : "rejected";
  const old = await db.prepare(
    "SELECT id,customer_telegram_id,state FROM orders WHERE id=?"
  ).bind(id).first();
  if (!old) return adminResponse("\u0633\u0641\u0627\u0631\u0634 \u0645\u0648\u0631\u062F\u0646\u0638\u0631 \u067E\u06CC\u062F\u0627 \u0646\u0634\u062F.", e.locale);
  if (old.state === desired) return adminResponse("\u0627\u06CC\u0646 \u0633\u0641\u0627\u0631\u0634 \u0642\u0628\u0644\u0627\u064B \u0628\u0631\u0631\u0633\u06CC \u0634\u062F\u0647 \u0627\u0633\u062A: " + id, e.locale);
  if (old.state !== "receipt_submitted")
    return adminResponse("\u0627\u06CC\u0646 \u0633\u0641\u0627\u0631\u0634 \u062F\u0631 \u0648\u0636\u0639\u06CC\u062A \u0641\u0639\u0644\u06CC \u0642\u0627\u0628\u0644 \u0628\u0631\u0631\u0633\u06CC \u0646\u06CC\u0633\u062A: " + faStatus(old.state), e.locale);
  const idKey = "review:" + id;
  const message = action2 === "approve" ? "\u2705 \u0631\u0633\u06CC\u062F \u0633\u0641\u0627\u0631\u0634 " + id + " \u062A\u0623\u06CC\u06CC\u062F \u0634\u062F. \u0635\u062F\u0648\u0631 \u06A9\u0627\u0646\u0641\u06CC\u06AF \u067E\u0633 \u0627\u0632 \u0622\u0645\u0627\u062F\u0647\u200C\u0633\u0627\u0632\u06CC \u0648 \u062A\u0623\u06CC\u06CC\u062F \u0633\u0631\u0648\u0631 \u0627\u0646\u062C\u0627\u0645 \u0645\u06CC\u200C\u0634\u0648\u062F." : "\u274C \u0631\u0633\u06CC\u062F \u0633\u0641\u0627\u0631\u0634 " + id + " \u062A\u0623\u06CC\u06CC\u062F \u0646\u0634\u062F. \u0644\u0637\u0641\u0627\u064B \u0627\u0632 \u0628\u062E\u0634 \u067E\u0634\u062A\u06CC\u0628\u0627\u0646\u06CC \u067E\u06CC\u06AF\u06CC\u0631\u06CC \u06A9\u0646\u06CC\u062F.";
  const results = await db.batch([
    db.prepare(
      "UPDATE orders SET state=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND state='receipt_submitted' AND EXISTS(SELECT 1 FROM receipts WHERE order_id=? AND state='pending')"
    ).bind(desired, id, id),
    db.prepare(
      "UPDATE receipts SET state=? WHERE order_id=? AND state='pending' AND EXISTS(SELECT 1 FROM orders WHERE id=? AND state=?)"
    ).bind(action2 === "approve" ? "accepted" : "rejected", id, id, desired),
    db.prepare(
      "INSERT OR IGNORE INTO audit_events(event_id,actor_id,object_type,object_id,verb) SELECT ?,?,'order',?,? WHERE EXISTS(SELECT 1 FROM orders WHERE id=? AND state=?)"
    ).bind(idKey, e.actorId, id, action2, id, desired),
    db.prepare(
      "INSERT OR IGNORE INTO telegram_notifications(id,chat_id,body,state,due_ms) SELECT ?,?,?,'pending',? WHERE EXISTS(SELECT 1 FROM orders WHERE id=? AND state=?)"
    ).bind(idKey, old.customer_telegram_id, message, Date.now(), id, desired)
  ]);
  if (results[0]?.meta?.changes !== 1) return adminResponse("\u0648\u0636\u0639\u06CC\u062A \u0633\u0641\u0627\u0631\u0634 \u062A\u063A\u06CC\u06CC\u0631 \u06A9\u0631\u062F\u0647 \u0627\u0633\u062A\u061B \u0641\u0647\u0631\u0633\u062A \u0631\u0633\u06CC\u062F\u0647\u0627 \u0631\u0627 \u062F\u0648\u0628\u0627\u0631\u0647 \u0628\u0627\u0632 \u06A9\u0646\u06CC\u062F.", e.locale);
  return adminResponse("\u2705 \u0646\u062A\u06CC\u062C\u0647 \u0628\u0631\u0631\u0633\u06CC \u0633\u0641\u0627\u0631\u0634 \u062B\u0628\u062A \u0634\u062F.\n\u0634\u0646\u0627\u0633\u0647: " + id + "\n\u0648\u0636\u0639\u06CC\u062A: " + (action2 === "approve" ? "\u062A\u0623\u06CC\u06CC\u062F \u0634\u062F" : "\u0631\u062F \u0634\u062F") + "\n\u0647\u0646\u0648\u0632 \u0647\u06CC\u0686 \u06A9\u0627\u0646\u0641\u06CC\u06AF\u06CC \u0635\u0627\u062F\u0631 \u0646\u0634\u062F\u0647 \u0627\u0633\u062A.", e.locale);
}
__name(adminDecision, "adminDecision");
async function supportInbox(env, e, filter = "open", page = 0) {
  const db = env.DB;
  const options = {
    open: { name: "\u0646\u06CC\u0627\u0632\u0645\u0646\u062F \u067E\u0627\u0633\u062E", where: "state='open'" },
    waiting: { name: "\u0645\u0646\u062A\u0638\u0631 \u0645\u0634\u062A\u0631\u06CC", where: "state='waiting'" },
    closed: { name: "\u0628\u0633\u062A\u0647\u200C\u0634\u062F\u0647", where: "state='closed'" },
    all: { name: "\u0647\u0645\u0647", where: "1=1" }
  };
  if (!Object.hasOwn(options, filter)) filter = "open";
  page = Number.isSafeInteger(page) && page >= 0 && page <= 1e3 ? page : 0;
  const [open, waiting, closed, filtered] = await Promise.all([
    db.prepare("SELECT COUNT(*) n FROM support_tickets WHERE state='open'").first(),
    db.prepare("SELECT COUNT(*) n FROM support_tickets WHERE state='waiting'").first(),
    db.prepare("SELECT COUNT(*) n FROM support_tickets WHERE state='closed'").first(),
    db.prepare("SELECT COUNT(*) n FROM support_tickets WHERE " + options[filter].where).first()
  ]);
  const total = Number(filtered?.n ?? 0), last = Math.max(0, Math.ceil(total / 6) - 1);
  page = Math.min(page, last);
  const rows = (await db.prepare(
    "SELECT id,customer_telegram_id,subject,state FROM support_tickets WHERE " + options[filter].where + " ORDER BY created_at DESC,id DESC LIMIT 6 OFFSET ?"
  ).bind(page * 6).all()).results ?? [];
  const optionsRow = [
    { text: (filter === "open" ? "\u2705 " : "") + "\u0646\u06CC\u0627\u0632\u0645\u0646\u062F \u067E\u0627\u0633\u062E", callback_data: "v2:admin:tickets:open:0" },
    { text: (filter === "waiting" ? "\u2705 " : "") + "\u0645\u0646\u062A\u0638\u0631 \u0645\u0634\u062A\u0631\u06CC", callback_data: "v2:admin:tickets:waiting:0" }
  ];
  const optionsRow2 = [
    { text: (filter === "closed" ? "\u2705 " : "") + "\u0628\u0633\u062A\u0647\u200C\u0634\u062F\u0647", callback_data: "v2:admin:tickets:closed:0" },
    { text: (filter === "all" ? "\u2705 " : "") + "\u0647\u0645\u0647", callback_data: "v2:admin:tickets:all:0" }
  ];
  const pages3 = [];
  if (page > 0) pages3.push({ text: "\u25C0\uFE0F \u0642\u0628\u0644\u06CC", callback_data: "v2:admin:tickets:" + filter + ":" + (page - 1) });
  if (page < last) pages3.push({ text: "\u0628\u0639\u062F\u06CC \u25B6\uFE0F", callback_data: "v2:admin:tickets:" + filter + ":" + (page + 1) });
  const buttons = [
    optionsRow,
    optionsRow2,
    ...rows.map((row) => [{
      text: statusSymbol(row.state) + " " + shortCode(row.id, 14) + " \xB7 " + shortCode(row.subject, 22),
      callback_data: "v2:ticket:view:" + row.id
    }]),
    ...pages3.length ? [pages3] : []
  ];
  return staffResponse(
    panelHeading("\u{1F4AC}", "\u0635\u0646\u062F\u0648\u0642 \u067E\u0634\u062A\u06CC\u0628\u0627\u0646\u06CC", "\u062F\u0631\u062E\u0648\u0627\u0633\u062A\u200C\u0647\u0627 \u062A\u0641\u06A9\u06CC\u06A9\u200C\u0634\u062F\u0647 \u0648 \u0642\u0627\u0628\u0644 \u067E\u06CC\u06AF\u06CC\u0631\u06CC\u200C\u0627\u0646\u062F") + "\n\n\u{1F535} \u0646\u06CC\u0627\u0632\u0645\u0646\u062F \u067E\u0627\u0633\u062E: " + faNumber(open?.n ?? 0) + "\n\u{1F7E1} \u0645\u0646\u062A\u0638\u0631 \u0645\u0634\u062A\u0631\u06CC: " + faNumber(waiting?.n ?? 0) + "\n\u26AA \u0628\u0633\u062A\u0647\u200C\u0634\u062F\u0647: " + faNumber(closed?.n ?? 0) + "\n\n\u{1F4C2} " + options[filter].name + " \xB7 \u0635\u0641\u062D\u0647 " + faNumber(page + 1) + " \u0627\u0632 " + faNumber(last + 1) + "\n" + (rows.length ? "\u0628\u0631\u0627\u06CC \u0645\u0634\u0627\u0647\u062F\u0647 \u06AF\u0641\u062A\u200C\u0648\u06AF\u0648 \u06CC\u06A9 \u062F\u0631\u062E\u0648\u0627\u0633\u062A \u0631\u0627 \u0627\u0646\u062A\u062E\u0627\u0628 \u06A9\u0646\u06CC\u062F." : "\u062F\u0631 \u0627\u06CC\u0646 \u062F\u0633\u062A\u0647 \u062F\u0631\u062E\u0648\u0627\u0633\u062A\u06CC \u0648\u062C\u0648\u062F \u0646\u062F\u0627\u0631\u062F."),
    e,
    env,
    buttons
  );
}
__name(supportInbox, "supportInbox");
async function staffCanReply(db, e, env) {
  return adminAllowed(env.ADMIN_TELEGRAM_IDS, e.actorId) || await isStaff(db, e, "support");
}
__name(staffCanReply, "staffCanReply");
async function startTicketReply(db, e, id, nowMs, env) {
  const ticket = await db.prepare(
    "SELECT id,customer_telegram_id,subject,state FROM support_tickets WHERE id=?"
  ).bind(id).first();
  if (!ticket || ticket.state === "closed") return staffResponse("\u0627\u06CC\u0646 \u062F\u0631\u062E\u0648\u0627\u0633\u062A \u0628\u0633\u062A\u0647 \u0634\u062F\u0647 \u06CC\u0627 \u062F\u0631 \u062F\u0633\u062A\u0631\u0633 \u0646\u06CC\u0633\u062A.", e, env);
  await db.prepare(
    "INSERT INTO support_staff_sessions(telegram_id,ticket_id,expires_ms) VALUES(?,?,?) ON CONFLICT(telegram_id) DO UPDATE SET ticket_id=excluded.ticket_id,expires_ms=excluded.expires_ms"
  ).bind(e.actorId, id, nowMs + 10 * 60 * 1e3).run();
  return staffResponse("\u2709\uFE0F  \u067E\u0627\u0633\u062E \u0628\u0647 \u062F\u0631\u062E\u0648\u0627\u0633\u062A " + id + "\n\u0645\u0648\u0636\u0648\u0639: " + ticket.subject.slice(0, 140) + "\n\n\u067E\u0627\u0633\u062E \u062E\u0648\u062F \u0631\u0627 \u062F\u0631 \u06CC\u06A9 \u067E\u06CC\u0627\u0645 \u0628\u0641\u0631\u0633\u062A\u06CC\u062F. \u0645\u0647\u0644\u062A: \u06F1\u06F0 \u062F\u0642\u06CC\u0642\u0647.\n\u{1F510} \u0647\u0631\u06AF\u0632 \u0631\u0645\u0632 \u0639\u0628\u0648\u0631 \u06CC\u0627 \u06A9\u0644\u06CC\u062F \u062E\u0635\u0648\u0635\u06CC \u062F\u0631\u062E\u0648\u0627\u0633\u062A \u0646\u06A9\u0646\u06CC\u062F.", e, env);
}
__name(startTicketReply, "startTicketReply");
async function staffReply(db, e, env, nowMs) {
  const text = e.inputText;
  if (typeof text !== "string" || !text.trim() || text.startsWith("/") || text.startsWith("v2:") || !await staffCanReply(db, e, env)) return null;
  const session = await db.prepare(
    "SELECT ticket_id,expires_ms FROM support_staff_sessions WHERE telegram_id=?"
  ).bind(e.actorId).first();
  if (!session) return null;
  if (session.expires_ms < nowMs) {
    await db.prepare("DELETE FROM support_staff_sessions WHERE telegram_id=?").bind(e.actorId).run();
    return staffResponse("\u231B \u0632\u0645\u0627\u0646 \u067E\u0627\u0633\u062E\u200C\u06AF\u0648\u06CC\u06CC \u067E\u0627\u06CC\u0627\u0646 \u06CC\u0627\u0641\u062A\u0647 \u0627\u0633\u062A\u061B \u062F\u0631\u062E\u0648\u0627\u0633\u062A \u0631\u0627 \u062F\u0648\u0628\u0627\u0631\u0647 \u0628\u0627\u0632 \u06A9\u0646\u06CC\u062F.", e, env);
  }
  const ticket = await db.prepare(
    "SELECT id,customer_telegram_id,state FROM support_tickets WHERE id=?"
  ).bind(session.ticket_id).first();
  if (!ticket || ticket.state === "closed") {
    await db.prepare("DELETE FROM support_staff_sessions WHERE telegram_id=?").bind(e.actorId).run();
    return staffResponse("\u0627\u06CC\u0646 \u062F\u0631\u062E\u0648\u0627\u0633\u062A \u0628\u0633\u062A\u0647 \u0634\u062F\u0647 \u0627\u0633\u062A\u061B \u067E\u06CC\u0627\u0645\u06CC \u0627\u0631\u0633\u0627\u0644 \u0646\u0634\u062F.", e, env);
  }
  const body3 = text.trim().slice(0, 1e3);
  await db.batch([
    db.prepare(
      "INSERT OR IGNORE INTO support_messages(id,ticket_id,sender_telegram_id,body,role) VALUES(?,?,?,?,'support')"
    ).bind("message:" + e.updateId, ticket.id, e.actorId, body3),
    db.prepare(
      "INSERT OR IGNORE INTO telegram_notifications(id,chat_id,body,state,due_ms) VALUES(?,?,?,'pending',?)"
    ).bind(
      "support:" + e.updateId,
      ticket.customer_telegram_id,
      "\u{1F4AC} \u067E\u0627\u0633\u062E \u067E\u0634\u062A\u06CC\u0628\u0627\u0646\u06CC \u0645\u062F\u0627\u0631 \u0628\u0647 \u062F\u0631\u062E\u0648\u0627\u0633\u062A " + ticket.id + ":\n\n" + body3,
      nowMs
    ),
    db.prepare(
      "UPDATE support_tickets SET state='waiting' WHERE id=? AND state='open'"
    ).bind(ticket.id),
    db.prepare("DELETE FROM support_staff_sessions WHERE telegram_id=?").bind(e.actorId),
    db.prepare(
      "INSERT OR IGNORE INTO audit_events(event_id,actor_id,object_type,object_id,verb) VALUES(?,?,?,?,?)"
    ).bind("support:reply:" + e.updateId, e.actorId, "support_ticket", ticket.id, "reply")
  ]);
  return staffResponse("\u2705 \u067E\u0627\u0633\u062E \u0628\u0631\u0627\u06CC \u0645\u0634\u062A\u0631\u06CC \u0627\u0631\u0633\u0627\u0644 \u0634\u062F.\n\u0634\u0646\u0627\u0633\u0647 \u062F\u0631\u062E\u0648\u0627\u0633\u062A: " + ticket.id, e, env);
}
__name(staffReply, "staffReply");
async function closeSupport(db, e, id, nowMs, env) {
  const ticket = await db.prepare(
    "SELECT id,state,customer_telegram_id FROM support_tickets WHERE id=?"
  ).bind(id).first();
  if (!ticket) return staffResponse("\u062F\u0631\u062E\u0648\u0627\u0633\u062A \u0645\u0648\u0631\u062F\u0646\u0638\u0631 \u067E\u06CC\u062F\u0627 \u0646\u0634\u062F.", e, env);
  if (ticket.state === "closed") return staffResponse("\u0627\u06CC\u0646 \u062F\u0631\u062E\u0648\u0627\u0633\u062A \u0642\u0628\u0644\u0627\u064B \u0628\u0633\u062A\u0647 \u0634\u062F\u0647 \u0627\u0633\u062A.", e, env);
  await db.batch([
    db.prepare(
      "UPDATE support_tickets SET state='closed' WHERE id=? AND state IN ('open','waiting')"
    ).bind(id),
    db.prepare(
      "INSERT OR IGNORE INTO telegram_notifications(id,chat_id,body,state,due_ms) VALUES(?,?,?,'pending',?)"
    ).bind(
      "support:closed:" + id,
      ticket.customer_telegram_id,
      "\u2705 \u062F\u0631\u062E\u0648\u0627\u0633\u062A \u067E\u0634\u062A\u06CC\u0628\u0627\u0646\u06CC " + id + " \u0628\u0633\u062A\u0647 \u0634\u062F. \u062F\u0631 \u0635\u0648\u0631\u062A \u0646\u06CC\u0627\u0632\u060C \u062F\u0631\u062E\u0648\u0627\u0633\u062A \u062A\u0627\u0632\u0647\u200C\u0627\u06CC \u062B\u0628\u062A \u06A9\u0646\u06CC\u062F.",
      nowMs
    ),
    db.prepare(
      "INSERT OR IGNORE INTO audit_events(event_id,actor_id,object_type,object_id,verb) VALUES(?,?,?,?,?)"
    ).bind("support:close:" + id, e.actorId, "support_ticket", id, "close")
  ]);
  return staffResponse("\u2705 \u062F\u0631\u062E\u0648\u0627\u0633\u062A \u067E\u0634\u062A\u06CC\u0628\u0627\u0646\u06CC \u0628\u0633\u062A\u0647 \u0634\u062F.\n\u0634\u0646\u0627\u0633\u0647: " + id, e, env);
}
__name(closeSupport, "closeSupport");
async function personalizedHome(env, e, customerView = false) {
  const isAdmin = adminAllowed(env.ADMIN_TELEGRAM_IDS, e.actorId);
  if (isAdmin && !customerView) return adminDashboard(env, e);
  const seller = await isStaff(env.DB, e, "seller");
  const supportAgent = await isStaff(env.DB, e, "support");
  const [active, customer, latestOrder] = await Promise.all([
    env.DB.prepare(
      "SELECT COUNT(*) AS n FROM subscriptions WHERE owner_telegram_id=? AND state='active' AND expires_at>?"
    ).bind(e.actorId, Date.now()).first(),
    env.DB.prepare("SELECT state FROM customers WHERE telegram_id=?").bind(e.actorId).first(),
    env.DB.prepare(
      "SELECT id,state FROM orders WHERE customer_telegram_id=? ORDER BY created_at DESC LIMIT 1"
    ).bind(e.actorId).first()
  ]);
  const activeCount = Number(active?.n ?? 0);
  const greeting = isAdmin && !customerView ? "\u{1F6E0} \u062E\u0648\u0634 \u0622\u0645\u062F\u06CC\u062F\u060C \u0645\u062F\u06CC\u0631 \u0645\u062F\u0627\u0631" : "\u{1F310} \u0628\u0647 \u0645\u062F\u0627\u0631 \u062E\u0648\u0634 \u0622\u0645\u062F\u06CC\u062F";
  const state = activeCount > 0 ? "\u{1F7E2} \u0627\u0634\u062A\u0631\u0627\u06A9\u200C\u0647\u0627\u06CC \u0641\u0639\u0627\u0644 \u0634\u0645\u0627: " + faNumber(activeCount) : "\u{1F4E6} \u062F\u0631 \u062D\u0627\u0644 \u062D\u0627\u0636\u0631 \u0627\u0634\u062A\u0631\u0627\u06A9 \u0641\u0639\u0627\u0644\u06CC \u062F\u0631 \u0627\u06CC\u0646 \u0646\u0633\u062E\u0647 \u0646\u062F\u0627\u0631\u06CC\u062F.";
  const orderHint = latestOrder ? "\u{1F9FE} \u0622\u062E\u0631\u06CC\u0646 \u0633\u0641\u0627\u0631\u0634: " + faStatus(latestOrder.state) + " \xB7 " + shortCode(latestOrder.id, 14) : "\u{1F9FE} \u0647\u0646\u0648\u0632 \u0633\u0641\u0627\u0631\u0634\u06CC \u062B\u0628\u062A \u0646\u06A9\u0631\u062F\u0647\u200C\u0627\u06CC\u062F.";
  const safety = !salesConfigured(env) ? "\u26D4 \u0641\u0631\u0648\u0634 \u0639\u0645\u0648\u0645\u06CC \u0647\u0646\u0648\u0632 \u0641\u0639\u0627\u0644 \u0646\u0634\u062F\u0647 \u0627\u0633\u062A\u061B \u062A\u0627 \u062A\u0623\u06CC\u06CC\u062F \u0627\u062A\u0635\u0627\u0644\u060C \u0638\u0631\u0641\u06CC\u062A \u0648 \u06A9\u0646\u062A\u0631\u0644 \u0645\u0635\u0631\u0641\u060C \u0647\u06CC\u0686 \u067E\u0631\u062F\u0627\u062E\u062A\u06CC \u0627\u0646\u062C\u0627\u0645 \u0646\u062F\u0647\u06CC\u062F." : "\u0628\u0631\u0627\u06CC \u0645\u0634\u0627\u0647\u062F\u0647 \u0628\u0633\u062A\u0647\u200C\u0647\u0627\u060C \u0628\u062E\u0634 \u062E\u0631\u06CC\u062F \u0627\u0634\u062A\u0631\u0627\u06A9 \u0631\u0627 \u0627\u0646\u062A\u062E\u0627\u0628 \u06A9\u0646\u06CC\u062F.";
  const restriction = customer?.state === "suspended" ? "\n\u26D4 \u062D\u0633\u0627\u0628 \u0634\u0645\u0627 \u062A\u0639\u0644\u06CC\u0642 \u0634\u062F\u0647 \u0627\u0633\u062A\u061B \u062F\u0633\u062A\u0631\u0633\u06CC \u0628\u0647 \u067E\u0634\u062A\u06CC\u0628\u0627\u0646\u06CC \u0647\u0645\u0686\u0646\u0627\u0646 \u0628\u0631\u0642\u0631\u0627\u0631 \u0627\u0633\u062A." : "";
  const menu = customerView ? botMenu() : isAdmin ? adminMenu() : supportAgent ? supportMenu() : seller ? sellerMenu() : botMenu();
  const quick = [
    ...isAdmin ? [[{ text: "\u{1F4CA} \u067E\u06CC\u0634\u062E\u0648\u0627\u0646 \u0645\u062F\u06CC\u0631\u06CC\u062A", callback_data: "v2:admin:home" }]] : [],
    ...isAdmin && !customerView ? [[{ text: "\u{1F464} \u0645\u0634\u0627\u0647\u062F\u0647 \u0646\u0645\u0627\u06CC \u0645\u0634\u062A\u0631\u06CC", callback_data: "v2:customer:home" }]] : [],
    ...seller ? [[{ text: "\u{1F9D1}\u200D\u{1F4BC} \u0648\u0631\u0648\u062F \u0628\u0647 \u067E\u0646\u0644 \u0641\u0631\u0648\u0634\u0646\u062F\u0647", callback_data: "v2:seller:home" }]] : []
  ];
  const homeLines = [
    panelHeading("\u{1F44B}", "\u067E\u0646\u0644 \u06A9\u0627\u0631\u0628\u0631\u06CC \u0645\u062F\u0627\u0631", "\u0627\u0634\u062A\u0631\u0627\u06A9 \u0648 \u0633\u0641\u0627\u0631\u0634\u200C\u0647\u0627\u06CC \u0634\u0645\u0627\u060C \u06CC\u06A9\u062C\u0627"),
    "",
    greeting,
    state,
    orderHint,
    "",
    safety + restriction
  ];
  return {
    text: frameMessage(homeLines.join("\n")),
    photoId: BRAND_BANNER_URL,
    replyMarkup: { inline_keyboard: [...quick, ...menu.inline_keyboard] }
  };
}
__name(personalizedHome, "personalizedHome");
async function liveServiceStatus(env, e, nowMs) {
  const ready = (await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM nodes n WHERE n.lifecycle='ready' AND EXISTS(SELECT 1 FROM routes r WHERE r.node_id=n.id AND r.state='ready' AND r.verified_ms BETWEEN ? AND ?)"
  ).bind(nowMs - 6e5, nowMs).first())?.n ?? 0;
  return response3(panelHeading("\u{1F4F6}", "\u0648\u0636\u0639\u06CC\u062A \u0633\u0631\u0648\u06CC\u0633 \u0645\u062F\u0627\u0631", "\u067E\u0627\u06CC\u0634 \u0645\u0633\u06CC\u0631\u0647\u0627\u06CC \u062A\u0623\u06CC\u06CC\u062F\u0634\u062F\u0647") + "\n\n" + (ready > 0 ? "\u{1F7E2} \u0645\u0633\u06CC\u0631\u0647\u0627\u06CC \u062F\u0627\u0631\u0627\u06CC \u062A\u0623\u06CC\u06CC\u062F \u062A\u0627\u0632\u0647 \u062F\u0631 \u06F1\u06F0 \u062F\u0642\u06CC\u0642\u0647 \u0627\u062E\u06CC\u0631: " + faNumber(ready) : "\u{1F7E0} \u062F\u0631 \u062D\u0627\u0644 \u062D\u0627\u0636\u0631 \u0645\u0633\u06CC\u0631 \u062A\u0623\u06CC\u06CC\u062F\u0634\u062F\u0647 \u062A\u0627\u0632\u0647\u200C\u0627\u06CC \u0628\u0631\u0627\u06CC \u0641\u0631\u0648\u0634 \u0639\u0645\u0648\u0645\u06CC \u0648\u062C\u0648\u062F \u0646\u062F\u0627\u0631\u062F.") + "\n\n\u0646\u0635\u0628 \u0622\u0632\u0645\u0627\u06CC\u0634\u06CC \u06CC\u0627 \u062F\u0631\u06CC\u0627\u0641\u062A \u0644\u06CC\u0646\u06A9 \u062A\u0633\u062A \u0628\u0647\u200C\u062A\u0646\u0647\u0627\u06CC\u06CC \u0628\u0647 \u0645\u0639\u0646\u06CC \u0622\u0645\u0627\u062F\u0647\u200C\u0628\u0648\u062F\u0646 \u0633\u0631\u0648\u06CC\u0633 \u067E\u0648\u0644\u06CC \u0646\u06CC\u0633\u062A.", e.locale);
}
__name(liveServiceStatus, "liveServiceStatus");
async function resolveBotAction(env, e, nowMs = Date.now()) {
  const db = env.DB;
  if (!db || !e || !/^\d+$/.test(e.actorId ?? "")) throw new Error("invalid_event");
  await upsertCustomer(db, e);
  e = { ...e, locale: "fa" };
  const key = e.key ?? "";
  if (!await isCustomerActive(db, e.actorId) && !["/start", "home", "support", "/support", "customer:tickets", "/tickets", "lang", "/lang"].includes(key) && !key.startsWith("lang:") && !key.startsWith("customer:ticket:") && !key.startsWith("customer:ticket:reply:") && !((typeof e.inputText === "string" || !!e.photoId) && (!!await db.prepare(
    "SELECT 1 AS ok FROM customer_sessions WHERE telegram_id=? AND mode='support' AND expires_ms>?"
  ).bind(e.actorId, nowMs).first() || !!await db.prepare(
    "SELECT 1 AS ok FROM v2_bot_input_sessions WHERE telegram_id=? AND mode='ticket_reply' AND expires_ms>?"
  ).bind(e.actorId, nowMs).first())))
    return response3("\u26D4 \u062D\u0633\u0627\u0628 \u0634\u0645\u0627 \u062A\u0639\u0644\u06CC\u0642 \u0634\u062F\u0647 \u0627\u0633\u062A. \u0628\u0631\u0627\u06CC \u067E\u06CC\u06AF\u06CC\u0631\u06CC \u0647\u0645\u0686\u0646\u0627\u0646 \u0645\u06CC\u200C\u062A\u0648\u0627\u0646\u06CC\u062F \u0627\u0632 \u0628\u062E\u0634 \u067E\u0634\u062A\u06CC\u0628\u0627\u0646\u06CC \u0627\u0633\u062A\u0641\u0627\u062F\u0647 \u06A9\u0646\u06CC\u062F.", e.locale);
  if (key === "lang" || key === "/lang" || key === "lang:fa" || key === "lang:en")
    return response3("\u{1F310} \u0632\u0628\u0627\u0646 \u0631\u0628\u0627\u062A \u0645\u062F\u0627\u0631 \u0641\u0627\u0631\u0633\u06CC \u0627\u0633\u062A \u0648 \u0647\u0645\u0647 \u067E\u06CC\u0627\u0645\u200C\u0647\u0627 \u0628\u0647 \u0632\u0628\u0627\u0646 \u0641\u0627\u0631\u0633\u06CC \u0646\u0645\u0627\u06CC\u0634 \u062F\u0627\u062F\u0647 \u0645\u06CC\u200C\u0634\u0648\u0646\u062F.", e.locale);
  const botActivationReply = /* @__PURE__ */ __name((prompt2) => ({
    text: frameMessage(prompt2.text),
    replyMarkup: prompt2.replyMarkup
  }), "botActivationReply");
  if (key === "activation:check") {
    const activation = await checkAndActivateBot(env, e.actorId, nowMs);
    if (activation.state === "activated") {
      const home = await personalizedHome(env, e);
      const body3 = home.text.startsWith("\u{1F310}  \u0645\u0640\u0640\u062F\u0627\u0631\n") ? home.text.slice("\u{1F310}  \u0645\u0640\u0640\u062F\u0627\u0631\n".length) : home.text;
      return { ...home, text: frameMessage(
        "\u2705 \u0639\u0636\u0648\u06CC\u062A \u0634\u0645\u0627 \u062F\u0631 \u06A9\u0627\u0646\u0627\u0644 \u0627\u0637\u0644\u0627\u0639\u200C\u0631\u0633\u0627\u0646\u06CC \u062A\u0623\u06CC\u06CC\u062F \u0634\u062F \u0648 \u0631\u0628\u0627\u062A \u0645\u062F\u0627\u0631 \u0628\u0631\u0627\u06CC \u062D\u0633\u0627\u0628 \u0634\u0645\u0627 \u0641\u0639\u0627\u0644 \u0627\u0633\u062A. \u0627\u06A9\u0646\u0648\u0646 \u0645\u06CC\u200C\u062A\u0648\u0627\u0646\u06CC\u062F \u0628\u0647 \u0627\u067E \u0645\u062F\u0627\u0631 \u0628\u0631\u06AF\u0631\u062F\u06CC\u062F \u0648 \u0648\u0631\u0648\u062F \u0631\u0627 \u0627\u0646\u062C\u0627\u0645 \u062F\u0647\u06CC\u062F.\n\n" + body3
      ) };
    }
    if (activation.state === "not_member")
      return botActivationReply(activationPrompt(env, "v2:activation:check", "bot"));
    if (activation.state === "unconfigured")
      return botActivationReply(activationPrompt(env, "v2:activation:check", "bot"));
    return botActivationReply(activationUnavailableReply(env, "v2:activation:check"));
  }
  if (key === "/start") {
    if (!adminAllowed(env.ADMIN_TELEGRAM_IDS, e.actorId) && !await isBotActivated(db, e.actorId)) {
      const activation = await checkAndActivateBot(env, e.actorId, nowMs);
      if (activation.state === "not_member" || activation.state === "unconfigured")
        return botActivationReply(activationPrompt(env, "v2:activation:check", "bot"));
      if (activation.state !== "activated")
        return botActivationReply(activationUnavailableReply(env, "v2:activation:check"));
    }
    const referral = await linkSellerOnStart(db, e, nowMs);
    const home = await personalizedHome(env, e);
    return referral ? { ...home, text: home.text + "\n\n" + referral } : home;
  }
  if (!adminAllowed(env.ADMIN_TELEGRAM_IDS, e.actorId) && !await isBotActivated(db, e.actorId))
    return botActivationReply(activationPrompt(env, "v2:activation:check", "bot"));
  if (e.photoId) {
    const image = await receiveSupportPhoto(env, e, nowMs);
    if (image) return image;
    return storeReceipt(db, e, env);
  }
  const customerImage = key.match(/^customer:ticket:media:([0-9]{1,20})$/);
  if (customerImage) return viewSupportPhoto(env, e, customerImage[1], true);
  const customer = await customerTicketAction(env, e, nowMs);
  if (customer) return customer;
  const adminPanel2 = await adminPanelAction(env, e, nowMs);
  if (adminPanel2) return adminPanel2;
  const panelInput = await consumePanelInput(env, e, nowMs);
  if (panelInput) return panelInput;
  if (key === "/cancel") {
    await db.batch([
      db.prepare("DELETE FROM customer_sessions WHERE telegram_id=?").bind(e.actorId),
      db.prepare("DELETE FROM admin_node_sessions WHERE telegram_id=?").bind(e.actorId)
    ]);
    await db.prepare("DELETE FROM support_staff_sessions WHERE telegram_id=?").bind(e.actorId).run();
    return response3(t("\u2705 \u0639\u0645\u0644\u06CC\u0627\u062A \u0644\u063A\u0648 \u0634\u062F.", "\u2705 Cancelled.", e.locale), e.locale);
  }
  if (key === "admin:node:new" || key === "admin:node:cancel") {
    if (!adminAllowed(env.ADMIN_TELEGRAM_IDS, e.actorId))
      return adminResponse("\u26D4 \u062F\u0633\u062A\u0631\u0633\u06CC \u0628\u0647 \u0627\u06CC\u0646 \u0628\u062E\u0634 \u0645\u062C\u0627\u0632 \u0646\u06CC\u0633\u062A.", e.locale);
    if (key === "admin:node:cancel") {
      await cancelNodeWizard(db, e.actorId);
      const overview = await nodeOverview(db);
      return adminResponse(overview.text, e.locale, overview.replyMarkup.inline_keyboard);
    }
    const panel5 = await beginNodeWizard(db, e.actorId, nowMs, env);
    return adminResponse(panel5.text, e.locale, panel5.replyMarkup?.inline_keyboard ?? []);
  }
  if (adminAllowed(env.ADMIN_TELEGRAM_IDS, e.actorId)) {
    const wizard = await consumeNodeWizard(db, e.actorId, e.inputText, nowMs, env);
    if (wizard) return adminResponse(wizard.text, e.locale);
  }
  const sellerAction = await handleSeller(env, e, nowMs);
  if (sellerAction) return sellerAction;
  if (key === "/seller_grant" || key === "/support_grant") {
    if (!adminAllowed(env.ADMIN_TELEGRAM_IDS, e.actorId))
      return adminResponse("\u26D4 \u062F\u0633\u062A\u0631\u0633\u06CC \u0628\u0647 \u0627\u06CC\u0646 \u0628\u062E\u0634 \u0645\u062C\u0627\u0632 \u0646\u06CC\u0633\u062A.", e.locale);
    const id = e.inputText?.trim().split(/\s+/)[1] ?? "";
    const role = key === "/seller_grant" ? "seller" : "support";
    if (!await grantStaffRole(db, e, role, id))
      return adminResponse("\u26A0\uFE0F \u0634\u0646\u0627\u0633\u0647 \u062A\u0644\u06AF\u0631\u0627\u0645 \u0645\u0639\u062A\u0628\u0631 \u0646\u06CC\u0633\u062A. \u062F\u0633\u062A\u0648\u0631 \u0631\u0627 \u0647\u0645\u0631\u0627\u0647 \u0634\u0646\u0627\u0633\u0647 \u0639\u062F\u062F\u06CC \u0628\u0641\u0631\u0633\u062A\u06CC\u062F.", e.locale);
    return adminResponse("\u2705 \u062F\u0633\u062A\u0631\u0633\u06CC " + faRole(role) + " \u0628\u0631\u0627\u06CC \u0634\u0646\u0627\u0633\u0647 " + id + " \u0641\u0639\u0627\u0644 \u0634\u062F.", e.locale);
  }
  if (key === "admin:configs" || key.startsWith("admin:configs:")) {
    if (!adminAllowed(env.ADMIN_TELEGRAM_IDS, e.actorId))
      return adminResponse("\u26D4 \u062F\u0633\u062A\u0631\u0633\u06CC \u0628\u0647 \u0627\u06CC\u0646 \u0628\u062E\u0634 \u0645\u062C\u0627\u0632 \u0646\u06CC\u0633\u062A.", e.locale);
    return adminConfigAction(env, e, nowMs);
  }
  if (/^admin:nodes:(all|ready|setup|testing|attention|quarantine|archive):[0-9]{1,4}$/.test(key)) {
    if (!adminAllowed(env.ADMIN_TELEGRAM_IDS, e.actorId))
      return adminResponse("\u26D4 \u062F\u0633\u062A\u0631\u0633\u06CC \u0628\u0647 \u0627\u06CC\u0646 \u0628\u062E\u0634 \u0645\u062C\u0627\u0632 \u0646\u06CC\u0633\u062A.", e.locale);
    const [, , filter, page] = key.split(":");
    const list = await nodeOverview(db, { filter, page: Number(page) });
    return adminResponse(list.text, e.locale, list.replyMarkup.inline_keyboard);
  }
  if (key.startsWith("admin:node:view:") || /^admin:node:(confirm|apply|trialref|field|fieldapply):/.test(key)) {
    if (!adminAllowed(env.ADMIN_TELEGRAM_IDS, e.actorId))
      return adminResponse("\u26D4 \u062F\u0633\u062A\u0631\u0633\u06CC \u0628\u0647 \u0627\u06CC\u0646 \u0628\u062E\u0634 \u0645\u062C\u0627\u0632 \u0646\u06CC\u0633\u062A.", e.locale);
    let panel5;
    const view3 = key.match(/^admin:node:view:([a-f0-9]{24})$/);
    const manage = key.match(/^admin:node:(confirm|apply):(quarantine|restore|retire):([a-f0-9]{24})$/);
    const trial = key.match(/^admin:node:trialref:([a-f0-9]{24})$/);
    const field = key.match(/^admin:node:(field|fieldapply):(mci|irancell):([a-f0-9]{24})$/);
    if (view3) panel5 = await nodeDetails(db, view3[1], e.actorId, env);
    else if (manage)
      panel5 = await nodeManagement(
        db,
        e.actorId,
        manage[3],
        manage[2],
        manage[1] === "apply",
        e.updateId
      );
    else if (field)
      panel5 = await nodeFieldAction(
        env,
        e.actorId,
        field[3],
        field[2],
        field[1] === "fieldapply",
        nowMs
      );
    else if (trial) {
      const node = await nodeFromRef(db, trial[1]);
      const job = node ? await db.prepare(
        "SELECT state,owner_id FROM node_bootstrap_jobs WHERE node_id=?"
      ).bind(node.id).first() : null;
      if (!node || !job || job.state !== "installed" || job.owner_id !== e.actorId || ["quarantined", "retired"].includes(node.lifecycle))
        panel5 = { text: "\u26D4 \u0635\u062F\u0648\u0631 \u0644\u06CC\u0646\u06A9 \u062A\u0633\u062A \u0627\u06CC\u0646 \u0633\u0631\u0648\u0631 \u0645\u062C\u0627\u0632 \u0646\u06CC\u0633\u062A.", replyMarkup: { inline_keyboard: [] } };
      else {
        const url = await issueTrialLink(env, e.actorId, node.id, nowMs);
        panel5 = {
          text: url ? "\u{1F517} \u0644\u06CC\u0646\u06A9 \u062A\u0633\u062A \u0633\u0631\u0648\u0631 " + node.id + "\n" + url + "\n\n\u0627\u06CC\u0646 \u0644\u06CC\u0646\u06A9 \u0622\u0632\u0645\u0627\u06CC\u0634\u06CC \u0627\u0633\u062A \u0648 \u062A\u0623\u06CC\u06CC\u062F \u0622\u0645\u0627\u062F\u06AF\u06CC \u0641\u0631\u0648\u0634 \u0645\u062D\u0633\u0648\u0628 \u0646\u0645\u06CC\u200C\u0634\u0648\u062F." : "\u23F8 \u0644\u06CC\u0646\u06A9 \u062A\u0633\u062A \u0622\u0645\u0627\u062F\u0647 \u0646\u06CC\u0633\u062A. \u0646\u0635\u0628 \u0633\u0631\u0648\u0631 \u0648 \u0645\u0633\u06CC\u0631\u0647\u0627\u06CC \u0627\u067E\u0631\u0627\u062A\u0648\u0631\u0647\u0627 \u0631\u0627 \u0628\u0631\u0631\u0633\u06CC \u06A9\u0646\u06CC\u062F.",
          replyMarkup: { inline_keyboard: [] }
        };
      }
    } else panel5 = { text: "\u26A0\uFE0F \u062F\u0631\u062E\u0648\u0627\u0633\u062A \u0645\u062F\u06CC\u0631\u06CC\u062A \u0633\u0631\u0648\u0631 \u0645\u0639\u062A\u0628\u0631 \u0646\u06CC\u0633\u062A.", replyMarkup: { inline_keyboard: [] } };
    return adminResponse(panel5.text, e.locale, panel5.replyMarkup?.inline_keyboard ?? []);
  }
  if (key.startsWith("admin:node:trial:")) {
    if (!adminAllowed(env.ADMIN_TELEGRAM_IDS, e.actorId))
      return adminResponse("\u26D4 \u062F\u0633\u062A\u0631\u0633\u06CC \u0628\u0647 \u0627\u06CC\u0646 \u0628\u062E\u0634 \u0645\u062C\u0627\u0632 \u0646\u06CC\u0633\u062A.", e.locale);
    const id = key.slice("admin:node:trial:".length);
    const url = await issueTrialLink(env, e.actorId, id, nowMs);
    return url ? adminResponse("\u{1F517} \u0644\u06CC\u0646\u06A9 \u0622\u0632\u0645\u0627\u06CC\u0634\u06CC \u06CC\u06A9\u200C\u0633\u0627\u0639\u062A\u0647 \u0645\u062F\u0627\u0631\n" + url + "\n\n\u0627\u06CC\u0646 \u0644\u06CC\u0646\u06A9 \u062F\u0648 \u0645\u0633\u06CC\u0631 \u0647\u0645\u0631\u0627\u0647 \u0627\u0648\u0644 \u0648 \u0627\u06CC\u0631\u0627\u0646\u0633\u0644 \u0631\u0627 \u0641\u0642\u0637 \u0628\u0631\u0627\u06CC \u0622\u0632\u0645\u0648\u0646 \u0646\u0634\u0627\u0646 \u0645\u06CC\u200C\u062F\u0647\u062F\u061B \u0633\u0631\u0648\u0631 \u0647\u0646\u0648\u0632 \u0628\u0631\u0627\u06CC \u0641\u0631\u0648\u0634 \u062A\u0623\u06CC\u06CC\u062F \u0646\u0634\u062F\u0647 \u0627\u0633\u062A.", e.locale) : adminResponse("\u23F8 \u0646\u0635\u0628 \u06A9\u0627\u0645\u0644 \u0646\u0634\u062F\u0647 \u06CC\u0627 \u0644\u06CC\u0646\u06A9 \u0622\u0632\u0645\u0627\u06CC\u0634\u06CC \u0622\u0645\u0627\u062F\u0647 \u0646\u06CC\u0633\u062A. \u0648\u0636\u0639\u06CC\u062A \u0633\u0631\u0648\u0631 \u0648 \u0627\u062C\u0631\u0627\u06A9\u0646\u0646\u062F\u0647 \u0627\u0645\u0646 \u0631\u0627 \u0628\u0631\u0631\u0633\u06CC \u06A9\u0646\u06CC\u062F.", e.locale);
  }
  if (key === "/admin" || key === "admin:home") return adminDashboard(env, e);
  if (key === "admin:node:trials") {
    if (!adminAllowed(env.ADMIN_TELEGRAM_IDS, e.actorId))
      return adminResponse("\u26D4 \u062F\u0633\u062A\u0631\u0633\u06CC \u0628\u0647 \u0627\u06CC\u0646 \u0628\u062E\u0634 \u0645\u062C\u0627\u0632 \u0646\u06CC\u0633\u062A.", e.locale);
    const rows = (await db.prepare(
      "SELECT node_id,state FROM node_bootstrap_jobs ORDER BY created_ms DESC LIMIT 12"
    ).all()).results ?? [];
    if (!rows.length) return adminResponse("\u{1F9EA} \u0647\u0646\u0648\u0632 \u0633\u0631\u0648\u0631 \u0622\u0632\u0645\u0627\u06CC\u0634\u06CC \u0627\u0636\u0627\u0641\u0647 \u0646\u0634\u062F\u0647 \u0627\u0633\u062A.", e.locale);
    return adminResponse(
      "\u{1F9EA}  \u0644\u06CC\u0646\u06A9\u200C\u0647\u0627\u06CC \u0622\u0632\u0645\u0627\u06CC\u0634\u06CC \u0633\u0631\u0648\u0631\u0647\u0627\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n" + rows.map((x) => x.node_id + "  |  " + faStatus(x.state)).join("\n"),
      e.locale,
      rows.filter((x) => x.state === "installed").map((x) => [{
        text: "\u{1F517} \u062F\u0631\u06CC\u0627\u0641\u062A \u0644\u06CC\u0646\u06A9 " + x.node_id,
        callback_data: "v2:admin:node:trial:" + x.node_id
      }])
    );
  }
  if (key === "admin:plans") {
    if (!adminAllowed(env.ADMIN_TELEGRAM_IDS, e.actorId))
      return adminResponse("\u26D4 \u062F\u0633\u062A\u0631\u0633\u06CC \u0628\u0647 \u0627\u06CC\u0646 \u0628\u062E\u0634 \u0645\u062C\u0627\u0632 \u0646\u06CC\u0633\u062A.", e.locale);
    if (Number.isSafeInteger(e.messageId) && e.messageId > 0)
      await db.prepare("DELETE FROM v2_bot_input_sessions WHERE telegram_id=? AND mode='plan_draft'").bind(e.actorId).run();
    const plans = (await db.prepare(
      "SELECT id,title_fa,active,price_amount,price_currency FROM plans ORDER BY id LIMIT 12"
    ).all()).results ?? [];
    return adminResponse(panelHeading("\u{1F6CD}", "\u0645\u062F\u06CC\u0631\u06CC\u062A \u067E\u0644\u0646\u200C\u0647\u0627", "\u0642\u06CC\u0645\u062A\u200C\u06AF\u0630\u0627\u0631\u06CC \u0648 \u0627\u0646\u062A\u0634\u0627\u0631 \u0628\u0633\u062A\u0647\u200C\u0647\u0627") + "\n\n" + (plans.map((x) => statusSymbol(x.active ? "active" : "disabled") + " " + x.title_fa + "\n\u0634\u0646\u0627\u0633\u0647: " + x.id + "  \xB7  " + (x.active ? "\u0641\u0639\u0627\u0644" : "\u063A\u06CC\u0631\u0641\u0639\u0627\u0644") + "\n\u{1F4B3} " + money(x.price_amount, x.price_currency)).join("\n\n\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n\n") || "\u0647\u0646\u0648\u0632 \u067E\u0644\u0646\u06CC \u062B\u0628\u062A \u0646\u0634\u062F\u0647 \u0627\u0633\u062A.") + "\n\n\u067E\u0644\u0646 \u062A\u0627\u0632\u0647 \u0627\u0628\u062A\u062F\u0627 \u063A\u06CC\u0631\u0641\u0639\u0627\u0644 \u0633\u0627\u062E\u062A\u0647 \u0645\u06CC\u200C\u0634\u0648\u062F\u061B \u0627\u0646\u062A\u0634\u0627\u0631 \u0641\u0642\u0637 \u067E\u0633 \u0627\u0632 \u062A\u0623\u06CC\u06CC\u062F \u0638\u0631\u0641\u06CC\u062A \u0648 \u0635\u062F\u0648\u0631 \u0645\u062C\u0627\u0632 \u0627\u0633\u062A.", e.locale, [
      [{ text: "\u2795 \u0633\u0627\u062E\u062A \u067E\u0644\u0646 \u062C\u062F\u06CC\u062F", callback_data: "v2:admin:plan:new" }],
      ...plans.map((x) => [{
        text: (x.active ? "\u{1F534} \u063A\u06CC\u0631\u0641\u0639\u0627\u0644\u200C\u0633\u0627\u0632\u06CC " : "\u{1F7E2} \u0641\u0639\u0627\u0644\u200C\u0633\u0627\u0632\u06CC ") + x.title_fa.slice(0, 16),
        callback_data: "v2:admin:plan:confirm:" + (x.active ? "off:" : "on:") + x.id
      }])
    ]);
  }
  if (key === "/node_add_auto") {
    if (!adminAllowed(env.ADMIN_TELEGRAM_IDS, e.actorId))
      return adminResponse("\u26D4 \u062F\u0633\u062A\u0631\u0633\u06CC \u0628\u0647 \u0627\u06CC\u0646 \u0628\u062E\u0634 \u0645\u062C\u0627\u0632 \u0646\u06CC\u0633\u062A.", e.locale);
    const data = (e.inputText ?? "").replace(/^\/node_add_auto(?:@\w+)?\s*/, "").trim();
    const result = await enqueueAutoNode(env, e.actorId, data, nowMs);
    const errors = {
      bad_input: "\u0627\u0637\u0644\u0627\u0639\u0627\u062A \u0633\u0631\u0648\u0631 \u0628\u0627 \u0642\u0627\u0644\u0628 \u062E\u0648\u0627\u0633\u062A\u0647\u200C\u0634\u062F\u0647 \u0645\u0637\u0627\u0628\u0642\u062A \u0646\u062F\u0627\u0631\u062F.",
      not_ready: "\u067E\u0627\u06CC\u06AF\u0627\u0647 \u062F\u0627\u062F\u0647 \u0622\u0645\u0627\u062F\u0647 \u0646\u06CC\u0633\u062A.",
      automation_not_configured: "\u0627\u062A\u0635\u0627\u0644 \u0627\u062C\u0631\u0627\u06A9\u0646\u0646\u062F\u0647 \u0627\u0645\u0646 \u06A9\u0627\u0645\u0644 \u0646\u06CC\u0633\u062A.",
      already_exists: "\u0627\u06CC\u0646 \u0634\u0646\u0627\u0633\u0647 \u0633\u0631\u0648\u0631 \u0642\u0628\u0644\u0627\u064B \u062B\u0628\u062A \u0634\u062F\u0647 \u0627\u0633\u062A."
    };
    if (result.error) return adminResponse("\u26A0\uFE0F \u062B\u0628\u062A \u0627\u0646\u062C\u0627\u0645 \u0646\u0634\u062F.\n" + (errors[result.error] ?? "\u062E\u0637\u0627\u06CC \u067E\u06CC\u0634\u200C\u0628\u06CC\u0646\u06CC\u200C\u0646\u0634\u062F\u0647\u061B \u062A\u0646\u0638\u06CC\u0645\u0627\u062A \u0631\u0627 \u0628\u0631\u0631\u0633\u06CC \u06A9\u0646\u06CC\u062F."), e.locale);
    return adminResponse(result.dispatched ? "\u{1F680} \u062F\u0631\u062E\u0648\u0627\u0633\u062A \u0646\u0635\u0628 \u062E\u0648\u062F\u06A9\u0627\u0631 \u0633\u0631\u0648\u0631 " + result.id + " \u0628\u0647 \u0627\u062C\u0631\u0627\u06A9\u0646\u0646\u062F\u0647 \u0627\u0645\u0646 \u0627\u0631\u0633\u0627\u0644 \u0634\u062F." : "\u23F8 \u0633\u0631\u0648\u0631 " + result.id + " \u062B\u0628\u062A \u0634\u062F\u060C \u0627\u0645\u0627 \u0627\u062C\u0631\u0627\u06CC \u062E\u0648\u062F\u06A9\u0627\u0631 \u0647\u0646\u0648\u0632 \u0622\u063A\u0627\u0632 \u0646\u0634\u062F\u0647 \u0627\u0633\u062A.", e.locale);
  }
  if (key === "/node_add" || key === "/node_route" || key === "/nodes" || key === "admin:nodes") {
    if (!adminAllowed(env.ADMIN_TELEGRAM_IDS, e.actorId))
      return adminResponse("\u26D4 \u062F\u0633\u062A\u0631\u0633\u06CC \u0628\u0647 \u0627\u06CC\u0646 \u0628\u062E\u0634 \u0645\u062C\u0627\u0632 \u0646\u06CC\u0633\u062A.", e.locale);
    const result = await nodeAdminAction(db, e.actorId, key === "admin:nodes" ? "/nodes" : key, e.inputText);
    if (key === "admin:nodes" || key === "/nodes")
      return adminResponse(result.text, e.locale, result.replyMarkup?.inline_keyboard ?? []);
    return adminResponse(result.text, e.locale);
  }
  if (key === "/plan_add") {
    if (!adminAllowed(env.ADMIN_TELEGRAM_IDS, e.actorId))
      return adminResponse("\u26D4 \u062F\u0633\u062A\u0631\u0633\u06CC \u0628\u0647 \u0627\u06CC\u0646 \u0628\u062E\u0634 \u0645\u062C\u0627\u0632 \u0646\u06CC\u0633\u062A.", e.locale);
    const raw = (e.inputText ?? "").replace(/^\/plan_add\s*/, "").trim();
    const parts = raw.split("|").map((x) => x.trim());
    if (parts.length !== 5) return adminResponse(
      "\u0642\u0627\u0644\u0628 \u062F\u0631\u0633\u062A: /plan_add \u0634\u0646\u0627\u0633\u0647 \u0641\u0646\u06CC|\u0646\u0627\u0645 \u0641\u0627\u0631\u0633\u06CC|\u0642\u06CC\u0645\u062A \u062A\u0648\u0645\u0627\u0646|\u062D\u062C\u0645 \u06AF\u06CC\u06AF\u0627\u0628\u0627\u06CC\u062A|\u0645\u062F\u062A \u0631\u0648\u0632",
      e.locale
    );
    const [id, title, priceRaw, gbRaw, daysRaw] = parts;
    const numeric = /^(0|[1-9]\d*)$/;
    if (!PLAN_ID.test(id) || !title || title.length > 64 || !numeric.test(priceRaw) || !numeric.test(gbRaw) || !numeric.test(daysRaw))
      return adminResponse("\u26A0\uFE0F \u0627\u0637\u0644\u0627\u0639\u0627\u062A \u067E\u0644\u0646 \u0645\u0639\u062A\u0628\u0631 \u0646\u06CC\u0633\u062A\u061B \u0647\u06CC\u0686 \u062A\u063A\u06CC\u06CC\u0631\u06CC \u0627\u0646\u062C\u0627\u0645 \u0646\u0634\u062F.", e.locale);
    const price = Number(priceRaw), gb = Number(gbRaw), days = Number(daysRaw);
    if (!Number.isSafeInteger(price) || price > 1e11 || gb < 1 || gb > 2e3 || days < 1 || days > 366)
      return adminResponse("\u26A0\uFE0F \u0642\u06CC\u0645\u062A\u060C \u062D\u062C\u0645 \u06CC\u0627 \u0645\u062F\u062A \u062E\u0627\u0631\u062C \u0627\u0632 \u0645\u062D\u062F\u0648\u062F\u0647 \u0645\u062C\u0627\u0632 \u0627\u0633\u062A.", e.locale);
    const result = await db.batch([
      db.prepare("INSERT OR IGNORE INTO plans(id,title_fa,title_en,price_amount,price_currency,quota_bytes,duration_days,active) VALUES(?,?,?,?,?,?,?,0)").bind(id, title, title, price, "IRT", gb * 1073741824, days),
      db.prepare("INSERT OR IGNORE INTO audit_events(event_id,actor_id,object_type,object_id,verb) VALUES(?,?,?,?,?)").bind("plan:create:" + id, e.actorId, "plan", id, "create:disabled")
    ]);
    return adminResponse(result[0]?.meta?.changes === 1 ? "\u2705 \u067E\u0644\u0646 \u0628\u0627 \u0645\u0648\u0641\u0642\u06CC\u062A \u0648 \u062F\u0631 \u0648\u0636\u0639\u06CC\u062A \u063A\u06CC\u0631\u0641\u0639\u0627\u0644 \u062B\u0628\u062A \u0634\u062F." : "\u2139\uFE0F \u0627\u06CC\u0646 \u0634\u0646\u0627\u0633\u0647 \u067E\u0644\u0646 \u0642\u0628\u0644\u0627\u064B \u062B\u0628\u062A \u0634\u062F\u0647 \u0627\u0633\u062A\u061B \u062A\u063A\u06CC\u06CC\u0631\u06CC \u0627\u06CC\u062C\u0627\u062F \u0646\u0634\u062F.", e.locale);
  }
  if (key.startsWith("admin:plan:confirm:")) {
    if (!adminAllowed(env.ADMIN_TELEGRAM_IDS, e.actorId))
      return adminResponse("\u26D4 \u062F\u0633\u062A\u0631\u0633\u06CC \u0628\u0647 \u0627\u06CC\u0646 \u0628\u062E\u0634 \u0645\u062C\u0627\u0632 \u0646\u06CC\u0633\u062A.", e.locale);
    const m = key.match(/^admin:plan:confirm:(on|off):([a-zA-Z0-9_-]{2,30})$/);
    if (!m) return adminResponse("\u26A0\uFE0F \u0634\u0646\u0627\u0633\u0647 \u067E\u0644\u0646 \u0645\u0639\u062A\u0628\u0631 \u0646\u06CC\u0633\u062A.", e.locale);
    const [, mode, id] = m;
    const plan = await db.prepare(
      "SELECT id,title_fa,active,price_amount,price_currency FROM plans WHERE id=?"
    ).bind(id).first();
    if (!plan) return adminResponse("\u067E\u0644\u0646 \u0645\u0648\u0631\u062F\u0646\u0638\u0631 \u067E\u06CC\u062F\u0627 \u0646\u0634\u062F.", e.locale);
    if (Boolean(plan.active) === (mode === "on"))
      return adminResponse(
        "\u0627\u06CC\u0646 \u067E\u0644\u0646 \u0627\u0632 \u0642\u0628\u0644 \u062F\u0631 \u0648\u0636\u0639\u06CC\u062A \u0627\u0646\u062A\u062E\u0627\u0628\u200C\u0634\u062F\u0647 \u0642\u0631\u0627\u0631 \u062F\u0627\u0631\u062F.",
        e.locale,
        [[{ text: "\u{1F6CD} \u0641\u0647\u0631\u0633\u062A \u067E\u0644\u0646\u200C\u0647\u0627", callback_data: "v2:admin:plans" }]]
      );
    return adminResponse(
      "\u26A0\uFE0F  \u062A\u0623\u06CC\u06CC\u062F \u062A\u063A\u06CC\u06CC\u0631 \u067E\u0644\u0646\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n\u067E\u0644\u0646: " + plan.title_fa + "\n\u0642\u06CC\u0645\u062A: " + money(plan.price_amount, plan.price_currency) + "\n\u0648\u0636\u0639\u06CC\u062A \u06A9\u0646\u0648\u0646\u06CC: " + (plan.active ? "\u0641\u0639\u0627\u0644" : "\u063A\u06CC\u0631\u0641\u0639\u0627\u0644") + "\n\u0648\u0636\u0639\u06CC\u062A \u062F\u0631\u062E\u0648\u0627\u0633\u062A\u06CC: " + (mode === "on" ? "\u0641\u0639\u0627\u0644" : "\u063A\u06CC\u0631\u0641\u0639\u0627\u0644") + "\n\n\u0628\u0631\u0627\u06CC \u062C\u0644\u0648\u06AF\u06CC\u0631\u06CC \u0627\u0632 \u062A\u063A\u06CC\u06CC\u0631 \u0646\u0627\u062E\u0648\u0627\u0633\u062A\u0647\u060C \u062A\u0635\u0645\u06CC\u0645 \u062E\u0648\u062F \u0631\u0627 \u062A\u0623\u06CC\u06CC\u062F \u06A9\u0646\u06CC\u062F.",
      e.locale,
      [
        [{ text: "\u2705 \u062A\u0623\u06CC\u06CC\u062F \u062A\u063A\u06CC\u06CC\u0631 \u0648\u0636\u0639\u06CC\u062A", callback_data: "v2:plan:" + mode + ":" + id }],
        [{ text: "\u21A9\uFE0F \u0627\u0646\u0635\u0631\u0627\u0641", callback_data: "v2:admin:plans" }]
      ]
    );
  }
  if (key.startsWith("plan:on:") || key.startsWith("plan:off:")) {
    if (!adminAllowed(env.ADMIN_TELEGRAM_IDS, e.actorId))
      return adminResponse("\u26D4 \u062F\u0633\u062A\u0631\u0633\u06CC \u0628\u0647 \u0627\u06CC\u0646 \u0628\u062E\u0634 \u0645\u062C\u0627\u0632 \u0646\u06CC\u0633\u062A.", e.locale);
    const [, mode, id] = key.split(":");
    if (!PLAN_ID.test(id)) return adminResponse("\u26A0\uFE0F \u0634\u0646\u0627\u0633\u0647 \u067E\u0644\u0646 \u0645\u0639\u062A\u0628\u0631 \u0646\u06CC\u0633\u062A.", e.locale);
    const plan = await db.prepare("SELECT * FROM plans WHERE id=?").bind(id).first();
    if (!plan) return adminResponse("\u067E\u0644\u0646 \u0645\u0648\u0631\u062F\u0646\u0638\u0631 \u067E\u06CC\u062F\u0627 \u0646\u0634\u062F.", e.locale);
    if (mode === "on" && (!salesConfigured(env) || !await availableForSale(db, plan, nowMs)))
      return adminResponse("\u26D4 \u0627\u0645\u06A9\u0627\u0646 \u0641\u0639\u0627\u0644\u200C\u0633\u0627\u0632\u06CC \u067E\u0644\u0646 \u0648\u062C\u0648\u062F \u0646\u062F\u0627\u0631\u062F\u061B \u067E\u0631\u062F\u0627\u062E\u062A\u060C \u0646\u0635\u0628 \u0648 \u0638\u0631\u0641\u06CC\u062A \u0633\u0631\u0648\u0631 \u0647\u0646\u0648\u0632 \u0628\u0647\u200C\u0637\u0648\u0631 \u06A9\u0627\u0645\u0644 \u062A\u0623\u06CC\u06CC\u062F \u0646\u0634\u062F\u0647\u200C\u0627\u0646\u062F.", e.locale);
    await db.batch([
      db.prepare("UPDATE plans SET active=? WHERE id=?").bind(mode === "on" ? 1 : 0, id),
      db.prepare("INSERT OR IGNORE INTO audit_events(event_id,actor_id,object_type,object_id,verb) VALUES(?,?,?,?,?)").bind("plan:toggle:" + e.updateId, e.actorId, "plan", id, "toggle:" + mode)
    ]);
    return adminResponse("\u2705 \u0648\u0636\u0639\u06CC\u062A \u067E\u0644\u0646 " + id + " \u0628\u0647 " + (mode === "on" ? "\u0641\u0639\u0627\u0644" : "\u063A\u06CC\u0631\u0641\u0639\u0627\u0644") + " \u062A\u063A\u06CC\u06CC\u0631 \u06A9\u0631\u062F.", e.locale);
  }
  if (key === "home") return personalizedHome(env, e);
  if (key === "customer:home") return personalizedHome(env, e, true);
  if (key === "customer:trial") {
    const trial = await issueCustomerTrialLink(env, e.actorId, nowMs);
    if (trial.status === "issued") return response3(
      panelHeading("\u{1F9EA}", "\u062A\u0633\u062A \u0631\u0627\u06CC\u06AF\u0627\u0646 \u0645\u062F\u0627\u0631", "\u0627\u0639\u062A\u0628\u0627\u0631 \u0644\u06CC\u0646\u06A9: \u06CC\u06A9 \u0633\u0627\u0639\u062A") + "\n\n\u2705 \u062A\u0633\u062A \u06CC\u06A9\u200C\u0633\u0627\u0639\u062A\u0647 \u0634\u0645\u0627 \u0641\u0639\u0627\u0644 \u0634\u062F.\n\u06CC\u06A9 \u0644\u06CC\u0646\u06A9 \u0634\u0627\u0645\u0644 \u062F\u0648 \u0645\u0633\u06CC\u0631 \u0647\u0645\u0631\u0627\u0647 \u0627\u0648\u0644 \u0648 \u0627\u06CC\u0631\u0627\u0646\u0633\u0644 \u062F\u0631\u06CC\u0627\u0641\u062A \u0645\u06CC\u200C\u06A9\u0646\u06CC\u062F:\n\n" + trial.url + "\n\n\u062F\u0631 v2rayNG \u0627\u0632 \u0628\u062E\u0634 \u062A\u0646\u0638\u06CC\u0645\u0627\u062A \u0627\u0634\u062A\u0631\u0627\u06A9\u060C \u0644\u06CC\u0646\u06A9 \u0631\u0627 \u0627\u0636\u0627\u0641\u0647 \u0648 \u0628\u0647\u200C\u0631\u0648\u0632\u0631\u0633\u0627\u0646\u06CC \u06A9\u0646\u06CC\u062F.\n\u{1F510} \u0644\u06CC\u0646\u06A9 \u062E\u0635\u0648\u0635\u06CC \u0627\u0633\u062A \u0648 \u0641\u0642\u0637 \u06CC\u06A9 \u0628\u0627\u0631 \u0628\u0631\u0627\u06CC \u0627\u06CC\u0646 \u062D\u0633\u0627\u0628 \u0635\u0627\u062F\u0631 \u0645\u06CC\u200C\u0634\u0648\u062F.",
      e.locale
    );
    if (trial.status === "existing") return response3(
      panelHeading("\u{1F9EA}", "\u062A\u0633\u062A \u0631\u0627\u06CC\u06AF\u0627\u0646 \u0634\u0645\u0627", "\u0627\u06CC\u0646 \u062A\u0633\u062A \u0642\u0628\u0644\u0627\u064B \u0628\u0631\u0627\u06CC \u062D\u0633\u0627\u0628 \u0634\u0645\u0627 \u0635\u0627\u062F\u0631 \u0634\u062F\u0647 \u0627\u0633\u062A") + "\n\n\u0647\u0645\u0627\u0646 \u0644\u06CC\u0646\u06A9 \u0642\u0628\u0644\u06CC \u0647\u0646\u0648\u0632 \u062A\u0627 \u067E\u0627\u06CC\u0627\u0646 \u0645\u0647\u0644\u062A \u06CC\u06A9\u200C\u0633\u0627\u0639\u062A\u0647 \u0645\u0639\u062A\u0628\u0631 \u0627\u0633\u062A:\n\n" + trial.url + "\n\n\u067E\u0633 \u0627\u0632 \u067E\u0627\u06CC\u0627\u0646 \u0645\u0647\u0644\u062A\u060C \u0627\u0645\u06A9\u0627\u0646 \u062F\u0631\u06CC\u0627\u0641\u062A \u062A\u0633\u062A \u062F\u0648\u0645 \u0648\u062C\u0648\u062F \u0646\u062F\u0627\u0631\u062F.",
      e.locale
    );
    if (trial.status === "used") return response3(
      panelHeading("\u{1F9EA}", "\u0633\u0647\u0645\u06CC\u0647 \u062A\u0633\u062A \u0627\u0633\u062A\u0641\u0627\u062F\u0647 \u0634\u062F\u0647", "\u0647\u0631 \u062D\u0633\u0627\u0628 \u062A\u0644\u06AF\u0631\u0627\u0645 \u0641\u0642\u0637 \u06CC\u06A9 \u0628\u0627\u0631 \u0645\u062C\u0627\u0632 \u0628\u0647 \u062F\u0631\u06CC\u0627\u0641\u062A \u062A\u0633\u062A \u0627\u0633\u062A.") + "\n\n\u062A\u0633\u062A \u0642\u0628\u0644\u06CC \u0634\u0645\u0627 \u0645\u0646\u0642\u0636\u06CC \u0634\u062F\u0647 \u06CC\u0627 \u0642\u0628\u0644\u0627\u064B \u0627\u0633\u062A\u0641\u0627\u062F\u0647 \u0634\u062F\u0647 \u0627\u0633\u062A\u061B \u0627\u0645\u06A9\u0627\u0646 \u0635\u062F\u0648\u0631 \u062A\u0633\u062A \u0645\u062C\u062F\u062F \u0648\u062C\u0648\u062F \u0646\u062F\u0627\u0631\u062F.",
      e.locale
    );
    return response3(
      panelHeading("\u23F3", "\u062A\u0633\u062A \u0631\u0627\u06CC\u06AF\u0627\u0646 \u0641\u0639\u0644\u0627\u064B \u062F\u0631 \u062F\u0633\u062A\u0631\u0633 \u0646\u06CC\u0633\u062A", "\u0633\u0631\u0648\u0631 \u0622\u0645\u0627\u062F\u0647 \u0628\u0627 \u062F\u0648 \u0645\u0633\u06CC\u0631 \u062A\u0623\u06CC\u06CC\u062F\u0634\u062F\u0647 \u067E\u06CC\u062F\u0627 \u0646\u0634\u062F.") + "\n\n\u0633\u0647\u0645\u06CC\u0647 \u06CC\u06A9\u200C\u0628\u0627\u0631\u0647 \u0634\u0645\u0627 \u0645\u0635\u0631\u0641 \u0646\u0634\u062F\u0647 \u0627\u0633\u062A. \u0644\u0637\u0641\u0627\u064B \u0628\u0639\u062F\u0627\u064B \u062F\u0648\u0628\u0627\u0631\u0647 \u062A\u0644\u0627\u0634 \u06A9\u0646\u06CC\u062F.",
      e.locale
    );
  }
  if (key === "plans" || key === "/plans") return listPlans(db, env, e.locale, nowMs);
  if (key === "my" || key === "/my") return mySubscriptions(db, e, env);
  if (key.startsWith("my:link:")) {
    const subId = key.slice("my:link:".length);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{1,79}$/.test(subId))
      return response3(t("\u0627\u0634\u062A\u0631\u0627\u06A9 \u0646\u0627\u0645\u0639\u062A\u0628\u0631 \u0627\u0633\u062A.", "Invalid subscription.", e.locale), e.locale);
    const owned = await db.prepare(
      "SELECT id FROM subscriptions WHERE id=? AND owner_telegram_id=? AND state='active'"
    ).bind(subId, e.actorId).first();
    if (!owned) return response3(t("\u0627\u0634\u062A\u0631\u0627\u06A9 \u0641\u0639\u0627\u0644 \u0634\u0645\u0627 \u067E\u06CC\u062F\u0627 \u0646\u0634\u062F.", "Active subscription not found.", e.locale), e.locale);
    const link = await issueCarrierLink(env, subId, nowMs);
    if (!link) return response3(t(
      "\u0647\u0631 \u062F\u0648 \u0645\u0633\u06CC\u0631 \u062A\u0623\u06CC\u06CC\u062F\u0634\u062F\u0647 \u0647\u0646\u0648\u0632 \u0622\u0645\u0627\u062F\u0647 \u0646\u06CC\u0633\u062A\u0646\u062F\u061B \u0644\u06CC\u0646\u06A9\u06CC \u0635\u0627\u062F\u0631 \u0646\u0634\u062F.",
      "Both verified carrier routes are not yet ready; no link was issued.",
      e.locale
    ), e.locale);
    return response3(line(
      "\u{1F517}  \u0644\u06CC\u0646\u06A9 \u0627\u0634\u062A\u0631\u0627\u06A9 \u0645\u062F\u0627\u0631",
      "\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501",
      "\u0627\u06CC\u0646 \u0644\u06CC\u0646\u06A9 \u0634\u0627\u0645\u0644 \u062F\u0648 \u0645\u0633\u06CC\u0631 \u062C\u062F\u0627\u06AF\u0627\u0646\u0647 \u0628\u0631\u0627\u06CC \u0647\u0645\u0631\u0627\u0647 \u0627\u0648\u0644 \u0648 \u0627\u06CC\u0631\u0627\u0646\u0633\u0644 \u0627\u0633\u062A:",
      link.url,
      "",
      "\u062F\u0631 \u0628\u0631\u0646\u0627\u0645\u0647 v2rayNG \u0648\u0627\u0631\u062F \u0628\u062E\u0634 \xAB\u062A\u0646\u0638\u06CC\u0645\u0627\u062A \u0627\u0634\u062A\u0631\u0627\u06A9\xBB \u0634\u0648\u06CC\u062F\u060C \u0644\u06CC\u0646\u06A9 \u0631\u0627 \u0627\u0636\u0627\u0641\u0647 \u06A9\u0646\u06CC\u062F \u0648 \u0633\u067E\u0633 \xAB\u0628\u0647\u200C\u0631\u0648\u0632\u0631\u0633\u0627\u0646\u06CC \u0627\u0634\u062A\u0631\u0627\u06A9\xBB \u0631\u0627 \u0628\u0632\u0646\u06CC\u062F.",
      "\u{1F510} \u0627\u06CC\u0646 \u0644\u06CC\u0646\u06A9 \u062E\u0635\u0648\u0635\u06CC \u0627\u0633\u062A\u061B \u0622\u0646 \u0631\u0627 \u0628\u0631\u0627\u06CC \u062F\u06CC\u06AF\u0631\u0627\u0646 \u0627\u0631\u0633\u0627\u0644 \u0646\u06A9\u0646\u06CC\u062F.",
      "\u06CC\u06A9 \u0627\u0634\u062A\u0631\u0627\u06A9\u060C \u06CC\u06A9 \u062D\u062C\u0645 \u0645\u0635\u0631\u0641 \u0648 \u06CC\u06A9 \u062A\u0627\u0631\u06CC\u062E \u0627\u0646\u0642\u0636\u0627 \u0628\u0631\u0627\u06CC \u0647\u0631 \u062F\u0648 \u0645\u0633\u06CC\u0631."
    ), e.locale);
  }
  if (key === "orders" || key === "/orders") return myOrders(db, e);
  if (key.startsWith("orders:view:")) return orderDetails(db, e, key.slice("orders:view:".length));
  if (key === "status" || key === "/status") return liveServiceStatus(env, e, nowMs);
  if (key === "privacy" || key === "/privacy") return botPage("privacy", e.locale);
  if (key === "help" || key === "/help") return botPage("help", e.locale);
  if (key === "support" || key === "/support") return beginSupport(db, e, nowMs);
  if (key.startsWith("buy:")) return purchase(db, env, e, key.slice(4), nowMs);
  if (key === "admin:queue") {
    if (!adminAllowed(env.ADMIN_TELEGRAM_IDS, e.actorId)) return adminResponse("\u26D4 \u062F\u0633\u062A\u0631\u0633\u06CC \u0628\u0647 \u0627\u06CC\u0646 \u0628\u062E\u0634 \u0645\u062C\u0627\u0632 \u0646\u06CC\u0633\u062A.", e.locale);
    return adminQueue(db, e);
  }
  if (key.startsWith("admin:receipt:")) {
    if (!adminAllowed(env.ADMIN_TELEGRAM_IDS, e.actorId)) return adminResponse("\u26D4 \u062F\u0633\u062A\u0631\u0633\u06CC \u0628\u0647 \u0627\u06CC\u0646 \u0628\u062E\u0634 \u0645\u062C\u0627\u0632 \u0646\u06CC\u0633\u062A.", e.locale);
    return adminReceipt(db, e, key.slice("admin:receipt:".length));
  }
  if (key === "admin:tickets" || /^admin:tickets:(open|waiting|closed|all):[0-9]{1,4}$/.test(key)) {
    if (!adminAllowed(env.ADMIN_TELEGRAM_IDS, e.actorId) && !await isStaff(db, e, "support")) return adminResponse("\u26D4 \u062F\u0633\u062A\u0631\u0633\u06CC \u0628\u0647 \u0627\u06CC\u0646 \u0628\u062E\u0634 \u0645\u062C\u0627\u0632 \u0646\u06CC\u0633\u062A.", e.locale);
    const match = key.match(/^admin:tickets:(open|waiting|closed|all):([0-9]{1,4})$/);
    return supportInbox(env, e, match?.[1] ?? "open", match ? Number(match[2]) : 0);
  }
  const staffImage = key.match(/^ticket:media:([0-9]{1,20})$/);
  if (staffImage) return viewSupportPhoto(env, e, staffImage[1], false);
  const staffPage = key.match(/^ticket:page:(tg-[0-9]{1,20}):([0-9]{1,4})$/);
  if (staffPage) {
    if (!await staffCanReply(db, e, env)) return adminResponse("\u26D4 \u062F\u0633\u062A\u0631\u0633\u06CC \u0628\u0647 \u0627\u06CC\u0646 \u0628\u062E\u0634 \u0645\u062C\u0627\u0632 \u0646\u06CC\u0633\u062A.", e.locale);
    return staffTicketDetails(env, e, staffPage[1], Number(staffPage[2]));
  }
  if (key.startsWith("ticket:view:")) {
    if (!await staffCanReply(db, e, env)) return adminResponse("\u26D4 \u062F\u0633\u062A\u0631\u0633\u06CC \u0628\u0647 \u0627\u06CC\u0646 \u0628\u062E\u0634 \u0645\u062C\u0627\u0632 \u0646\u06CC\u0633\u062A.", e.locale);
    return staffTicketDetails(env, e, key.slice("ticket:view:".length));
  }
  if (key.startsWith("ticket:confirm-close:")) {
    if (!await staffCanReply(db, e, env))
      return staffResponse("\u26D4 \u062F\u0633\u062A\u0631\u0633\u06CC \u0628\u0647 \u0627\u06CC\u0646 \u0628\u062E\u0634 \u0645\u062C\u0627\u0632 \u0646\u06CC\u0633\u062A.", e, env);
    const id = key.slice("ticket:confirm-close:".length);
    if (!/^tg-[0-9]{1,20}$/.test(id))
      return staffResponse("\u26A0\uFE0F \u0634\u0646\u0627\u0633\u0647 \u062F\u0631\u062E\u0648\u0627\u0633\u062A \u0645\u0639\u062A\u0628\u0631 \u0646\u06CC\u0633\u062A.", e, env);
    const ticket = await db.prepare(
      "SELECT id,state,subject FROM support_tickets WHERE id=?"
    ).bind(id).first();
    if (!ticket || ticket.state === "closed")
      return staffResponse("\u062F\u0631\u062E\u0648\u0627\u0633\u062A \u0628\u0633\u062A\u0647 \u0634\u062F\u0647 \u06CC\u0627 \u062F\u0631 \u062F\u0633\u062A\u0631\u0633 \u0646\u06CC\u0633\u062A.", e, env);
    return staffResponse(
      "\u26A0\uFE0F  \u0628\u0633\u062A\u0646 \u06AF\u0641\u062A\u200C\u0648\u06AF\u0648\u06CC \u067E\u0634\u062A\u06CC\u0628\u0627\u0646\u06CC\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n\u0634\u0646\u0627\u0633\u0647: " + id + "\n\u0645\u0648\u0636\u0648\u0639: " + ticket.subject + "\n\n\u0628\u0627 \u0628\u0633\u062A\u0646 \u062F\u0631\u062E\u0648\u0627\u0633\u062A\u060C \u0627\u0645\u06A9\u0627\u0646 \u067E\u0627\u0633\u062E \u062F\u0631 \u0627\u06CC\u0646 \u06AF\u0641\u062A\u200C\u0648\u06AF\u0648 \u0645\u062A\u0648\u0642\u0641 \u0645\u06CC\u200C\u0634\u0648\u062F.",
      e,
      env,
      [
        [{ text: "\u2705 \u062A\u0623\u06CC\u06CC\u062F \u0628\u0633\u062A\u0646 \u062F\u0631\u062E\u0648\u0627\u0633\u062A", callback_data: "v2:ticket:close:" + id }],
        [{ text: "\u21A9\uFE0F \u0628\u0627\u0632\u06AF\u0634\u062A \u0628\u0647 \u06AF\u0641\u062A\u200C\u0648\u06AF\u0648", callback_data: "v2:ticket:view:" + id }]
      ]
    );
  }
  if (key.startsWith("ticket:reply:") || key.startsWith("ticket:close:")) {
    if (!await staffCanReply(db, e, env)) return adminResponse("\u26D4 \u062F\u0633\u062A\u0631\u0633\u06CC \u0628\u0647 \u0627\u06CC\u0646 \u0628\u062E\u0634 \u0645\u062C\u0627\u0632 \u0646\u06CC\u0633\u062A.", e.locale);
    const action2 = key.startsWith("ticket:reply:") ? "reply" : "close";
    const id = key.slice(action2 === "reply" ? "ticket:reply:".length : "ticket:close:".length);
    if (!/^tg-[0-9]{1,20}$/.test(id)) return adminResponse("\u26A0\uFE0F \u0634\u0646\u0627\u0633\u0647 \u062F\u0631\u062E\u0648\u0627\u0633\u062A \u0645\u0639\u062A\u0628\u0631 \u0646\u06CC\u0633\u062A.", e.locale);
    return action2 === "reply" ? startTicketReply(db, e, id, nowMs, env) : closeSupport(db, e, id, nowMs, env);
  }
  if (key.startsWith("admin:review:")) {
    if (!adminAllowed(env.ADMIN_TELEGRAM_IDS, e.actorId))
      return adminResponse("\u26D4 \u062F\u0633\u062A\u0631\u0633\u06CC \u0628\u0647 \u0627\u06CC\u0646 \u0628\u062E\u0634 \u0645\u062C\u0627\u0632 \u0646\u06CC\u0633\u062A.", e.locale);
    const m = key.match(/^admin:review:(approve|reject):([a-zA-Z0-9_-]{2,48})$/);
    if (!m) return adminResponse("\u26A0\uFE0F \u0634\u0646\u0627\u0633\u0647 \u0631\u0633\u06CC\u062F \u0645\u0639\u062A\u0628\u0631 \u0646\u06CC\u0633\u062A.", e.locale);
    const [, decision, id] = m;
    const record = await db.prepare(
      "SELECT id,state,quoted_amount,quoted_currency FROM orders WHERE id=?"
    ).bind(id).first();
    if (!record || record.state !== "receipt_submitted")
      return adminResponse("\u0627\u06CC\u0646 \u0633\u0641\u0627\u0631\u0634 \u062F\u06CC\u06AF\u0631 \u0628\u0631\u0627\u06CC \u0628\u0631\u0631\u0633\u06CC \u062F\u0631 \u062F\u0633\u062A\u0631\u0633 \u0646\u06CC\u0633\u062A.", e.locale);
    return adminResponse("\u26A0\uFE0F  \u062A\u0623\u06CC\u06CC\u062F \u062A\u0635\u0645\u06CC\u0645 \u062F\u0631\u0628\u0627\u0631\u0647 \u0631\u0633\u06CC\u062F\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n\u06A9\u062F \u0633\u0641\u0627\u0631\u0634: " + record.id + "\n\u0645\u0628\u0644\u063A: " + money(record.quoted_amount, record.quoted_currency) + "\n\n\u062A\u0635\u0645\u06CC\u0645: " + (decision === "approve" ? "\u2705 \u062A\u0623\u06CC\u06CC\u062F \u0631\u0633\u06CC\u062F \u067E\u0631\u062F\u0627\u062E\u062A" : "\u274C \u0631\u062F \u0631\u0633\u06CC\u062F \u067E\u0631\u062F\u0627\u062E\u062A") + "\n\n\u0627\u06CC\u0646 \u0627\u0642\u062F\u0627\u0645 \u062F\u0631 \u067E\u0631\u0648\u0646\u062F\u0647 \u0633\u0641\u0627\u0631\u0634 \u062B\u0628\u062A \u0648 \u0628\u0647 \u0645\u0634\u062A\u0631\u06CC \u0627\u0637\u0644\u0627\u0639 \u062F\u0627\u062F\u0647 \u0645\u06CC\u200C\u0634\u0648\u062F.", e.locale, [
      [{ text: "\u2705 \u0628\u0644\u0647\u060C \u062B\u0628\u062A \u062A\u0635\u0645\u06CC\u0645", callback_data: "v2:" + decision + ":" + id }],
      [{ text: "\u21A9\uFE0F \u0628\u0627\u0632\u06AF\u0634\u062A \u0628\u062F\u0648\u0646 \u062A\u063A\u06CC\u06CC\u0631", callback_data: "v2:admin:receipt:" + id }]
    ]);
  }
  if (key.startsWith("approve:") || key.startsWith("reject:")) {
    if (!adminAllowed(env.ADMIN_TELEGRAM_IDS, e.actorId)) return adminResponse("\u26D4 \u062F\u0633\u062A\u0631\u0633\u06CC \u0628\u0647 \u0627\u06CC\u0646 \u0628\u062E\u0634 \u0645\u062C\u0627\u0632 \u0646\u06CC\u0633\u062A.", e.locale);
    const [action2, id] = key.split(":");
    return adminDecision(db, e, action2, id);
  }
  const reply4 = await staffReply(db, e, env, nowMs);
  if (reply4) return reply4;
  const support = await maybeRecordSupport(db, e, env, nowMs);
  return support ?? botPage("unknown", e.locale);
}
__name(resolveBotAction, "resolveBotAction");

// src/brand-banner.mjs
var BANNER_BASE64 = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAC8gIykjHS8pJik1Mi84R3ZMR0FBR5BnbVV2q5azsKiWpaK81P/lvMj/y6Kl6//u////////tuL/////////////2wBDATI1NUc+R4pMTIr/wqXC////////////////////////////////////////////////////////////////////wAARCACpASwDASIAAhEBAxEB/8QAGgAAAwEBAQEAAAAAAAAAAAAAAAECAwQFBv/EADoQAAICAQMDAgUDAgMGBwAAAAECAAMRBBIhMUFRE2EFIjJxgUKRoRRSM2LwIyRDRHKSNFOCscHR4f/EABcBAQEBAQAAAAAAAAAAAAAAAAABAgP/xAAkEQEBAQACAgEEAgMAAAAAAAAAARECEiExAzJBUWETIkJxof/aAAwDAQACEQMRAD8A8uEITSCEIQCOKEAjijhBCEIBCEIChHFCiEIQCEI4BCEoCETiPE0VCZtXpmc4Alxm8pHMFmldDuflUmdopqqHzkMR2zxM7NQcBeAPA7TWOfe30gadE+tvwI96J9CAe8yZ8+8GOD82QY2GW+1NYx6zNm48QHeVnqCB07xqyYgMSIskxNkdYpnW8MxRkRQoijikBFmEIURQhCiEIQCEIQCEI4BCPEMQhQlbYbYTUwlYixC6UIQgKEcIBCEoCAATeuosYqkyZ6FVa1Lufr2E3I48+eFVpQF3PwIrrgi7U4H/ALyL9SSes43sJlYnG1TuTMwN5OWAA7ySYBvlII+0za7SYpSEJOMnt7SSckyV64jkaxSnByIbmXk8gxQzCGfpDYwOmZO4Y6mPJ/aQxyciRYrcMx4mcYOO0LisRGPOVyfMUIIjHEYURRxQohCEAjhGBCACUEJmlVRYzs9KulN1h/E1I58ueONKGc/KMzb0Kq/8WwA+BM7dUzfKnyL7dZz5jYmcr78Oz1dMvStm+8fq6c9aiJxZjzGr/H+3Z6ens+lyp95nbpXQZHzL5EwzNKr3rPynjwZEzlPVZERTtKpqULVjDjqs5GXBka48tRCOKGzEtRzIE3qwPmboP5ljPK46aQtSh26noJNtxbqZg9pZszNmJ6ma1ynDbtU7eZBMCSRzJmbXWQQhCRoEkNkcSjg8/wAxHnrDIA94RRUhip6jiBIUDPPtILM3TgeBERg4gw2Yn2kwhDQhCEClPbzH5kSs8desJSJzARQhRCEIBCEIDE0rXJkCdOmXc4E1GOVyOupVoq9R+J599zXPk9Owm/xC7LCpeg6zjjlWPj4/5UQil1lRYu/6c8zLqER7DhFLfadK6QIN19gQeBJs1jDK04VfIEzrRr2ZnfAUZZjzL4c72s2+I39Ci3/BtwfBmNlFlX1Lx5HIg9K+mbKrN4XqCMEQr1VtfG7cPBkSdvtd/wBpR2rcMp5E6L1W2sXJ36jwZOrC7a3VQpYZOItG2WapvpcfzLC3Z2jAxSnBViD1BxBV3H8Zh01IlFu3aTKem1F3PWyr5IkMTmLMaqzsFUEk9AI7K3rIFiMpPkYhcTmGZSU2WAmutmA64GZEB5hNf6XUf+RZ/wBpmbKyHDKVPgjEBZjzBEZ2CopZj2Ag6PW211KnwRiDBmTNEotsXclbsPIGYPRbWMvW6jyRBjOEYBYgAEk9hBlKnDAg+DAUJQRypYKSo6nEYptIyK2IPtBsRAcGNkZDhlK/cRmt1XcUYKe+INiTCNUZzhFLH2ERGDg9YUQhCAQhCUUJ16L6yfAnGJ16M/Jaf8ssc/k+lzWNvsZvJjWixgCF4Mzlix1GA7AfeTx92rLnh00pqK1wKQec8mah9UP+XT95z0s7rk6kqfGZqEY/87/P/wCzX2cOXvzn/XPqbGss+dApXjAnXp6a/wCkJYnDjLfic2o07VqLA/qKTy06dPfWNOql1BAwcyT35Xn9E6nRVQ9T+mW2twczz2G1mHgkT0dO9NFWz1kODnM5KK/X1JP6QcmSw4XLyt9NNZ8qUr3CzmRtjqw7HM01Vvq3sR0HAmMjpwn9crp1i41BI78yaV+SxvCzTW/Un/SJNbbdNZ74ErM+mOcz6CwV2VJRZ/xF4/AnzxnpfErl9PTmqwFl5+U9OBM12jTRaYaPfdf9Wdq/695j8a/8RX/0f/Myu1raq6ncNiqRxnvnrOvVelf8RpJsTYq5J3DHXpCtKGXQ0aet/qtb5vb/AFxPO+IU+jrGAHyt8wnZqPidYuKihbApwGJk66yvVaOu4ModTyuefeBt8T1Vum9L0iBuznIzJVx8Q0FhsUCxM4I84l6yrT6vZnUou3PQgzC2+jS6U6fTNvd+C2fPvAn4Yoqpt1T9FGFj+JAX6anVKOow3+vvNbNVTo9PVSipdxzg8Qp1dOrptpdUpGOOeIB8PLr8MsNQy+Tt47zXRPqrA41aYTHcYnNpbhR8MsAsUWAnAyJVWpGs0T1W2hLB+onGYHmEhLSU6BsidOtXeK7VGdwx/wDU5CMEg9p3aOxDSFsZQUPGTNT8OPyeM5ROqIo0yUL1PWbXNclNfogk45wM9pwX2erazdug+07NVqCi1ipx74wZdc7xv9YdpZtAxvADdpr8no11v0dcfxPMsust+tiZ1a51NdQRgSPB6RpfjviL0lJp1NinxwfIzOGzmxvuZ6Om1KWVguyhxwc8Znmnkn7yX038e3ldKEISOxwjxFNAnVoTlnXys5ZpQ/p3Kx6Z5+0kZ5TZjMjBx4im+rr2XHw3MwksxZdmiEI9rbd204844hW2nv8ATyjjNbdR4jt0xA30neh8dRHrNJ/S+mN+4uM9Jkj2UnIyuexHBll/LF42XeKqdM9p6bV8ma3XJVX6NH/qbzMbNRZbwTx4EzIIODxGz7J1tu8hGg3OFHc4inRokzbvb6UGTJGuVyarWtm/A/SAJju/2OPLRWOXdmPc5k54lScckhRRzXT1C12DA7QpJI7cSNM3VkbawwfBiAJIAGSZ2B6W1AtexdoUAqVJyNuDiSK6akawP6nTbhSMcj8SK5WUqxVhgg4IinZclJ9a7fv35KgKRg5/aGmqqs09m4fMASSQeOOMduso44Tr0fppW9lwXaSFBK7jnvx9oPVSFtsVg4IOwKrfKc+YHJCdf9PSgqa60oSMshBz17SXTTJS2yze+ABwRznr9sQOaE6KKa7dilyHZiCMdsR10LZU7Wf7HYAAxBwT7+8DnRWdgqglj0AinejaSpqijglWGWwcnzn28TlSrfVa4zlMcAeTAhEZ2CqCWPQCJUZyQozgZ/E7aKE09lV1l6BTkgYPMPU06uoUoMhlLIpwARgdeTIOIAk4AJPtGEYuECncTjHedPoUqq41IV+udrAEe0pBX6zaj5lRbV2k9xnmBxY8wlOQXYjoSYpQoRxQNN2evMRHiKOb3VLEJXXrDEmMugf7xp9v606e85CCDgzRGKMGXqJ0PWuoXenD9xLmsb1v6cYBY4AJPtPSKNT8FZbBtZm4B+846LrNJaWUDdjGGEnUam3UsDa2cdAOgnN0lel8Qrst1WnWrBcKWGTN669RdXYmsFeCMLjzPD9Rw27e27znmDWWNjc7HHTJMD19HpLdLRY2xDefpyZn8QDNoUfUqq37sDHieb61u4N6j7h0O45jJsucbizt7nMYalQWIAGSZ1W4ooFIPzNy5jVV0q7mw1pHA8TmYlmJJyTN5jn9V/SYRxSNlHvYIUDHaeSM8GEUgI9zbdu448Z4gAO5lj0x1BP8S4mp3v6ezJ25ziPc+zZuO3OdueJYtUdK1/PMf9S/baPsBLkTb+CqsuqBFZ4PUYyIi1xYsS2Sc8ccxnUWH9Z/eT61n97fvGQl5JYOzFm3EnqTFiX6z/3GP1n85+4jI0zGQcjrLstttx6ljNjpk5ler5RT+IxZX3qH4JlyNMcSkZ623IxU+QcTYPT3qP8A3R+pQP8Agn8vHUxg7PY252Zj5JzEFJ6CdBvUfTUg+/Mza52GM4HgcRkPDNg3G4njgZ7QZmYAFiQvQE9IQxMs6mGJslDt+nA8niarp0H12D7KJcZvKRy4jFbEZCk/idgFKdCB9xmHqVf3n9perPe/aOKEJSrmRu0pQnQ1GFBXkEdZkyEdpWJzlT17RhihyDgxEEgYP4k7GHUGFdHrV2jFq8/3CSdIG5qcMPEzVPM2rrTuxEub7Zv9fTI6W0fp/mA0lp/T/M76xX3taFgr7WNHWM/yVyDSqnNtgX2letXWMUjH+YwetOzTFlA6RmNTL7PG853ZJiNfuPzxI2nsIwSBgn8Q7QFSJOJQzNFr3qSeMDOYzVk1hCUZMzYhQjimUEIQgEIQgEIQgOEUcoI4ATarTvZ0HHmEvKT2yAJmldD2fSpM7EoqrHzfMf4jaw4wOB4E1OLjfl/DAaZV+ts+wlZVPoUD3gcmZs2OBNek232bP5Myaw9uIjnMkzNrc4wExZgYpGzxKHEA/kZlDY3fH3hLfy1pvKfbxNzdS4+ZMH2nKaiJJUy+XPrK2ZaW6Pj7iRtI+lx+DiZENJOZNanH9tSbPv8AsZJL/wBv8TOEa11aB2HaP1GP6Zln3MM+5l06xpub+3+IbrOwx+BM8/eKTWpGp3N9TfuYBax9Vg/AzMswzLrWugWUp0RnP+Y4H8SLL2fjgDwOBMoR2q9qeYoQkQQhGFY9ATIFDEv0274EewDqZetRlDE2+UdAPzDce3H2jqay2nxHtMvky0pducYHky4zeUjILNK6GfoOPJm6pXX1+Y/xG1jEeBL1c7zt9GlNVfLfMf4mhuHQCcxde5z9ovV8ACGOlvmukNu7GGVA+Y4nOGJ6niZvZu4HSXSfHrpa2npuP7SC1J6P+4nKTFmZ10nxx07Fb6WB/MhqyO0xlrYy9CceJda60FZOJr6it9S49xH6YPIYEfeMamufMYMmE5q1Wxl6GareD9a/kTmhma1m8ZXYFV/oIPtJNfkTmDYmq6hxwTuHvLsY62ejNY8SDUfM3FtTdQVP7iV6e4ZQhh7GXInaz25ChEWJ0lSO0kqD1EmNTm58QxNzWvY4kmrxz9pMXtGWIYllcdRCMXUYMe0x5hC6No7mHyjtmKPEGqDY6AD8QLk9TJxHiXTRmEoVse0oIo6nP2jzWbyQATN69OTy3yj3k+oF+kASWuJlyRm9r6dYFVY+UZPkzKy4d2z7CcrWM3Uycx2/CT4/vWrXHsMSCxPU5kxgSba6TjIYlKIgvc9ImbPA6Srhu+eB0kQxHiTFkKGI8gRbvaFPEMRbjFuPmNgvEMSdx8w3nzLsa8IjihObJwijhBDMIQHmUGI6GRCVMbjUOOpz9+ZXrKeq/sZzxy7Wbxjfch6HH3EXHYiYwjTq2yYuO4EhY41MVhT5ENi+ZJkwuNNq/wBwhhB+o/tM4QY03IOxMPVx0AH4mcRjTrFmwnqZJYyYRq5DzmEUcjQjxFLE1IsgCkzQV7RluB29465eo/xfwJ0kaxg2W7YA7STgd8/aXZ9ExmeVwvhRbxxJJihMW2siEISAhCEAhCED/9k=";
function brandBannerBytes() {
  return Uint8Array.from(atob(BANNER_BASE64), (c) => c.charCodeAt(0));
}
__name(brandBannerBytes, "brandBannerBytes");
function bannerImageResponse() {
  return new Response(brandBannerBytes(), { headers: { "content-type": "image/jpeg", "cache-control": "public, max-age=86400", "x-content-type-options": "nosniff" } });
}
__name(bannerImageResponse, "bannerImageResponse");

// src/index.mjs
var json5 = /* @__PURE__ */ __name((value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer"
  }
}), "json");
var MAX_WEBHOOK_BYTES = 32768;
var delay = /* @__PURE__ */ __name((n) => Math.min(36e5, 5e3 * 2 ** Math.min(n, 9)), "delay");
async function readJson(request) {
  if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers.get("content-type") ?? "")) return { status: 415 };
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BYTES) return { status: 413 };
  const reader = request.body?.getReader();
  if (!reader) return { status: 400 };
  const chunks = [];
  let length = 0;
  try {
    for (; ; ) {
      const { done, value: value2 } = await reader.read();
      if (done) break;
      length += value2.byteLength;
      if (length > MAX_WEBHOOK_BYTES) {
        await reader.cancel();
        return { status: 413 };
      }
      chunks.push(value2);
    }
    const bytes = new Uint8Array(length);
    let off = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, off);
      off += chunk.byteLength;
    }
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) return { status: 400 };
    return { value };
  } catch {
    return { status: 400 };
  } finally {
    reader.releaseLock();
  }
}
__name(readJson, "readJson");
async function telegramCall(env, method, payload) {
  try {
    const brandedPhoto = method === "sendPhoto" && payload.photo === BRAND_BANNER_URL;
    let form = null;
    if (brandedPhoto) {
      form = new FormData();
      form.append("chat_id", String(payload.chat_id));
      form.append("photo", new Blob([brandBannerBytes()], { type: "image/jpeg" }), "madar-banner.jpg");
      form.append("caption", String(payload.caption ?? ""));
      if (payload.caption_entities) form.append("caption_entities", JSON.stringify(payload.caption_entities));
      if (payload.reply_markup) form.append("reply_markup", JSON.stringify(payload.reply_markup));
    }
    const response4 = await fetch("https://api.telegram.org/bot" + env.BOT_TOKEN + "/" + method, {
      method: "POST",
      ...form ? {} : { headers: { "content-type": "application/json" } },
      body: form ?? JSON.stringify(payload),
      signal: AbortSignal.timeout(12e3)
    });
    const data = await response4.json().catch(() => null);
    return { ok: response4.ok && data?.ok === true, description: String(data?.description ?? "") };
  } catch {
    return { ok: false, description: "" };
  }
}
__name(telegramCall, "telegramCall");
async function telegram(env, method, payload) {
  return (await telegramCall(env, method, payload)).ok;
}
__name(telegram, "telegram");
async function processInbox(env, nowMs = Date.now()) {
  if (!env.DB || !env.BOT_TOKEN) return;
  const rows = (await env.DB.prepare(
    "SELECT i.update_id,i.event_json,i.attempts FROM telegram_inbox i WHERE ((i.state='pending' AND i.due_ms<=?) OR (i.state='leased' AND i.lease_until_ms<=?)) AND NOT EXISTS (SELECT 1 FROM telegram_inbox prev WHERE prev.chat_id=i.chat_id AND prev.update_id<i.update_id AND prev.state IN ('pending','leased')) ORDER BY i.update_id LIMIT 20"
  ).bind(nowMs, nowMs).all()).results ?? [];
  for (const item of rows) {
    const claim = await env.DB.prepare(
      "UPDATE telegram_inbox SET state='leased',lease_until_ms=?,attempts=attempts+1 WHERE update_id=? AND ((state='pending' AND due_ms<=?) OR (state='leased' AND lease_until_ms<=?))"
    ).bind(nowMs + 3e4, item.update_id, nowMs, nowMs).run();
    if (claim.meta?.changes !== 1) continue;
    try {
      const event = JSON.parse(item.event_json);
      if (event.updateId !== item.update_id) throw new Error("inbox_id_mismatch");
      const reply4 = await approveAndroidLogin(env, event, nowMs) ?? await resolveBotAction(env, event, nowMs);
      const msg = reply4 ?? { text: frameMessage("\u26A0\uFE0F \u067E\u0627\u0633\u062E \u0645\u0646\u0627\u0633\u0628\u06CC \u062F\u0631\u06CC\u0627\u0641\u062A \u0646\u0634\u062F. \u0644\u0637\u0641\u0627\u064B \u062F\u0648\u0628\u0627\u0631\u0647 \u062A\u0644\u0627\u0634 \u06A9\u0646\u06CC\u062F."), replyMarkup: null };
      let sourceIsAttachment = false;
      if (typeof event.sourcePhotoId === "string" && event.sourcePhotoId.length >= 5) {
        const original = await env.DB.prepare(
          "SELECT 1 ok WHERE EXISTS(SELECT 1 FROM support_messages WHERE telegram_file_id=?) OR EXISTS(SELECT 1 FROM receipts WHERE telegram_file_id=?)"
        ).bind(event.sourcePhotoId, event.sourcePhotoId).first();
        sourceIsAttachment = !!original;
      }
      const canEditMessage = !sourceIsAttachment && (!msg.photoId || msg.photoId === BRAND_BANNER_URL);
      const pageKeyboard = msg.replyMarkup ? styleInlineKeyboard(contextualKeyboard(
        event.key,
        msg.replyMarkup,
        { isAdmin: adminAllowed(env.ADMIN_TELEGRAM_IDS, event.actorId) }
      )) : null;
      await env.DB.prepare(
        "INSERT OR IGNORE INTO telegram_outbox (update_id,chat_id,body,reply_markup,media_file_id,edit_message_id,edit_kind,state,due_ms) VALUES (?,?,?,?,?,?,?,'pending',?)"
      ).bind(
        item.update_id,
        event.chatId,
        msg.text.slice(0, 3800),
        pageKeyboard ? JSON.stringify(pageKeyboard) : null,
        msg.photoId ?? null,
        canEditMessage && (!msg.photoId || event.editKind === "caption") && Number.isSafeInteger(event.messageId) ? event.messageId : null,
        canEditMessage && (!msg.photoId || event.editKind === "caption") ? event.editKind === "caption" ? "caption" : event.editKind === "text" ? "text" : null : null,
        nowMs
      ).run();
      await env.DB.prepare(
        "UPDATE telegram_inbox SET state='done',lease_until_ms=0,event_json='{}' WHERE update_id=? AND state='leased'"
      ).bind(item.update_id).run();
    } catch {
      const attempt = item.attempts + 1;
      await env.DB.prepare(
        "UPDATE telegram_inbox SET state=?,lease_until_ms=0,due_ms=? WHERE update_id=? AND state='leased'"
      ).bind(attempt >= 8 ? "dead" : "pending", nowMs + delay(attempt), item.update_id).run();
    }
  }
}
__name(processInbox, "processInbox");
function brandedEntities(body3) {
  if (typeof body3 !== "string" || !body3.startsWith("\u{1F310}  \u0645\u0640\u0640\u062F\u0627\u0631\n")) return [];
  const header = "\u{1F310}  \u0645\u0640\u0640\u062F\u0627\u0631";
  const out = [{ type: "bold", offset: 0, length: header.length }];
  const first = body3.indexOf("\n");
  if (first < 0) return out;
  const start = first + 1, end = body3.indexOf("\n", start);
  const title = body3.slice(start, end < 0 ? body3.length : end);
  if (title.length > 0 && title.length <= 85) out.push({ type: "bold", offset: start, length: title.length });
  return out;
}
__name(brandedEntities, "brandedEntities");
async function deliverTable(env, name, nowMs, withPhoto) {
  const rows = (await env.DB.prepare(
    "SELECT id,chat_id,body,attempts" + (withPhoto ? ",reply_markup,media_file_id,edit_message_id,edit_kind" : "") + " FROM " + name + " WHERE (state='pending' AND due_ms<=?) OR (state='leased' AND lease_until_ms<=?) ORDER BY id LIMIT 20"
  ).bind(nowMs, nowMs).all()).results ?? [];
  for (const item of rows) {
    const claimed = await env.DB.prepare(
      "UPDATE " + name + " SET state='leased',lease_until_ms=?,attempts=attempts+1 WHERE id=? AND ((state='pending' AND due_ms<=?) OR (state='leased' AND lease_until_ms<=?))"
    ).bind(nowMs + 3e4, item.id, nowMs, nowMs).run();
    if (claimed.meta?.changes !== 1) continue;
    let sent = false;
    try {
      const markup = withPhoto && item.reply_markup ? JSON.parse(item.reply_markup) : null;
      const media = withPhoto && typeof item.media_file_id === "string" && item.media_file_id.length > 0;
      const displayBody = media ? item.body.slice(0, 1024) : item.body;
      const entities = brandedEntities(displayBody);
      const sendPayload = {
        chat_id: item.chat_id,
        ...media ? { photo: item.media_file_id, caption: displayBody } : { text: displayBody },
        ...entities.length ? { [media ? "caption_entities" : "entities"]: entities } : {},
        ...markup ? { reply_markup: markup } : {}
      };
      let editAttempted = false;
      if (withPhoto && item.edit_message_id && (!media || item.media_file_id === BRAND_BANNER_URL && item.edit_kind === "caption")) {
        const caption2 = item.edit_kind === "caption";
        if (!caption2 || displayBody.length <= 1024) {
          editAttempted = true;
          const method = caption2 ? "editMessageCaption" : "editMessageText";
          const field = caption2 ? "caption" : "text";
          const editPayload = {
            chat_id: item.chat_id,
            message_id: item.edit_message_id,
            [field]: displayBody,
            ...entities.length ? { [caption2 ? "caption_entities" : "entities"]: entities } : {},
            reply_markup: markup ?? { inline_keyboard: [] }
          };
          const edited = await telegramCall(env, method, editPayload);
          sent = edited.ok || /message is not modified/i.test(edited.description);
          if (!sent && /message to edit not found|message can't be edited|there is no text in the message to edit|message_id_invalid|message caption is too long|message is too long/i.test(edited.description))
            sent = await telegram(env, "sendMessage", {
              chat_id: item.chat_id,
              text: displayBody,
              ...entities.length ? { entities } : {},
              ...markup ? { reply_markup: markup } : {}
            });
        }
      }
      if (!editAttempted) sent = await telegram(env, media ? "sendPhoto" : "sendMessage", sendPayload);
    } catch {
    }
    if (sent) {
      await env.DB.prepare("UPDATE " + name + " SET state='sent',lease_until_ms=0 WHERE id=? AND state='leased'").bind(item.id).run();
    } else {
      const attempt = item.attempts + 1;
      await env.DB.prepare("UPDATE " + name + " SET state=?,lease_until_ms=0,due_ms=? WHERE id=? AND state='leased'").bind(attempt >= 8 ? "dead" : "pending", nowMs + delay(attempt), item.id).run();
    }
  }
}
__name(deliverTable, "deliverTable");
async function dispatchOutbox(env, nowMs = Date.now()) {
  if (!env.DB || !env.BOT_TOKEN) return;
  await deliverTable(env, "telegram_outbox", nowMs, true);
  await deliverTable(env, "telegram_notifications", nowMs, false);
}
__name(dispatchOutbox, "dispatchOutbox");
async function poll(env) {
  await processInbox(env);
  await dispatchOutbox(env);
}
__name(poll, "poll");
async function receive(request, env, ctx) {
  if (!await verifyTelegramSecret(
    request.headers.get("x-telegram-bot-api-secret-token"),
    env.TELEGRAM_WEBHOOK_SECRET
  )) return json5({ error: "unauthorized" }, 401);
  if (!env.DB || !env.BOT_TOKEN) return json5({ error: "not_ready" }, 503);
  const parsed = await readJson(request);
  if (parsed.status) return json5({ error: parsed.status === 413 ? "too_large" : "bad_request" }, parsed.status);
  const event = toBotMessage(parsed.value);
  if (!event) return json5({ ok: true, ignored: true });
  const minimal = {
    updateId: event.updateId,
    chatId: event.chatId,
    actorId: event.actorId,
    locale: event.locale,
    key: event.key,
    inputText: event.inputText,
    photoId: event.photoId,
    messageId: event.messageId,
    editKind: event.editKind
  };
  const payload = JSON.stringify(minimal);
  if (payload.length > 8192) return json5({ error: "too_large" }, 413);
  await env.DB.prepare(
    "INSERT OR IGNORE INTO telegram_inbox(update_id,chat_id,event_json,state,due_ms) VALUES(?,?,?,'pending',?)"
  ).bind(event.updateId, event.chatId, payload, Date.now()).run();
  ctx?.waitUntil?.(poll(env).catch(() => {
  }));
  if (event.callbackId) ctx?.waitUntil?.(
    telegram(env, "answerCallbackQuery", { callback_query_id: event.callbackId, cache_time: 0 }).catch(() => false)
  );
  return json5({ ok: true });
}
__name(receive, "receive");
async function telegramBindingStatus(env, transport = fetch) {
  if (!env.BOT_TOKEN) return json5({ status: "unconfigured", bot: "missing", webhook: "unknown" }, 503);
  try {
    const base = "https://api.telegram.org/bot" + env.BOT_TOKEN + "/";
    const [me, hook] = await Promise.all(["getMe", "getWebhookInfo"].map(async (method) => {
      const r = await transport(base + method, { signal: AbortSignal.timeout(7e3) });
      if (!r.ok) throw Error("telegram_api_error");
      const data = await r.json();
      if (data?.ok !== true) throw Error("telegram_api_error");
      return data.result;
    }));
    const url = typeof hook?.url === "string" ? hook.url : "";
    let webhook = "unknown";
    if (url === "") webhook = "unset";
    else {
      try {
        const parsed = new URL(url);
        if (parsed.protocol === "https:") {
          if (parsed.hostname === "madar-v2-staging.alirezaanari117.workers.dev" && parsed.pathname === "/telegram/webhook")
            webhook = "v2";
          else if (parsed.hostname === "madar-sales-bot.alirezaanari117.workers.dev")
            webhook = "legacy_v1";
          else webhook = "another_bot_or_app";
        } else webhook = "another_bot_or_app";
      } catch {
        webhook = "another_bot_or_app";
      }
    }
    return json5({
      status: "ok",
      bot_id: me?.id,
      bot_username: me?.username,
      webhook,
      webhook_pending: Math.min(1e5, Math.max(0, hook?.pending_update_count ?? 0)),
      is_dedicated_v2: webhook === "v2"
    });
  } catch {
    return json5({ status: "telegram_check_unavailable" }, 503);
  }
}
__name(telegramBindingStatus, "telegramBindingStatus");
var index_default = {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/enroll") return new Response(enrollmentPage, { headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "permissions-policy": "camera=(), microphone=(), geolocation=()",
      "content-security-policy": "default-src 'none'; script-src 'unsafe-inline' https://telegram.org; style-src 'unsafe-inline'; connect-src 'self'; frame-src https://oauth.telegram.org; base-uri 'none'; form-action 'self'"
    } });
    if (path.startsWith("/api/enrollment/")) {
      try {
        return await enrollmentApi(request, env);
      } catch {
        return json5({ error: "TEMPORARY_FAILURE" }, 503);
      }
    }
    if (path.startsWith("/api/runner/")) {
      try {
        return await runnerApi(request, env);
      } catch {
        return json5({ error: "TEMPORARY_FAILURE" }, 503);
      }
    }
    if (request.method === "GET" && path === "/brand/banner.jpg") return bannerImageResponse();
    if (request.method === "GET" && path === "/health/bot") return telegramBindingStatus(env);
    if (request.method === "GET" && path === "/health/live")
      return json5({ status: "alive", service: "madar-v2" });
    if (request.method === "GET" && path === "/health/ready") {
      if (!env.DB || !env.BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET || !/^\d{5,20}(?:,\d{5,20})*$/.test(env.ADMIN_TELEGRAM_IDS ?? ""))
        return json5({ status: "not_ready" }, 503);
      if (!channelActivationConfigured(env))
        return json5({ status: "not_ready", reason: "channel_activation_not_configured" }, 503);
      try {
        await env.DB.prepare("SELECT media_file_id FROM telegram_outbox LIMIT 1").first();
        await env.DB.prepare("SELECT event_json FROM telegram_inbox LIMIT 1").first();
        const bot = await telegramBindingStatus(env);
        if (bot.status !== 200 || (await bot.json()).is_dedicated_v2 !== true)
          return json5({ status: "not_ready", reason: "independent_telegram_bot_required" }, 503);
        return json5({ status: "ready" });
      } catch {
        return json5({ status: "not_ready" }, 503);
      }
    }
    if (path.startsWith("/t/")) {
      try {
        return await getTrialFeed(request, env);
      } catch {
        return json5({ error: "not_ready" }, 503);
      }
    }
    if (path === "/api/v2/node-bootstrap/report") {
      try {
        return await reportInstall(request, env);
      } catch {
        return json5({ error: "not_ready" }, 503);
      }
    }
    if (path.startsWith("/s/")) {
      try {
        return await getCarrierFeed(request, env);
      } catch {
        return new Response("Not ready", { status: 503, headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "private, no-store",
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff"
        } });
      }
    }
    if (path === "/api/v2/android/login/start" || path === "/api/v2/android/login/verify" || path === "/api/v2/android/login/complete" || path === "/api/v2/android/logout") {
      try {
        return await androidLoginRoute(request, env);
      } catch {
        return json5({ error: "temporary_failure" }, 503);
      }
    }
    if (path === "/api/v2/subscription") {
      if (new URL(request.url).search) return json5({ error: "query_not_allowed" }, 400);
      try {
        return await getSubscription(request, env);
      } catch {
        return json5({ error: "temporary_failure" }, 503);
      }
    }
    if (path === "/api/v2/field/accept") {
      try {
        return await fieldProbeRoute(request, env);
      } catch {
        return json5({ error: "field_temporary_failure" }, 503);
      }
    }
    if (path === "/api/node/v1/health") {
      try {
        return await nodeHealthRoute(request, env);
      } catch {
        return json5({ error: "node_health_failure" }, 503);
      }
    }
    if (path === "/api/node/v1/usage" || path === "/api/node/v1/clients/revoked") {
      try {
        return await usageRoute(request, env);
      } catch {
        return json5({ error: "usage_temporary_failure" }, 503);
      }
    }
    if (path.startsWith("/api/node/v1/")) {
      try {
        return await nodeRoute(request, env);
      } catch {
        return json5({ error: "node_temporary_failure" }, 503);
      }
    }
    if (request.method === "POST" && path === "/telegram/webhook") {
      try {
        return await receive(request, env, ctx);
      } catch {
        return json5({ error: "temporary_failure" }, 503);
      }
    }
    return json5({ error: "not_found" }, 404);
  },
  async scheduled(_event, env) {
    await activateIsolatedBotWebhook(env);
    await poll(env);
    await retryPending(env);
    await reconcileApprovedOrders(env);
    if (!env.DB) return;
    const now = Date.now();
    await expireEntitlements(env, now);
    if (env.RUNNER_ENROLLMENT_ENABLED === "true") await cleanupRunnerJobs(env.DB, now);
    await purgeAndroidLogins(env.DB, now);
    const oldDays = /* @__PURE__ */ __name((n) => Math.floor((now - n * 864e5) / 1e3), "oldDays");
    await env.DB.prepare("DELETE FROM node_nonces WHERE created_ms<?").bind(now - 10 * 60 * 1e3).run();
    await env.DB.prepare("DELETE FROM v2_bot_input_sessions WHERE expires_ms<?").bind(now).run();
    await env.DB.prepare(
      "DELETE FROM telegram_inbox WHERE state IN ('done','dead') AND created_at<datetime(?,'unixepoch')"
    ).bind(oldDays(14)).run();
    await env.DB.prepare(
      "DELETE FROM telegram_outbox WHERE state IN ('sent','dead') AND created_at<datetime(?,'unixepoch')"
    ).bind(oldDays(30)).run();
    await env.DB.prepare(
      "DELETE FROM telegram_notifications WHERE state IN ('sent','dead') AND created_at<datetime(?,'unixepoch')"
    ).bind(oldDays(30)).run();
    await env.DB.prepare(
      "DELETE FROM support_messages WHERE ticket_id IN (SELECT id FROM support_tickets WHERE state='closed' AND closed_at<datetime(?,'unixepoch'))"
    ).bind(oldDays(90)).run();
  }
};
export {
  brandedEntities,
  index_default as default,
  dispatchOutbox,
  processInbox,
  telegramBindingStatus
};
//# sourceMappingURL=index.js.map
