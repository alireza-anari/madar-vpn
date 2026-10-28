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
import { handleUpdate } from "../src/menus";

const E = {
  ...env,
  ADMIN_TELEGRAM_IDS: "9",
  PUBLIC_BASE_URL: "https://example.test",
};
const GB = 1e9;
let seq = 5000;

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
const send = (id: number, text: string, update = seq++) =>
  handleUpdate(
    E,
    {
      update_id: update,
      message: {
        message_id: update,
        chat: { id, type: "private" },
        from: { id },
        text,
      },
    },
    100,
  );
const payload = async (update: number) =>
  JSON.parse(
    (await env.SALES_DB.prepare("SELECT payload FROM outbox WHERE id=?")
      .bind(`u${update}:reply`)
      .first<string>("payload"))!,
  );

beforeEach(async () => {
  await resetDb();
  for (const sql of [m1, m2, m3, m4, m5, m6, m7, m8, m9, m10, m11])
    await env.SALES_DB.exec(sql);
  await env.SALES_DB.exec(
    "INSERT INTO settings(key,value) VALUES('app_mode','reseller');" +
      "INSERT INTO nodes(id,name,target_ip,healthy,last_seen,agent_capabilities,max_accounts,max_allocated_bytes) VALUES('n1','Stockholm','8.8.8.8',1,100,'quota-v2,shared-443',20,100000000000),('n2','Frankfurt','1.1.1.1',1,100,'quota-v2,shared-443',20,100000000000);" +
      "INSERT INTO node_purposes(purpose,node_id) VALUES('sale','n1'),('trial','n2');" +
      "INSERT INTO resellers(telegram_id,enabled,created_at) VALUES('10',1,10);",
  );
});

async function account(
  id: string,
  nodeId: string,
  state: string,
  quotaGb: number,
  usedGb: number,
  epoch: number,
) {
  await env.SALES_DB.prepare(
    "INSERT INTO managed_accounts(id,seller_id,request_key,node_id,kind,label,uuid,state,quota_bytes,used_bytes,duration_seconds,valid_until,created_at,seller_settlement_epoch) VALUES(?,'10',?,?,'sale',?,?,?, ?,?,86400,1000,20,?)",
  )
    .bind(
      id,
      id,
      nodeId,
      id,
      `uuid-${id}`,
      state,
      quotaGb * GB,
      usedGb * GB,
      epoch,
    )
    .run();
}

function flatButtons(p: any) {
  return (p.reply_markup?.inline_keyboard || []).flat();
}

test("seller home counts all still-in-service configs even after settlement", async () => {
  await account("old-live", "n1", "active", 30, 5, 0);
  await env.SALES_DB.exec(
    "INSERT INTO reseller_controls(seller_id,current_settlement_epoch,settlement_started_at,updated_at) VALUES('10',1,90,90);",
  );
  await send(10, "/start", 5010);
  const home = await payload(5010);
  expect(home.text).toContain("در سرویس: ۱");
  expect(home.text).toContain("این تسویه: ۰ کانفیگ");
  expect(home.text).toContain("کل فروش: ۱ کانفیگ");
});

test("admin and enabled seller homes expose the Madar Mini App while legacy actions remain", async () => {
  await send(9, "/start", 5011);
  const admin = await payload(5011);
  const adminButtons = flatButtons(admin);
  expect(adminButtons).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        text: "باز کردن پنل مدار",
        web_app: { url: "https://example.test/app" },
      }),
    ]),
  );
  expect(adminButtons.some((b: any) => b.callback_data === "rs:nodes")).toBe(true);
  expect(adminButtons.some((b: any) => b.web_app?.url?.endsWith("/enroll"))).toBe(false);

  await send(10, "/start", 5012);
  const seller = await payload(5012);
  const sellerButtons = flatButtons(seller);
  expect(sellerButtons).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        text: "باز کردن پنل مدار",
        web_app: { url: "https://example.test/app" },
      }),
    ]),
  );
  expect(sellerButtons.some((b: any) => b.callback_data)).toBe(true);
});

test("ordinary users never receive the management Mini App entry", async () => {
  await send(77, "/start", 5013);
  const ordinary = await payload(5013);
  expect(flatButtons(ordinary).some((b: any) => b.web_app?.url?.endsWith("/app"))).toBe(false);
});

test("native Add VPS works from both admin home and server inventory", async () => {
  await send(9, "/start", 5020);
  const home = await payload(5020);
  expect(
    flatButtons(home).some((b: any) => b.web_app?.url?.endsWith("/enroll")),
  ).toBe(false);
  expect(
    flatButtons(home).some((b: any) => b.web_app?.url?.endsWith("/app")),
  ).toBe(true);

  await click(9, "rs:nodes", 5021);
  const nodes = await payload(5021);
  expect(
    flatButtons(nodes).some((b: any) => b.callback_data === "enroll:start"),
  ).toBe(true);
  expect(flatButtons(nodes).some((b: any) => b.web_app?.url?.endsWith("/enroll"))).toBe(false);
});

test("node detail includes alert status and a config-list action", async () => {
  await env.SALES_DB.exec(
    "INSERT INTO node_capacity_alert_state(node_id,level,sequence,updated_at) VALUES('n1',90,2,99);",
  );
  await click(9, "rs:nodedetail:n1", 5030);
  const detail = await payload(5030);
  expect(detail.text).toContain("هشدار ظرفیت: ۹۰٪");
  expect(
    detail.reply_markup.inline_keyboard
      .flat()
      .some((b: any) => b.callback_data === "rs:list"),
  ).toBe(true);
});

test("seller detail reports state counts and both current and all-time node breakdowns", async () => {
  await account("old-revoked", "n1", "revoked", 20, 8, 0);
  await account("new-live", "n2", "active", 30, 5, 1);
  await env.SALES_DB.exec(
    "INSERT INTO reseller_controls(seller_id,current_settlement_epoch,settlement_started_at,updated_at) VALUES('10',1,90,90);",
  );
  await click(9, "rs:seller:10", 5040);
  const detail = await payload(5040);
  expect(detail.text).toContain("وضعیت این تسویه");
  expect(detail.text).toContain("وضعیت کل دوره");
  expect(detail.text).toContain("تفکیک این تسویه");
  expect(detail.text).toContain("تفکیک کل دوره");
  expect(detail.text).toContain("Frankfurt");
  expect(detail.text).toContain("Stockholm");
});
