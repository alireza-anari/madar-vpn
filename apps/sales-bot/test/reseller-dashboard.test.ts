import { env } from "cloudflare:workers";
import { beforeEach, expect, test } from "vitest";
import { resetDb } from "./db";
import m1 from "../migrations/0001.sql?raw";
import m2 from "../migrations/0002.sql?raw";
import m3 from "../migrations/0003.sql?raw";
import m4 from "../migrations/0004-reseller-accounts.sql?raw";
import m5 from "../migrations/0005-shared-node-purposes.sql?raw";
import m6 from "../migrations/0006-trial-quota.sql?raw";
import m7 from "../migrations/0007-node-capacity.sql?raw";
import m8 from "../migrations/0008-reseller-invites.sql?raw";
import m9 from "../migrations/0009-node-allocation-cap.sql?raw";
import m10 from "../migrations/0010-capacity-accounting-resellers.sql?raw";
import m11 from "../migrations/0011-node-account-slot-mode.sql?raw";
import { handleUpdate } from "../src/menus";

const GB = 1e9;
const E = { ...env, ADMIN_TELEGRAM_IDS: "9", PUBLIC_BASE_URL: "https://example.test" };
let seq = 3000;

const click = (id: number, data: string, update = seq++) =>
  handleUpdate(
    E,
    {
      update_id: update,
      callback_query: {
        id: String(update),
        from: { id },
        message: { chat: { id, type: "private" } },
        data,
      },
    },
    100,
  );
const send = (id: number, text: string, update = seq++) =>
  handleUpdate(
    E,
    {
      update_id: update,
      message: {
        message_id: update,
        chat: { id, type: "private" },
        from: { id },
        text,
      },
    },
    100,
  );
const clickFromMessage = (
  id: number,
  data: string,
  messageId: number,
  sourceText: string,
  update = seq++,
) =>
  handleUpdate(
    E,
    {
      update_id: update,
      callback_query: {
        id: String(update),
        from: { id },
        message: {
          message_id: messageId,
          chat: { id, type: "private" },
          text: sourceText,
        },
        data,
      },
    },
    100,
  );
const payload = async (update: number) =>
  JSON.parse(
    (await env.SALES_DB.prepare("SELECT payload FROM outbox WHERE id=?")
      .bind(`u${update}:reply`)
      .first<string>("payload"))!,
  );

beforeEach(async () => {
  await resetDb();
  for (const sql of [m1, m2, m3, m4, m5, m6, m7, m8, m9, m10, m11])
    await env.SALES_DB.exec(sql);
  await env.SALES_DB.exec(
    "INSERT INTO settings(key,value) VALUES('app_mode','reseller');" +
      "INSERT INTO nodes(id,name,target_ip,healthy,last_seen,agent_capabilities,max_accounts,max_allocated_bytes) VALUES('n1','Stockholm','8.8.8.8',1,100,'quota-v2,shared-443',20,100000000000),('n2','Frankfurt','1.1.1.1',1,100,'quota-v2,shared-443',20,100000000000);" +
      "INSERT INTO node_purposes(purpose,node_id) VALUES('sale','n1'),('trial','n2');" +
      "INSERT INTO resellers(telegram_id,enabled,created_at) VALUES('10',1,50);",
  );
});

async function account(
  id: string,
  state: string,
  quotaGb: number,
  usedGb: number,
  validUntil = 1000,
  nodeId = "n1",
) {
  await env.SALES_DB.prepare(
    "INSERT INTO managed_accounts(id,seller_id,request_key,node_id,kind,label,uuid,state,quota_bytes,used_bytes,duration_seconds,valid_until,created_at) VALUES(?,'10',?,?,'sale',?,?,?, ?,?,86400,?,60)",
  )
    .bind(id, id, nodeId, id, `uuid-${id}`, state, quotaGb * GB, usedGb * GB, validUntil)
    .run();
}

