import { env } from "cloudflare:workers";
import { beforeEach, expect, test } from "vitest";
import { resetDb } from "./db";
import m1 from "../migrations/0001.sql?raw";
import m2 from "../migrations/0002.sql?raw";
import m3 from "../migrations/0003.sql?raw";
import m4 from "../migrations/0004-reseller-accounts.sql?raw";
import m7 from "../migrations/0007-node-capacity.sql?raw";
import m9 from "../migrations/0009-node-allocation-cap.sql?raw";
import m11 from "../migrations/0011-node-account-slot-mode.sql?raw";
import type { SalesActor } from "../src/resellers";

const admin: SalesActor = { telegramId: "9", role: "admin" };
const seller: SalesActor = { telegramId: "10", role: "seller" };
const load = () => import("../src/" + "node-settings");

beforeEach(async () => {
  await resetDb();
  for (const sql of [m1, m2, m3, m4, m7, m9, m11]) await env.SALES_DB.exec(sql);
  await env.SALES_DB.exec(
    "INSERT INTO nodes(id,name,target_ip,max_accounts,max_allocated_bytes) VALUES('n','Stockholm','8.8.8.8',20,200000000000);" +
      "INSERT INTO resellers(telegram_id,enabled,created_at) VALUES('10',1,1);",
  );
});

test("admin can set finite and unlimited node traffic caps with audit", async () => {
  const { setNodeMaxAllocatedBytes } = await load();
  await setNodeMaxAllocatedBytes(env.SALES_DB, admin, "n", 500e9, 100);
  expect(
    await env.SALES_DB.prepare("SELECT max_allocated_bytes FROM nodes WHERE id='n'").first(
      "max_allocated_bytes",
    ),
  ).toBe(500e9);
  await setNodeMaxAllocatedBytes(env.SALES_DB, admin, "n", null, 101);
  expect(
    await env.SALES_DB.prepare("SELECT max_allocated_bytes FROM nodes WHERE id='n'").first(
      "max_allocated_bytes",
    ),
  ).toBeNull();
  expect(
    await env.SALES_DB.prepare(
      "SELECT COUNT(*) n FROM audit_events WHERE actor_id='9' AND action='node_allocation_cap' AND target_id='n'",
    ).first("n"),
  ).toBe(2);
});

test("admin can set slot cap and every change is audited", async () => {
  const { setNodeMaxAccounts } = await load();
  await setNodeMaxAccounts(env.SALES_DB, admin, "n", 120, 100);
  expect(
    await env.SALES_DB.prepare("SELECT max_accounts FROM nodes WHERE id='n'").first(
      "max_accounts",
    ),
  ).toBe(120);
  expect(
    await env.SALES_DB.prepare(
      "SELECT COUNT(*) n FROM audit_events WHERE action='node_capacity' AND target_id='n'",
    ).first("n"),
  ).toBe(1);
});

test("seller cannot change node caps", async () => {
  const { setNodeMaxAccounts, setNodeMaxAllocatedBytes } = await load();
  await expect(
    setNodeMaxAccounts(env.SALES_DB, seller, "n", 50, 100),
  ).rejects.toThrow("ADMIN_REQUIRED");
  await expect(
    setNodeMaxAllocatedBytes(env.SALES_DB, seller, "n", null, 100),
  ).rejects.toThrow("ADMIN_REQUIRED");
});

test("node setting validation rejects invalid values and missing nodes", async () => {
  const { setNodeMaxAccounts, setNodeMaxAllocatedBytes } = await load();
  await expect(
    setNodeMaxAccounts(env.SALES_DB, admin, "n", 0, 100),
  ).rejects.toThrow("INVALID_CAPACITY");
  await expect(
    setNodeMaxAccounts(env.SALES_DB, admin, "n", 10001, 100),
  ).rejects.toThrow("INVALID_CAPACITY");
  await expect(
    setNodeMaxAllocatedBytes(env.SALES_DB, admin, "n", 0, 100),
  ).rejects.toThrow("INVALID_ALLOCATION_CAP");
  await expect(
    setNodeMaxAllocatedBytes(env.SALES_DB, admin, "n", 1_000_000_000_000_001, 100),
  ).rejects.toThrow("INVALID_ALLOCATION_CAP");
  await expect(
    setNodeMaxAccounts(env.SALES_DB, admin, "missing", 10, 100),
  ).rejects.toThrow("INVALID_NODE");
});
