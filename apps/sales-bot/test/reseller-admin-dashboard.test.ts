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

const GB = 1e9;
const E = {
  ...env,
  ADMIN_TELEGRAM_IDS: "9",
  PUBLIC_BASE_URL: "https://example.test",
};
let seq = 4000;
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
      "INSERT INTO nodes(id,name,target_ip,healthy,last_seen,agent_capabilities,max_accounts,max_allocated_bytes) VALUES('n1','Stockholm','8.8.8.8',1,100,'quota-v2,shared-443',20,100000000000),('n2','Frankfurt','1.1.1.1',1,100,'quota-v2,shared-443',10,200000000000);" +
      "INSERT INTO node_purposes(purpose,node_id) VALUES('sale','n1'),('trial','n2');" +
      "INSERT INTO resellers(telegram_id,enabled,created_at) VALUES('10',1,50);",
  );
});

async function account(
  id: string,
  nodeId: string,
  state: string,
  quotaGb: number,
  usedGb: number,
  validUntil = 1000,
) {
  await env.SALES_DB.prepare(
    "INSERT INTO managed_accounts(id,seller_id,request_key,node_id,kind,label,uuid,state,quota_bytes,used_bytes,duration_seconds,valid_until,created_at) VALUES(?,'10',?,?,'sale',?,?,?, ?,?,86400,?,60)",
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
      validUntil,
    )
    .run();
}

test("admin node list is compact and node detail shows true capacity metrics", async () => {
  await account("live", "n1", "active", 30, 5);
  await account("rev", "n1", "revoked", 20, 8);
  await click(9, "rs:nodes", 4100);
  const list = await payload(4100);
  const buttons = list.reply_markup.inline_keyboard.flat();
  expect(buttons.some((b: any) => b.callback_data === "rs:nodedetail:n1")).toBe(true);
  expect(buttons.some((b: any) => b.callback_data === "rs:nodedetail:n2")).toBe(true);

  await click(9, "rs:nodedetail:n1", 4101);
  const detail = await payload(4101);
  expect(detail.text).toContain("🌐 Stockholm");
  expect(detail.text).toContain("کل: ۱۰۰ GB");
  expect(detail.text).toContain("رزرو فعال: ۳۰ GB");
  expect(detail.text).toContain("مصرف قطعی: ۸ GB");
  expect(detail.text).toContain("قابل فروش: ۶۲ GB");
  expect(detail.text).toContain("کانفیگ: ۱ / ۲۰");
  expect(detail.text).toContain("۳۸٪");
  expect(detail.text).toContain("فروش");
});

test("admin can switch a node to unlimited while seller cannot", async () => {
  await click(10, "rs:unlimit:n1", 4110);
  expect(
    await env.SALES_DB.prepare(
      "SELECT max_allocated_bytes FROM nodes WHERE id='n1'",
    ).first("max_allocated_bytes"),
  ).toBe(100e9);

  await click(9, "rs:unlimit:n1", 4111);
  expect(
    await env.SALES_DB.prepare(
      "SELECT max_allocated_bytes FROM nodes WHERE id='n1'",
    ).first("max_allocated_bytes"),
  ).toBeNull();
  await click(9, "rs:nodedetail:n1", 4112);
  expect((await payload(4112)).text).toContain("حجم: نامحدود");
});

test("seller detail shows current and all-time accounting with node breakdown", async () => {
  await account("live", "n1", "active", 30, 5);
  await account("rev", "n2", "revoked", 20, 8);
  await click(9, "rs:sellers", 4120);
  const list = await payload(4120);
  expect(
    list.reply_markup.inline_keyboard
      .flat()
      .some((b: any) => b.callback_data === "rs:seller:10"),
  ).toBe(true);

  await click(9, "rs:seller:10", 4121);
  const detail = await payload(4121);
  expect(detail.text).toContain("👤 فروشنده ۱۰");
  expect(detail.text).toContain("این تسویه");
  expect(detail.text).toContain("کل دوره");
  expect(detail.text).toContain("فروش: ۵۰ GB");
  expect(detail.text).toContain("مصرف واقعی: ۱۳ GB");
  expect(detail.text).toContain("Stockholm");
  expect(detail.text).toContain("Frankfurt");
});

test("admin can set and clear seller count and traffic caps", async () => {
  await click(9, "rs:limitcount:10", 4130);
  await send(9, "۲", 4131);
  expect(
    await env.SALES_DB.prepare(
      "SELECT max_reserved_accounts FROM reseller_controls WHERE seller_id='10'",
    ).first("max_reserved_accounts"),
  ).toBe(2);

  await click(9, "rs:limitbytes:10", 4132);
  await send(9, "۵۰", 4133);
  expect(
    await env.SALES_DB.prepare(
      "SELECT max_committed_bytes FROM reseller_controls WHERE seller_id='10'",
    ).first("max_committed_bytes"),
  ).toBe(50e9);

  await click(9, "rs:limitcount:10", 4134);
  await send(9, "۰", 4135);
  await click(9, "rs:limitbytes:10", 4136);
  await send(9, "0", 4137);
  expect(
    await env.SALES_DB.prepare(
      "SELECT max_reserved_accounts FROM reseller_controls WHERE seller_id='10'",
    ).first("max_reserved_accounts"),
  ).toBeNull();
  expect(
    await env.SALES_DB.prepare(
      "SELECT max_committed_bytes FROM reseller_controls WHERE seller_id='10'",
    ).first("max_committed_bytes"),
  ).toBeNull();
});

