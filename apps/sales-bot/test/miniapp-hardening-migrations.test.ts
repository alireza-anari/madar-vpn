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
import profiles from "../migrations/0012-telegram-profiles.sql?raw";
import archive from "../migrations/0013-managed-account-archive.sql?raw";

beforeEach(async () => {
  await resetDb();
  for (const sql of [m1, m2, m3, m4, m5, m6, m7, m8, m9, m10, m11])
    await env.SALES_DB.exec(sql);
});

test("Mini App hardening migrations are additive and preserve account history", async () => {
  await env.SALES_DB.exec(
    "INSERT INTO nodes(id,name,target_ip,max_accounts,max_allocated_bytes) VALUES('n','node','8.8.8.8',20,1000000000000);" +
      "INSERT INTO resellers(telegram_id,enabled,created_at) VALUES('10',1,100);" +
      "INSERT INTO managed_accounts(id,seller_id,request_key,node_id,kind,label,uuid,quota_bytes,duration_seconds,created_at,state,valid_until) VALUES('a','10','r','n','sale','client','uuid-a',1000000000,86400,100,'active',1000);",
  );

  await env.SALES_DB.exec(profiles);
  await env.SALES_DB.exec(archive);

  await env.SALES_DB.prepare(
    "INSERT INTO telegram_profiles(telegram_id,username,first_name,last_name,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(telegram_id) DO UPDATE SET username=excluded.username,first_name=excluded.first_name,last_name=excluded.last_name,updated_at=excluded.updated_at",
  )
    .bind("10", "seller", "Ali", "Rezaei", 200)
    .run();

  const profile = await env.SALES_DB.prepare(
    "SELECT telegram_id,username,first_name,last_name,updated_at FROM telegram_profiles WHERE telegram_id='10'",
  ).first();
  expect(profile).toEqual({
    telegram_id: "10",
    username: "seller",
    first_name: "Ali",
    last_name: "Rezaei",
    updated_at: 200,
  });

  const account = await env.SALES_DB.prepare(
    "SELECT id,state,archived_at,archived_by FROM managed_accounts WHERE id='a'",
  ).first();
  expect(account).toEqual({
    id: "a",
    state: "active",
    archived_at: null,
    archived_by: null,
  });
});
