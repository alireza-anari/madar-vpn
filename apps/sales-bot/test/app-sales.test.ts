import { createHmac } from "node:crypto";
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
import { createAccount } from "../src/accounts";
import { appApi } from "../src/app-api";
import {
  createAppSale,
  createAppTrial,
  previewSale,
} from "../src/app-sales";
import {
  buildAccountDeliveryArtifact,
  queueAccountDelivery,
} from "../src/account-delivery";
import type { SalesActor } from "../src/resellers";

const GB = 1e9;
const now = 10_000;
const seller: SalesActor = { telegramId: "10", role: "seller" };
const other: SalesActor = { telegramId: "20", role: "seller" };
const token = "123456:SALES_TEST";
const e = {
  ...env,
  BOT_TOKEN: token,
  ADMIN_TELEGRAM_IDS: "1",
  PUBLIC_BASE_URL: "https://example.test",
} as Env;

function signed(id: number) {
  const p = new URLSearchParams({
    auth_date: String(now),
    query_id: `q-${id}`,
    user: JSON.stringify({ id }),
  });
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const value = [...p.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  p.set("hash", createHmac("sha256", secret).update(value).digest("hex"));
  return p.toString();
}

function request(path: string, id: number, body?: unknown) {
  return new Request(`https://example.test${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "X-Telegram-Init-Data": signed(id),
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeEach(async () => {
  await resetDb();
  for (const sql of [m1, m2, m3, m4, m5, m6, m7, m8, m9, m10])
    await env.SALES_DB.exec(sql);
  await env.SALES_DB.exec(
    "INSERT INTO resellers(telegram_id,enabled,created_at) VALUES('10',1,1),('20',1,1);",
  );
});

async function node(id: string, maxBytes: number | null, maxAccounts = 10) {
  await env.SALES_DB.prepare(
    `INSERT INTO nodes(
      id,name,target_ip,vpn_port,state,revision,acked_revision,last_seen,healthy,
      agent_capabilities,max_accounts,max_allocated_bytes
    ) VALUES(?,?,?,443,'ready',5,5,?,1,'quota-v2,shared-443',?,?)`,
  )
    .bind(id, id === "n1" ? "Stockholm" : "Europe", `8.8.8.${id === "n1" ? 1 : 2}`, now, maxAccounts, maxBytes)
    .run();
}

const saleInput = {
  kind: "sale" as const,
  label: "Ali",
  quotaBytes: 20 * GB,
  durationSeconds: 30 * 86400,
  nodeId: "n1",
};

test("preview validates the request and reports eligible nodes plus before/after capacity", async () => {
  await node("n1", 50 * GB, 2);
  await node("n2", null, 10);
  const preview = await previewSale(env.SALES_DB, seller, saleInput, now);
  expect(preview.selectedNode).toMatchObject({
    id: "n1",
    beforeSellableBytes: 50 * GB,
    afterSellableBytes: 30 * GB,
    remainingSlotsBefore: 2,
    remainingSlotsAfter: 1,
  });
  expect(preview.nodes.find((n) => n.id === "n2")?.recommended).toBe(true);
  await expect(
    previewSale(env.SALES_DB, seller, { ...saleInput, quotaBytes: 0 }, now),
  ).rejects.toThrow("INVALID_ACCOUNT");
});

test("final create rejects stale byte capacity even after a successful preview", async () => {
  await node("n1", 25 * GB, 10);
  expect((await previewSale(env.SALES_DB, seller, saleInput, now)).selectedNode?.eligible).toBe(true);
  await createAccount(
    env.SALES_DB,
    other,
    {
      nodeId: "n1",
      kind: "sale",
      label: "other",
      quotaBytes: 10 * GB,
      durationSeconds: 86400,
      requestKey: "other-byte",
    },
    now,
  );
  const response = await appApi(
    request("/api/app/configs/create", 10, { ...saleInput, requestKey: "stale-byte" }),
    e,
    now,
  );
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "INSUFFICIENT_NODE_CAPACITY" });
});

test("final create rejects a stale node slot", async () => {
  await node("n1", 100 * GB, 1);
  await previewSale(env.SALES_DB, seller, saleInput, now);
  await createAccount(
    env.SALES_DB,
    other,
    {
      nodeId: "n1",
      kind: "sale",
      label: "other",
      quotaBytes: 1 * GB,
      durationSeconds: 86400,
      requestKey: "other-slot",
    },
    now,
  );
  const response = await appApi(
    request("/api/app/configs/create", 10, { ...saleInput, requestKey: "stale-slot" }),
    e,
    now,
  );
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "NODE_SLOT_LIMIT" });
});

test("repeating a requestKey returns the same account without double charging capacity", async () => {
  await node("n1", 100 * GB, 10);
  const input = { ...saleInput, requestKey: "same-key" };
  const first = await createAppSale(e, seller, input, now);
  const second = await createAppSale(e, seller, input, now);
  expect(second.accountId).toBe(first.accountId);
  expect(
    await env.SALES_DB.prepare(
      "SELECT COUNT(*) n FROM managed_accounts WHERE seller_id='10' AND request_key='same-key'",
    ).first<number>("n"),
  ).toBe(1);
});

test("trial creation always uses exactly 1 GB and 30 minutes through the normal guard", async () => {
  await node("n1", 100 * GB, 10);
  const result = await createAppTrial(e, seller, { nodeId: "n1", requestKey: "trial-1" }, now);
  const row = await env.SALES_DB.prepare(
    "SELECT kind,quota_bytes,duration_seconds FROM managed_accounts WHERE id=?",
  )
    .bind(result.accountId)
    .first<{ kind: string; quota_bytes: number; duration_seconds: number }>();
  expect(row).toEqual({ kind: "trial", quota_bytes: GB, duration_seconds: 1800 });
});

async function readyDeliveryFixture() {
  const uuid = "11111111-1111-4111-8111-111111111111";
  const policy = JSON.stringify({
    version: 2,
    nodeId: "ready",
    revision: 5,
    expiresAt: now + 500,
    clients: [
      {
        accountId: "ready-account",
        uuid,
        quotaEpoch: 1,
        quotaBytes: GB,
        usedBytes: 0,
        validUntil: now + 300,
        generation: "ready-account:1",
        listenPort: 20000,
      },
    ],
  });
  await env.SALES_DB.prepare(
    `INSERT INTO nodes(
      id,name,target_ip,vpn_port,state,revision,acked_revision,last_seen,healthy,public_key,
      short_id,sni,policy_payload,agent_capabilities,max_accounts,max_allocated_bytes
    ) VALUES('ready','Stockholm','8.8.4.4',443,'ready',5,5,?,1,'public','1234567890abcdef','www.cloudflare.com',?,'quota-v2,shared-443',10,100000000000)`,
  )
    .bind(now, policy)
    .run();
  await env.SALES_DB.prepare(
    `INSERT INTO managed_accounts(
      id,seller_id,request_key,node_id,kind,label,uuid,state,quota_bytes,duration_seconds,
      started_at,valid_until,prepared_revision,activation_revision,created_at,listen_port,seller_settlement_epoch
    ) VALUES('ready-account','10','ready-r','ready','sale','Ready',?,'active',?,86400,?, ?,4,5,1,20000,0)`,
  )
    .bind(uuid, GB, now - 10, now + 300)
    .run();
}

test("result artifact is pending before activation and matches durable bot delivery once ready", async () => {
  await node("n1", 100 * GB, 10);
  const pending = await createAppSale(e, seller, { ...saleInput, requestKey: "pending" }, now);
  expect(await buildAccountDeliveryArtifact(e, pending.accountId, now)).toBeNull();

  await readyDeliveryFixture();
  const artifact = await buildAccountDeliveryArtifact(e, "ready-account", now);
  expect(artifact?.config).toContain("vless://");
  expect(artifact?.config).toContain(":443?");
  await queueAccountDelivery(e, "ready-account", now);
  const payload = await env.SALES_DB.prepare(
    "SELECT payload FROM outbox WHERE id='account:ready-account'",
  ).first<string>("payload");
  expect(payload).toBeTruthy();
  expect(JSON.parse(payload!).text).toContain(artifact!.config);

  const foreign = await appApi(
    request("/api/app/configs/ready-account/result", 20),
    e,
    now,
  );
  expect([403, 404]).toContain(foreign.status);
  expect(await foreign.text()).not.toContain("vless://");
});
