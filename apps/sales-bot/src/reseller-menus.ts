import type { TelegramUpdate } from "./contracts";
import { handleCustomerTelegramUpdate } from "./customer-telegram";
import { handleTelegramSupport } from "./telegram-support";
import { handleAdminStoreTelegram } from "./admin-telegram-store";
import { handleTelegramEnrollment } from "./telegram-enrollment";
import { handleSellerTelegram } from "./seller-telegram";
import { handleResellerAdminUi } from "./reseller-admin-ui";
import { handleResellerUpdate as handleDashboardResellerUpdate } from "./reseller-menus-dashboard";
import { sellerNodeStats, sellerStats } from "./seller-accounting";
import { formatBytes } from "./sales-format";
import { resolveSalesActor } from "./resellers";

const faDigits = (value: string) =>
  value
    .replace(/\d/g, (digit) => "۰۱۲۳۴۵۶۷۸۹"[Number(digit)]!)
    .replace(/%/g, "٪");

function updateIdentity(u: TelegramUpdate) {
  const id = u.message?.from?.id ?? u.callback_query?.from.id;
  const chat = u.message?.chat ?? u.callback_query?.message?.chat;
  if (!id || !chat || chat.type !== "private" || chat.id !== id) return null;
  return String(id);
}

async function loadReply(env: Env, updateId: number) {
  const id = `u${updateId}:reply`;
  const raw = await env.SALES_DB.prepare("SELECT payload FROM outbox WHERE id=?")
    .bind(id)
    .first<string>("payload");
  if (!raw) return null;
  try {
    return { id, payload: JSON.parse(raw) as Record<string, any> };
  } catch {
    return null;
  }
}

async function saveReply(
  env: Env,
  reply: { id: string; payload: Record<string, any> },
) {
  await env.SALES_DB.prepare("UPDATE outbox SET payload=? WHERE id=?")
    .bind(JSON.stringify(reply.payload), reply.id)
    .run();
}

function stateSummary(stats: Awaited<ReturnType<typeof sellerStats>>) {
  return [
    `در سرویس: ${(stats.liveCount + stats.blockedCount).toLocaleString("fa-IR")}`,
    `متوقف: ${stats.blockedCount.toLocaleString("fa-IR")}`,
    `منقضی: ${stats.expiredCount.toLocaleString("fa-IR")}`,
    `لغوشده: ${stats.revokedCount.toLocaleString("fa-IR")}`,
    `پایان حجم: ${stats.exhaustedCount.toLocaleString("fa-IR")}`,
  ].join(" · ");
}

function nodeBreakdown(
  rows: Awaited<ReturnType<typeof sellerNodeStats>>,
) {
  if (!rows.length) return "—";
  return rows
    .map(
      (row) =>
        `${row.nodeName}: ${row.configCount.toLocaleString("fa-IR")} کانفیگ · ${formatBytes(row.soldBytes)} فروش · ${formatBytes(row.usedBytes)} مصرف`,
    )
    .join("\n");
}

