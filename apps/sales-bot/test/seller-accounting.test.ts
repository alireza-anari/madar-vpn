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

const GB = 1e9;
const admin = { telegramId: "9", role: "admin" as const };
const seller = { telegramId: "10", role: "seller" as const };
const load = () => import("../src/" + "seller-accounting");

beforeEach(async () => {
  await resetDb();
  for (const sql of [m1, m2, m3, m4, m5, m6, m7, m8, m9, m10])
    await env.SALES_DB.exec(sql);
  await env.SALES_DB.exec(
    "INSERT INTO nodes(id,name,target_ip,max_accounts,max_allocated_bytes) VALUES('n1','Stockholm','8.8.8.8',20,1000000000000),('n2','Frankfurt','1.1.1.1',20,1000000000000);" +
      "INSERT INTO resellers(telegram_id,enabled,created_at) VALUES('10',1,50),('11',1,60);",
  );
});

async function add(
  id: string,
  nodeId: string,
  state: string,
  quotaGb: number | null,
  usedGb: number,
  validUntil: number,
  epoch = 0,
) {
  await env.SALES_DB.prepare(
    "INSERT INTO managed_accounts(id,seller_id,request_key,node_id,kind,label,uuid,state,quota_bytes,used_bytes,duration_seconds,valid_until,created_at,seller_settlement_epoch) VALUES(?,'10',?,?,'sale',?,?,?, ?,?,86400,?,70,?)",
  )
    .bind(
      id,
      id,
      nodeId,
      id,
      `uuid-${id}`,
      state,
      quotaGb === null ? null : quotaGb * GB,
      usedGb * GB,
      validUntil,
      epoch,
    )
    .run();
}

async function seedEpochZero() {
  await add("active", "n1", "active", 30, 5, 1000);
  await add("blocked", "n1", "blocked", 20, 3, 1000);
  await add("expired", "n2", "expired", 10, 4, 1000);
  await add("stale", "n2", "blocked", 15, 6, 50);
  await add("revoked", "n1", "revoked", 5, 2, 1000);
  await add("exhausted", "n2", "exhausted", 8, 9, 1000);
  await add("preparing", "n1", "preparing", 12, 0, 0);
}

test("current and all-time seller stats normalize stale states and split node totals", async () => {
  await seedEpochZero();
  const a: any = await load();
  const current = await a.sellerStats(env.SALES_DB, "10", "current", 100);
  const all = await a.sellerStats(env.SALES_DB, "10", "all", 100);

  expect(current).toMatchObject({
    sellerId: "10",
    epoch: 0,
    startedAt: 50,
    configCount: 7,
    soldBytes: 100 * GB,
    usedBytes: 29 * GB,
    liveCount: 2,
    blockedCount: 1,
    expiredCount: 2,
    revokedCount: 1,
    exhaustedCount: 1,
  });
  expect(all).toMatchObject({ ...current, epoch: null });

  const nodes = await a.sellerNodeStats(env.SALES_DB, "10", "current", 100);
  expect(nodes).toEqual([
    { nodeId: "n2", nodeName: "Frankfurt", configCount: 3, soldBytes: 33 * GB, usedBytes: 19 * GB },
    { nodeId: "n1", nodeName: "Stockholm", configCount: 4, soldBytes: 67 * GB, usedBytes: 10 * GB },
  ]);
});

