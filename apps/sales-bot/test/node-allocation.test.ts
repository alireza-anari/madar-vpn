import { env } from "cloudflare:workers";
import { beforeEach, expect, test } from "vitest";
import { resetDb } from "./db";
import base from "../migrations/0001.sql?raw";
import sales from "../migrations/0002.sql?raw";
import nodes from "../migrations/0003.sql?raw";
import accounts from "../migrations/0004-reseller-accounts.sql?raw";
import shared from "../migrations/0005-shared-node-purposes.sql?raw";
import capacity from "../migrations/0007-node-capacity.sql?raw";
import allocation from "../migrations/0009-node-allocation-cap.sql?raw";
import accounting from "../migrations/0010-capacity-accounting-resellers.sql?raw";
import slotMode from "../migrations/0011-node-account-slot-mode.sql?raw";
import { createAccount, revokeAccount } from "../src/accounts";

const GB = 1e9;
const seller = { telegramId: "10", role: "seller" as const };
const seller2 = { telegramId: "11", role: "seller" as const };
const admin = { telegramId: "9", role: "admin" as const };
const input = (key: string, quotaBytes = 100 * GB) => ({
  kind: "sale" as const,
  label: key,
  quotaBytes,
  durationSeconds: 86400,
  requestKey: key,
});

beforeEach(async () => {
  await resetDb();
  for (const sql of [
    base,
    sales,
    nodes,
    accounts,
    shared,
    capacity,
    allocation,
    accounting,
    slotMode,
  ])
    await env.SALES_DB.exec(sql);
  await env.SALES_DB.exec(
    "INSERT INTO nodes(id,name,target_ip,max_accounts,max_allocated_bytes) VALUES('n','n','8.8.8.8',20,1000000000000);" +
      "INSERT INTO node_purposes VALUES('sale','n'),('trial','n');" +
      "INSERT INTO resellers VALUES('10',1,100),('11',1,100);",
  );
});

async function setControls(
  sellerId: string,
  maxAccounts: number | null,
  maxBytes: number | null,
  epoch = 0,
) {
  await env.SALES_DB.prepare(
    "INSERT INTO reseller_controls(seller_id,current_settlement_epoch,settlement_started_at,max_reserved_accounts,max_committed_bytes,updated_at) VALUES(?,?,?,?,?,100) ON CONFLICT(seller_id) DO UPDATE SET current_settlement_epoch=excluded.current_settlement_epoch,max_reserved_accounts=excluded.max_reserved_accounts,max_committed_bytes=excluded.max_committed_bytes",
  )
    .bind(sellerId, epoch, 100, maxAccounts, maxBytes)
    .run();
}

test("ten 100 GB accounts fill a 1000 GB server before its twenty-account cap", async () => {
  for (let i = 0; i < 10; i++)
    await createAccount(env.SALES_DB, seller, input("a" + i), 100);
  await expect(
    createAccount(env.SALES_DB, seller, input("overflow", GB), 100),
  ).rejects.toThrow("NODE_ALLOCATION_FULL");
  expect((await createAccount(env.SALES_DB, seller, input("a0"), 100)).id).toBeTruthy();
});

test("twenty live reservations fill count even when allocated GB remain", async () => {
  for (let i = 0; i < 20; i++)
    await createAccount(env.SALES_DB, seller, input("a" + i, 10 * GB), 100);
  await expect(
    createAccount(env.SALES_DB, seller, input("overflow", GB), 100),
  ).rejects.toThrow("NODE_FULL");
});

