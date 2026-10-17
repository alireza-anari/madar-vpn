import { env } from "cloudflare:workers";
import { beforeEach, expect, test } from "vitest";
import { resetDb } from "./db";
import m1 from "../migrations/0001.sql?raw";
import m2 from "../migrations/0002.sql?raw";
import m3 from "../migrations/0003.sql?raw";
import m4 from "../migrations/0004-reseller-accounts.sql?raw";
import m5 from "../migrations/0005-shared-node-purposes.sql?raw";
import m7 from "../migrations/0007-node-capacity.sql?raw";
import m9 from "../migrations/0009-node-allocation-cap.sql?raw";
import m10 from "../migrations/0010-capacity-accounting-resellers.sql?raw";
import m11 from "../migrations/0011-node-account-slot-mode.sql?raw";

const GB = 1e9;
const E = { ...env, ADMIN_TELEGRAM_IDS: "9,8" };
const load = () => import("../src/" + "capacity-alerts");

beforeEach(async () => {
  await resetDb();
  for (const sql of [m1, m2, m3, m4, m5, m7, m9, m10, m11])
    await env.SALES_DB.exec(sql);
  await env.SALES_DB.exec(
    "INSERT INTO nodes(id,name,target_ip,max_accounts,max_allocated_bytes) VALUES('n','Stockholm','8.8.8.8',20,100000000000),('u','Unlimited','1.1.1.1',20,NULL);" +
      "INSERT INTO resellers(telegram_id,enabled,created_at) VALUES('10',1,1);",
  );
});

async function setCommitted(gb: number) {
  await env.SALES_DB.exec("DELETE FROM managed_accounts WHERE node_id='n';");
  if (!gb) return;
  await env.SALES_DB.prepare(
    "INSERT INTO managed_accounts(id,seller_id,request_key,node_id,kind,label,uuid,state,quota_bytes,used_bytes,duration_seconds,valid_until,created_at) VALUES('a','10','a','n','sale','a','uuid-a','active',?,0,86400,1000,1)",
  )
    .bind(gb * GB)
    .run();
}

async function state() {
  return env.SALES_DB.prepare(
    "SELECT level,sequence FROM node_capacity_alert_state WHERE node_id='n'",
  ).first<{ level: number; sequence: number }>();
}

async function outboxCount() {
  return Number(
    await env.SALES_DB.prepare(
      "SELECT COUNT(*) n FROM outbox WHERE id LIKE 'capacity:n:%'",
    ).first("n"),
  );
}

test("80, 90 and 95 crossings alert once per admin while duplicate refreshes stay quiet", async () => {
  const { refreshCapacityAlert } = await load();
  await setCommitted(80);
  expect(await refreshCapacityAlert(E, "n", 100)).toBe(80);
  expect(await state()).toEqual({ level: 80, sequence: 1 });
  expect(await outboxCount()).toBe(2);

  expect(await refreshCapacityAlert(E, "n", 101)).toBeNull();
  expect(await state()).toEqual({ level: 80, sequence: 1 });
  expect(await outboxCount()).toBe(2);

  await setCommitted(90);
  expect(await refreshCapacityAlert(E, "n", 102)).toBe(90);
  expect(await state()).toEqual({ level: 90, sequence: 2 });
  expect(await outboxCount()).toBe(4);

  await setCommitted(95);
  expect(await refreshCapacityAlert(E, "n", 103)).toBe(95);
  expect(await state()).toEqual({ level: 95, sequence: 3 });
  expect(await outboxCount()).toBe(6);

  const rows = await env.SALES_DB.prepare(
    "SELECT id,chat_id,payload FROM outbox WHERE id LIKE 'capacity:n:%' ORDER BY id,chat_id",
  ).all<{ id: string; chat_id: string; payload: string }>();
  expect(new Set(rows.results.map((r) => r.chat_id))).toEqual(new Set(["8", "9"]));
  const latest = JSON.parse(rows.results.find((r) => r.id.includes(":3:"))!.payload);
  expect(latest.text).toContain("Stockholm");
  expect(latest.text).toContain("۹۵٪");
  expect(latest.text).toContain("رزرو");
  expect(latest.text).toContain("مصرف قطعی");
  expect(latest.text).toContain("قابل فروش");
});

test("dropping below a threshold rearms silently and a later crossing alerts again", async () => {
  const { refreshCapacityAlert } = await load();
  await setCommitted(95);
  await refreshCapacityAlert(E, "n", 100);
  expect(await outboxCount()).toBe(2);

  await setCommitted(70);
  expect(await refreshCapacityAlert(E, "n", 101)).toBeNull();
  expect(await state()).toEqual({ level: 0, sequence: 1 });
  expect(await outboxCount()).toBe(2);

  await setCommitted(80);
  expect(await refreshCapacityAlert(E, "n", 102)).toBe(80);
  expect(await state()).toEqual({ level: 80, sequence: 2 });
  expect(await outboxCount()).toBe(4);
});

test("a direct jump from below 80 to at least 95 sends one highest-level alert", async () => {
  const { refreshCapacityAlert } = await load();
  await setCommitted(79);
  expect(await refreshCapacityAlert(E, "n", 100)).toBeNull();
  expect(await state()).toEqual({ level: 0, sequence: 0 });

  await setCommitted(96);
  expect(await refreshCapacityAlert(E, "n", 101)).toBe(95);
  expect(await state()).toEqual({ level: 95, sequence: 1 });
  expect(await outboxCount()).toBe(2);
});

test("unlimited nodes never emit bandwidth alerts", async () => {
  const { refreshCapacityAlert } = await load();
  expect(await refreshCapacityAlert(E, "u", 100)).toBeNull();
  expect(
    await env.SALES_DB.prepare(
      "SELECT COUNT(*) n FROM outbox WHERE id LIKE 'capacity:u:%'",
    ).first("n"),
  ).toBe(0);
});

test("concurrent refreshes emit exactly one message per admin for one crossing", async () => {
  const { refreshCapacityAlert } = await load();
  await setCommitted(80);
  const results = await Promise.all([
    refreshCapacityAlert(E, "n", 100),
    refreshCapacityAlert(E, "n", 100),
  ]);
  expect(results.filter((r) => r === 80)).toHaveLength(1);
  expect(await state()).toEqual({ level: 80, sequence: 1 });
  expect(await outboxCount()).toBe(2);
});
