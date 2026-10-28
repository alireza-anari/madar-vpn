import type { TelegramUpdate } from "./contracts";
import {
  nodeCapacities,
  remainingAllocation,
  utilizationPercent,
} from "./node-capacity";
import { refreshCapacityAlert } from "./capacity-alerts";
import { setNodeMaxAccounts, setNodeMaxAllocatedBytes } from "./node-settings";
import {
  sellerLimits,
  sellerNodeStats,
  sellerStats,
  setSellerLimits,
  settleSeller,
} from "./seller-accounting";
import { formatBytes, nodeCapacitySummary } from "./sales-format";
import { resolveSalesActor, type SalesActor } from "./resellers";

const btn = (text: string, callback_data: string) => ({ text, callback_data });
const home = () => [btn("🏠 منوی اصلی", "rs:home")];
const backNodes = () => [btn("🌐 سرورها", "rs:nodes")];
const backSellers = () => [btn("👥 فروشندگان", "rs:sellers")];

const digits = (value: string) =>
  value
    .trim()
    .replace(/[۰-۹]/g, (c) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(c)))
    .replace(/[٠-٩]/g, (c) => String("٠١٢٣٤٥٦٧٨٩".indexOf(c)));

function identity(u: TelegramUpdate) {
  const id = u.message?.from?.id ?? u.callback_query?.from.id;
  const chat = u.message?.chat ?? u.callback_query?.message?.chat;
  if (!id || !chat || chat.type !== "private" || chat.id !== id) return null;
  return String(id);
}

