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
) {
  await db
    .prepare("UPDATE outbox SET payload=? WHERE id=?")
    .bind(
      JSON.stringify({
        ...original,
        text,
        reply_markup: { inline_keyboard: rows },
      }),
      id,
    )
    .run();
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
    const [current, all] = await Promise.all([
      sellerStats(db, actor.telegramId, "current", now),
      sellerStats(db, actor.telegramId, "all", now),
    ]);
    const text = [
      "💼 پنل فروش",
      `در سرویس: ${inService(current).toLocaleString("fa-IR")}`,
      `این تسویه: ${current.configCount.toLocaleString("fa-IR")} کانفیگ · ${formatBytes(current.soldBytes)}`,
      `کل فروش: ${all.configCount.toLocaleString("fa-IR")} کانفیگ · ${formatBytes(all.soldBytes)}`,
      "",
      "فروش، تست، کانفیگ‌ها و آمار خودت را از اینجا مدیریت کن.",
    ].join("\n");
    await replaceReply(db, reply.id, reply.payload, text, [
      [btn("➕ صدور کانفیگ", "rs:sale"), btn("🎁 تست", "rs:trial")],
      [btn("📋 کانفیگ‌ها", "rs:list"), btn("📊 آمار من", "rs:stats")],
      [btn("📖 راهنما", "rs:help")],
    ]);
    return;
  }
  if (actor.role !== "admin") return;

  const capacities = await nodeCapacities(db, now);
  const activeNodes = capacities.filter(
    (n) =>
      n.healthy === 1 &&
      n.last_seen > now - 90 &&
      n.agent_capabilities.split(",").includes("quota-v2"),
  );
  const committed = capacities.reduce((sum, n) => sum + n.committed_bytes, 0);
  const finalized = capacities.reduce(
    (sum, n) => sum + n.finalized_used_bytes,
    0,
  );
  const serviceCount = capacities.reduce(
    (sum, n) => sum + n.reserved_accounts,
    0,
  );
  const sellers =
    (await db
      .prepare("SELECT COUNT(*) n FROM resellers WHERE enabled=1")
      .first<number>("n")) || 0;
  const text = [
    "📊 وضعیت کلی مدار",
    `سرورهای فعال: ${activeNodes.length.toLocaleString("fa-IR")}`,
    `کانفیگ‌های در سرویس: ${serviceCount.toLocaleString("fa-IR")}`,
    `رزرو فعال: ${formatBytes(committed)}`,
    `مصرف قطعی: ${formatBytes(finalized)}`,
    `فروشنده‌های فعال: ${sellers.toLocaleString("fa-IR")}`,
  ].join("\n");
  const rows: Record<string, unknown>[][] = [
    [btn("➕ صدور کانفیگ", "rs:sale"), btn("🎁 تست", "rs:trial")],
    [btn("🌐 سرورها", "rs:nodes"), btn("👥 فروشندگان", "rs:sellers")],
    [btn("📋 کانفیگ‌ها", "rs:list"), btn("📈 گزارش", "rs:reports")],
    [btn("📖 راهنما", "rs:help")],
  ];
  if (env.PUBLIC_BASE_URL)
    rows.push([
      {
        text: "➕ افزودن VPS",
        web_app: { url: `${env.PUBLIC_BASE_URL}/enroll` },
      },
    ]);
  await replaceReply(db, reply.id, reply.payload, text, rows);
}

async function rewriteSellerStats(
  env: Env,
  actor: SalesActor,
  reply: { id: string; payload: Record<string, any> },
  now: number,
) {
  if (actor.role !== "seller") return;
  const [current, all] = await Promise.all([
    sellerStats(env.SALES_DB, actor.telegramId, "current", now),
    sellerStats(env.SALES_DB, actor.telegramId, "all", now),
  ]);
  const text = [
    "📊 آمار من",
    "",
    "این تسویه",
    `فروش: ${formatBytes(current.soldBytes)} · ${current.configCount.toLocaleString("fa-IR")} کانفیگ`,
    `مصرف واقعی: ${formatBytes(current.usedBytes)}`,
    `در سرویس: ${inService(current).toLocaleString("fa-IR")}`,
    "",
    "کل دوره",
    `فروش: ${formatBytes(all.soldBytes)} · ${all.configCount.toLocaleString("fa-IR")} کانفیگ`,
    `مصرف واقعی: ${formatBytes(all.usedBytes)}`,
  ].join("\n");
  await replaceReply(env.SALES_DB, reply.id, reply.payload, text, [home()]);
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
  const capacities = await nodeCapacities(env.SALES_DB, now);
  const committed = capacities.reduce((sum, n) => sum + n.committed_bytes, 0);
  const finalized = capacities.reduce(
    (sum, n) => sum + n.finalized_used_bytes,
    0,
  );
  const sellable = capacities.reduce((sum, n) => {
    const remaining = remainingAllocation(n);
    return remaining === null ? sum : sum + remaining;
  }, 0);
  const total = await env.SALES_DB.prepare(
    "SELECT COUNT(*) n FROM managed_accounts",
  ).first<number>("n");
  const text = [
    "📈 گزارش فروش و ظرفیت",
    `کل کانفیگ‌ها: ${(total || 0).toLocaleString("fa-IR")}`,
    `رزرو فعال: ${formatBytes(committed)}`,
    `مصرف قطعی: ${formatBytes(finalized)}`,
    `قابل فروش روی سرورهای محدود: ${formatBytes(sellable)}`,
  ].join("\n");
  await replaceReply(env.SALES_DB, reply.id, reply.payload, text, [home()]);
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