test("revocation releases only unused node quota and keeps actual traffic charged", async () => {
  await env.SALES_DB.exec("UPDATE nodes SET max_allocated_bytes=100000000000");
  const a = await createAccount(env.SALES_DB, seller, input("a", 100 * GB), 100);
  await env.SALES_DB.prepare(
    "UPDATE managed_accounts SET state='active',valid_until=1000,used_bytes=? WHERE id=?",
  )
    .bind(90 * GB, a.id)
    .run();
  await revokeAccount(env.SALES_DB, admin, a.id, 101);
  await expect(
    createAccount(env.SALES_DB, seller, input("too-much", 11 * GB), 102),
  ).rejects.toThrow("NODE_ALLOCATION_FULL");
  await expect(
    createAccount(env.SALES_DB, seller, input("fits", 10 * GB), 102),
  ).resolves.toBeTruthy();
});

test("30 GB sold and 8 GB used on revoke releases exactly 22 GB", async () => {
  await env.SALES_DB.exec("UPDATE nodes SET max_allocated_bytes=100000000000");
  const a = await createAccount(env.SALES_DB, seller, input("a", 30 * GB), 100);
  await env.SALES_DB.prepare(
    "UPDATE managed_accounts SET state='active',valid_until=1000,used_bytes=? WHERE id=?",
  )
    .bind(8 * GB, a.id)
    .run();
  await revokeAccount(env.SALES_DB, admin, a.id, 101);
  await expect(
    createAccount(env.SALES_DB, seller, input("93", 93 * GB), 102),
  ).rejects.toThrow("NODE_ALLOCATION_FULL");
  await expect(
    createAccount(env.SALES_DB, seller, input("92", 92 * GB), 102),
  ).resolves.toBeTruthy();
});

test("valid blocked accounts keep full quota while expired accounts keep only usage", async () => {
  await env.SALES_DB.exec("UPDATE nodes SET max_allocated_bytes=100000000000");
  const blocked = await createAccount(env.SALES_DB, seller, input("blocked", 100 * GB), 100);
  await env.SALES_DB.prepare(
    "UPDATE managed_accounts SET state='blocked',valid_until=1000,used_bytes=? WHERE id=?",
  )
    .bind(8 * GB, blocked.id)
    .run();
  await expect(
    createAccount(env.SALES_DB, seller, input("blocked-overflow", GB), 101),
  ).rejects.toThrow("NODE_ALLOCATION_FULL");

  await env.SALES_DB.prepare(
    "UPDATE managed_accounts SET state='expired',used_bytes=? WHERE id=?",
  )
    .bind(20 * GB, blocked.id)
    .run();
  await expect(
    createAccount(env.SALES_DB, seller, input("expired-fits", 80 * GB), 102),
  ).resolves.toBeTruthy();
});

