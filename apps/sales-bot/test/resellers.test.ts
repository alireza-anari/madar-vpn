import allocation from "../migrations/0009-node-allocation-cap.sql?raw";
import capacity from "../migrations/0007-node-capacity.sql?raw";
import { env } from "cloudflare:workers";
import { beforeEach, expect, test } from "vitest";
import { resetDb } from "./db";
import base from "../migrations/0001.sql?raw";
import sales from "../migrations/0002.sql?raw";
import nodes from "../migrations/0003.sql?raw";
import migration from "../migrations/0004-reseller-accounts.sql?raw";
import {
  resolveSalesActor,
  setReseller,
  setNodePurpose,
} from "../src/resellers";
import { createAccount, ownedAccount, revokeAccount } from "../src/accounts";
const admin = { telegramId: "9", role: "admin" as const },
  seller = { telegramId: "10", role: "seller" as const };
beforeEach(async () => {
  await resetDb();
  for (const schema of [base, sales, nodes]) await env.SALES_DB.exec(schema);
  await env.SALES_DB.prepare(
    "INSERT INTO ledger VALUES('old','old-user',10,1)",
  ).run();
  await env.SALES_DB.exec(migration);
  await env.SALES_DB.exec(capacity);
  await env.SALES_DB.exec(allocation);
  await env.SALES_DB.prepare(
    "INSERT INTO nodes(id,name,target_ip) VALUES('sale','sale','8.8.8.8'),('trial','trial','1.1.1.1')",
  ).run();
  await setReseller(env.SALES_DB, admin, "10", true, 100);
  await setNodePurpose(env.SALES_DB, admin, "sale", "sale", 100);
  await setNodePurpose(env.SALES_DB, admin, "trial", "trial", 100);
});
test("roles are authoritative and preserve historical data", async () => {
  expect(
    (
      await resolveSalesActor(env.SALES_DB, "9", {
        ...env,
        ADMIN_TELEGRAM_IDS: "9",
      })
    ).role,
  ).toBe("admin");
  expect((await resolveSalesActor(env.SALES_DB, "10", env)).role).toBe(
    "seller",
  );
  expect((await resolveSalesActor(env.SALES_DB, "11", env)).role).toBe(
    "ordinary",
  );
  expect(
    await env.SALES_DB.prepare("SELECT COUNT(*) n FROM ledger").first("n"),
  ).toBe(1);
  await expect(
    setReseller(env.SALES_DB, seller, "11", true, 100),
  ).rejects.toThrow("ADMIN_REQUIRED");
  await expect(
    setNodePurpose(env.SALES_DB, seller, "trial", "sale", 100),
  ).rejects.toThrow("ADMIN_REQUIRED");
});
test("duplicate concurrent confirmations create one independent account", async () => {
  const input = {
    kind: "sale" as const,
    label: "customer",
    quotaBytes: 30e9,
    durationSeconds: 86400,
    requestKey: "request-1",
  };
  const [a, b] = await Promise.all([
    createAccount(env.SALES_DB, seller, input, 100),
    createAccount(env.SALES_DB, seller, input, 100),
  ]);
  expect(a.id).toBe(b.id);
  const other = await createAccount(
    env.SALES_DB,
    seller,
    { ...input, requestKey: "request-2" },
    100,
  );
  expect(other.id).not.toBe(a.id);
  expect((await ownedAccount(env.SALES_DB, seller, a.id)).uuid).not.toBe(
    (await ownedAccount(env.SALES_DB, seller, other.id)).uuid,
  );
  await expect(
    ownedAccount(env.SALES_DB, { telegramId: "11", role: "seller" }, a.id),
  ).rejects.toThrow();
});
test("each new trial has 1800 seconds and distinct request identity", async () => {
  const input = {
    kind: "trial" as const,
    label: "test",
    quotaBytes: null,
    durationSeconds: 1800,
    requestKey: "test-1",
  };
  const a = await createAccount(env.SALES_DB, seller, input, 100);
  const b = await createAccount(
    env.SALES_DB,
    seller,
    { ...input, requestKey: "test-2" },
    100,
  );
  expect(a.id).not.toBe(b.id);
  expect(
    (await ownedAccount(env.SALES_DB, seller, a.id)).duration_seconds,
  ).toBe(1800);
  await expect(
    createAccount(
      env.SALES_DB,
      seller,
      { ...input, durationSeconds: 1801 },
      100,
    ),
  ).rejects.toThrow("INVALID_ACCOUNT");
});
test("new trials always receive one decimal GB, including an old pending null quota", async () => {
  const a = await createAccount(
    env.SALES_DB,
    seller,
    {
      kind: "trial",
      label: "test",
      quotaBytes: null,
      durationSeconds: 1800,
      requestKey: "new-cap",
    },
    100,
  );
  expect((await ownedAccount(env.SALES_DB, seller, a.id)).quota_bytes).toBe(
    1000000000,
  );
});
test("invalid amounts, revoked seller and unauthorized account revocation are denied", async () => {
  const input = {
    kind: "sale" as const,
    label: "x",
    quotaBytes: 1e9,
    durationSeconds: 86400,
    requestKey: "x",
  };
  for (const quotaBytes of [null, -1, 0, Number.MAX_SAFE_INTEGER + 1])
    await expect(
      createAccount(env.SALES_DB, seller, { ...input, quotaBytes }, 100),
    ).rejects.toThrow("INVALID_ACCOUNT");
  const a = await createAccount(env.SALES_DB, seller, input, 100);
  await expect(revokeAccount(env.SALES_DB, seller, a.id, 100)).rejects.toThrow(
    "ADMIN_REQUIRED",
  );
  await revokeAccount(env.SALES_DB, admin, a.id, 100);
  expect((await ownedAccount(env.SALES_DB, admin, a.id)).state).toBe("revoked");
  await setReseller(env.SALES_DB, admin, "10", false, 100);
  await expect(
    createAccount(env.SALES_DB, seller, { ...input, requestKey: "new" }, 100),
  ).rejects.toThrow("SELLER_REQUIRED");
});

test("node capacity is atomic, replay-safe and released by revocation", async () => {
  await env.SALES_DB.exec(
    "UPDATE nodes SET max_accounts=1,healthy=1,last_seen=100,agent_capabilities='quota-v2' WHERE id='sale';",
  );
  const input = {
    kind: "sale" as const,
    label: "capacity",
    quotaBytes: 1e9,
    durationSeconds: 86400,
    nodeId: "sale",
    requestKey: "capacity1",
  };
  const results = await Promise.allSettled([
    createAccount(env.SALES_DB, seller, input, 100),
    createAccount(
      env.SALES_DB,
      seller,
      { ...input, requestKey: "capacity2" },
      100,
    ),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const row = await env.SALES_DB.prepare(
    "SELECT id,request_key FROM managed_accounts",
  ).first<{ id: string; request_key: string }>();
  expect(
    (
      await createAccount(
        env.SALES_DB,
        seller,
        { ...input, requestKey: row!.request_key },
        100,
      )
    ).id,
  ).toBe(row!.id);
  await revokeAccount(env.SALES_DB, admin, row!.id, 101);
  await expect(
    createAccount(
      env.SALES_DB,
      seller,
      { ...input, requestKey: "capacity3" },
      102,
    ),
  ).resolves.toBeTruthy();
});