test("settlement freezes epoch snapshot, starts a new current window and never mutates customers", async () => {
  await seedEpochZero();
  const a: any = await load();
  const beforeStates = await env.SALES_DB.prepare(
    "SELECT id,state FROM managed_accounts ORDER BY id",
  ).all();

  const closed = await a.settleSeller(env.SALES_DB, admin, "10", 100);
  expect(closed.closedEpoch).toBe(0);

  expect(
    await env.SALES_DB.prepare(
      "SELECT current_settlement_epoch,settlement_started_at FROM reseller_controls WHERE seller_id='10'",
    ).first(),
  ).toEqual({ current_settlement_epoch: 1, settlement_started_at: 100 });
  expect(
    await env.SALES_DB.prepare(
      "SELECT epoch,config_count,sold_bytes,used_bytes,live_count,blocked_count,expired_count,revoked_count,exhausted_count FROM reseller_settlements WHERE seller_id='10' AND epoch=0",
    ).first(),
  ).toEqual({
    epoch: 0,
    config_count: 7,
    sold_bytes: 100 * GB,
    used_bytes: 29 * GB,
    live_count: 2,
    blocked_count: 1,
    expired_count: 2,
    revoked_count: 1,
    exhausted_count: 1,
  });
  expect(
    await env.SALES_DB.prepare(
      "SELECT node_id,config_count,sold_bytes,used_bytes FROM reseller_settlement_nodes WHERE settlement_id=? ORDER BY node_id",
    )
      .bind(closed.settlementId)
      .all(),
  ).toMatchObject({
    results: [
      { node_id: "n1", config_count: 4, sold_bytes: 67 * GB, used_bytes: 10 * GB },
      { node_id: "n2", config_count: 3, sold_bytes: 33 * GB, used_bytes: 19 * GB },
    ],
  });

  expect((await a.sellerStats(env.SALES_DB, "10", "current", 101)).configCount).toBe(0);
  expect((await a.sellerStats(env.SALES_DB, "10", "all", 101)).configCount).toBe(7);
  expect(
    (await env.SALES_DB.prepare("SELECT id,state FROM managed_accounts ORDER BY id").all()).results,
  ).toEqual(beforeStates.results);

  await add("new", "n1", "active", 25, 1, 1000, 1);
  expect((await a.sellerStats(env.SALES_DB, "10", "current", 102)).soldBytes).toBe(25 * GB);
  expect((await a.sellerStats(env.SALES_DB, "10", "all", 102)).soldBytes).toBe(125 * GB);

  await env.SALES_DB.prepare("UPDATE managed_accounts SET used_bytes=? WHERE id='active'")
    .bind(17 * GB)
    .run();
  expect(
    await env.SALES_DB.prepare(
      "SELECT used_bytes FROM reseller_settlements WHERE id=?",
    )
      .bind(closed.settlementId)
      .first("used_bytes"),
  ).toBe(29 * GB);
});

test("seller limits count only live commitments and preserve uncapped legacy risk", async () => {
  await add("a", "n1", "active", 30, 5, 1000);
  await add("b", "n1", "blocked", 20, 3, 1000);
  await add("old", "n1", "revoked", 50, 10, 1000);
  await add("legacy", "n1", "active", null, 0, 1000);
  const a: any = await load();

  await a.setSellerLimits(
    env.SALES_DB,
    admin,
    "10",
    { maxReservedAccounts: 5, maxCommittedBytes: 80 * GB },
    100,
  );
  expect(await a.sellerLimits(env.SALES_DB, "10", 100)).toMatchObject({
    maxReservedAccounts: 5,
    maxCommittedBytes: 80 * GB,
    reservedAccounts: 3,
    committedBytes: 50 * GB,
    uncappedAccounts: 1,
  });

  await expect(
    a.setSellerLimits(env.SALES_DB, seller, "10", { maxReservedAccounts: 1, maxCommittedBytes: null }, 100),
  ).rejects.toThrow("ADMIN_REQUIRED");
  await expect(
    a.setSellerLimits(env.SALES_DB, admin, "10", { maxReservedAccounts: 0, maxCommittedBytes: null }, 100),
  ).rejects.toThrow("INVALID_SELLER_LIMITS");
  await expect(a.settleSeller(env.SALES_DB, seller, "10", 100)).rejects.toThrow("ADMIN_REQUIRED");
});

test("two concurrent settlement attempts cannot close the same epoch twice", async () => {
  await add("a", "n1", "active", 10, 1, 1000);
  const a: any = await load();
  const results = await Promise.allSettled([
    a.settleSeller(env.SALES_DB, admin, "10", 100),
    a.settleSeller(env.SALES_DB, admin, "10", 100),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(
    await env.SALES_DB.prepare("SELECT COUNT(*) n FROM reseller_settlements WHERE seller_id='10' AND epoch=0").first("n"),
  ).toBe(1);
});
