import { env } from "cloudflare:workers";
import { beforeEach, expect, test } from "vitest";
import { resetDb } from "./db";
import base from "../migrations/0001.sql?raw";
import sales from "../migrations/0002.sql?raw";
import nodes from "../migrations/0003.sql?raw";
import accounts from "../migrations/0004-reseller-accounts.sql?raw";
import shared from "../migrations/0005-shared-node-purposes.sql?raw";
import allocation from "../migrations/0009-node-allocation-cap.sql?raw";
import capacity from "../migrations/0007-node-capacity.sql?raw";
import { createAccount, revokeAccount } from "../src/accounts";
const seller = { telegramId: "10", role: "seller" as const },
  admin = { telegramId: "9", role: "admin" as const };
const input = (key: string, quotaBytes = 100e9) => ({
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
  ])
    await env.SALES_DB.exec(sql);
  await env.SALES_DB.exec(
    "INSERT INTO nodes(id,name,target_ip,max_accounts,max_allocated_bytes) VALUES('n','n','8.8.8.8',20,1000000000000); INSERT INTO node_purposes VALUES('sale','n'),('trial','n'); INSERT INTO resellers VALUES('10',1,100),('11',1,100);",
  );
});
test("ten 100 GB accounts fill a 1000 GB server before its twenty-account cap", async () => {
  for (let i = 0; i < 10; i++)
    await createAccount(env.SALES_DB, seller, input("a" + i), 100);
  await expect(
    createAccount(env.SALES_DB, seller, input("overflow", 1e9), 100),
  ).rejects.toThrow("NODE_ALLOCATION_FULL");
  expect(
    (await createAccount(env.SALES_DB, seller, input("a0"), 100)).id,
  ).toBeTruthy();
});
test("twenty active reservations fill the count even when allocated GB remain", async () => {
  for (let i = 0; i < 20; i++)
    await createAccount(env.SALES_DB, seller, input("a" + i, 10e9), 100);
  await expect(
    createAccount(env.SALES_DB, seller, input("overflow", 1e9), 100),
  ).rejects.toThrow("NODE_FULL");
});
test("partial consumption does not release the assigned volume; revocation does", async () => {
  await env.SALES_DB.exec("UPDATE nodes SET max_allocated_bytes=100000000000");
  const a = await createAccount(env.SALES_DB, seller, input("a"), 100);
  await env.SALES_DB.prepare(
    "UPDATE managed_accounts SET state='active',valid_until=1000,used_bytes=90000000000 WHERE id=?",
  )
    .bind(a.id)
    .run();
  await expect(
    createAccount(env.SALES_DB, seller, input("overflow", 1e9), 100),
  ).rejects.toThrow("NODE_ALLOCATION_FULL");
  await revokeAccount(env.SALES_DB, admin, a.id, 101);
  await expect(
    createAccount(env.SALES_DB, seller, input("b"), 102),
  ).resolves.toBeTruthy();
});
test.each(["expired", "exhausted", "blocked"])(
  "%s accounts release their reservation",
  async (state) => {
    await env.SALES_DB.exec(
      "UPDATE nodes SET max_allocated_bytes=100000000000",
    );
    const a = await createAccount(env.SALES_DB, seller, input("a"), 100);
    await env.SALES_DB.prepare("UPDATE managed_accounts SET state=? WHERE id=?")
      .bind(state, a.id)
      .run();
    await expect(
      createAccount(env.SALES_DB, seller, input("b"), 101),
    ).resolves.toBeTruthy();
  },
);
test("competing sellers cannot over-allocate the last GB", async () => {
  await env.SALES_DB.exec("UPDATE nodes SET max_allocated_bytes=100000000000");
  const results = await Promise.allSettled([
    createAccount(env.SALES_DB, seller, input("a"), 100),
    createAccount(
      env.SALES_DB,
      { telegramId: "11", role: "seller" },
      input("b"),
      100,
    ),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
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
    createAccount(env.SALES_DB, seller, input("overflow", 1e9), 100),
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
    createAccount(env.SALES_DB, seller, input("new", 1e9), 100),
  ).rejects.toThrow("NODE_ALLOCATION_FULL");
});


test("node health goes stale despite stored healthy flag", async () => {
  const { nodeCapacities } = await import("../src/node-capacity");
  await env.SALES_DB.exec(
    "UPDATE nodes SET healthy=1,state='ready',revision=3,acked_revision=3,last_seen=95 WHERE id='n'",
  );
  expect((await nodeCapacities(env.SALES_DB, 100))[0]?.healthy).toBe(1);
  expect((await nodeCapacities(env.SALES_DB, 186))[0]?.healthy).toBe(0);
});

test("node health requires current policy acknowledgement and ready state", async () => {
  const { nodeCapacities } = await import("../src/node-capacity");
  await env.SALES_DB.exec(
    "UPDATE nodes SET healthy=1,state='ready',revision=4,acked_revision=3,last_seen=99 WHERE id='n'",
  );
  expect((await nodeCapacities(env.SALES_DB, 100))[0]?.healthy).toBe(0);
  await env.SALES_DB.exec(
    "UPDATE nodes SET revision=3,state='verifying' WHERE id='n'",
  );
  expect((await nodeCapacities(env.SALES_DB, 100))[0]?.healthy).toBe(0);
});