test("seller home is compact, seller-only and shows current plus all-time accounting", async () => {
  await account("live", "active", 30, 5);
  await account("rev", "revoked", 20, 8);
  const update = 3100;
  await click(10, "rs:home", update);
  const p = await payload(update);
  expect(p.text).toContain("💼 پنل فروش");
  expect(p.text).toContain("در سرویس: ۱");
  expect(p.text).toContain("این تسویه: ۲ کانفیگ · ۵۰ GB");
  expect(p.text).toContain("کل فروش: ۲ کانفیگ · ۵۰ GB");
  expect(p.text).not.toContain("فروشنده‌های فعال");
  const buttons = p.reply_markup.inline_keyboard.flat().map((b: any) => b.callback_data);
  expect(buttons).toContain("rs:stats");
  expect(buttons).not.toContain("rs:sellers");
});

test("admin home prioritizes operational node and reseller inventory", async () => {
  await account("live", "active", 30, 5);
  await account("rev", "revoked", 20, 8);
  const update = 3101;
  await click(9, "rs:home", update);
  const p = await payload(update);
  expect(p.text).toContain("📊 وضعیت کلی مدار");
  expect(p.text).toContain("سرورهای فعال: ۲");
  expect(p.text).toContain("رزرو فعال: ۳۰ GB");
  expect(p.text).toContain("مصرف قطعی: ۸ GB");
  expect(p.text).toContain("فروشنده‌های فعال: ۱");
  const buttons = p.reply_markup.inline_keyboard.flat().map((b: any) => b.callback_data);
  expect(buttons).toContain("rs:nodes");
  expect(buttons).toContain("rs:sellers");
  expect(buttons).toContain("rs:reports");
});

test("server picker uses true sellable traffic and excludes nodes that cannot fit the sale", async () => {
  await account("rev", "revoked", 30, 8);
  await env.SALES_DB.exec("UPDATE nodes SET max_allocated_bytes=20000000000 WHERE id='n2'");
  await click(10, "rs:sale", 3110);
  await send(10, "client", 3111);
  await send(10, "30", 3112);
  await send(10, "30", 3113);
  const p = await payload(3113);
  const buttons = p.reply_markup.inline_keyboard.flat();
  const stockholm = buttons.find((b: any) => b.callback_data === "rs:choose:n1");
  expect(stockholm.text).toContain("۹۲ GB");
  expect(stockholm.text).toContain("قابل فروش");
  expect(buttons.some((b: any) => b.callback_data === "rs:choose:n2")).toBe(false);
});

test("valid blocked reservation reduces picker capacity while stale blocked keeps only usage", async () => {
  await account("blocked", "blocked", 30, 8, 1000);
  await click(10, "rs:trial", 3120);
  let p = await payload(3120);
  let stockholm = p.reply_markup.inline_keyboard
    .flat()
    .find((b: any) => b.callback_data === "rs:choose:n1");
  expect(stockholm.text).toContain("۷۰ GB");

  await env.SALES_DB.exec("UPDATE managed_accounts SET valid_until=50 WHERE id='blocked'");
  await click(10, "rs:trial", 3121);
  p = await payload(3121);
  stockholm = p.reply_markup.inline_keyboard
    .flat()
    .find((b: any) => b.callback_data === "rs:choose:n1");
  expect(stockholm.text).toContain("۹۲ GB");
});

test("server confirmation shows capacity before and projected after the sale", async () => {
  await account("rev", "revoked", 30, 8);
  await click(10, "rs:sale", 3130);
  await send(10, "client", 3131);
  await send(10, "30", 3132);
  await send(10, "30", 3133);
  await click(10, "rs:choose:n1", 3134);
  const p = await payload(3134);
  expect(p.text).toContain("✅ بررسی نهایی");
  expect(p.text).toContain("قابل فروش فعلی: ۹۲ GB");
  expect(p.text).toContain("پس از این فروش: ۶۲ GB");
});

