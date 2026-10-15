import { resetDb } from "./db";
import { env } from "cloudflare:workers";
import { beforeEach, expect, test } from "vitest";
import worker from "../src/index";
import { resolveActor } from "../src/auth";
import { recordUpdate } from "../src/telegram";
import { deliverOutbox } from "../src/outbox";
import schema from "../migrations/0001.sql?raw";
beforeEach(async () => {
  await resetDb();
  await env.SALES_DB.exec(schema);
});
test("unauthenticated webhook rejects before persistence", async () => {
  const r = await worker.fetch(
    new Request("https://bot/webhook", {
      method: "POST",
      body: '{"update_id":1}',
    }),
    { ...env, TELEGRAM_WEBHOOK_SECRET: "test-hook" },
  );
  expect(r.status).toBe(401);
  expect(
    await env.SALES_DB.prepare("SELECT COUNT(*) n FROM telegram_updates").first(
      "n",
    ),
  ).toBe(0);
});
test("durable update dedupe preserves one row", async () => {
  expect(await recordUpdate(env.SALES_DB, { update_id: 1 })).toBe(true);
  expect(await recordUpdate(env.SALES_DB, { update_id: 1 })).toBe(false);
  expect(
    await env.SALES_DB.prepare("SELECT COUNT(*) n FROM telegram_updates").first(
      "n",
    ),
  ).toBe(1);
});
test("admin IDs are exact numeric identities", () => {
  expect(
    resolveActor("123", { ...env, ADMIN_TELEGRAM_IDS: "123,456" }).role,
  ).toBe("admin");
  expect(resolveActor("12", { ...env, ADMIN_TELEGRAM_IDS: "123" }).role).toBe(
    "customer",
  );
  expect(resolveActor("123", { ...env, ADMIN_TELEGRAM_IDS: "" }).role).toBe(
    "customer",
  );
});
test("storage error is not acknowledged", async () => {
  await env.SALES_DB.exec("DROP TABLE telegram_updates");
  const r = await worker.fetch(
    new Request("https://bot/webhook", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": "test-hook" },
      body: '{"update_id":2}',
    }),
    { ...env, TELEGRAM_WEBHOOK_SECRET: "test-hook" },
  );
  expect(r.status).toBe(503);
});
test("transient delivery failure retains durable retry", async () => {
  await env.SALES_DB.prepare(
    "INSERT INTO outbox(id,chat_id,payload,available_at) VALUES('a','123','{}',0)",
  ).run();
  await deliverOutbox(
    { ...env, BOT_TOKEN: "test-only" },
    100,
    async () => new Response("{}", { status: 503 }),
  );
  const row = await env.SALES_DB.prepare(
    "SELECT state,attempts,available_at FROM outbox WHERE id='a'",
  ).first();
  expect(row).toMatchObject({ state: "pending", attempts: 1 });
  expect(Number(row?.available_at)).toBeGreaterThan(100);
});
test("health is explicitly disabled before token setup", async () => {
  const r = await worker.fetch(new Request("https://bot/health"), {
    ...env,
    BOT_TOKEN: "",
  });
  expect(await r.json()).toMatchObject({ telegram: "disabled" });
});