test("settlement is confirmed once, snapshots the epoch and never changes customer service", async () => {
  await account("live", "n1", "active", 30, 5);
  await click(9, "rs:settle:10", 4140);
  const confirm = await payload(4140);
  expect(confirm.text).toContain("تسویه فروشنده ۱۰");
  expect(
    confirm.reply_markup.inline_keyboard
      .flat()
      .some((b: any) => b.callback_data === "rs:settleok:10"),
  ).toBe(true);

  await click(9, "rs:settleok:10", 4141);
  await click(9, "rs:settleok:10", 4141);
  expect(
    await env.SALES_DB.prepare(
      "SELECT COUNT(*) n FROM reseller_settlements WHERE seller_id='10'",
    ).first("n"),
  ).toBe(1);
  expect(
    await env.SALES_DB.prepare(
      "SELECT current_settlement_epoch FROM reseller_controls WHERE seller_id='10'",
    ).first("current_settlement_epoch"),
  ).toBe(1);
  expect(
    await env.SALES_DB.prepare(
      "SELECT state FROM managed_accounts WHERE id='live'",
    ).first("state"),
  ).toBe("active");

  await click(9, "rs:settlements:10", 4142);
  const history = await payload(4142);
  expect(history.text).toContain("تسویه‌های اخیر");
  expect(history.text).toContain("۳۰ GB");
});

test("seller cannot invoke admin detail, limit or settlement callbacks", async () => {
  await click(10, "rs:nodedetail:n1", 4150);
  await click(10, "rs:limitcount:10", 4151);
  await click(10, "rs:settle:10", 4152);
  expect(
    await env.SALES_DB.prepare(
      "SELECT COUNT(*) n FROM reseller_controls WHERE seller_id='10'",
    ).first("n"),
  ).toBe(0);
  for (const update of [4150, 4151, 4152])
    expect((await payload(update)).text).not.toContain("تأیید تسویه");
});

test("admin node list paginates beyond eight servers and keeps add-VPS action", async () => {
  for (let i=0;i<12;i++) {
    await env.SALES_DB.prepare("INSERT INTO nodes(id,name,target_ip,healthy,last_seen,agent_capabilities,max_accounts,max_allocated_bytes) VALUES(?,?,?,1,100,'quota-v2,shared-443',20,100000000000)")
      .bind("extra"+i,"Extra node "+i,"10.0.0."+ (i+1)).run();
  }
  await click(9,"rs:nodes",4201);
  const first=await payload(4201);
  const firstButtons=first.reply_markup.inline_keyboard.flat();
  expect(first.text).toContain("صفحه ۱ از ۲");
  expect(firstButtons.filter((b:any)=>b.callback_data?.startsWith("rs:nodedetail:")).length).toBe(8);
  expect(firstButtons.some((b:any)=>b.callback_data==="rs:nodes:1")).toBe(true);
  await click(9,"rs:nodes:1",4202);
  const second=await payload(4202);
  const secondButtons=second.reply_markup.inline_keyboard.flat();
  expect(second.text).toContain("صفحه ۲ از ۲");
  expect(secondButtons.filter((b:any)=>b.callback_data?.startsWith("rs:nodedetail:")).length).toBe(6);
  expect(secondButtons.some((b:any)=>b.callback_data==="rs:nodes:0")).toBe(true);
  expect(secondButtons.some((b:any)=>b.web_app?.url?.endsWith("/enroll"))).toBe(true);
});

test("admin seller list has eight-per-page navigation with seller management actions", async () => {
  for(let i=11;i<=22;i++) {
    await env.SALES_DB.prepare("INSERT INTO resellers(telegram_id,enabled,created_at) VALUES(?,1,?)").bind(String(i),i).run();
  }
  await click(9,"rs:sellers",4203);
  const first=await payload(4203);
  expect(first.text).toContain("صفحه ۱ از ۲");
  expect(first.reply_markup.inline_keyboard.flat().filter((b:any)=>b.callback_data?.startsWith("rs:seller:")).length).toBe(8);
  expect(first.reply_markup.inline_keyboard.flat().some((b:any)=>b.callback_data==="rs:sellers:1")).toBe(true);
  await click(9,"rs:sellers:1",4204);
  const second=await payload(4204);
  expect(second.text).toContain("صفحه ۲ از ۲");
  expect(second.reply_markup.inline_keyboard.flat().filter((b:any)=>b.callback_data?.startsWith("rs:seller:")).length).toBe(5);
  expect(second.reply_markup.inline_keyboard.flat().some((b:any)=>b.callback_data==="rs:invite")).toBe(true);
});

test("seller cannot open admin inventory pages or receive privileged VPS links", async () => {
  for(const [i,data] of [["4205","rs:nodes"],["4206","rs:nodes:1"],["4207","rs:sellers:1"]] as const) {
    await click(10,data,Number(i));
    const p=await payload(Number(i));
    expect(p.text).toContain("فقط برای مدیر");
    expect(p.reply_markup.inline_keyboard.flat().some((b:any)=>b.web_app?.url?.endsWith("/enroll"))).toBe(false);
    expect(p.reply_markup.inline_keyboard.flat().some((b:any)=>b.callback_data==="rs:nodedetail:n1")).toBe(false);
  }
});
