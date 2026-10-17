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
import accounting from "../migrations/0010-capacity-accounting-resellers.sql?raw";

beforeEach(async () => {
  await resetDb();
  for (const sql of [m1, m2, m3, m4, m5, m6, m7, m8, m9])
    await env.SALES_DB.exec(sql);
});

test("capacity accounting migration is additive and constrains controls", async () => {
  await env.SALES_DB.exec(
    "INSERT INTO nodes(id,name,target_ip,max_accounts,max_allocated_bytes) VALUES('n','node','8.8.8.8',20,1000000000000);" +
      "INSERT INTO resellers(telegram_id,enabled,created_at) VALUES('10',1,100);" +
      "INSERT INTO managed_accounts(id,seller_id,request_key,node_id,kind,label,uuid,quota_bytes,duration_seconds,created_at,state,valid_until) VALUES('a','10','r','n','sale','client','uuid-a',1000000000,86400,100,'active',1000);",
  );

  await env.SALES_DB.exec(accounting);

  const old = await env.SALES_DB.prepare(
    "SELECT id,seller_settlement_epoch FROM managed_accounts WHERE id='a'",
  ).first<{ id: string; seller_settlement_epoch: number }>();
  expect(old).toEqual({ id: "a", seller_settlement_epoch: 0 });

  const tables = await env.SALES_DB.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('reseller_controls','reseller_settlements','reseller_settlement_nodes','node_capacity_alert_state') ORDER BY name",
  ).all<{ name: string }>();
  expect(tables.results.map((row) => row.name)).toEqual([
    "node_capacity_alert_state",
    "reseller_controls",
    "reseller_settlement_nodes",
    "reseller_settlements",
  ]);

  await env.SALES_DB.exec(
    "INSERT INTO reseller_controls(seller_id,current_settlement_epoch,settlement_started_at,max_reserved_accounts,max_committed_bytes,updated_at) VALUES('10',0,100,NULL,NULL,100);",
  );
  expect(
    await env.SALES_DB.prepare(
      "SELECT max_reserved_accounts,max_committed_bytes FROM reseller_controls WHERE seller_id='10'",
    ).first(),
  ).toEqual({ max_reserved_accounts: null, max_committed_bytes: null });

  await env.SALES_DB.exec(
    "INSERT INTO resellers(telegram_id,enabled,created_at) VALUES('11',1,100),('12',1,100);",
  );
  await expect(
    env.SALES_DB.exec(
      "INSERT INTO reseller_controls(seller_id,max_reserved_accounts) VALUES('11',0);",
    ),
  ).rejects.toThrow();
  await expect(
    env.SALES_DB.exec(
      "INSERT INTO reseller_controls(seller_id,max_committed_bytes) VALUES('12',-1);",
    ),
  ).rejects.toThrow();
  await expect(
    env.SALES_DB.exec(
      "INSERT INTO node_capacity_alert_state(node_id,level) VALUES('n',85);",
    ),
  ).rejects.toThrow();
});
