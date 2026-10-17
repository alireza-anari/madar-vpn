import allocation from "../migrations/0009-node-allocation-cap.sql?raw";
import capacity from "../migrations/0007-node-capacity.sql?raw";
import accounting from "../migrations/0010-capacity-accounting-resellers.sql?raw";
import slotMode from "../migrations/0011-node-account-slot-mode.sql?raw";
import { env } from "cloudflare:workers";
import { beforeEach, expect, test } from "vitest";
import { resetDb } from "./db";
import a from "../migrations/0001.sql?raw";
import b from "../migrations/0002.sql?raw";
import c from "../migrations/0003.sql?raw";
import d from "../migrations/0004-reseller-accounts.sql?raw";
import trialQuota from "../migrations/0006-trial-quota.sql?raw";
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
  for (const s of [a, b, c, d, capacity, allocation, accounting, slotMode])
    await env.SALES_DB.exec(s);
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

test("Persian and Arabic numerals work and cancellation clears issuance", async () => {
  await click(10, "rs:sale");
  await send(10, "مشتری فارسی");
  await send(10, "۳۰");
  await send(10, "٧");
  const state = JSON.parse(
    (await env.SALES_DB.prepare(
      "SELECT conversation FROM users WHERE id='10'",
    ).first<string>("conversation"))!,
  );
  expect(state.quotaBytes).toBe(30e9);
  expect(state.durationSeconds).toBe(7 * 86400);
  await click(10, "rs:home");
  await click(10, `rs:confirm:${state.requestKey}`);
  expect(
    await env.SALES_DB.prepare("SELECT COUNT(*) n FROM managed_accounts").first(
      "n",
    ),
  ).toBe(0);
});
test("revocation requires admin confirmation", async () => {
  await click(10, "rs:trial", 2100);
  await click(10, "rs:confirm:trial:2100", 2101);
  const id = await env.SALES_DB.prepare(
    "SELECT id FROM managed_accounts",
  ).first<string>("id");
  await click(9, `rs:revoke:${id}`);
  expect(
    await env.SALES_DB.prepare("SELECT state FROM managed_accounts").first(
      "state",
    ),
  ).toBe("preparing");
  await click(10, `rs:revokeok:${id}`);
  expect(
    await env.SALES_DB.prepare("SELECT state FROM managed_accounts").first(
      "state",
    ),
  ).toBe("preparing");
  await click(9, `rs:revokeok:${id}`);
  expect(
    await env.SALES_DB.prepare("SELECT state FROM managed_accounts").first(
      "state",
    ),
  ).toBe("revoked");
});

test("account pages preserve seller ownership", async () => {
  for (let i = 0; i < 10; i++)
    await env.SALES_DB.prepare(
      "INSERT INTO managed_accounts(id,seller_id,request_key,node_id,kind,label,uuid,quota_bytes,duration_seconds,created_at) VALUES(?, '10', ?, 's', 'sale', ?, ?, 1000000000,86400,100)",
    )
      .bind(`a${i}`, `k${i}`, `client${i}`, `uuid${i}`)
      .run();
  await click(10, "rs:list", 2200);
  const first = JSON.parse(
    (await env.SALES_DB.prepare(
      "SELECT payload FROM outbox WHERE id='u2200:reply'",
    ).first<string>("payload"))!,
  );
  expect(
    first.reply_markup.inline_keyboard
      .flat()
      .filter((b: any) => b.callback_data.startsWith("rs:view:")),
  ).toHaveLength(8);
  await click(10, "rs:list:1", 2201);
  const second = JSON.parse(
    (await env.SALES_DB.prepare(
      "SELECT payload FROM outbox WHERE id='u2201:reply'",
    ).first<string>("payload"))!,
  );
  expect(
    second.reply_markup.inline_keyboard
      .flat()
      .filter((b: any) => b.callback_data.startsWith("rs:view:")),
  ).toHaveLength(2);
  await env.SALES_DB.exec("INSERT INTO resellers VALUES('12',1,100)");
  await click(12, "rs:list", 2202);
  const other = JSON.parse(
    (await env.SALES_DB.prepare(
      "SELECT payload FROM outbox WHERE id='u2202:reply'",
    ).first<string>("payload"))!,
  );
  expect(
    other.reply_markup.inline_keyboard
      .flat()
      .some((b: any) => b.callback_data.startsWith("rs:view:")),
  ).toBe(false);
});

