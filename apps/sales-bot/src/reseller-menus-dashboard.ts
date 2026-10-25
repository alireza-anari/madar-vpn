import type { TelegramUpdate } from "./contracts";
import { handleResellerUpdate as handleLegacyResellerUpdate } from "./reseller-menus-legacy";
import {
  canAllocate,
  nodeCapacities,
  remainingAllocation,
} from "./node-capacity";
import { sellerLimits, sellerStats } from "./seller-accounting";
import { formatBytes } from "./sales-format";
import { resolveSalesActor, type SalesActor } from "./resellers";

const btn = (text: string, callback_data: string) => ({ text, callback_data });
const home = () => [btn("🏠 منوی اصلی", "rs:home")];

function updateUserId(u: TelegramUpdate) {
  const id = u.message?.from?.id ?? u.callback_query?.from.id;
  const chat = u.message?.chat ?? u.callback_query?.message?.chat;
  if (!id || !chat || chat.type !== "private" || chat.id !== id) return null;
  return String(id);
}

async function conversation(db: D1Database, id: string) {
  const raw = await db
    .prepare("SELECT conversation FROM users WHERE id=?")
    .bind(id)
    .first<string>("conversation");
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

async function replyPayload(db: D1Database, updateId: number) {
  const id = `u${updateId}:reply`;
  const raw = await db
    .prepare("SELECT payload FROM outbox WHERE id=?")
    .bind(id)
    .first<string>("payload");
  if (!raw) return null;
  try {
    return { id, payload: JSON.parse(raw) as Record<string, any> };
  } catch {
    return null;
  }
}

async function replaceReply(
  db: D1Database,
  id: string,
  original: Record<string, any>,
  text: string,
  rows: Record<string, unknown>[][],
  html = false,
) {
  await db
    .prepare("UPDATE outbox SET payload=? WHERE id=?")
    .bind(
      JSON.stringify({
        ...original,
        text,
        ...(html ? { parse_mode: "HTML" } : { parse_mode: undefined }),
        reply_markup: { inline_keyboard: rows },
      }),
      id,
    )
    .run();
}

const fa = (value: number) => value.toLocaleString("fa-IR");
const meter = (used: number, max: number | null) => {
  if (max === null) return "♾️ بدون سقف";
  const filled = max > 0 ? Math.max(0, Math.min(8, Math.round(8 * used / max))) : 8;
  return "🟩".repeat(filled) + "⬜".repeat(8 - filled);
};
const divider = "━━━━━━━━━━━━━━━━";
async function pendingCustomerReceipts(db: D1Database): Promise<number | null> {
  try {
    return (await db.prepare("SELECT COUNT(*) n FROM customer_orders WHERE state='pending_review'")
      .first<number>("n")) ?? 0;
  } catch {
    // Legacy migration test databases can predate customer checkout.
    return null;
  }
}

function inService(stats: Awaited<ReturnType<typeof sellerStats>>) {
  return stats.liveCount + stats.blockedCount;
}

async function rewriteHome(
  env: Env,
  actor: SalesActor,
  reply: { id: string; payload: Record<string, any> },
  now: number,
) {
  const db = env.SALES_DB;
  if (actor.role === "seller") {
    const [current, all, limits] = await Promise.all([
      sellerStats(db, actor.telegramId, "current", now),
      sellerStats(db, actor.telegramId, "all", now),
      sellerLimits(db, actor.telegramId, now),
    ]);
    const cappedCount = limits.maxReservedAccounts !== null;
    const cappedBytes = limits.maxCommittedBytes !== null;
    const countLeft = cappedCount ? Math.max(0, limits.maxReservedAccounts! - limits.reservedAccounts) : null;
    const bytesLeft = cappedBytes ? Math.max(0, limits.maxCommittedBytes! - limits.committedBytes) : null;
    const atLimit = countLeft === 0 || bytesLeft === 0 ||
      (cappedBytes && limits.uncappedAccounts > 0);
    const text = [
      "💼 پنل فروش مدار",
      divider,
      "<b>📊 وضعیت فروش</b>",
      `در سرویس: ${fa(inService(current))}`,
      `این تسویه: ${fa(current.configCount)} کانفیگ · ${formatBytes(current.soldBytes)}`,
      `کل فروش: ${fa(all.configCount)} کانفیگ · ${formatBytes(all.soldBytes)}`,
      "",
      "<b>🎯 سهمیه فعلی فروشنده</b>",
      `🔢 کانفیگ: ${fa(limits.reservedAccounts)} / ${cappedCount ? fa(limits.maxReservedAccounts!) : "نامحدود"}`,
      meter(limits.reservedAccounts, limits.maxReservedAccounts),
      `📦 حجم تعهدشده: ${formatBytes(limits.committedBytes)} / ${cappedBytes ? formatBytes(limits.maxCommittedBytes!) : "نامحدود"}`,
      meter(limits.committedBytes, limits.maxCommittedBytes),
      ...(cappedBytes && limits.uncappedAccounts > 0
        ? ["⚠️ کانفیگ بدون سقف حجمی در تعهد فعال وجود دارد؛ تخصیص جدید باید بررسی شود."] : []),
      ...(atLimit ? ["⛔ یکی از سقف‌های فروش پر شده؛ صدور جدید مشروط به ظرفیت واقعی است."] : []),
      "",
      "👇 <b>عملیات موردنظر را انتخاب کن.</b>",
    ].join("\n");
    await replaceReply(db, reply.id, reply.payload, text, [
      [btn("➕ صدور کانفیگ", "rs:sale"), btn("🎁 تست", "rs:trial")],
      [btn("📋 کانفیگ‌ها", "rs:list"), btn("📊 آمار من", "rs:stats")],
      [btn("📖 راهنما", "rs:help")],
    ], true);
    return;
  }
  if (actor.role !== "admin") return;

  const [capacities, pendingReceipts] = await Promise.all([
    nodeCapacities(db, now),
    pendingCustomerReceipts(db),
  ]);
  const activeNodes = capacities.filter(
    (n) =>
      n.healthy === 1 &&
      n.last_seen > now - 90 &&
      n.agent_capabilities.split(",").includes("quota-v2"),
  );
  const committed = capacities.reduce((sum, n) => sum + n.committed_bytes, 0);
  const finalized = capacities.reduce((sum, n) => sum + n.finalized_used_bytes, 0);
  const serviceCount = capacities.reduce((sum, n) => sum + n.reserved_accounts, 0);
  const sellers = (await db.prepare("SELECT COUNT(*) n FROM resellers WHERE enabled=1").first<number>("n")) || 0;
  const text = [
    "📊 وضعیت کلی مدار",
    divider,
    "<b>🛰️ سرورها و ظرفیت</b>",
    `سرورهای فعال: ${fa(activeNodes.length)} از ${fa(capacities.length)}`,
    `کانفیگ‌های در سرویس: ${fa(serviceCount)}`,
    `رزرو فعال: ${formatBytes(committed)}`,
    `مصرف قطعی: ${formatBytes(finalized)}`,
    "",
    "<b>👥 فروش و سفارش‌ها</b>",
    `فروشنده‌های فعال: ${fa(sellers)}`,
    ...(pendingReceipts !== null ? [
      `📨 رسیدهای منتظر بررسی: ${fa(pendingReceipts)}`,
      ...(pendingReceipts > 0 ? ["⚠️ رسیدهای مشتریان نیاز به بررسی مدیر دارند."] : []),
    ] : []),
    "",
    "👇 <b>بخش مدیریتی موردنظر را انتخاب کن.</b>",
  ].join("\n");
  const rows: Record<string, unknown>[][] = [
    [btn("🌐 سرورها", "rs:nodes"), btn("👥 فروشندگان", "rs:sellers")],
    [btn("➕ صدور کانفیگ", "rs:sale"), btn("🎁 تست", "rs:trial")],
    [btn("📋 کانفیگ‌ها", "rs:list"), btn("📈 گزارش", "rs:reports")],
    [btn("📖 راهنما", "rs:help")],
  ];
  // The existing dashboard enhancer keeps the customer-receipt inbox entry.
  if (env.PUBLIC_BASE_URL)
    rows.push([{ text: "➕ افزودن VPS", web_app: { url: `${env.PUBLIC_BASE_URL}/enroll` } }]);
  await replaceReply(db, reply.id, reply.payload, text, rows, true);
}

async function rewriteSellerStats(
  env: Env,
  actor: SalesActor,
  reply: { id: string; payload: Record<string, any> },
  now: number,
) {
  if (actor.role !== "seller") return;
  const [current, all, limits] = await Promise.all([
    sellerStats(env.SALES_DB, actor.telegramId, "current", now),
    sellerStats(env.SALES_DB, actor.telegramId, "all", now),
    sellerLimits(env.SALES_DB, actor.telegramId, now),
  ]);
  const text = [
    "📊 آمار من | مدار",
    divider,
    "<b>📅 این تسویه</b>",
    `فروش: ${formatBytes(current.soldBytes)} · ${fa(current.configCount)} کانفیگ`,
    `مصرف واقعی: ${formatBytes(current.usedBytes)}`,
    `در سرویس: ${fa(inService(current))}`,
    `پایان حجم: ${fa(current.exhaustedCount)} · منقضی: ${fa(current.expiredCount)}`,
    "",
    "<b>📈 کل دوره</b>",
    `فروش: ${formatBytes(all.soldBytes)} · ${fa(all.configCount)} کانفیگ`,
    `مصرف واقعی: ${formatBytes(all.usedBytes)}`,
    "",
    "<b>🎯 سهمیه فعلی</b>",
    `تعداد: ${fa(limits.reservedAccounts)} از ${limits.maxReservedAccounts === null ? "نامحدود" : fa(limits.maxReservedAccounts)}`,
    `حجم تعهدشده: ${formatBytes(limits.committedBytes)} از ${limits.maxCommittedBytes === null ? "نامحدود" : formatBytes(limits.maxCommittedBytes)}`,
  ].join("\n");
  await replaceReply(env.SALES_DB, reply.id, reply.payload, text, [
    [btn("➕ صدور کانفیگ", "rs:sale"), btn("📋 کانفیگ‌ها", "rs:list")],
    home(),
  ], true);
}

async function sellerLimitError(
  db: D1Database,
  actor: SalesActor,
  requestedBytes: number,
  now: number,
) {
  if (actor.role !== "seller") return null;
  const limits = await sellerLimits(db, actor.telegramId, now);
  if (
    limits.maxReservedAccounts !== null &&
    limits.reservedAccounts >= limits.maxReservedAccounts
  )
    return "سقف تعداد کانفیگ فروشنده پر شده است. برای صدور جدید، مدیر باید سقف را افزایش دهد یا یکی از تعهدهای فعال پایان پیدا کند.";
  if (
    limits.maxCommittedBytes !== null &&
    (limits.uncappedAccounts > 0 ||
      limits.committedBytes + requestedBytes > limits.maxCommittedBytes)
  )
    return "سقف حجم فروشنده برای این صدور کافی نیست. حجم کمتری انتخاب کن یا از مدیر بخواه سقف حجم را افزایش دهد.";
  return null;
}

async function rewriteServerPicker(
  env: Env,
  actor: SalesActor,
  state: any,
  reply: { id: string; payload: Record<string, any> },
  now: number,
) {
  const requestedBytes = Number(state?.quotaBytes || 0);
  if (!Number.isFinite(requestedBytes) || requestedBytes <= 0) return;
  const limitError = await sellerLimitError(
    env.SALES_DB,
    actor,
    requestedBytes,
    now,
  );
  if (limitError) {
    await replaceReply(env.SALES_DB, reply.id, reply.payload, limitError, [home()]);
    return;
  }
  const nodes = (await nodeCapacities(env.SALES_DB, now)).filter(
    (n) =>
      n.healthy === 1 &&
      n.last_seen > now - 90 &&
      n.agent_capabilities.split(",").includes("quota-v2") &&
      n.reserved_accounts < n.max_accounts &&
      canAllocate(n, requestedBytes),
  );
  const text = nodes.length
    ? "🌍 انتخاب سرور\nفقط سرورهایی نمایش داده می‌شوند که همین حالا ظرفیت این فروش را دارند."
    : "در حال حاضر سروری با ظرفیت کافی برای این فروش در دسترس نیست. حجم را کمتر کن یا بعداً دوباره تلاش کن.";
  const rows: Record<string, unknown>[][] = nodes.map((n) => {
    const remaining = remainingAllocation(n);
    return [
      btn(
        `${n.name} · ${Math.max(0, n.max_accounts - n.reserved_accounts).toLocaleString("fa-IR")} جای خالی · قابل فروش: ${remaining === null ? "نامحدود" : formatBytes(remaining)}`,
        `rs:choose:${n.id}`,
      ),
    ];
  });
  rows.push(home());
  await replaceReply(env.SALES_DB, reply.id, reply.payload, text, rows);
}

async function rewriteConfirmation(
  env: Env,
  state: any,
  reply: { id: string; payload: Record<string, any> },
  now: number,
) {
  const requestedBytes = Number(state?.quotaBytes || 0);
  const nodeId = String(state?.nodeId || "");
  if (!nodeId || !Number.isFinite(requestedBytes) || requestedBytes <= 0) return;
  const node = (await nodeCapacities(env.SALES_DB, now, nodeId))[0];
  if (
    !node ||
    node.healthy !== 1 ||
    node.last_seen <= now - 90 ||
    !node.agent_capabilities.split(",").includes("quota-v2") ||
    node.reserved_accounts >= node.max_accounts ||
    !canAllocate(node, requestedBytes)
  ) {
    await replaceReply(
      env.SALES_DB,
      reply.id,
      reply.payload,
      "ظرفیت این سرور دیگر برای این کانفیگ کافی نیست. سرور دیگری انتخاب کن.",
      [[btn("تغییر سرور", "rs:servers")], home()],
    );
    return;
  }
  const before = remainingAllocation(node);
  const after = before === null ? null : Math.max(0, before - requestedBytes);
  const duration =
    state.kind === "trial"
      ? "۳۰ دقیقه"
      : `${(Number(state.durationSeconds) / 86400).toLocaleString("fa-IR")} روز`;
  const text = [
    "✅ بررسی نهایی",
    `مشتری: ${state.label}`,
    `سرور: ${node.name}`,
    `حجم: ${formatBytes(requestedBytes)}`,
    `مدت: ${duration}`,
    "",
    `قابل فروش فعلی: ${before === null ? "نامحدود" : formatBytes(before)}`,
    `پس از این فروش: ${after === null ? "نامحدود" : formatBytes(after)}`,
  ].join("\n");
  await replaceReply(env.SALES_DB, reply.id, reply.payload, text, [
    [btn("✅ تأیید و ساخت", `rs:confirm:${state.requestKey}`)],
    [btn("تغییر سرور", "rs:servers")],
    home(),
  ]);
}

async function rewriteAdminReport(
  env: Env,
  actor: SalesActor,
  reply: { id: string; payload: Record<string, any> },
  now: number,
) {
  if (actor.role !== "admin") return;
  const [capacities, pendingReceipts] = await Promise.all([
    nodeCapacities(env.SALES_DB, now),
    pendingCustomerReceipts(env.SALES_DB),
  ]);
  const committed = capacities.reduce((sum, n) => sum + n.committed_bytes, 0);
  const finalized = capacities.reduce((sum, n) => sum + n.finalized_used_bytes, 0);
  const sellable = capacities.reduce((sum, n) => {
    const remaining = remainingAllocation(n);
    return remaining === null ? sum : sum + remaining;
  }, 0);
  const total = await env.SALES_DB.prepare(
    "SELECT COUNT(*) n FROM managed_accounts",
  ).first<number>("n");
  const healthy = capacities.filter(n => n.healthy === 1 &&
    n.last_seen > now - 90 && n.agent_capabilities.split(",").includes("quota-v2")).length;
  const text = [
    "📈 گزارش فروش و ظرفیت",
    divider,
    "<b>🛰️ وضعیت زیرساخت</b>",
    `سرور آماده: ${fa(healthy)} از ${fa(capacities.length)}`,
    `کل کانفیگ‌ها: ${fa(total || 0)}`,
    `رزرو فعال: ${formatBytes(committed)}`,
    `مصرف قطعی: ${formatBytes(finalized)}`,
    `قابل فروش روی سرورهای محدود: ${formatBytes(sellable)}`,
    "",
    "<b>💳 سفارش مشتریان</b>",
    ...(pendingReceipts === null
      ? ["برای مشاهده رسیدها از صندوق رسیدها استفاده کن."]
      : [`رسیدهای منتظر بررسی: ${fa(pendingReceipts)}`]),
    "",
    "👇 <b>برای جزئیات، بخش موردنظر را باز کن.</b>",
  ].join("\n");
  await replaceReply(env.SALES_DB, reply.id, reply.payload, text, [
    [btn("🌐 سرورها", "rs:nodes"), btn("👥 فروشندگان", "rs:sellers")],
    [btn("💳 رسیدهای مشتریان", "cust:inbox:0")],
    home(),
  ], true);
}

async function rewriteSellerConfirmError(
  env: Env,
  actor: SalesActor,
  state: any,
  reply: { id: string; payload: Record<string, any> },
  now: number,
) {
  if (actor.role !== "seller") return;
  if (String(reply.payload.text || "").startsWith("⏳ درخواست ثبت شد")) return;
  const requestedBytes = Number(state?.quotaBytes || 0);
  if (!Number.isFinite(requestedBytes) || requestedBytes <= 0) return;
  const error = await sellerLimitError(
    env.SALES_DB,
    actor,
    requestedBytes,
    now,
  );
  if (error)
    await replaceReply(env.SALES_DB, reply.id, reply.payload, error, [
      [btn("تغییر سرور", "rs:servers")],
      home(),
    ]);
}

export async function handleResellerUpdate(
  env: Env,
  u: TelegramUpdate,
  now: number,
) {
  await handleLegacyResellerUpdate(env, u, now);

  const id = updateUserId(u);
  if (!id) return;
  const reply = await replyPayload(env.SALES_DB, u.update_id);
  if (!reply) return;
  const actor = await resolveSalesActor(env.SALES_DB, id, env);
  if (actor.role === "ordinary") return;

  const data = u.callback_query?.data;
  const text = u.message?.text?.trim();
  const state = await conversation(env.SALES_DB, id);

  if (
    text === "/start" ||
    text === "/menu" ||
    text === "/cancel" ||
    data === "home" ||
    data === "rs:home"
  ) {
    await rewriteHome(env, actor, reply, now);
    return;
  }
  if (data === "rs:stats") {
    await rewriteSellerStats(env, actor, reply, now);
    return;
  }
  if (data === "rs:reports") {
    await rewriteAdminReport(env, actor, reply, now);
    return;
  }
  if (
    state?.step === "confirm" &&
    String(reply.payload.text || "").startsWith("🌍 انتخاب سرور")
  ) {
    await rewriteServerPicker(env, actor, state, reply, now);
    return;
  }
  if (data?.startsWith("rs:choose:") && state?.step === "confirm") {
    await rewriteConfirmation(env, state, reply, now);
    return;
  }
  if (data?.startsWith("rs:confirm:") && state?.step === "confirm")
    await rewriteSellerConfirmError(env, actor, state, reply, now);
}