test("competing sellers cannot over-allocate the last node bytes", async () => {
  await env.SALES_DB.exec("UPDATE nodes SET max_allocated_bytes=100000000000");
  const results = await Promise.allSettled([
    createAccount(env.SALES_DB, seller, input("a", 100 * GB), 100),
    createAccount(env.SALES_DB, seller2, input("b", 100 * GB), 100),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
});

test("seller account cap has a distinct error and cannot be bypassed concurrently", async () => {
  await setControls("10", 1, null);
  const results = await Promise.allSettled([
    createAccount(env.SALES_DB, seller, input("a", 10 * GB), 100),
    createAccount(env.SALES_DB, seller, input("b", 10 * GB), 100),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
  expect(String(rejected.reason)).toContain("SELLER_ACCOUNT_LIMIT");
});

test("seller committed-byte cap is atomic and returns a distinct error", async () => {
  await setControls("10", null, 50 * GB);
  await createAccount(env.SALES_DB, seller, input("a", 30 * GB), 100);
  await expect(
    createAccount(env.SALES_DB, seller, input("too-much", 21 * GB), 100),
  ).rejects.toThrow("SELLER_ALLOCATION_FULL");
  await expect(
    createAccount(env.SALES_DB, seller, input("fits", 20 * GB), 100),
  ).resolves.toBeTruthy();
});

test("terminal rows release seller caps but not finalized node traffic", async () => {
  await env.SALES_DB.exec("UPDATE nodes SET max_allocated_bytes=100000000000");
  await setControls("10", 1, 30 * GB);
  const a = await createAccount(env.SALES_DB, seller, input("a", 30 * GB), 100);
  await env.SALES_DB.prepare(
    "UPDATE managed_accounts SET state='revoked',used_bytes=?,valid_until=1000 WHERE id=?",
  )
    .bind(8 * GB, a.id)
    .run();
  await expect(
    createAccount(env.SALES_DB, seller, input("b", 30 * GB), 101),
  ).resolves.toBeTruthy();
});

test("admin-issued configs bypass reseller caps but still obey node caps", async () => {
  await env.SALES_DB.exec("INSERT INTO resellers VALUES('9',1,100)");
  await setControls("9", 1, GB);
  await createAccount(env.SALES_DB, admin, input("admin-a", 10 * GB), 100);
  await expect(
    createAccount(env.SALES_DB, admin, input("admin-b", 10 * GB), 100),
  ).resolves.toBeTruthy();
  await env.SALES_DB.exec("UPDATE nodes SET max_allocated_bytes=20000000000");
  await expect(
    createAccount(env.SALES_DB, admin, input("admin-over", GB), 100),
  ).rejects.toThrow("NODE_ALLOCATION_FULL");
});

test("new accounts are stamped with the seller current settlement epoch", async () => {
  await setControls("10", null, null, 3);
  const created = await createAccount(env.SALES_DB, seller, input("epoch", 10 * GB), 100);
  expect(
    await env.SALES_DB.prepare(
      "SELECT seller_settlement_epoch FROM managed_accounts WHERE id=?",
    )
      .bind(created.id)
      .first("seller_settlement_epoch"),
  ).toBe(3);
});

test("request replay stays idempotent and does not consume capacity twice", async () => {
  await env.SALES_DB.exec("UPDATE nodes SET max_allocated_bytes=10000000000");
  const first = await createAccount(env.SALES_DB, seller, input("same", 10 * GB), 100);
  const second = await createAccount(env.SALES_DB, seller, input("same", 10 * GB), 101);
  expect(second.id).toBe(first.id);
  expect(
    await env.SALES_DB.prepare("SELECT COUNT(*) n FROM managed_accounts").first("n"),
  ).toBe(1);
});

test("trial reserves one GB", async () => {
  await env.SALES_DB.exec("UPDATE nodes SET max_allocated_bytes=1000000000");
  await createAccount(
    env.SALES_DB,
    seller,
    {
      ...input("trial"),
      kind: "trial",
      durationSeconds: 1800,
      quotaBytes: null,
    },
    100,
  );
  await expect(
    createAccount(env.SALES_DB, seller, input("overflow", GB), 100),
  ).rejects.toThrow("NODE_ALLOCATION_FULL");
});

test("preparing accounts with elapsed activation expiry release both limits", async () => {
  await env.SALES_DB.exec(
    "UPDATE nodes SET max_accounts=1,max_allocated_bytes=100000000000",
  );
  const a = await createAccount(env.SALES_DB, seller, input("old"), 100);
  await env.SALES_DB.prepare(
    "UPDATE managed_accounts SET valid_until=101,started_at=100 WHERE id=?",
  )
    .bind(a.id)
    .run();
  await expect(
    createAccount(env.SALES_DB, seller, input("new"), 102),
  ).resolves.toBeTruthy();
});

test("uncapped legacy accounts prevent new finite allocations", async () => {
  await env.SALES_DB.exec(
    "INSERT INTO managed_accounts(id,seller_id,request_key,node_id,kind,label,uuid,quota_bytes,duration_seconds,created_at,state,valid_until) VALUES('legacy','10','legacy','n','trial','legacy','legacy',NULL,1800,100,'active',1000)",
  );
  await expect(
    createAccount(env.SALES_DB, seller, input("new", GB), 100),
  ).rejects.toThrow("NODE_ALLOCATION_FULL");
});
