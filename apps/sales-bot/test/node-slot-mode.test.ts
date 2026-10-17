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
import { createAccount } from "../src/accounts";
import { nodeCapacities, remainingSlots } from "../src/node-capacity";
import {
  setNodeMaxAccounts,
  setNodeUnlimitedAccounts,
} from "../src/node-settings";
import type { SalesActor } from "../src/resellers";

const GB = 1e9;
const now = 10_000;
const admin: SalesActor = { telegramId: "1", role: "admin" };
const seller: SalesActor = { telegramId: "10", role: "seller" };

beforeEach(async () => {
  await resetDb();
  for (const sql of [m1, m2, m3, m4, m5, m6, m7, m8, m9, m10, m11])
    await env.SALES_DB.exec(sql);
  await env.SALES_DB.exec(
    "INSERT INTO resellers(telegram_id,enabled,created_at) VALUES('10',1,1);",
  );
});

async function addNode(maxAccounts = 1, maxBytes: number | null = 100 * GB) {
  await env.SALES_DB.prepare(
    `INSERT INTO nodes(
      id,name,target_ip,vpn_port,state,revision,acked_revision,last_seen,healthy,
      agent_capabilities,max_accounts,max_allocated_bytes
    ) VALUES('n1','Stockholm','8.8.8.8',443,'ready',1,1,?,1,'quota-v2,shared-443',?,?)`,
  )
    .bind(now, maxAccounts, maxBytes)
    .run();
}

async function sale(requestKey: string, quotaBytes = 10 * GB) {
  return createAccount(
    env.SALES_DB,
    seller,
    {
      nodeId: "n1",
      kind: "sale",
      label: requestKey,
      quotaBytes,
      durationSeconds: 86400,
      requestKey,
    },
    now,
  );
}

test("migration keeps every existing node finite by default", async () => {
  await addNode(20);
  const row = await env.SALES_DB.prepare(
    "SELECT max_accounts,max_accounts_unlimited FROM nodes WHERE id='n1'",
  ).first<{ max_accounts: number; max_accounts_unlimited: number }>();
  expect(row).toEqual({ max_accounts: 20, max_accounts_unlimited: 0 });
});

test("finite mode enforces max_accounts while unlimited mode bypasses only the node slot cap", async () => {
  await addNode(1, 25 * GB);
  await sale("first", 10 * GB);
  await expect(sale("finite-full", 1 * GB)).rejects.toThrow("NODE_FULL");

  await setNodeUnlimitedAccounts(env.SALES_DB, admin, "n1", true, now);
  await expect(sale("unlimited-slot", 10 * GB)).resolves.toBeTruthy();
  await expect(sale("still-byte-capped", 10 * GB)).rejects.toThrow(
    "NODE_ALLOCATION_FULL",
  );

  const capacity = (await nodeCapacities(env.SALES_DB, now, "n1"))[0]!;
  expect(capacity.max_accounts_unlimited).toBe(1);
  expect(remainingSlots(capacity)).toBeNull();
});

test("unlimited node slots do not bypass seller account limits", async () => {
  await addNode(1, 100 * GB);
  await setNodeUnlimitedAccounts(env.SALES_DB, admin, "n1", true, now);
  await env.SALES_DB.exec(
    "INSERT INTO reseller_controls(seller_id,current_settlement_epoch,settlement_started_at,max_reserved_accounts,updated_at) VALUES('10',0,1,1,1);",
  );
  await sale("first", 1 * GB);
  await expect(sale("seller-full", 1 * GB)).rejects.toThrow(
    "SELLER_ACCOUNT_LIMIT",
  );
});

test("saving a finite max account count turns unlimited mode back off", async () => {
  await addNode(5);
  await setNodeUnlimitedAccounts(env.SALES_DB, admin, "n1", true, now);
  await setNodeMaxAccounts(env.SALES_DB, admin, "n1", 7, now + 1);
  const row = await env.SALES_DB.prepare(
    "SELECT max_accounts,max_accounts_unlimited FROM nodes WHERE id='n1'",
  ).first<{ max_accounts: number; max_accounts_unlimited: number }>();
  expect(row).toEqual({ max_accounts: 7, max_accounts_unlimited: 0 });
});