test("seller self-statistics expose current/all-time usage without global admin data", async () => {
  await account("live", "active", 30, 5);
  await account("rev", "revoked", 20, 8, 1000, "n2");
  const update = 3140;
  await click(10, "rs:stats", update);
  const p = await payload(update);
  expect(p.text).toContain("📊 آمار من");
  expect(p.text).toContain("این تسویه");
  expect(p.text).toContain("کل دوره");
  expect(p.text).toContain("فروش: ۵۰ GB");
  expect(p.text).toContain("مصرف واقعی: ۱۳ GB");
  expect(p.text).not.toContain("فروشنده‌های فعال");
});

test("stale final confirmation returns a safe Persian node-capacity error", async () => {
  await click(10, "rs:sale", 3150);
  await send(10, "client", 3151);
  await send(10, "30", 3152);
  await send(10, "30", 3153);
  await click(10, "rs:choose:n1", 3154);
  const state = JSON.parse(
    (await env.SALES_DB.prepare("SELECT conversation FROM users WHERE id='10'").first<string>("conversation"))!,
  );
  await env.SALES_DB.exec("UPDATE nodes SET max_allocated_bytes=20000000000 WHERE id='n1'");
  await click(10, `rs:confirm:${state.requestKey}`, 3155);
  expect((await payload(3155)).text).toContain("ظرفیت حجمی این سرور");
});

test("seller count and byte caps have distinct Persian errors", async () => {
  await account("live", "active", 10, 0);
  await env.SALES_DB.exec(
    "INSERT INTO reseller_controls(seller_id,current_settlement_epoch,settlement_started_at,max_reserved_accounts,max_committed_bytes,updated_at) VALUES('10',0,50,1,NULL,100)",
  );
  await click(10, "rs:sale", 3160);
  await send(10, "client", 3161);
  await send(10, "10", 3162);
  await send(10, "30", 3163);
  expect((await payload(3163)).text).toContain("سقف تعداد کانفیگ فروشنده");

  await env.SALES_DB.exec(
    "UPDATE reseller_controls SET max_reserved_accounts=NULL,max_committed_bytes=15000000000 WHERE seller_id='10'",
  );
  await click(10, "rs:sale", 3170);
  await send(10, "client2", 3171);
  await send(10, "10", 3172);
  await send(10, "30", 3173);
  expect((await payload(3173)).text).toContain("سقف حجم فروشنده");
});

test("seller and admin callback menus edit the current text message instead of adding duplicates", async () => {
  const sellerUpdate = 3190;
  await clickFromMessage(10, "rs:home", 701, "💼 پنل فروش قدیمی", sellerUpdate);
  const sellerReply = await payload(sellerUpdate);
  expect(sellerReply._method).toBe("editMessageText");
  expect(sellerReply.message_id).toBe(701);
  expect(sellerReply.text).toContain("💼 پنل فروش");
  expect(sellerReply.reply_markup.inline_keyboard.flat().some((b: any) => b.callback_data === "rs:sale")).toBe(true);

  const adminUpdate = 3191;
  await clickFromMessage(9, "rs:nodes", 702, "📊 وضعیت کلی مدار", adminUpdate);
  const adminReply = await payload(adminUpdate);
  expect(adminReply._method).toBe("editMessageText");
  expect(adminReply.message_id).toBe(702);
  expect(adminReply.text).toContain("🌐 سرورها");
  expect(adminReply.reply_markup.inline_keyboard.flat().some((b: any) => b.callback_data === "rs:home")).toBe(true);
});

test("admin/seller callback from a photo or unknown message stays on safe send-message path", async () => {
  const update = 3192;
  await handleUpdate(E, {
    update_id: update,
    callback_query: {
      id: String(update),
      from: { id: 10 },
      message: { message_id: 703, chat: { id: 10, type: "private" }, caption: "پنل فروش", photo: [{ file_id: "photo" }] },
      data: "rs:home",
    },
  } as any, 100);
  const reply = await payload(update);
  expect(reply._method).toBeUndefined();
  expect(reply.message_id).toBeUndefined();
  expect(reply.text).toContain("💼 پنل فروش");
});
