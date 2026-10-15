import { env } from "cloudflare:workers";
import { beforeEach, expect, test } from "vitest";
import { resetDb } from "./db";
import a from "../migrations/0001.sql?raw";
import b from "../migrations/0002.sql?raw";
import c from "../migrations/0003.sql?raw";
import d from "../migrations/0004-reseller-accounts.sql?raw";
import { handleUpdate } from "../src/menus";
const E = { ...env, ADMIN_TELEGRAM_IDS: "9" };
let seq = 1;
const send = (id: number, text: string) =>
  handleUpdate(
    E,
    {
      update_id: seq++,
      message: {
        message_id: seq,
        chat: { id, type: "private" },
        from: { id },
        text,
      },
    },
    100,
  );
const click = (id: number, data: string, update = seq++) =>
  handleUpdate(
    E,
    {
      update_id: update,
      callback_query: {
        id: String(update),
        from: { id },
        message: { chat: { id, type: "private" } },
        data,
      },
    },
    100,
  );
beforeEach(async () => {
  await resetDb();
  for (const s of [a, b, c, d]) await env.SALES_DB.exec(s);
  await env.SALES_DB.exec(
    "INSERT INTO settings VALUES('app_mode','reseller'); INSERT INTO nodes(id,name,target_ip) VALUES('s','sale','8.8.8.8'),('t','trial','1.1.1.1'); INSERT INTO node_purposes VALUES('sale','s'),('trial','t'); INSERT INTO resellers VALUES('10',1,100);",
  );
});
test("confirmed sale and trial replay are idempotent and legacy callbacks inert", async () => {
  await click(10, "rs:sale");
  await send(10, "مشتری");
  await send(10, "30");
  await send(10, "30");
  const state = JSON.parse(
    (await env.SALES_DB.prepare(
      "SELECT conversation FROM users WHERE id='10'",
    ).first<string>("conversation")) || "{}",
  );
  await Promise.all([
    click(10, `rs:confirm:${state.requestKey}`, 900),
    click(10, `rs:confirm:${state.requestKey}`, 900),
  ]);
  expect(
    await env.SALES_DB.prepare("SELECT COUNT(*) n FROM managed_accounts").first(
      "n",
    ),
  ).toBe(1);
  await click(10, "rs:trial", 901);
  await click(10, "rs:confirm:trial:901", 903);
  await click(10, "rs:confirm:trial:901", 903);
  await click(10, "rs:trial", 902);
  await click(10, "rs:confirm:trial:902", 904);
  expect(
    await env.SALES_DB.prepare("SELECT COUNT(*) n FROM managed_accounts").first(
      "n",
    ),
  ).toBe(3);
  await click(9, "admin:approve:any");
  expect(
    await env.SALES_DB.prepare("SELECT COUNT(*) n FROM ledger").first("n"),
  ).toBe(0);
});
test("ordinary users cannot issue and admin can enable sellers", async () => {
  await click(11, "rs:trial");
  expect(
    await env.SALES_DB.prepare("SELECT COUNT(*) n FROM managed_accounts").first(
      "n",
    ),
  ).toBe(0);
  await click(9, "rs:seller");
  await send(9, "11");
  expect(
    await env.SALES_DB.prepare(
      "SELECT enabled FROM resellers WHERE telegram_id='11'",
    ).first("enabled"),
  ).toBe(1);
});
test("replayed text update cannot advance a second conversation step", async () => {
  await click(10, "rs:sale");
  await send(10, "client");
  const update = {
    update_id: 777,
    message: {
      message_id: 777,
      chat: { id: 10, type: "private" },
      from: { id: 10 },
      text: "30",
    },
  };
  await handleUpdate(E, update, 100);
  await handleUpdate(E, update, 100);
  const state = JSON.parse(
    (await env.SALES_DB.prepare(
      "SELECT conversation FROM users WHERE id='10'",
    ).first<string>("conversation")) || "{}",
  );
  expect(state.step).toBe("days");
  expect(state.durationSeconds).toBeUndefined();
  expect(
    await env.SALES_DB.prepare(
      "SELECT COUNT(*) n FROM outbox WHERE id='u777:reply'",
    ).first("n"),
  ).toBe(1);
});
test("conversation and durable reply roll back together on storage failure", async () => {
  await click(10, "rs:sale");
  await send(10, "client");
  await env.SALES_DB.exec(
    "CREATE TRIGGER fail_reply BEFORE INSERT ON outbox WHEN NEW.id='u778:reply' BEGIN SELECT RAISE(ABORT,'TEST_STORAGE_FAILURE'); END;",
  );
  const update = {
    update_id: 778,
    message: {
      message_id: 778,
      chat: { id: 10, type: "private" },
      from: { id: 10 },
      text: "30",
    },
  };
  await expect(handleUpdate(E, update, 100)).rejects.toThrow();
  expect(
    JSON.parse(
      (await env.SALES_DB.prepare(
        "SELECT conversation FROM users WHERE id='10'",
      ).first<string>("conversation")) || "{}",
    ).step,
  ).toBe("quota");
  await env.SALES_DB.exec("DROP TRIGGER fail_reply;");
  await handleUpdate(E, update, 100);
  expect(
    JSON.parse(
      (await env.SALES_DB.prepare(
        "SELECT conversation FROM users WHERE id='10'",
      ).first<string>("conversation")) || "{}",
    ).step,
  ).toBe("days");
});
test("reseller-mode provisioning jobs carry the compatible protocol version", async () => {
  await env.SALES_DB.prepare(
    "INSERT INTO installation_jobs(id,kind,user_id,target_ip,port,created_at,expires_at) VALUES('probe-job','probe','9','8.8.4.4',22,100,1000)",
  ).run();
  const { leaseJob } = await import("../src/runner-api");
  const job = await leaseJob(E, "test-runner", 101);
  expect(job?.protocolVersion).toBe(2);
});