function parseState(raw: string) {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

function isAdminCallback(data: string | undefined) {
  if (!data) return false;
  if (data === "rs:nodes" || data === "rs:sellers" ||
    /^rs:(?:nodes|sellers):(0|[1-9][0-9]{0,2})$/.test(data)) return true;
  return /^rs:(?:nodedetail|unlimit|capacity|allocation|seller|settle|settleok|settlements|limits|limitcount|limitbytes):/.test(
    data,
  );
}

async function directContext(env: Env, u: TelegramUpdate, id: string) {
  const db = env.SALES_DB;
  await db.prepare("INSERT OR IGNORE INTO users(id) VALUES(?)").bind(id).run();
  const replyId = `u${u.update_id}:reply`;
  if (await db.prepare("SELECT id FROM outbox WHERE id=?").bind(replyId).first())
    return { duplicate: true as const, state: {}, set: (_: unknown) => {}, reply: async () => {} };

  const snapshot = await db
    .prepare("SELECT conversation,sales_update_id FROM users WHERE id=?")
    .bind(id)
    .first<{ conversation: string; sales_update_id: number }>();
  if (!snapshot) throw Error("USER_NOT_FOUND");
  const raw = snapshot.conversation || "";
  const state = parseState(raw);
  let nextConversation = raw;
  const set = (value: unknown) => {
    nextConversation = JSON.stringify(value);
  };
  const reply = async (
    text: string,
    rows: Record<string, unknown>[][] = [home()],
  ) => {
    const result = await db.batch([
      db
        .prepare(
          "UPDATE users SET conversation=?,sales_update_id=? WHERE id=? AND conversation=? AND sales_update_id=?",
        )
        .bind(
          nextConversation,
          u.update_id,
          id,
          raw,
          snapshot.sales_update_id,
        ),
      db
        .prepare(
          "INSERT OR IGNORE INTO outbox(id,chat_id,payload,available_at) SELECT ?,?,?,0 FROM users WHERE id=? AND sales_update_id=?",
        )
        .bind(
          replyId,
          id,
          JSON.stringify({ text, reply_markup: { inline_keyboard: rows } }),
          id,
          u.update_id,
        ),
    ]);
    if (
      !result[0]?.meta.changes &&
      !(await db.prepare("SELECT id FROM outbox WHERE id=?").bind(replyId).first())
    )
      throw Error("CONVERSATION_RETRY");
  };
  return { duplicate: false as const, state, set, reply };
}

function adminDenied(actor: SalesActor) {
  return actor.role !== "admin";
}

async function bestEffortAlert(env: Env, nodeId: string, now: number) {
  try {
    await refreshCapacityAlert(env, nodeId, now);
  } catch {
    // Capacity controls must remain available even if warning persistence is down.
  }
}

function nodeRows(n: Awaited<ReturnType<typeof nodeCapacities>>[number]) {
  return [
    [
      btn("🎯 سرور فروش", `rs:node:sale:${n.id}`),
      btn("🧪 سرور تست", `rs:node:trial:${n.id}`),
    ],
    [
      btn("🔢 سقف کانفیگ", `rs:capacity:${n.id}`),
      btn("📦 سقف حجم", `rs:allocation:${n.id}`),
    ],
    ...(n.max_allocated_bytes === null
      ? []
      : [[btn("♾ نامحدود کردن حجم", `rs:unlimit:${n.id}`)]]),
    backNodes(),
    home(),
  ];
}

async function showNodeList(
  env: Env,
  reply: (text: string, rows?: Record<string, unknown>[][]) => Promise<void>,
  now: number,
  requestedPage = 0,
) {
  const nodes = await nodeCapacities(env.SALES_DB, now);
  const perPage = 8;
  const page = Math.min(requestedPage, Math.max(0, Math.ceil(nodes.length / perPage) - 1));
  const visible = nodes.slice(page * perPage, (page + 1) * perPage);
  const healthy = nodes.filter(n => n.healthy === 1 && n.last_seen > now - 90 &&
    n.agent_capabilities.split(",").includes("quota-v2") &&
    n.reserved_accounts < n.max_accounts &&
    (remainingAllocation(n) === null || remainingAllocation(n)! > 0)).length;
  const rows: Record<string, unknown>[][] = visible.map((n) => {
    const remaining = remainingAllocation(n);
    const available = n.healthy === 1 && n.last_seen > now - 90 &&
      n.agent_capabilities.split(",").includes("quota-v2") &&
      n.reserved_accounts < n.max_accounts &&
      (remaining === null || remaining > 0);
    const status = available ? "🟢" : "🔴";
    const freeSlots = Math.max(0, n.max_accounts - n.reserved_accounts);
    return [btn(
      `${status} ${n.name.slice(0,20)} · ${freeSlots.toLocaleString("fa-IR")} جای خالی · ${remaining === null ? "♾" : formatBytes(remaining)}`,
      `rs:nodedetail:${n.id}`,
    )];
  });
  const navigation: Record<string, unknown>[] = [];
  if (page > 0) navigation.push(btn("◀️ قبلی", `rs:nodes:${page - 1}`));
  if ((page + 1) * perPage < nodes.length) navigation.push(btn("بعدی ▶️", `rs:nodes:${page + 1}`));
  if (navigation.length) rows.push(navigation);
  rows.push([btn("🔄 تازه‌سازی فهرست","rs:nodes")]);
  rows.push(home());
  await reply(
    [
      "🌐 سرورها | مدیریت ظرفیت",
      "━━━━━━━━━━━━━━━━",
      `🟢 آماده فروش: ${healthy.toLocaleString("fa-IR")} از ${nodes.length.toLocaleString("fa-IR")}`,
      `🔴 نیازمند بررسی: ${(nodes.length - healthy).toLocaleString("fa-IR")}`,
      "",
      "📊 وضعیت بر اساس سلامت، ظرفیت تعداد و حجم واقعی محاسبه می‌شود.",
      nodes.length ? "👇 یک سرور را برای مشاهده جزئیات و تغییر سقف انتخاب کن." : "هنوز سروری ثبت نشده است.",
      nodes.length ? `صفحه ${(page + 1).toLocaleString("fa-IR")} از ${Math.max(1, Math.ceil(nodes.length / perPage)).toLocaleString("fa-IR")}` : "",
    ].filter(Boolean).join("\n"),
    rows,
  );
}

async function showNodeDetail(
  env: Env,
  nodeId: string,
  reply: (text: string, rows?: Record<string, unknown>[][]) => Promise<void>,
  now: number,
) {
  const n = (await nodeCapacities(env.SALES_DB, now, nodeId))[0];
  if (!n) throw Error("INVALID_NODE");
  const purposes = await env.SALES_DB.prepare(
    "SELECT purpose FROM node_purposes WHERE node_id=? ORDER BY purpose",
  )
    .bind(nodeId)
    .all<{ purpose: string }>();
  const purposeText = purposes.results.length
    ? purposes.results
        .map((p) => (p.purpose === "sale" ? "فروش" : "تست"))
        .join("، ")
    : "بدون کاربرد";
  const summary = nodeCapacitySummary(n).split("\n");
  summary[0] = `🌐 ${n.name}`;
  const health = n.healthy === 1 && n.last_seen > now - 90 ? "🟢 آماده" : "🔴 نیاز به بررسی";
  await reply(
    [
      summary[0],
      "━━━━━━━━━━━━━━━━",
      `وضعیت: ${health}`,
      ...summary.slice(1),
      `کاربرد: ${purposeText}`,
      "",
      "👇 تغییر سقف‌ها فقط روی ظرفیت صدورهای جدید اثر می‌گذارد.",
    ].join("\n"),
    nodeRows(n),
  );
}

async function showSellerList(
  env: Env,
  reply: (text: string, rows?: Record<string, unknown>[][]) => Promise<void>,
  now: number,
  requestedPage = 0,
) {
  const db = env.SALES_DB;
  const perPage = 8;
  const total = (await db.prepare("SELECT COUNT(*) AS n FROM resellers").first<number>("n")) || 0;
  const active = (await db.prepare("SELECT COUNT(*) AS n FROM resellers WHERE enabled=1").first<number>("n")) || 0;
  const page = Math.min(requestedPage, Math.max(0, Math.ceil(total / perPage) - 1));
  const sellers = await db.prepare(
    "SELECT telegram_id,enabled FROM resellers ORDER BY enabled DESC,created_at DESC,telegram_id ASC LIMIT ? OFFSET ?"
  ).bind(perPage, page * perPage).all<{ telegram_id: string; enabled: number }>();
  const rows: Record<string, unknown>[][] = [];
  for (const seller of sellers.results) {
    const stats = await sellerStats(db, seller.telegram_id, "current", now);
    rows.push([btn(
      `${seller.enabled ? "🟢" : "⚪"} ${seller.telegram_id} · ${stats.configCount.toLocaleString("fa-IR")} کانفیگ · ${formatBytes(stats.soldBytes)}`,
      `rs:seller:${seller.telegram_id}`,
    )]);
  }
  const navigation: Record<string, unknown>[] = [];
  if (page > 0) navigation.push(btn("◀️ قبلی", `rs:sellers:${page - 1}`));
  if ((page + 1) * perPage < total) navigation.push(btn("بعدی ▶️", `rs:sellers:${page + 1}`));
  if (navigation.length) rows.push(navigation);
  rows.push(
    [btn("🔗 دعوت فروشنده", "rs:invite")],
    [btn("➕ افزودن با شناسه", "rs:seller"), btn("⛔ قطع دسترسی", "rs:disable")],
    [btn("🔄 تازه‌سازی", "rs:sellers")],
    home(),
  );
  await reply(
    [
      "👥 فروشندگان | مدیریت فروش",
      "━━━━━━━━━━━━━━━━",
      `🟢 فعال: ${active.toLocaleString("fa-IR")} از ${total.toLocaleString("fa-IR")}`,
      `⚪ غیرفعال: ${(total-active).toLocaleString("fa-IR")}`,
      "",
      total ? "👇 فروشنده را برای مشاهده فروش، سهمیه و تسویه انتخاب کن." :
        "هنوز فروشنده‌ای ثبت نشده است.",
      total ? `صفحه ${(page + 1).toLocaleString("fa-IR")} از ${Math.max(1, Math.ceil(total / perPage)).toLocaleString("fa-IR")}` : "",
    ].filter(Boolean).join("\n"),
    rows,
  );
}

async function sellerDetailText(env: Env, sellerId: string, now: number) {
  const db = env.SALES_DB;
  const seller = await db
    .prepare("SELECT enabled FROM resellers WHERE telegram_id=?")
    .bind(sellerId)
    .first<{ enabled: number }>();
  if (!seller) throw Error("INVALID_SELLER");
  const [current, all, nodes, limits] = await Promise.all([
    sellerStats(db, sellerId, "current", now),
    sellerStats(db, sellerId, "all", now),
    sellerNodeStats(db, sellerId, "current", now),
    sellerLimits(db, sellerId, now),
  ]);
  const breakdown = nodes.length
    ? nodes
        .map(
          (n) =>
            `${n.nodeName}: ${n.configCount.toLocaleString("fa-IR")} کانفیگ · ${formatBytes(n.soldBytes)} فروش · ${formatBytes(n.usedBytes)} مصرف`,
        )
        .join("\n")
    : "هنوز فروشی در تسویهٔ جاری ثبت نشده است.";
  return [
    `👤 فروشنده ${sellerId}`,
    "━━━━━━━━━━━━━━━━",
    `وضعیت: ${seller.enabled ? "🟢 فعال" : "⚪ غیرفعال"}`,
    "",
    "📅 این تسویه",
    `فروش: ${formatBytes(current.soldBytes)} · ${current.configCount.toLocaleString("fa-IR")} کانفیگ`,
    `مصرف واقعی: ${formatBytes(current.usedBytes)}`,
    `در سرویس: ${(current.liveCount + current.blockedCount).toLocaleString("fa-IR")}`,
    "",
    "📈 کل دوره",
    `فروش: ${formatBytes(all.soldBytes)} · ${all.configCount.toLocaleString("fa-IR")} کانفیگ`,
    `مصرف واقعی: ${formatBytes(all.usedBytes)}`,
    "",
    "🎯 سقف‌های جاری",
    `تعداد: ${limits.maxReservedAccounts === null ? "نامحدود" : limits.maxReservedAccounts.toLocaleString("fa-IR")}`,
    `حجم: ${limits.maxCommittedBytes === null ? "نامحدود" : formatBytes(limits.maxCommittedBytes)}`,
    "",
    "🛰️ تفکیک سرور",
    breakdown,
    "",
    "👇 مدیریت سهمیه یا تسویه را انتخاب کن.",
  ].join("\n");
}

function sellerDetailRows(sellerId: string) {
  return [
    [btn("🎯 سقف‌های فروش", `rs:limits:${sellerId}`), btn("🧾 تسویه", `rs:settle:${sellerId}`)],
    [btn("📚 تسویه‌های اخیر", `rs:settlements:${sellerId}`)],
    backSellers(),
    home(),
  ];
}

async function showSettlementHistory(
  env: Env,
  sellerId: string,
  reply: (text: string, rows?: Record<string, unknown>[][]) => Promise<void>,
) {
  const rows = await env.SALES_DB.prepare(
    "SELECT epoch,started_at,ended_at,config_count,sold_bytes,used_bytes FROM reseller_settlements WHERE seller_id=? ORDER BY ended_at DESC,epoch DESC LIMIT 10",
  )
    .bind(sellerId)
    .all<{
      epoch: number;
      started_at: number;
      ended_at: number;
      config_count: number;
      sold_bytes: number;
      used_bytes: number;
    }>();
  const text = rows.results.length
    ? rows.results
        .map(
          (r) =>
            `دوره ${r.epoch.toLocaleString("fa-IR")} · ${r.config_count.toLocaleString("fa-IR")} کانفیگ · ${formatBytes(r.sold_bytes)} فروش · ${formatBytes(r.used_bytes)} مصرف`,
        )
        .join("\n")
    : "هنوز تسویه‌ای ثبت نشده است.";
  await reply(`📚 تسویه‌های اخیر فروشنده ${sellerId}\n${text}`, [
    [btn("بازگشت به فروشنده", `rs:seller:${sellerId}`)],
    home(),
  ]);
}

export async function handleResellerAdminUi(
  env: Env,
  u: TelegramUpdate,
  now: number,
): Promise<boolean> {
  const id = identity(u);
  if (!id) return false;
  const data = u.callback_query?.data;
  const text = u.message?.text?.trim();
  const actor = await resolveSalesActor(env.SALES_DB, id, env);

  const existingStateRaw = await env.SALES_DB.prepare(
    "SELECT conversation FROM users WHERE id=?",
  )
    .bind(id)
    .first<string>("conversation");
  const existingState = parseState(existingStateRaw || "");
  const isAdminInput =
    Boolean(text) &&
    typeof existingState?.step === "string" &&
    existingState.step.startsWith("admin_");
  if (!isAdminCallback(data) && !isAdminInput) return false;

  const ctx = await directContext(env, u, id);
  if (ctx.duplicate) return true;
  if (adminDenied(actor)) {
    ctx.set({});
    await ctx.reply("این بخش فقط برای مدیر مدار در دسترس است.", [home()]);
    return true;
  }

  const db = env.SALES_DB;
  try {
    if (data === "rs:nodes" || /^rs:nodes:(0|[1-9][0-9]{0,2})$/.test(data || "")) {
      ctx.set({});
      const page = data === "rs:nodes" ? 0 : Number(data!.slice("rs:nodes:".length));
      await showNodeList(env, ctx.reply, now, page);
      return true;
    }
    if (data?.startsWith("rs:nodedetail:")) {
      ctx.set({});
      await showNodeDetail(env, data.slice(14), ctx.reply, now);
      return true;
    }
    if (data?.startsWith("rs:capacity:")) {
      const nodeId = data.slice(12);
      const n = (await nodeCapacities(db, now, nodeId))[0];
      if (!n) throw Error("INVALID_NODE");
      ctx.set({ step: "admin_node_count", nodeId });
      await ctx.reply(
        `🔢 سقف کانفیگ ${n.name}\nسقف فعلی: ${n.max_accounts.toLocaleString("fa-IR")}\nعدد جدید را از ۱ تا ۱۰۰۰۰ بفرست.`,
        [backNodes(), home()],
      );
      return true;
    }
    if (data?.startsWith("rs:allocation:")) {
      const nodeId = data.slice(14);
      const n = (await nodeCapacities(db, now, nodeId))[0];
      if (!n) throw Error("INVALID_NODE");
      ctx.set({ step: "admin_node_bytes", nodeId });
      await ctx.reply(
        `📦 سقف حجم ${n.name}\nسقف فعلی: ${n.max_allocated_bytes === null ? "نامحدود" : formatBytes(n.max_allocated_bytes)}\nسقف جدید را به گیگابایت از ۱ تا ۱۰۰۰۰۰۰ بفرست.`,
        [backNodes(), home()],
      );
      return true;
    }
    if (data?.startsWith("rs:unlimit:")) {
      const nodeId = data.slice(11);
      await bestEffortAlert(env, nodeId, now);
      await setNodeMaxAllocatedBytes(db, actor, nodeId, null, now);
      await bestEffortAlert(env, nodeId, now);
      ctx.set({});
      await ctx.reply("✅ سقف حجمی سرور نامحدود شد.", [
        [btn("مشاهده سرور", `rs:nodedetail:${nodeId}`)],
        backNodes(),
        home(),
      ]);
      return true;
    }
    if (text && ctx.state?.step === "admin_node_count") {
      const value = Number(digits(text));
      await setNodeMaxAccounts(db, actor, String(ctx.state.nodeId), value, now);
      ctx.set({});
      await ctx.reply("✅ سقف تعداد کانفیگ سرور ثبت شد.", [
        [btn("مشاهده سرور", `rs:nodedetail:${ctx.state.nodeId}`)],
        backNodes(),
        home(),
      ]);
      return true;
    }
    if (text && ctx.state?.step === "admin_node_bytes") {
      const raw = digits(text);
      const gb = Number(raw);
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(gb) || gb < 1 || gb > 1_000_000)
        throw Error("INVALID_ALLOCATION_CAP");
      const nodeId = String(ctx.state.nodeId);
      await bestEffortAlert(env, nodeId, now);
      await setNodeMaxAllocatedBytes(db, actor, nodeId, gb * 1e9, now);
      await bestEffortAlert(env, nodeId, now);
      ctx.set({});
      await ctx.reply("✅ سقف حجم سرور ثبت شد.", [
        [btn("مشاهده سرور", `rs:nodedetail:${nodeId}`)],
        backNodes(),
        home(),
      ]);
      return true;
    }

    if (data === "rs:sellers" || /^rs:sellers:(0|[1-9][0-9]{0,2})$/.test(data || "")) {
      ctx.set({});
      const page = data === "rs:sellers" ? 0 : Number(data!.slice("rs:sellers:".length));
      await showSellerList(env, ctx.reply, now, page);
      return true;
    }
    if (data?.startsWith("rs:seller:")) {
      const sellerId = data.slice(10);
      ctx.set({});
      await ctx.reply(
        await sellerDetailText(env, sellerId, now),
        sellerDetailRows(sellerId),
      );
      return true;
    }
    if (data?.startsWith("rs:limits:")) {
      const sellerId = data.slice(10);
      const limits = await sellerLimits(db, sellerId, now);
      ctx.set({});
      await ctx.reply(
        [
          `⚙️ سقف‌های فروشنده ${sellerId}`,
          `تعداد: ${limits.maxReservedAccounts === null ? "نامحدود" : limits.maxReservedAccounts.toLocaleString("fa-IR")}`,
          `حجم: ${limits.maxCommittedBytes === null ? "نامحدود" : formatBytes(limits.maxCommittedBytes)}`,
          "عدد ۰ هنگام ویرایش، سقف را حذف می‌کند.",
        ].join("\n"),
        [
          [
            btn("🔢 سقف تعداد", `rs:limitcount:${sellerId}`),
            btn("📦 سقف حجم", `rs:limitbytes:${sellerId}`),
          ],
          [btn("بازگشت به فروشنده", `rs:seller:${sellerId}`)],
          home(),
        ],
      );
      return true;
    }
    if (data?.startsWith("rs:limitcount:")) {
      const sellerId = data.slice(14);
      await sellerLimits(db, sellerId, now);
      ctx.set({ step: "admin_seller_count", sellerId });
      await ctx.reply(
        `🔢 سقف تعداد فروشنده ${sellerId}\nعدد ۱ تا ۱۰۰۰۰ را بفرست؛ ۰ یعنی بدون سقف.`,
        [[btn("بازگشت", `rs:limits:${sellerId}`)], home()],
      );
      return true;
    }
    if (data?.startsWith("rs:limitbytes:")) {
      const sellerId = data.slice(14);
      await sellerLimits(db, sellerId, now);
      ctx.set({ step: "admin_seller_bytes", sellerId });
      await ctx.reply(
        `📦 سقف حجم فروشنده ${sellerId}\nگیگابایت را از ۱ تا ۱۰۰۰۰۰۰ بفرست؛ ۰ یعنی بدون سقف.`,
        [[btn("بازگشت", `rs:limits:${sellerId}`)], home()],
      );
      return true;
    }
    if (text && ctx.state?.step === "admin_seller_count") {
      const raw = digits(text);
      const value = Number(raw);
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 0 || value > 10_000)
        throw Error("INVALID_SELLER_LIMITS");
      const sellerId = String(ctx.state.sellerId);
      const limits = await sellerLimits(db, sellerId, now);
      await setSellerLimits(
        db,
        actor,
        sellerId,
        {
          maxReservedAccounts: value === 0 ? null : value,
          maxCommittedBytes: limits.maxCommittedBytes,
        },
        now,
      );
      ctx.set({});
      await ctx.reply("✅ سقف تعداد فروشنده ثبت شد.", [
        [btn("مشاهده سقف‌ها", `rs:limits:${sellerId}`)],
        home(),
      ]);
      return true;
    }
    if (text && ctx.state?.step === "admin_seller_bytes") {
      const raw = digits(text);
      const gb = Number(raw);
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(gb) || gb < 0 || gb > 1_000_000)
        throw Error("INVALID_SELLER_LIMITS");
      const sellerId = String(ctx.state.sellerId);
      const limits = await sellerLimits(db, sellerId, now);
      await setSellerLimits(
        db,
        actor,
        sellerId,
        {
          maxReservedAccounts: limits.maxReservedAccounts,
          maxCommittedBytes: gb === 0 ? null : gb * 1e9,
        },
        now,
      );
      ctx.set({});
      await ctx.reply("✅ سقف حجم فروشنده ثبت شد.", [
        [btn("مشاهده سقف‌ها", `rs:limits:${sellerId}`)],
        home(),
      ]);
      return true;
    }

    if (data?.startsWith("rs:settle:") && !data.startsWith("rs:settleok:")) {
      const sellerId = data.slice(10);
      const stats = await sellerStats(db, sellerId, "current", now);
      ctx.set({ step: "admin_settle_confirm", sellerId, epoch: stats.epoch });
      await ctx.reply(
        [
          `🧾 تسویه فروشنده ${sellerId}`,
          `فروش این دوره: ${formatBytes(stats.soldBytes)} · ${stats.configCount.toLocaleString("fa-IR")} کانفیگ`,
          `مصرف واقعی: ${formatBytes(stats.usedBytes)}`,
          "",
          "تسویه فقط گزارش دوره را می‌بندد و هیچ کانفیگ مشتری را قطع یا تغییر نمی‌دهد.",
        ].join("\n"),
        [
          [btn("✅ تأیید تسویه", `rs:settleok:${sellerId}`)],
          [btn("بازگشت", `rs:seller:${sellerId}`)],
          home(),
        ],
      );
      return true;
    }
    if (data?.startsWith("rs:settleok:")) {
      const sellerId = data.slice(12);
      if (
        ctx.state?.step !== "admin_settle_confirm" ||
        String(ctx.state.sellerId) !== sellerId
      )
        throw Error("SETTLEMENT_CONFIRMATION_REQUIRED");
      const current = await sellerStats(db, sellerId, "current", now);
      if (current.epoch !== ctx.state.epoch) throw Error("SETTLEMENT_CONFLICT");
      await settleSeller(db, actor, sellerId, now);
      ctx.set({});
      await ctx.reply("✅ تسویه ثبت شد و دورهٔ جاری فروشنده از نو شروع شد.", [
        [btn("تسویه‌های اخیر", `rs:settlements:${sellerId}`)],
        [btn("فروشنده", `rs:seller:${sellerId}`)],
        home(),
      ]);
      return true;
    }
    if (data?.startsWith("rs:settlements:")) {
      const sellerId = data.slice(15);
      await sellerStats(db, sellerId, "all", now);
      ctx.set({});
      await showSettlementHistory(env, sellerId, ctx.reply);
      return true;
    }

    return false;
  } catch (error) {
    const message = error instanceof Error ? error.message : "INVALID";
    const safe =
      message === "INVALID_CAPACITY"
        ? "سقف تعداد باید عددی از ۱ تا ۱۰۰۰۰ باشد."
        : message === "INVALID_ALLOCATION_CAP"
          ? "سقف حجم باید عددی از ۱ تا ۱۰۰۰۰۰۰ گیگابایت باشد."
          : message === "INVALID_SELLER_LIMITS"
            ? "مقدار سقف فروشنده معتبر نیست."
            : message === "SETTLEMENT_CONFLICT" ||
                message === "SETTLEMENT_CONFIRMATION_REQUIRED"
              ? "این تسویه دیگر قابل اجرا نیست. صفحهٔ فروشنده را تازه کن و دوباره تأیید کن."
              : "این درخواست در دسترس نیست یا اطلاعات آن معتبر نیست.";
    await ctx.reply(safe, [home()]);
    return true;
  }
}
