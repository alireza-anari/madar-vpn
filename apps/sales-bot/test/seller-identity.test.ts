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
import m12 from "../migrations/0012-telegram-profiles.sql?raw";
import { listAdminSellerCards, loadAdminSellerDetail } from "../src/app-admin";

const admin = { telegramId: "1", role: "admin" as const };
const now = 10_000;

beforeEach(async () => {
  await resetDb();
  for (const sql of [m1,m2,m3,m4,m5,m6,m7,m8,m9,m10,m11,m12])
    await env.SALES_DB.exec(sql);
  await env.SALES_DB.exec(
    "INSERT INTO resellers(telegram_id,enabled,created_at) VALUES('10',1,100),('20',1,90),('30',1,80);" +
    "INSERT INTO telegram_profiles(telegram_id,username,first_name,last_name,updated_at) VALUES('10','seller10','Ali','Rezaei',1),('20',NULL,'Sara','Ahmadi',1);"
  );
});

test("seller cards prefer @username, then Telegram name, then numeric id", async () => {
  const cards = await listAdminSellerCards(env.SALES_DB, admin, now);
  const byId = new Map(cards.map((card) => [card.sellerId, card]));
  expect(byId.get("10")).toMatchObject({ sellerId: "10", username: "seller10", displayName: "@seller10" });
  expect(byId.get("20")).toMatchObject({ sellerId: "20", username: null, displayName: "Sara Ahmadi" });
  expect(byId.get("30")).toMatchObject({ sellerId: "30", username: null, displayName: "30" });
});

test("seller detail keeps numeric id as secondary metadata", async () => {
  await expect(loadAdminSellerDetail(env.SALES_DB, admin, "10", now)).resolves.toMatchObject({
    sellerId: "10",
    username: "seller10",
    displayName: "@seller10",
  });
});
