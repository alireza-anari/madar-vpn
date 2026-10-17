import { env } from "cloudflare:workers";
import { beforeEach, expect, test } from "vitest";
import profiles from "../migrations/0012-telegram-profiles.sql?raw";
import {
  profileDisplayName,
  upsertTelegramProfile,
  type VerifiedTelegramUser,
} from "../src/telegram-profiles";
import { resetDb } from "./db";

beforeEach(async () => {
  await resetDb();
  await env.SALES_DB.exec(profiles);
});

const profile = (overrides: Partial<VerifiedTelegramUser> = {}): VerifiedTelegramUser => ({
  telegramId: "200",
  username: null,
  firstName: null,
  lastName: null,
  ...overrides,
});

test("profile display name prefers username, then Telegram name, then numeric id", () => {
  expect(profileDisplayName(profile({ username: "seller", firstName: "Ali" }))).toBe(
    "@seller",
  );
  expect(profileDisplayName(profile({ firstName: "Ali", lastName: "Rezaei" }))).toBe(
    "Ali Rezaei",
  );
  expect(profileDisplayName(profile())).toBe("200");
});

test("profile upsert is idempotent and refreshes mutable Telegram fields", async () => {
  await upsertTelegramProfile(
    env.SALES_DB,
    profile({ username: "old_name", firstName: "Ali" }),
    100,
  );
  await upsertTelegramProfile(
    env.SALES_DB,
    profile({ username: "new_name", firstName: "Ali", lastName: "Rezaei" }),
    200,
  );
  await expect(
    env.SALES_DB.prepare(
      "SELECT telegram_id,username,first_name,last_name,updated_at FROM telegram_profiles WHERE telegram_id='200'",
    ).first(),
  ).resolves.toEqual({
    telegram_id: "200",
    username: "new_name",
    first_name: "Ali",
    last_name: "Rezaei",
    updated_at: 200,
  });
});
