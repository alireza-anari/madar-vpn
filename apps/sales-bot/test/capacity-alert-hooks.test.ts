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
import m14 from "../migrations/0014-on-demand-usage.sql?raw";
import { hash } from "../src/crypto";
import { nodeApi } from "../src/node-api";
import { refreshAllCapacityAlerts } from "../src/capacity-alerts";
import { drainInbox } from "../src/inbox";

const token = "A".repeat(40);
const E = { ...env, ADMIN_TELEGRAM_IDS: "9" };

beforeEach(async () => {
  await resetDb();
  for (const sql of [m1, m2, m3, m4, m5, m7, m9, m10, m11, m14])
    await env.SALES_DB.exec(sql);
  await env.SALES_DB.prepare(
    "INSERT INTO settings(key,value) VALUES('app_mode','reseller')",
  ).run();
  await env.SALES_DB.prepare(
    "INSERT INTO nodes(id,name,target_ip,max_accounts,max_allocated_bytes,token_hash,policy_key) VALUES('n','Stockholm','8.8.8.8',20,100000000000,?, 'policy')",
  )
    .bind(hash(token))
    .run();
  await env.SALES_DB.exec(
    "INSERT INTO resellers(telegram_id,enabled,created_at) VALUES('10',1,1);" +
      "INSERT INTO managed_accounts(id,seller_id,request_key,node_id,kind,label,uuid,state,quota_bytes,used_bytes,quota_epoch,duration_seconds,valid_until,created_at) VALUES('a','10','a','n','sale','a','uuid-a','active',100000000000,0,1,86400,1000,1);",
  );
});

test("accepted quota reports remain successful when alert persistence is unavailable", async () => {
  await env.SALES_DB.exec("DROP TABLE node_capacity_alert_state;");
  const request = new Request("https://example.test/api/node/quota-reports", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      reports: [
        {
          accountId: "a",
          quotaEpoch: 1,
          sequence: 1,
          totalBytes: 80_000_000_000,
          observedAt: 100,
          generation: "a:1",
        },
      ],
    }),
  });
  const response = await nodeApi(request, E, 100);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ accepted: 1, duplicates: 0 });
  expect(
    await env.SALES_DB.prepare(
      "SELECT used_bytes FROM managed_accounts WHERE id='a'",
    ).first("used_bytes"),
  ).toBe(80_000_000_000);
});

test("sale confirmation completes even when both alert refreshes fail", async () => {
  await env.SALES_DB.exec(
    "DELETE FROM managed_accounts; UPDATE nodes SET healthy=1,last_seen=100,agent_capabilities='quota-v2' WHERE id='n';",
  );
  const conversation = JSON.stringify({
    step: "confirm",
    requestKey: "alert-sale",
    kind: "sale",
    label: "client",
    quotaBytes: 10_000_000_000,
    durationSeconds: 86400,
    nodeId: "n",
  });
  await env.SALES_DB.prepare(
    "INSERT INTO users(id,conversation) VALUES('10',?)",
  )
    .bind(conversation)
    .run();
  await env.SALES_DB.prepare(
    "INSERT INTO telegram_updates(id,payload) VALUES(900,?)",
  )
    .bind(
      JSON.stringify({
        update_id: 900,
        callback_query: {
          id: "900",
          from: { id: 10 },
          message: { chat: { id: 10, type: "private" } },
          data: "rs:confirm:alert-sale",
        },
      }),
    )
    .run();
  await env.SALES_DB.exec("DROP TABLE node_capacity_alert_state;");

  await drainInbox(E, 100);

  expect(
    await env.SALES_DB.prepare(
      "SELECT COUNT(*) n FROM managed_accounts WHERE request_key='alert-sale'",
    ).first("n"),
  ).toBe(1);
  expect(
    await env.SALES_DB.prepare(
      "SELECT state FROM telegram_updates WHERE id=900",
    ).first("state"),
  ).toBe("done");
});

test("revoke completes even when its downward alert refresh fails", async () => {
  await env.SALES_DB.prepare(
    "INSERT INTO telegram_updates(id,payload) VALUES(901,?)",
  )
    .bind(
      JSON.stringify({
        update_id: 901,
        callback_query: {
          id: "901",
          from: { id: 9 },
          message: { chat: { id: 9, type: "private" } },
          data: "rs:revokeok:a",
        },
      }),
    )
    .run();
  await env.SALES_DB.exec("DROP TABLE node_capacity_alert_state;");

  await drainInbox(E, 100);

  expect(
    await env.SALES_DB.prepare(
      "SELECT state FROM managed_accounts WHERE id='a'",
    ).first("state"),
  ).toBe("revoked");
  expect(
    await env.SALES_DB.prepare(
      "SELECT state FROM telegram_updates WHERE id=901",
    ).first("state"),
  ).toBe("done");
});

test("the scheduled sweep isolates one broken alert store from its caller", async () => {
  await env.SALES_DB.exec("DROP TABLE node_capacity_alert_state;");
  await expect(refreshAllCapacityAlerts(E, 100)).resolves.toBeUndefined();
});