test("trial cap migration preserves usage, expiry and revocation", async () => {
  await env.SALES_DB.exec(
    "INSERT INTO managed_accounts(id,seller_id,request_key,node_id,kind,label,uuid,quota_bytes,duration_seconds,created_at,state,used_bytes,valid_until) VALUES('old','10','old','t','trial','old','old',NULL,1800,100,'active',1100000000,999),('rev','10','rev','t','trial','rev','rev',NULL,1800,100,'revoked',123,888);",
  );
  await env.SALES_DB.exec(trialQuota);
  expect(
    await env.SALES_DB.prepare(
      "SELECT quota_bytes,state,used_bytes,valid_until FROM managed_accounts WHERE id='old'",
    ).first(),
  ).toEqual({
    quota_bytes: 1e9,
    state: "exhausted",
    used_bytes: 1100000000,
    valid_until: 999,
  });
  expect(
    await env.SALES_DB.prepare(
      "SELECT state FROM managed_accounts WHERE id='rev'",
    ).first("state"),
  ).toBe("revoked");
});

test("quick choices and edit preserve a single sale request", async () => {
  await click(10, "rs:sale");
  await send(10, "مشتری");
  await click(10, "rs:pick:quota:30");
  await click(10, "rs:pick:days:30");
  const current = async () =>
    JSON.parse(
      (await env.SALES_DB.prepare(
        "SELECT conversation FROM users WHERE id='10'",
      ).first<string>("conversation"))!,
    );
  const before = await current();
  expect(before.quotaBytes).toBe(30e9);
  expect(before.durationSeconds).toBe(2592000);
  await click(10, "rs:back:quota");
  await click(10, "rs:pick:quota:50");
  await click(10, "rs:pick:days:7");
  const after = await current();
  expect(after.requestKey).toBe(before.requestKey);
  expect(after.quotaBytes).toBe(50e9);
  expect(after.durationSeconds).toBe(604800);
});
test("seller administration is restricted and home has help", async () => {
  await click(10, "rs:sellers", 2300);
  const denied = JSON.parse(
    (await env.SALES_DB.prepare(
      "SELECT payload FROM outbox WHERE id='u2300:reply'",
    ).first<string>("payload"))!,
  );
  expect(denied.text).not.toContain("غیرفعال‌کردن");
  await click(9, "rs:sellers", 2301);
  const admin = JSON.parse(
    (await env.SALES_DB.prepare(
      "SELECT payload FROM outbox WHERE id='u2301:reply'",
    ).first<string>("payload"))!,
  );
  expect(admin.text).toContain("فروشندگان");
  await send(10, "/help");
});
test("resending delivery preserves private capability and rejects other owners", async () => {
  await env.SALES_DB.exec(
    "INSERT INTO managed_accounts(id,seller_id,request_key,node_id,kind,label,uuid,quota_bytes,duration_seconds,created_at,state,valid_until,status_token_hash) VALUES('resend','10','resend','s','sale','client','uuid',1000000000,86400,100,'active',999,'hash'); INSERT INTO resellers VALUES('12',1,100);",
  );
  await env.SALES_DB.prepare(
    "INSERT INTO outbox(id,chat_id,payload,available_at) VALUES('account:resend','10',?,0)",
  )
    .bind(
      JSON.stringify({
        text: "private config",
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "usage", url: "https://example.com/usage/private" }],
          ],
        },
      }),
    )
    .run();
  await click(12, "rs:resend:resend", 2302);
  const denied = JSON.parse(
    (await env.SALES_DB.prepare(
      "SELECT payload FROM outbox WHERE id='u2302:reply'",
    ).first<string>("payload"))!,
  );
  expect(denied.text).not.toContain("private config");
  await click(10, "rs:resend:resend", 2303);
  const allowed = JSON.parse(
    (await env.SALES_DB.prepare(
      "SELECT payload FROM outbox WHERE id='u2303:reply'",
    ).first<string>("payload"))!,
  );
  expect(allowed.text).toBe("private config");
  expect(allowed.parse_mode).toBe("HTML");
  expect(allowed.reply_markup.inline_keyboard[0][0].url).toContain(
    "/usage/private",
  );
});

