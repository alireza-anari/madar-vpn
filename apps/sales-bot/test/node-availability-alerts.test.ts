import { env } from "cloudflare:workers";
import { beforeEach, expect, test } from "vitest";
import { resetDb } from "./db";
import m1 from "../migrations/0001.sql?raw";
import m2 from "../migrations/0002.sql?raw";
import m3 from "../migrations/0003.sql?raw";
import m15 from "../migrations/0015-node-availability-alerts.sql?raw";
import { refreshNodeAvailabilityAlerts } from "../src/node-availability-alerts";

const E = { ...env, ADMIN_TELEGRAM_IDS: "9,8" };
const insert = async (
  id: string,
  name: string,
  state: string,
  seen: number,
) =>
  env.SALES_DB.prepare(
    "INSERT INTO nodes(id,name,target_ip,state,last_seen,healthy) VALUES(?,?,? ,?,?,1)",
  )
    .bind(id, name, `203.0.113.${id === "n" ? "1" : id === "u" ? "2" : "3"}`, state, seen)
    .run();

const messages = async () =>
  (
    await env.SALES_DB.prepare(
      "SELECT id,chat_id,payload FROM outbox WHERE id LIKE 'availability:%' ORDER BY id",
    ).all<{ id: string; chat_id: string; payload: string }>()
  ).results;

beforeEach(async () => {
  await resetDb();
  for (const sql of [m1, m2, m3, m15]) await env.SALES_DB.exec(sql);
});

test("only one down message and one recovery per admin, ever-changing time is silent", async () => {
  await insert("n", "Stockholm", "ready", 900);
  await refreshNodeAvailabilityAlerts(E, 1000);
  expect(await messages()).toHaveLength(0);
  expect(await env.SALES_DB.prepare("SELECT status,sequence FROM node_availability_alert_state WHERE node_id='n'").first()).toEqual({ status: "up", sequence: 0 });
  await refreshNodeAvailabilityAlerts(E, 1080); // exactly three minutes
  expect(await messages()).toHaveLength(0);
  await refreshNodeAvailabilityAlerts(E, 1081);
  expect(await messages()).toHaveLength(2);
  expect((await messages())[0]?.id).toContain("availability:n:1:");
  expect(JSON.parse((await messages())[0]!.payload).text).toContain("قطع ارتباط");
  await refreshNodeAvailabilityAlerts(E, 1600);
  expect(await messages()).toHaveLength(2); // no daily/hourly spam
  await env.SALES_DB.prepare("UPDATE nodes SET last_seen=1601 WHERE id='n'").run();
  await refreshNodeAvailabilityAlerts(E, 1605);
  expect(await messages()).toHaveLength(4);
  expect((await messages()).filter((m) => JSON.parse(m.payload).text.includes("برقرار شد"))).toHaveLength(2);
  await refreshNodeAvailabilityAlerts(E, 1606);
  expect(await messages()).toHaveLength(4);
  await refreshNodeAvailabilityAlerts(E, 1800); // new outage
  expect(await messages()).toHaveLength(6);
  expect(new Set((await messages()).map((m) => m.chat_id))).toEqual(new Set(["9", "8"]));
});

test("new nodes enroll automatically after first ready heartbeat; installing and unknown nodes stay quiet", async () => {
  await insert("n", "Being installed", "installing", 100);
  await insert("u", "Never checked in", "ready", 0);
  await refreshNodeAvailabilityAlerts(E, 5000);
  expect(await messages()).toHaveLength(0);
  expect(Number(await env.SALES_DB.prepare("SELECT COUNT(*) count FROM node_availability_alert_state").first("count"))).toBe(0);
  await env.SALES_DB.prepare("UPDATE nodes SET state='ready',last_seen=5010 WHERE id='n'").run();
  await refreshNodeAvailabilityAlerts(E, 5020);
  expect(await messages()).toHaveLength(0);
  await refreshNodeAvailabilityAlerts(E, 5191);
  expect(await messages()).toHaveLength(2);
  await env.SALES_DB.prepare("UPDATE nodes SET state='installing' WHERE id='n'").run();
  await refreshNodeAvailabilityAlerts(E, 6000);
  expect(await messages()).toHaveLength(2);
});

test("persisted healthy=1 is not proof of an active heartbeat", async () => {
  await insert("n", "Old cached green", "ready", 100);
  await refreshNodeAvailabilityAlerts(E, 1000);
  expect(await messages()).toHaveLength(2);
});

test("maintenance silences outages and clears recoveries during the window", async () => {
  await insert("n", "Stockholm", "ready", 1000);
  await refreshNodeAvailabilityAlerts(E, 1010);
  await env.SALES_DB.prepare(
    "UPDATE node_availability_alert_state SET muted_until=1500 WHERE node_id='n'",
  ).run();
  await refreshNodeAvailabilityAlerts(E, 1300);
  expect(await messages()).toHaveLength(0);
  await refreshNodeAvailabilityAlerts(E, 1501);
  expect(await messages()).toHaveLength(2);
  await env.SALES_DB.prepare("UPDATE node_availability_alert_state SET muted_until=2000 WHERE node_id='n'").run();
  await env.SALES_DB.prepare("UPDATE nodes SET last_seen=1505 WHERE id='n'").run();
  await refreshNodeAvailabilityAlerts(E, 1506);
  expect(await messages()).toHaveLength(2);
  expect(await env.SALES_DB.prepare("SELECT status FROM node_availability_alert_state WHERE node_id='n'").first("status")).toBe("up");
});

test("overlapping sweeps do not duplicate down alerts", async () => {
  await insert("n", "Stockholm", "ready", 10);
  await Promise.all([
    refreshNodeAvailabilityAlerts(E, 1000),
    refreshNodeAvailabilityAlerts(E, 1000),
    refreshNodeAvailabilityAlerts(E, 1000),
  ]);
  expect(await messages()).toHaveLength(2);
  expect(await env.SALES_DB.prepare("SELECT sequence FROM node_availability_alert_state WHERE node_id='n'").first("sequence")).toBe(1);
});

test("no admin recipients produces no writes or false delivered states", async () => {
  await insert("n", "Stockholm", "ready", 1);
  await refreshNodeAvailabilityAlerts({ ...E, ADMIN_TELEGRAM_IDS: "bad,0" }, 1000);
  expect(await messages()).toHaveLength(0);
  expect(Number(await env.SALES_DB.prepare("SELECT COUNT(*) n FROM node_availability_alert_state").first("n"))).toBe(0);
  await refreshNodeAvailabilityAlerts(E, 1000);
  expect(await messages()).toHaveLength(2);
});