async function enhanceAdminReply(env: Env, u: TelegramUpdate, now: number) {
  const data = u.callback_query?.data;
  if (!data) return;
  // Do not augment denied admin callbacks with privileged navigation links.
  const id = updateIdentity(u);
  if (!id || (await resolveSalesActor(env.SALES_DB, id, env)).role !== "admin") return;
  const reply = await loadReply(env, u.update_id);
  if (!reply) return;

  const keyboard = (reply.payload.reply_markup?.inline_keyboard || []) as Record<
    string,
    any
  >[][];

  if (data === "rs:nodes" || /^rs:nodes:(0|[1-9][0-9]{0,2})$/.test(data)) {
    const withoutExisting=keyboard.filter(row=>
      !row.some(button=>button.web_app || button.callback_data==="enroll:start"));
    const homeIndex=withoutExisting.findIndex(row=>row.some(button=>button.callback_data==="rs:home"));
    const native=[{text:"➕ افزودن سرور در ربات",callback_data:"enroll:start"}];
    if(homeIndex>=0)withoutExisting.splice(homeIndex,0,native);
    else withoutExisting.push(native);
    reply.payload.reply_markup={inline_keyboard:withoutExisting};
    await saveReply(env,reply);
    return;
  }

  if (data.startsWith("rs:nodedetail:")) {
    const nodeId = data.slice(14);
    const level =
      (await env.SALES_DB.prepare(
        "SELECT level FROM node_capacity_alert_state WHERE node_id=?",
      )
        .bind(nodeId)
        .first<number>("level")) || 0;
    if (typeof reply.payload.text === "string")
      reply.payload.text += `\nهشدار ظرفیت: ${level ? `${level}%` : "عادی"}`;
    const hasConfigAction = keyboard.some((row) =>
      row.some((button) => button.callback_data === "rs:list"),
    );
    if (!hasConfigAction) {
      const backIndex = keyboard.findIndex((row) =>
        row.some((button) => button.callback_data === "rs:nodes"),
      );
      const row = [{ text: "📋 کانفیگ‌ها", callback_data: "rs:list" }];
      if (backIndex >= 0) keyboard.splice(backIndex, 0, row);
      else keyboard.push(row);
    }
    reply.payload.reply_markup = { inline_keyboard: keyboard };
    await saveReply(env, reply);
    return;
  }

  if (data.startsWith("rs:view:")) {
    const ownerId=id;
    const accountId=data.slice("rs:view:".length);
    const owned=await env.SALES_DB.prepare(
      "SELECT id FROM managed_accounts WHERE id=? AND seller_id=?",
    ).bind(accountId,ownerId).first<string>("id");
    if(owned){
      const ownButtons=[
        {text:"👤 جزئیات و خدمات مشتری",callback_data:"seller:account:"+accountId},
      ];
      const beforeBack=keyboard.findIndex(row=>row.some(x=>x.callback_data==="rs:list"));
      if(beforeBack>=0)keyboard.splice(beforeBack,0,ownButtons);
      else keyboard.push(ownButtons);
      reply.payload.reply_markup={inline_keyboard:keyboard};
      await saveReply(env,reply);
    }
    return;
  }

  if (data.startsWith("rs:seller:")) {
    const sellerId = data.slice(10);
    const [current, all, currentNodes, allNodes] = await Promise.all([
      sellerStats(env.SALES_DB, sellerId, "current", now),
      sellerStats(env.SALES_DB, sellerId, "all", now),
      sellerNodeStats(env.SALES_DB, sellerId, "current", now),
      sellerNodeStats(env.SALES_DB, sellerId, "all", now),
    ]);
    if (typeof reply.payload.text === "string") {
      const base = reply.payload.text.split("\n\nتفکیک سرور\n")[0]!;
      reply.payload.text = [
        base,
        "",
        "وضعیت این تسویه",
        stateSummary(current),
        "",
        "وضعیت کل دوره",
        stateSummary(all),
        "",
        "تفکیک این تسویه",
        nodeBreakdown(currentNodes),
        "",
        "تفکیک کل دوره",
        nodeBreakdown(allNodes),
      ].join("\n");
    }
    await saveReply(env, reply);
  }
}

function addMiniAppEntry(payload: Record<string, any>, publicBaseUrl: string) {
  const keyboard = (payload.reply_markup?.inline_keyboard || []) as Record<
    string,
    any
  >[][];
  const appUrl = `${publicBaseUrl.replace(/\/+$/, "")}/app`;
  // The home screen gets exactly one Web App action. Callback buttons remain as
  // rollout fallback, but the standalone /enroll action stays under Servers.
  const fallbackRows = keyboard.filter(
    (row) => !row.some((button) => button.web_app),
  );
  payload.reply_markup = {
    inline_keyboard: [
      ...fallbackRows,
      [{ text: "باز کردن پنل مدار", web_app: { url: appUrl } }],
    ],
  };
}