test("server picker shows remaining capacity and persists the selected server", async () => {
  await env.SALES_DB.exec(
    "UPDATE nodes SET healthy=1,last_seen=100,agent_capabilities='quota-v2',max_accounts=4;",
  );
  await click(10, "rs:sale");
  await send(10, "انتخاب سرور");
  await send(10, "30");
  await click(10, "rs:pick:days:30", 2400);
  const p = JSON.parse(
    (await env.SALES_DB.prepare(
      "SELECT payload FROM outbox WHERE id='u2400:reply'",
    ).first<string>("payload"))!,
  );
  expect(
    p.reply_markup.inline_keyboard
      .flat()
      .some((b: any) => b.text.includes("۴ جای خالی")),
  ).toBe(true);
  await click(10, "rs:choose:t");
  const state = JSON.parse(
    (await env.SALES_DB.prepare(
      "SELECT conversation FROM users WHERE id='10'",
    ).first<string>("conversation"))!,
  );
  expect(state.nodeId).toBe("t");
  await click(10, `rs:confirm:${state.requestKey}`);
  expect(
    await env.SALES_DB.prepare("SELECT node_id FROM managed_accounts").first(
      "node_id",
    ),
  ).toBe("t");
  await click(10, "rs:capacity:s");
  await send(10, "1");
  expect(
    await env.SALES_DB.prepare(
      "SELECT max_accounts FROM nodes WHERE id='s'",
    ).first("max_accounts"),
  ).toBe(4);
  await click(9, "rs:capacity:s");
  await send(9, "۱۲");
  expect(
    await env.SALES_DB.prepare(
      "SELECT max_accounts FROM nodes WHERE id='s'",
    ).first("max_accounts"),
  ).toBe(12);
});

test("only admins edit volume caps and picker displays allocated GB remaining", async () => {
  await env.SALES_DB.exec(
    "UPDATE nodes SET max_allocated_bytes=1000000000000,healthy=1,last_seen=100,agent_capabilities='quota-v2';",
  );
  await click(10, "rs:allocation:s");
  await send(10, "1");
  expect(
    await env.SALES_DB.prepare(
      "SELECT max_allocated_bytes FROM nodes WHERE id='s'",
    ).first("max_allocated_bytes"),
  ).toBe(1e12);
  await click(9, "rs:allocation:s");
  await send(9, "۵۰۰");
  expect(
    await env.SALES_DB.prepare(
      "SELECT max_allocated_bytes FROM nodes WHERE id='s'",
    ).first("max_allocated_bytes"),
  ).toBe(500e9);
  await click(10, "rs:sale");
  await send(10, "client");
  await send(10, "30");
  await click(10, "rs:pick:days:30", 2500);
  const payload = JSON.parse(
    (await env.SALES_DB.prepare(
      "SELECT payload FROM outbox WHERE id='u2500:reply'",
    ).first<string>("payload"))!,
  );
  expect(
    payload.reply_markup.inline_keyboard
      .flat()
      .some((b: any) => b.text.includes("قابل فروش: ۵۰۰ GB")),
  ).toBe(true);
});