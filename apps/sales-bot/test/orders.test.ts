import { resetDb } from "./db";
import { env } from "cloudflare:workers";
import { beforeEach, expect, test } from "vitest";
import schema from "../migrations/0001.sql?raw";
import sales from "../migrations/0002.sql?raw";
import {
  createOrder,
  approveOrder,
  reserveTrial,
  startTrialAfterAck,
} from "../src/orders";
const user = { telegramId: "100", role: "customer" as const },
  admin = { telegramId: "9", role: "admin" as const };
beforeEach(async () => {
  await resetDb();
  await env.SALES_DB.exec(schema);
  await env.SALES_DB.exec(sales);
  await env.SALES_DB.prepare(
    "INSERT INTO plans(id,name,price,currency,duration,enabled) VALUES('month','ماهانه',3000000,'IRR',2592000,1)",
  ).run();
  await env.SALES_DB.prepare(
    "INSERT INTO settings(key,value) VALUES('payment','test destination')",
  ).run();
});
async function pending() {
  const o = await createOrder(env.SALES_DB, user, "month", 100);
  await env.SALES_DB.prepare(
    "UPDATE orders SET state='pending_review' WHERE id=?",
  )
    .bind(o.id)
    .run();
  return o;
}
test("concurrent financial approval applies one extension", async () => {
  const o = await pending();
  const r = await Promise.all([
    approveOrder(env.SALES_DB, admin, o.id, 100),
    approveOrder(env.SALES_DB, admin, o.id, 100),
  ]);
  expect(r.filter((x) => x.applied)).toHaveLength(1);
  expect(
    await env.SALES_DB.prepare("SELECT COUNT(*) n FROM ledger").first("n"),
  ).toBe(1);
  expect(
    await env.SALES_DB.prepare(
      "SELECT valid_until FROM entitlements WHERE user_id=?",
    )
      .bind("100")
      .first("valid_until"),
  ).toBe(2592100);
});
test("order price and duration are immutable snapshot", async () => {
  const o = await pending();
  await env.SALES_DB.prepare("UPDATE plans SET price=999,duration=1").run();
  await approveOrder(env.SALES_DB, admin, o.id, 100);
  expect(o.price).toBe(3000000);
  expect(
    await env.SALES_DB.prepare("SELECT valid_until FROM entitlements").first(
      "valid_until",
    ),
  ).toBe(2592100);
  expect((await approveOrder(env.SALES_DB, admin, o.id, 101)).applied).toBe(
    false,
  );
});
test("customer cannot approve", async () => {
  const o = await pending();
  await expect(approveOrder(env.SALES_DB, user, o.id, 100)).rejects.toThrow(
    "ADMIN_REQUIRED",
  );
});
test("trial reserved once and starts only after matching ACK", async () => {
  expect((await reserveTrial(env.SALES_DB, user)).created).toBe(true);
  expect((await reserveTrial(env.SALES_DB, user)).created).toBe(false);
  expect(
    await env.SALES_DB.prepare("SELECT valid_until FROM entitlements").first(
      "valid_until",
    ),
  ).toBe(0);
  await startTrialAfterAck(env.SALES_DB, "100", 1, 100);
  expect(
    await env.SALES_DB.prepare("SELECT valid_until FROM entitlements").first(
      "valid_until",
    ),
  ).toBe(0);
  await env.SALES_DB.prepare(
    "UPDATE trials SET prepared_revision=1,acked_revision=1",
  ).run();
  await startTrialAfterAck(env.SALES_DB, "100", 1, 100);
  await startTrialAfterAck(env.SALES_DB, "100", 1, 200);
  expect(
    await env.SALES_DB.prepare("SELECT valid_until FROM entitlements").first(
      "valid_until",
    ),
  ).toBe(1900);
});
test("unset payment disables purchases", async () => {
  await env.SALES_DB.prepare("DELETE FROM settings").run();
  await expect(createOrder(env.SALES_DB, user, "month", 100)).rejects.toThrow(
    "SALES_DISABLED",
  );
});
test("replayed purchase update creates one snapshot order", async () => {
  const a = await createOrder(env.SALES_DB, user, "month", 100, "update100");
  const c = await createOrder(env.SALES_DB, user, "month", 101, "update100");
  expect(a.id).toBe(c.id);
  expect(
    await env.SALES_DB.prepare("SELECT COUNT(*) n FROM orders").first("n"),
  ).toBe(1);
});
