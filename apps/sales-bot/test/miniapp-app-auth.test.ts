import { createHmac } from "node:crypto";
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
import {
  authenticateMiniApp,
  verifyMiniAppTelegramId,
} from "../src/miniapp-auth";

const now = 2_000_000;
const token = "123456:TEST_TOKEN";
const appEnv = {
  ...env,
  BOT_TOKEN: token,
  ADMIN_TELEGRAM_IDS: "100",
} as Env;

function signed(pairs: Array<[string, string]>) {
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const value = [...pairs]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const hash = createHmac("sha256", secret).update(value).digest("hex");
  const params = new URLSearchParams();
  for (const [k, v] of pairs) params.append(k, v);
  params.append("hash", hash);
  return params.toString();
}

function initData(id: number, authDate = now) {
  return signed([
    ["auth_date", String(authDate)],
    ["query_id", "AA-test"],
    ["user", JSON.stringify({ id, first_name: "Test" })],
  ]);
}

beforeEach(async () => {
  await resetDb();
  for (const sql of [m1, m2, m3, m4, m5, m6, m7, m8, m9, m10])
    await env.SALES_DB.exec(sql);
});

test("resolves a valid admin Mini App session", async () => {
  expect(verifyMiniAppTelegramId(initData(100), appEnv, now)).toBe("100");
  await expect(authenticateMiniApp(initData(100), appEnv, now)).resolves.toEqual({
    telegramId: "100",
    role: "admin",
  });
});

test("resolves an enabled reseller and distinguishes a disabled reseller", async () => {
  await env.SALES_DB.exec(
    "INSERT INTO resellers(telegram_id,enabled,created_at) VALUES('200',1,1),('201',0,1);",
  );
  await expect(authenticateMiniApp(initData(200), appEnv, now)).resolves.toEqual({
    telegramId: "200",
    role: "seller",
  });
  await expect(authenticateMiniApp(initData(201), appEnv, now)).rejects.toThrow(
    "SELLER_DISABLED",
  );
});

test("fails closed on duplicate query keys", () => {
  const data = signed([
    ["auth_date", String(now)],
    ["query_id", "one"],
    ["query_id", "two"],
    ["user", JSON.stringify({ id: 100 })],
  ]);
  expect(() => verifyMiniAppTelegramId(data, appEnv, now)).toThrow("INVALID_SIGNATURE");
});

test("fails closed on malformed signed user JSON", () => {
  const data = signed([
    ["auth_date", String(now)],
    ["query_id", "one"],
    ["user", "{bad"],
  ]);
  expect(() => verifyMiniAppTelegramId(data, appEnv, now)).toThrow();
});

test("rejects a forged hash", () => {
  const params = new URLSearchParams(initData(100));
  params.set("hash", "0".repeat(64));
  expect(() => verifyMiniAppTelegramId(params.toString(), appEnv, now)).toThrow(
    "INVALID_SIGNATURE",
  );
});

test("rejects auth dates too far in the future or older than five minutes", () => {
  expect(() => verifyMiniAppTelegramId(initData(100, now + 31), appEnv, now)).toThrow(
    "AUTH_EXPIRED",
  );
  expect(() => verifyMiniAppTelegramId(initData(100, now - 301), appEnv, now)).toThrow(
    "AUTH_EXPIRED",
  );
});
