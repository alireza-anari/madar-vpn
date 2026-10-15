import { resetDb } from "./db";
import { env } from "cloudflare:workers";
import { beforeEach, expect, test } from "vitest";
import base from "../migrations/0001.sql?raw";
import sales from "../migrations/0002.sql?raw";
import { handleUpdate } from "../src/menus";
import { recordReceipt } from "../src/receipts";
import { createOrder } from "../src/orders";
const adminEnv = {
  ...env,
  ADMIN_TELEGRAM_IDS: "9",
  PUBLIC_BASE_URL: "https://bot.example",
};
beforeEach(async () => {
  await resetDb();
  await env.SALES_DB.exec(base);
  await env.SALES_DB.exec(sales);
});
const msg = (id: number, text: string) => ({
  update_id: id,
  message: { message_id: 1, chat: { id, type: "private" }, from: { id }, text },
});
test("customer menu does not expose administrator controls", async () => {
  await handleUpdate(adminEnv, msg(100, "/start"), 100);
  const row = await env.SALES_DB.prepare(
    "SELECT payload FROM outbox",
  ).first<string>("payload");
  expect(row).toContain("تست");
  expect(row).not.toContain("پرداخت‌های منتظر");
});
test("admin sees controls and customer forged callback denied", async () => {
  await handleUpdate(adminEnv, msg(9, "/start"), 100);
  expect(
    await env.SALES_DB.prepare("SELECT payload FROM outbox").first("payload"),
  ).toContain("پرداخت‌های منتظر");
  await handleUpdate(
    adminEnv,
    {
      update_id: 101,
      callback_query: {
        id: "cb",
        from: { id: 100 },
        message: { chat: { id: 100, type: "private" } },
        data: "admin:orders",
      },
    },
    100,
  );
  expect(
    await env.SALES_DB.prepare(
      "SELECT payload FROM outbox WHERE id='u101:reply'",
    ).first("payload"),
  ).toContain("دسترسی");
});
test("receipt cannot modify another customer order", async () => {
  await env.SALES_DB.prepare(
    "INSERT INTO plans VALUES('a','a',100,'IRT',60,1)",
  ).run();
  await env.SALES_DB.prepare(
    "INSERT INTO settings VALUES('payment','x')",
  ).run();
  const o = await createOrder(
    env.SALES_DB,
    { telegramId: "100", role: "customer" },
    "a",
    100,
  );
  await expect(
    recordReceipt(
      env.SALES_DB,
      { telegramId: "200", role: "customer" },
      o.id,
      "file",
    ),
  ).rejects.toThrow("ORDER_NOT_AVAILABLE");
  expect(
    await env.SALES_DB.prepare("SELECT COUNT(*) n FROM receipts").first("n"),
  ).toBe(0);
});
test("payment and plan wizard requires admin and persists values", async () => {
  await handleUpdate(
    adminEnv,
    {
      update_id: 2,
      callback_query: {
        id: "c",
        from: { id: 9 },
        message: { chat: { id: 9, type: "private" } },
        data: "admin:payment",
      },
    },
    100,
  );
  await handleUpdate(
    adminEnv,
    { ...msg(9, "شماره کارت آزمایشی"), update_id: 3 },
    100,
  );
  expect(
    await env.SALES_DB.prepare(
      "SELECT value FROM settings WHERE key='payment'",
    ).first("value"),
  ).toBe("شماره کارت آزمایشی");
});
test("approval replay sends owner one preparing notice", async () => {
  await env.SALES_DB.exec(
    "INSERT INTO plans VALUES('a','a',100,'IRT',60,1);\nINSERT INTO settings VALUES('payment','x');",
  );
  const o = await createOrder(
    env.SALES_DB,
    { telegramId: "100", role: "customer" },
    "a",
    100,
  );
  await recordReceipt(
    env.SALES_DB,
    { telegramId: "100", role: "customer" },
    o.id,
    "file",
  );
  for (const update_id of [1, 2])
    await handleUpdate(
      adminEnv,
      {
        update_id,
        callback_query: {
          id: "c",
          from: { id: 9 },
          message: { chat: { id: 9, type: "private" } },
          data: `admin:approve:${o.id}`,
        },
      },
      100,
    );
  expect(
    await env.SALES_DB.prepare(
      "SELECT COUNT(*) n FROM outbox WHERE chat_id='100'",
    ).first("n"),
  ).toBe(1);
  expect(
    await env.SALES_DB.prepare(
      "SELECT payload FROM outbox WHERE chat_id='100'",
    ).first("payload"),
  ).toContain("آماده‌سازی");
});
test("financial notice survives crash between approval and callback reply", async () => {
  await env.SALES_DB.exec(
    "INSERT INTO plans VALUES('a','a',100,'IRT',60,1);\nINSERT INTO settings VALUES('payment','x');",
  );
  const o = await createOrder(
    env.SALES_DB,
    { telegramId: "100", role: "customer" },
    "a",
    100,
  );
  await recordReceipt(
    env.SALES_DB,
    { telegramId: "100", role: "customer" },
    o.id,
    "file",
  );
  const { approveOrder } = await import("../src/orders");
  await approveOrder(
    env.SALES_DB,
    { telegramId: "9", role: "admin" },
    o.id,
    100,
  );
  expect(
    await env.SALES_DB.prepare("SELECT COUNT(*) n FROM outbox WHERE id=?")
      .bind("approved:" + o.id)
      .first("n"),
  ).toBe(1);
});
test("photo receipt is forwarded using photo method", async () => {
  await env.SALES_DB.exec(
    "INSERT INTO plans VALUES('a','a',100,'IRT',60,1);\nINSERT INTO settings VALUES('payment','x');",
  );
  const actor = { telegramId: "100", role: "customer" as const };
  const o = await createOrder(env.SALES_DB, actor, "a", 100);
  await env.SALES_DB.prepare("UPDATE users SET conversation=? WHERE id=?")
    .bind("receipt:" + o.id, "100")
    .run();
  await handleUpdate(
    adminEnv,
    {
      update_id: 50,
      message: {
        message_id: 1,
        from: { id: 100 },
        chat: { id: 100, type: "private" },
        photo: [{ file_id: "photo-only" }],
      },
    },
    100,
  );
  await handleUpdate(
    adminEnv,
    {
      update_id: 51,
      callback_query: {
        id: "c",
        from: { id: 9 },
        message: { chat: { id: 9, type: "private" } },
        data: "admin:order:" + o.id,
      },
    },
    100,
  );
  const payload = await env.SALES_DB.prepare(
    "SELECT payload FROM outbox WHERE id='u51:receipt'",
  ).first<string>("payload");
  expect(JSON.parse(payload!)).toMatchObject({
    _method: "sendPhoto",
    photo: "photo-only",
  });
});
