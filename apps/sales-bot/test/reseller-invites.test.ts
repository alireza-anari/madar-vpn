import { env } from "cloudflare:workers";
import { beforeEach, expect, test } from "vitest";
import { resetDb } from "./db";
import a from "../migrations/0001.sql?raw";
import b from "../migrations/0002.sql?raw";
import c from "../migrations/0003.sql?raw";
import d from "../migrations/0004-reseller-accounts.sql?raw";
import invites from "../migrations/0008-reseller-invites.sql?raw";
import {
  createSellerInvite,
  claimSellerInvite,
  sellerInviteUrl,
} from "../src/reseller-invites";
import { handleResellerUpdate } from "../src/reseller-menus";
const E = {
  ...env,
  POLICY_SIGNING_SECRET: "test-invite-secret",
  ADMIN_TELEGRAM_IDS: "9",
};
const admin = { telegramId: "9", role: "admin" as const };
beforeEach(async () => {
  await resetDb();
  for (const sql of [a, b, c, d, invites]) await env.SALES_DB.exec(sql);
  await env.SALES_DB.exec(
    "INSERT INTO settings VALUES('bot_username','MadarTestBot')",
  );
});
test("only admin creates stable private expiring invitations", async () => {
  const token = await createSellerInvite(E, admin, "update1", 100);
  expect(await createSellerInvite(E, admin, "update1", 200)).toBe(token);
  expect(
    await env.SALES_DB.prepare("SELECT expires_at FROM reseller_invites").first(
      "expires_at",
    ),
  ).toBe(86500);
  expect(await sellerInviteUrl(E, token)).toBe(
    `https://t.me/MadarTestBot?start=seller_${token}`,
  );
  await expect(
    createSellerInvite(E, { telegramId: "10", role: "seller" }, "no", 100),
  ).rejects.toThrow("ADMIN_REQUIRED");
  expect(await claimSellerInvite(env.SALES_DB, token, "10", 86500)).toBe(false);
});
test("one concurrent recipient wins, replay cannot reenable a disabled seller", async () => {
  const token = await createSellerInvite(E, admin, "update2", 100);
  const results = await Promise.all([
    claimSellerInvite(env.SALES_DB, token, "10", 101),
    claimSellerInvite(env.SALES_DB, token, "11", 101),
  ]);
  expect(results.filter(Boolean)).toHaveLength(1);
  const winner = await env.SALES_DB.prepare(
    "SELECT telegram_id FROM resellers",
  ).first<string>("telegram_id");
  expect(await claimSellerInvite(env.SALES_DB, token, winner!, 102)).toBe(true);
  await env.SALES_DB.exec("UPDATE resellers SET enabled=0");
  expect(await claimSellerInvite(env.SALES_DB, token, winner!, 103)).toBe(
    false,
  );
  expect(await claimSellerInvite(env.SALES_DB, "bad", "12", 103)).toBe(false);
});
test("Telegram start activates seller without an entered numerical ID", async () => {
  const token = await createSellerInvite(E, admin, "update3", 100);
  await handleResellerUpdate(
    E,
    {
      update_id: 1,
      message: {
        message_id: 1,
        from: { id: 10 },
        chat: { id: 10, type: "private" },
        text: `/start seller_${token}`,
      },
    },
    101,
  );
  expect(
    await env.SALES_DB.prepare(
      "SELECT enabled FROM resellers WHERE telegram_id='10'",
    ).first("enabled"),
  ).toBe(1);
  const payload = JSON.parse(
    (await env.SALES_DB.prepare(
      "SELECT payload FROM outbox WHERE id='u1:reply'",
    ).first<string>("payload"))!,
  );
  expect(payload.text).toContain("فعال شد");
});
