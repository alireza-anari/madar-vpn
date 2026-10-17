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
import * as capacity from "../src/node-capacity";

const GB = 1e9;

beforeEach(async () => {
  await resetDb();
  for (const sql of [m1, m2, m3, m4, m5, m6, m7, m8, m9, m10])
    await env.SALES_DB.exec(sql);
  await env.SALES_DB.exec(
    "INSERT INTO resellers(telegram_id,enabled,created_at) VALUES('10',1,1);",
  );
});

async function node(id: string, suffix: number, cap: number | null = 100 * GB) {
  await env.SALES_DB.prepare(
    "INSERT INTO nodes(id,name,target_ip,max_accounts,max_allocated_bytes) VALUES(?,?,?,?,?)",
  )
    .bind(id, id, `8.8.8.${suffix}`, 20, cap)
    .run();
}

async function account(
  nodeId: string,
  id: string,
  state: string,
  quota: number | null,
  used: number,
  validUntil: number,
) {
  await env.SALES_DB.prepare(
    "INSERT INTO managed_accounts(id,seller_id,request_key,node_id,kind,label,uuid,state,quota_bytes,used_bytes,duration_seconds,valid_until,created_at) VALUES(?,'10',?,?,'sale',?,?,?, ?,?,86400,?,1)",
  )
    .bind(id, id, nodeId, id, `uuid-${id}`, state, quota, used, validUntil)
    .run();
}

async function read(id: string, now = 100) {
  return (await capacity.nodeCapacities(env.SALES_DB, now, id))[0] as any;
}

test("valid blocked quota stays committed while stale blocked keeps only actual usage", async () => {
  await node("live-blocked", 1);
  await account("live-blocked", "a", "blocked", 30 * GB, 8 * GB, 1000);
  const live = await read("live-blocked");
  expect(live.reserved_accounts).toBe(1);
  expect(live.committed_bytes).toBe(30 * GB);
  expect(live.finalized_used_bytes).toBe(0);
  expect(capacity.remainingAllocation(live)).toBe(70 * GB);

  await node("stale-blocked", 2);
  await account("stale-blocked", "b", "blocked", 30 * GB, 8 * GB, 50);
  const stale = await read("stale-blocked");
  expect(stale.reserved_accounts).toBe(0);
  expect(stale.committed_bytes).toBe(0);
  expect(stale.finalized_used_bytes).toBe(8 * GB);
  expect(capacity.remainingAllocation(stale)).toBe(92 * GB);
});

test.each([
  ["revoked", 8 * GB, 8 * GB],
  ["expired", 8 * GB, 8 * GB],
  ["exhausted", 31 * GB, 30 * GB],
] as const)("%s accounts charge finalized traffic without keeping sold quota", async (state, used, expected) => {
  await node(state, state === "revoked" ? 3 : state === "expired" ? 4 : 5);
  await account(state, `a-${state}`, state, 30 * GB, used, 1000);
  const n = await read(state);
  expect(n.reserved_accounts).toBe(0);
  expect(n.committed_bytes).toBe(0);
  expect(n.finalized_used_bytes).toBe(expected);
  expect(capacity.remainingAllocation(n)).toBe(100 * GB - expected);
});

test("partial active usage reserves full quota and elapsed preparing releases both limits", async () => {
  await node("active", 6);
  await account("active", "active-a", "active", 30 * GB, 20 * GB, 1000);
  const active = await read("active");
  expect(active.reserved_accounts).toBe(1);
  expect(active.committed_bytes).toBe(30 * GB);
  expect(active.finalized_used_bytes).toBe(0);

  await node("old-preparing", 7);
  await account("old-preparing", "prep-a", "preparing", 30 * GB, 0, 50);
  const old = await read("old-preparing");
  expect(old.reserved_accounts).toBe(0);
  expect(old.committed_bytes).toBe(0);
  expect(old.finalized_used_bytes).toBe(0);
});

test("helpers expose charged, sellable, utilization and requested-byte eligibility", async () => {
  await node("mixed", 8);
  await account("mixed", "active-m", "active", 30 * GB, 10 * GB, 1000);
  await account("mixed", "revoked-m", "revoked", 20 * GB, 8 * GB, 1000);
  const n = await read("mixed");
  expect((capacity as any).chargedBytes(n)).toBe(38 * GB);
  expect(capacity.remainingAllocation(n)).toBe(62 * GB);
  expect((capacity as any).utilizationPercent(n)).toBe(38);
  expect((capacity as any).canAllocate(n, 62 * GB)).toBe(true);
  expect((capacity as any).canAllocate(n, 62 * GB + 1)).toBe(false);
});

test("unlimited nodes ignore byte eligibility and finite nodes fail closed on live uncapped legacy accounts", async () => {
  await node("unlimited", 9, null);
  await account("unlimited", "u", "active", 30 * GB, 1 * GB, 1000);
  const unlimited = await read("unlimited");
  expect(capacity.remainingAllocation(unlimited)).toBeNull();
  expect((capacity as any).utilizationPercent(unlimited)).toBeNull();
  expect((capacity as any).canAllocate(unlimited, 999 * GB)).toBe(true);

  await node("legacy", 10);
  await account("legacy", "legacy-a", "active", null, 0, 1000);
  const legacy = await read("legacy");
  expect(legacy.uncapped_accounts).toBe(1);
  expect(capacity.remainingAllocation(legacy)).toBe(0);
  expect((capacity as any).canAllocate(legacy, 1)).toBe(false);
});