async function enhanceDashboardReply(env: Env, u: TelegramUpdate, now: number) {
  const id = updateIdentity(u);
  if (!id) return;
  const data = u.callback_query?.data;
  const text = u.message?.text?.trim();
  const isHome =
    text === "/start" ||
    text === "/menu" ||
    text === "/cancel" ||
    data === "home" ||
    data === "rs:home";
  if (!isHome) return;

  const reply = await loadReply(env, u.update_id);
  if (!reply) return;
  const actor = await resolveSalesActor(env.SALES_DB, id, env);

  if (actor.role === "seller") {
    // The entire seller home is native Telegram. Do not append the old Mini App action.
    return;
  }

  if (actor.role === "admin") {
    if (env.PUBLIC_BASE_URL) addMiniAppEntry(reply.payload, env.PUBLIC_BASE_URL);
    // Native operations are always primary. Keep optional web shortcuts at the very end.
    const adminKeyboard = (reply.payload.reply_markup?.inline_keyboard || []) as Record<string, any>[][];
    if (env.PUBLIC_BASE_URL)
      adminKeyboard.push([{ text: "🛍️ پیش‌نمایش فروشگاه (اختیاری)", web_app: {
        url: new URL("/customer", env.PUBLIC_BASE_URL).toString()
      } }]);
    reply.payload.reply_markup = { inline_keyboard: adminKeyboard };
    await saveReply(env, reply);
  }
}

// Turn callback-driven admin/seller navigation into an in-place text edit.
// Media captions and messages without a known message_id are intentionally left alone.
async function editAdminSellerCallbackReply(env: Env, u: TelegramUpdate) {
  const source = u.callback_query?.message;
  const id = updateIdentity(u);
  if (
    !source ||
    !id ||
    !Number.isSafeInteger(source.message_id) ||
    !source.message_id ||
    typeof source.text !== "string"
  ) return;
  const actor = await resolveSalesActor(env.SALES_DB, id, env);
  if (actor.role !== "admin" && actor.role !== "seller") return;
  const reply = await loadReply(env, u.update_id);
  if (!reply) return;
  if (reply.payload._method === "sendPhoto" || reply.payload._method === "sendDocument") return;
  reply.payload._method = "editMessageText";
  reply.payload.message_id = source.message_id;
  await saveReply(env, reply);
}

async function localizeAdminReply(env: Env, updateId: number) {
  const reply = await loadReply(env, updateId);
  if (!reply) return;
  try {
    if (typeof reply.payload.text !== "string") return;
    reply.payload.text = faDigits(reply.payload.text);
    await saveReply(env, reply);
  } catch {
    // Durable reply already exists; presentation localization must never fail the action.
  }
}

export async function handleResellerUpdate(
  env: Env,
  u: TelegramUpdate,
  now: number,
) {
  if (await handleTelegramEnrollment(env, u, now)) {
    await editAdminSellerCallbackReply(env, u);
    return;
  }
  if (await handleAdminStoreTelegram(env, u, now)) {
    await localizeAdminReply(env, u.update_id);
    await editAdminSellerCallbackReply(env, u);
    return;
  }
  if (await handleTelegramSupport(env, u, now)) {
    await editAdminSellerCallbackReply(env, u);
    return;
  }
  if (await handleSellerTelegram(env, u, now)) {
    await editAdminSellerCallbackReply(env, u);
    return;
  }
  if (await handleCustomerTelegramUpdate(env, u, now)) {
    await editAdminSellerCallbackReply(env, u);
    return;
  }
  if (await handleResellerAdminUi(env, u, now)) {
    await enhanceAdminReply(env, u, now);
    await localizeAdminReply(env, u.update_id);
    await editAdminSellerCallbackReply(env, u);
    return;
  }
  await handleDashboardResellerUpdate(env, u, now);
  await enhanceDashboardReply(env, u, now);
  await editAdminSellerCallbackReply(env, u);
}
