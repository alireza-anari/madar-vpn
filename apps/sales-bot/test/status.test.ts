import { env } from "cloudflare:workers";
import { beforeEach, expect, test } from "vitest";
import { resetDb } from "./db";
import a from "../migrations/0001.sql?raw";
import b from "../migrations/0002.sql?raw";
import c from "../migrations/0003.sql?raw";
import d from "../migrations/0004-reseller-accounts.sql?raw";
import { queueAccountDelivery } from "../src/account-delivery";
import { accountStatus, statusResponse } from "../src/status-routes";
beforeEach(async () => {
  await resetDb();
  for (const s of [a, b, c, d]) await env.SALES_DB.exec(s);
  await env.SALES_DB.exec(
    "INSERT INTO nodes(id,name,target_ip,revision,acked_revision,last_seen,healthy,public_key,short_id,sni,agent_capabilities) VALUES('n','n','8.8.8.8',2,2,100,1,'public','1234','example.com','quota-v2,per-account-process');INSERT INTO managed_accounts(id,seller_id,request_key,node_id,kind,label,uuid,quota_bytes,duration_seconds,created_at,state,started_at,valid_until,activation_revision,listen_port) VALUES('a','10','r','n','sale','client','private-uuid',30000000000,1800,1,'preparing',100,1900,2,20000);",
  );
});
test("delivery waits for activation then is durable and capability scoped", async () => {
  await env.SALES_DB.prepare("UPDATE nodes SET policy_payload=?")
    .bind(
      JSON.stringify({
        version: 2,
        expiresAt: 400,
        clients: [{ accountId: "a", uuid: "private-uuid", validUntil: 1900 }],
      }),
    )
    .run();
  const E = { ...env, PUBLIC_BASE_URL: "https://example.com" };
  await queueAccountDelivery(E, "a", 101);
  expect(
    await env.SALES_DB.prepare("SELECT COUNT(*) n FROM outbox").first("n"),
  ).toBe(0);
  await env.SALES_DB.exec(
    "UPDATE managed_accounts SET state='active' WHERE id='a'",
  );
  await Promise.all([
    queueAccountDelivery(E, "a", 102),
    queueAccountDelivery(E, "a", 102),
  ]);
  const rows = await env.SALES_DB.prepare("SELECT payload FROM outbox").all<{
    payload: string;
  }>();
  expect(rows.results).toHaveLength(1);
  const message = JSON.parse(rows.results[0]!.payload);
  const url = message.reply_markup.inline_keyboard
    .flat()
    .find((b: any) => b.url).url;
  const token = url.split("/").pop();
  expect(message.text).not.toContain("seller");
  expect(message.text).toContain(":20000?");
  expect(await accountStatus(env.SALES_DB, token, 103)).toMatchObject({
    label: "client",
    usedBytes: 0,
    totalBytes: 30e9,
  });
  expect(await accountStatus(env.SALES_DB, "x".repeat(43), 103)).toBe(null);
  const response = await statusResponse(new Request(url), E, 103);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(await response.text()).not.toContain("private-uuid");
  await env.SALES_DB.exec(
    "UPDATE managed_accounts SET state='revoked',status_token_hash=NULL WHERE id='a'",
  );
  expect(await accountStatus(env.SALES_DB, token, 104)).toBe(null);
});
test("database outage returns a generic response without an uncaught capability request", async () => {
  const broken = {
    ...env,
    SALES_DB: {
      prepare() {
        throw Error("database unavailable");
      },
    },
  } as unknown as Env;
  const response = await statusResponse(
    new Request("https://example.com/api/usage/" + "a".repeat(64)),
    broken,
    100,
  );
  expect(response.status).toBe(503);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(await response.text()).not.toContain("a".repeat(64));
});
test("shared frontend exports public443 rather than private worker port", async () => {
  await env.SALES_DB.exec(
    "UPDATE nodes SET agent_capabilities='quota-v2,per-account-process,shared-443';UPDATE managed_accounts SET state='active';",
  );
  await env.SALES_DB.prepare("UPDATE nodes SET policy_payload=?")
    .bind(
      JSON.stringify({
        version: 2,
        expiresAt: 400,
        clients: [{ accountId: "a", uuid: "private-uuid", validUntil: 1900 }],
      }),
    )
    .run();
  await queueAccountDelivery(
    { ...env, PUBLIC_BASE_URL: "https://example.com" },
    "a",
    102,
  );
  const payload = await env.SALES_DB.prepare(
    "SELECT payload FROM outbox",
  ).first<string>("payload");
  expect(JSON.parse(payload!).text).toContain(":443?");
  expect(JSON.parse(payload!).text).not.toContain(":20000?");
});
test("delivery is forwardable HTML with private usage button and one-touch config copy", async () => {
  await env.SALES_DB.prepare(
    "UPDATE nodes SET public_key=?,sni='www.microsoft.com',short_id='1234567890abcdef',agent_capabilities='quota-v2,per-account-process,shared-443',policy_payload=?",
  )
    .bind(
      "p".repeat(43),
      JSON.stringify({
        version: 2,
        expiresAt: 400,
        clients: [{ accountId: "a", uuid: "private-uuid", validUntil: 1900 }],
      }),
    )
    .run();
  await env.SALES_DB.exec(
    "UPDATE managed_accounts SET state='active',kind='trial',quota_bytes=1000000000,label='<b>مشتری</b>';",
  );
  await queueAccountDelivery(
    { ...env, PUBLIC_BASE_URL: "https://example.com" },
    "a",
    102,
  );
  const payload = JSON.parse(
    (await env.SALES_DB.prepare("SELECT payload FROM outbox").first<string>(
      "payload",
    ))!,
  );
  const buttons = payload.reply_markup.inline_keyboard.flat();
  const copy = buttons.find((b: any) => b.copy_text),
    status = buttons.find((b: any) => b.url);
  expect(payload.parse_mode).toBe("HTML");
  expect(payload.text).not.toContain(status.url);
  expect(payload.text).not.toContain("/usage/");
  expect(payload.text).toContain("&lt;b&gt;مشتری&lt;/b&gt;");
  expect(payload.text).toContain("۱ گیگابایت");
  expect(copy.copy_text.text.length).toBeLessThanOrEqual(256);
  expect(copy.copy_text.text).toMatch(/^vless:\/\/private-uuid@8.8.8.8:443\?/);
  expect(payload.text).toContain("<pre>");
  expect(payload.text).not.toContain("headerType=");
});

test("long config retains a complete code block without invalid copy_text", async () => {
  await env.SALES_DB.prepare("UPDATE nodes SET sni=?,policy_payload=?")
    .bind(
      "a".repeat(240),
      JSON.stringify({
        version: 2,
        expiresAt: 400,
        clients: [{ accountId: "a", uuid: "private-uuid", validUntil: 1900 }],
      }),
    )
    .run();
  await env.SALES_DB.exec("UPDATE managed_accounts SET state='active';");
  await queueAccountDelivery(
    { ...env, PUBLIC_BASE_URL: "https://example.com" },
    "a",
    102,
  );
  const payload = JSON.parse(
    (await env.SALES_DB.prepare("SELECT payload FROM outbox").first<string>(
      "payload",
    ))!,
  );
  expect(
    payload.reply_markup.inline_keyboard.flat().some((b: any) => b.copy_text),
  ).toBe(false);
  expect(payload.text).toContain("a".repeat(240));
  expect(payload.text).toContain("<pre>");
});
