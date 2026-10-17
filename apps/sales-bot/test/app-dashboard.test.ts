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
import {
  listAppConfigs,
  listAppNodes,
  loadAppDashboard,
  loadSellerSelfStats,
} from "../src/app-dashboard";
import type { SalesActor } from "../src/resellers";

const GB = 1e9;
const now = 1_000;
const admin: SalesActor = { telegramId: "1", role: "admin" };
const seller: SalesActor = { telegramId: "10", role: "seller" };

beforeEach(async () => {
  await resetDb();
  for (const sql of [m1, m2, m3, m4, m5, m6, m7, m8, m9, m10, m11])
    await env.SALES_DB.exec(sql);
  await env.SALES_DB.exec(
    "INSERT INTO resellers(telegram_id,enabled,created_at) VALUES('10',1,1),('20',1,1);",
  );
  const insertNode = env.SALES_DB.prepare(
    "INSERT INTO nodes(id,name,target_ip,vpn_port,state,revision,acked_revision,last_seen,healthy,agent_capabilities,max_accounts,max_allocated_bytes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
  );
  await insertNode
    .bind(
      "n1",
      "Stockholm",
      "13.51.1.1",
      443,
      "ready",
      7,
      7,
      1000,
      1,
      "quota-v2,shared-443",
      10,
      200 * GB,
    )
    .run();
  await insertNode
    .bind(
      "n2",
      "Unlimited",
      "13.51.1.2",
      443,
      "ready",
      3,
      3,
      1000,
      1,
      "quota-v2,shared-443",
      10,
      null,
    )
    .run();
  await env.SALES_DB.prepare(
    "INSERT INTO node_capacity_alert_state(node_id,level,updated_at) VALUES(?,?,?)",
  )
    .bind("n1", 80, 1000)
    .run();
});

async function account(args: {
  id: string;
  sellerId?: string;
  nodeId?: string;
  state?: string;
  quota?: number;
  used?: number;
  validUntil?: number;
  createdAt?: number;
}) {
  await env.SALES_DB.prepare(
    `INSERT INTO managed_accounts(
      id,seller_id,request_key,node_id,kind,label,uuid,state,quota_bytes,used_bytes,
      duration_seconds,valid_until,created_at,seller_settlement_epoch
    ) VALUES(?,?,?,?,'sale',?,?,?, ?,?,2592000,?,?,0)`,
  )
    .bind(
      args.id,
      args.sellerId || "10",
      args.id,
      args.nodeId || "n1",
      `Customer ${args.id}`,
      `uuid-${args.id}`,
      args.state || "active",
      args.quota ?? 10 * GB,
      args.used ?? 0,
      args.validUntil ?? 2_000,
      args.createdAt ?? 100,
    )
    .run();
}

test("admin dashboard aggregates global live, committed, finalized and seller totals", async () => {
  await account({ id: "a", quota: 30 * GB, used: 8 * GB });
  await account({ id: "b", sellerId: "20", state: "revoked", quota: 20 * GB, used: 5 * GB });
  const dashboard = await loadAppDashboard(env.SALES_DB, admin, now);
  expect(dashboard.role).toBe("admin");
  expect(dashboard.summary).toMatchObject({
    configsInService: 1,
    reservedBytes: 30 * GB,
    finalizedUsedBytes: 5 * GB,
    activeSellers: 2,
  });
});

test("seller dashboard and self stats include only the current seller", async () => {
  await account({ id: "own", quota: 40 * GB, used: 4 * GB });
  await account({ id: "foreign", sellerId: "20", quota: 90 * GB, used: 9 * GB });
  const dashboard = await loadAppDashboard(env.SALES_DB, seller, now);
  expect(dashboard.role).toBe("seller");
  expect(dashboard.summary).toMatchObject({ configsInService: 1, allTimeSoldBytes: 40 * GB });
  const stats = await loadSellerSelfStats(env.SALES_DB, seller, now);
  expect(stats.all.configCount).toBe(1);
  expect(stats.all.soldBytes).toBe(40 * GB);
});

test("seller node DTO exposes sale metadata only and supports finite/unlimited capacity", async () => {
  await account({ id: "own", quota: 70 * GB, used: 2 * GB });
  const nodes = await listAppNodes(env.SALES_DB, seller, now, 20 * GB);
  const finite = nodes.find((n) => n.id === "n1")!;
  const unlimited = nodes.find((n) => n.id === "n2")!;
  expect(finite).toMatchObject({
    displayName: "Stockholm",
    sellableBytes: 130 * GB,
    remainingSlots: 9,
    utilizationPercent: 35,
    eligible: true,
  });
  expect(unlimited.sellableBytes).toBeNull();
  expect(unlimited.eligible).toBe(true);
  const serialized = JSON.stringify(nodes);
  for (const forbidden of ["target_ip", "ssh", "fingerprint", "revision", "acked_revision", "debug"])
    expect(serialized).not.toContain(forbidden);
});

test("admin nodes include alert level while seller nodes do not", async () => {
  const adminNode = (await listAppNodes(env.SALES_DB, admin, now))[0] as any;
  const sellerNode = (await listAppNodes(env.SALES_DB, seller, now))[0] as any;
  expect(adminNode.alertLevel).toBe(80);
  expect(sellerNode.alertLevel).toBeUndefined();
});

test("config pagination never returns another seller account", async () => {
  for (let i = 0; i < 22; i++)
    await account({ id: `own-${i}`, createdAt: 100 + i });
  await account({ id: "foreign", sellerId: "20", createdAt: 999 });
  const first = await listAppConfigs(env.SALES_DB, seller, now);
  expect(first.items).toHaveLength(20);
  expect(first.items.some((item) => item.id === "foreign")).toBe(false);
  expect(first.nextCursor).toBe("20");
  const second = await listAppConfigs(env.SALES_DB, seller, now, first.nextCursor!);
  expect(second.items).toHaveLength(2);
  expect(second.items.every((item) => item.sellerId === "10")).toBe(true);
});
