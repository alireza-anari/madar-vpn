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
import { loadAdminNodeDetail } from "../src/app-admin";

const admin = { telegramId: "1", role: "admin" as const };
const now = 10_000;

beforeEach(async () => {
  await resetDb();
  for (const sql of [m1,m2,m3,m4,m5,m6,m7,m8,m9,m10,m11]) await env.SALES_DB.exec(sql);
  await env.SALES_DB.exec(
    "INSERT INTO nodes(id,name,target_ip,state,revision,acked_revision,last_seen,healthy,agent_capabilities,max_accounts,max_allocated_bytes) VALUES('n','Stockholm','8.8.8.8','ready',5,5,10000,1,'quota-v2,per-account-process,shared-443',20,100000000000);"
  );
});

async function detail() {
  return loadAdminNodeDetail(env.SALES_DB, admin, "n", now);
}

test("healthy recent node reports OK and zero last-seen age", async () => {
  await expect(detail()).resolves.toMatchObject({
    healthy: true,
    healthReason: "OK",
    lastSeenAgeSeconds: 0,
  });
});

test("stale heartbeat has highest health-reason precedence", async () => {
  await env.SALES_DB.exec(
    "UPDATE nodes SET last_seen=9800,revision=8,acked_revision=7,healthy=0,agent_capabilities='per-account-process' WHERE id='n'",
  );
  await expect(detail()).resolves.toMatchObject({
    healthy: false,
    healthReason: "STALE_HEARTBEAT",
    lastSeenAgeSeconds: 200,
  });
});

test("recent revision mismatch precedes capability and reported health", async () => {
  await env.SALES_DB.exec(
    "UPDATE nodes SET last_seen=9999,revision=8,acked_revision=7,healthy=0,agent_capabilities='per-account-process' WHERE id='n'",
  );
  await expect(detail()).resolves.toMatchObject({ healthReason: "REVISION_NOT_ACKED" });
});

test("missing quota capability precedes recent unhealthy flag", async () => {
  await env.SALES_DB.exec(
    "UPDATE nodes SET last_seen=9999,revision=8,acked_revision=8,healthy=0,agent_capabilities='per-account-process' WHERE id='n'",
  );
  await expect(detail()).resolves.toMatchObject({ healthReason: "MISSING_QUOTA_CAPABILITY" });
});

test("recent capable node can truthfully report agent unhealthy", async () => {
  await env.SALES_DB.exec(
    "UPDATE nodes SET last_seen=9999,revision=8,acked_revision=8,healthy=0,agent_capabilities='quota-v2,per-account-process' WHERE id='n'",
  );
  await expect(detail()).resolves.toMatchObject({ healthReason: "AGENT_REPORTED_UNHEALTHY" });
});
