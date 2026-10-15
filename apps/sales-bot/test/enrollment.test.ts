import { env } from "cloudflare:workers";
import { expect, test, beforeEach } from "vitest";
import { createHmac } from "node:crypto";
import { verifyMiniApp } from "../src/miniapp-auth";
import { publicTarget } from "../src/targets";
import { createEnrollment, issueNonce } from "../src/enrollment";
import { resetDb } from "./db";
import b from "../migrations/0001.sql?raw";
import s from "../migrations/0002.sql?raw";
import n from "../migrations/0003.sql?raw";
function signed(id: number, date = 100) {
  const p = new URLSearchParams({
    auth_date: String(date),
    user: JSON.stringify({ id }),
    query_id: "query",
  });
  const secret = createHmac("sha256", "WebAppData")
    .update("test-token")
    .digest();
  p.set(
    "hash",
    createHmac("sha256", secret)
      .update(
        [...p.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => `${k}=${v}`)
          .join("\n"),
      )
      .digest("hex"),
  );
  return p.toString();
}
const e = { ...env, BOT_TOKEN: "test-token", ADMIN_TELEGRAM_IDS: "9" };
beforeEach(async () => {
  await resetDb();
  await env.SALES_DB.exec(b);
  await env.SALES_DB.exec(s);
  await env.SALES_DB.exec(n);
});
test("Mini App verifies signature freshness and role", async () => {
  expect((await verifyMiniApp(signed(9), e, 100)).role).toBe("admin");
  await expect(verifyMiniApp(signed(100), e, 100)).rejects.toThrow(
    "ADMIN_REQUIRED",
  );
  await expect(verifyMiniApp(signed(9), e, 401)).rejects.toThrow(
    "AUTH_EXPIRED",
  );
  await expect(
    verifyMiniApp(signed(9).replace("query", "forged"), e, 100),
  ).rejects.toThrow("INVALID_SIGNATURE");
});
test.each([
  "127.0.0.1",
  "169.254.169.254",
  "10.0.0.1",
  "192.168.1.1",
  "100.64.1.1",
  "::1",
  "fe80::1",
  "::ffff:10.0.0.1",
  "2001:db8::1",
  "0.0.0.0",
])("blocks nonpublic target %s", (ip) =>
  expect(() => publicTarget(ip)).toThrow("INVALID_TARGET"),
);
test("public numeric IP accepted and hostname denied", () => {
  expect(publicTarget("51.21.199.245")).toBe("51.21.199.245");
  expect(() => publicTarget("example.com")).toThrow("INVALID_TARGET");
});
test("single-use nonce and fingerprint confirmation precede runnable job", async () => {
  const actor = { telegramId: "9", role: "admin" as const };
  const nonce = await issueNonce(env.SALES_DB, actor, 100);
  const input = {
    targetIp: "51.21.199.245",
    port: 22,
    username: "ubuntu",
    name: "new",
    hostFingerprint: "SHA256:" + "a".repeat(43),
    encryptedCredentials: '{"v":1,"key":"AA==","iv":"AA==","data":"AA=="}',
    nonce,
  };
  await expect(createEnrollment(e, actor, input, 100)).rejects.toThrow(
    "FINGERPRINT_UNCONFIRMED",
  );
  expect(
    await env.SALES_DB.prepare(
      "SELECT COUNT(*) n FROM installation_jobs",
    ).first("n"),
  ).toBe(0);
});
test("confirmed enrollment consumes nonce once and retains only encrypted input", async () => {
  const actor = { telegramId: "9", role: "admin" as const },
    fingerprint = "SHA256:" + "a".repeat(43);
  await env.SALES_DB.prepare(
    "INSERT INTO installation_jobs(id,kind,user_id,target_ip,port,fingerprint,state,created_at,expires_at) VALUES('probe','probe','9','51.21.199.245',22,?,'ready',100,400)",
  )
    .bind(fingerprint)
    .run();
  const nonce = await issueNonce(env.SALES_DB, actor, 100),
    input = {
      targetIp: "51.21.199.245",
      port: 22,
      username: "ubuntu",
      name: "new",
      hostFingerprint: fingerprint,
      encryptedCredentials: '{"v":1,"key":"AA==","iv":"AA==","data":"AA=="}',
      nonce,
      probeId: "probe",
    };
  const result = await createEnrollment(e, actor, input, 100);
  expect(result.jobId).toBeTruthy();
  await expect(createEnrollment(e, actor, input, 100)).rejects.toThrow(
    "FINGERPRINT_UNCONFIRMED",
  );
  expect(
    await env.SALES_DB.prepare("SELECT COUNT(*) n FROM admin_nonces").first(
      "n",
    ),
  ).toBe(0);
  const row = await env.SALES_DB.prepare(
    "SELECT credentials_expire_at,state FROM installation_jobs WHERE id=?",
  )
    .bind(result.jobId)
    .first();
  expect(row).toMatchObject({ credentials_expire_at: 1000, state: "queued" });
});
test("expired probe frees target lock without credentials", async () => {
  const { createProbe, cleanupCredentials } = await import("../src/enrollment");
  const actor = { telegramId: "9", role: "admin" as const };
  const nonce = await issueNonce(env.SALES_DB, actor, 100);
  await createProbe(
    e,
    actor,
    { targetIp: "51.21.199.245", port: 22, nonce },
    100,
  );
  await cleanupCredentials(env.SALES_DB, 401);
  const nonce2 = await issueNonce(env.SALES_DB, actor, 401);
  expect(
    (
      await createProbe(
        e,
        actor,
        { targetIp: "51.21.199.245", port: 22, nonce: nonce2 },
        401,
      )
    ).jobId,
  ).toBeTruthy();
});
test("failed installation accepts fresh credentials with the same recovery identity", async () => {
  const actor = { telegramId: "9", role: "admin" as const };
  const fingerprint = "SHA256:" + "a".repeat(43);
  await env.SALES_DB.prepare(
    "INSERT INTO nodes(id,name,target_ip,state) VALUES('node','old','51.21.199.245','failed')",
  ).run();
  await env.SALES_DB.prepare(
    "INSERT INTO installation_jobs(id,node_id,kind,user_id,target_ip,port,username,fingerprint,state,created_at,expires_at) VALUES('install','node','install','9','51.21.199.245',22,'ubuntu',?,'failed',1,2)",
  )
    .bind(fingerprint)
    .run();
  await env.SALES_DB.prepare(
    "INSERT INTO installation_jobs(id,kind,user_id,target_ip,port,fingerprint,state,created_at,expires_at) VALUES('probe','probe','9','51.21.199.245',22,?,'ready',100,400)",
  )
    .bind(fingerprint)
    .run();
  const result = await createEnrollment(
    e,
    actor,
    {
      targetIp: "51.21.199.245",
      port: 22,
      username: "ubuntu",
      name: "retry",
      hostFingerprint: fingerprint,
      encryptedCredentials: '{"v":1,"key":"AA==","iv":"AA==","data":"AA=="}',
      nonce: await issueNonce(env.SALES_DB, actor, 100),
      probeId: "probe",
    },
    100,
  );
  expect(result.jobId).toBe("install");
  expect(
    await env.SALES_DB.prepare(
      "SELECT node_id,state,credentials_expire_at FROM installation_jobs WHERE id='install'",
    ).first(),
  ).toMatchObject({
    node_id: "node",
    state: "queued",
    credentials_expire_at: 1000,
  });
  expect(
    await env.SALES_DB.prepare("SELECT COUNT(*) n FROM nodes").first("n"),
  ).toBe(1);
});
test("a probe is consumed after enrollment, even if installation fails quickly", async () => {
  const actor = { telegramId: "9", role: "admin" as const },
    fingerprint = "SHA256:" + "a".repeat(43);
  await env.SALES_DB.prepare(
    "INSERT INTO installation_jobs(id,kind,user_id,target_ip,port,fingerprint,state,created_at,expires_at) VALUES('probe','probe','9','51.21.199.245',22,?,'ready',100,400)",
  )
    .bind(fingerprint)
    .run();
  const input = {
    targetIp: "51.21.199.245",
    port: 22,
    username: "ubuntu",
    name: "new",
    hostFingerprint: fingerprint,
    encryptedCredentials: '{"v":1,"key":"AA==","iv":"AA==","data":"AA=="}',
    nonce: await issueNonce(env.SALES_DB, actor, 100),
    probeId: "probe",
  };
  const result = await createEnrollment(e, actor, input, 100);
  await env.SALES_DB.prepare(
    "UPDATE installation_jobs SET state='failed' WHERE id=?",
  )
    .bind(result.jobId)
    .run();
  await expect(
    createEnrollment(
      e,
      actor,
      { ...input, nonce: await issueNonce(env.SALES_DB, actor, 101) },
      101,
    ),
  ).rejects.toThrow("FINGERPRINT_UNCONFIRMED");
});
