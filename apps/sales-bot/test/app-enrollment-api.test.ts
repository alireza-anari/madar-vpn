import { createHmac } from "node:crypto";
import { env } from "cloudflare:workers";
import { beforeEach, expect, test } from "vitest";
import { resetDb } from "./db";
import m1 from "../migrations/0001.sql?raw";
import m2 from "../migrations/0002.sql?raw";
import m3 from "../migrations/0003.sql?raw";
import m4 from "../migrations/0004-reseller-accounts.sql?raw";
import m7 from "../migrations/0007-node-capacity.sql?raw";
import m9 from "../migrations/0009-node-allocation-cap.sql?raw";
import m11 from "../migrations/0011-node-account-slot-mode.sql?raw";
import { appApi } from "../src/app-api";
import { adminApi } from "../src/admin-api";

const now = 100;
const token = "test-token";
const e = {
  ...env,
  BOT_TOKEN: token,
  ADMIN_TELEGRAM_IDS: "9",
  RUNNER_PUBLIC_KEY: "",
} as Env;

function signed(id: number, date = now) {
  const p = new URLSearchParams({
    auth_date: String(date),
    user: JSON.stringify({ id }),
    query_id: `query-${id}`,
  });
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const value = [...p.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
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
  for (const sql of [m1, m2, m3, m4, m7, m9, m11])
    await env.SALES_DB.exec(sql);
  await env.SALES_DB.exec(
    "INSERT INTO resellers(telegram_id,enabled,created_at) VALUES('10',1,1);",
  );
});

test("seller is denied for every Mini App enrollment route before any nonce, credential or job write", async () => {
  const attempts: Array<[string, unknown?]> = [
    ["/api/app/admin/enrollment/session"],
    ["/api/app/admin/enrollment/probe", { targetIp: "51.21.199.245", port: 22, nonce: "x" }],
    [
      "/api/app/admin/enrollment/enroll",
      {
        targetIp: "51.21.199.245",
        port: 22,
        username: "ubuntu",
        name: "blocked",
        maxAllocatedGb: 100,
        hostFingerprint: "SHA256:" + "a".repeat(43),
        encryptedCredentials: '{"v":1,"key":"AA==","iv":"AA==","data":"AA=="}',
        nonce: "x",
        probeId: "missing",
      },
    ],
    ["/api/app/admin/enrollment/jobs/missing"],
  ];
  for (const [path, data] of attempts) {
    const response = await appApi(request(path, 10, data), e, now);
    expect(response.status, path).toBe(403);
    expect(await response.json(), path).toEqual({ error: "ADMIN_REQUIRED" });
  }
  expect(
    await env.SALES_DB.prepare("SELECT COUNT(*) n FROM admin_nonces").first("n"),
  ).toBe(0);
  expect(
    await env.SALES_DB.prepare("SELECT COUNT(*) n FROM installation_jobs").first("n"),
  ).toBe(0);
  expect(await env.SALES_DB.prepare("SELECT COUNT(*) n FROM nodes").first("n")).toBe(0);
});

test("Mini App admin can issue session, probe, enroll, and read the owned job without exposing raw credentials", async () => {
  const session = await appApi(request("/api/app/admin/enrollment/session", 9), e, now);
  expect(session.status).toBe(200);
  expect(session.headers.get("Cache-Control")).toBe("no-store");
  const sessionBody = (await session.json()) as any;
  expect(sessionBody.nonce).toBeTruthy();
  expect(sessionBody.publicKey).toBeNull();

  const probe = await appApi(
    request("/api/app/admin/enrollment/probe", 9, {
      targetIp: "51.21.199.245",
      port: 22,
      nonce: sessionBody.nonce,
    }),
    e,
    now,
  );
  expect(probe.status).toBe(200);
  const probeBody = (await probe.json()) as any;
  expect(probeBody.jobId).toBeTruthy();

  const fingerprint = "SHA256:" + "a".repeat(43);
  await env.SALES_DB.prepare(
    "UPDATE installation_jobs SET state='ready',fingerprint=? WHERE id=?",
  )
    .bind(fingerprint, probeBody.jobId)
    .run();

  const secondSession = await appApi(
    request("/api/app/admin/enrollment/session", 9),
    e,
    now,
  );
  const secondNonce = ((await secondSession.json()) as any).nonce;
  const encrypted = '{"v":1,"key":"AA==","iv":"AA==","data":"AA=="}';
  const enroll = await appApi(
    request("/api/app/admin/enrollment/enroll", 9, {
      targetIp: "51.21.199.245",
      port: 22,
      username: "ubuntu",
      name: "Mini App VPS",
      maxAccounts: 25,
      maxAllocatedGb: 500,
      hostFingerprint: fingerprint,
      encryptedCredentials: encrypted,
      nonce: secondNonce,
      probeId: probeBody.jobId,
    }),
    e,
    now,
  );
  expect(enroll.status).toBe(200);
  const enrollBody = (await enroll.json()) as any;
  expect(enrollBody.jobId).toBeTruthy();

  const job = await appApi(
    request(`/api/app/admin/enrollment/jobs/${enrollBody.jobId}`, 9),
    e,
    now,
  );
  expect(job.status).toBe(200);
  const jobText = await job.text();
  expect(jobText).toContain(enrollBody.jobId);
  expect(jobText).not.toContain(encrypted);
  expect(jobText).not.toContain("encrypted_credentials");

  const stored = await env.SALES_DB.prepare(
    "SELECT encrypted_credentials,credentials_expire_at,state FROM installation_jobs WHERE id=?",
  )
    .bind(enrollBody.jobId)
    .first<any>();
  expect(stored).toMatchObject({
    encrypted_credentials: encrypted,
    credentials_expire_at: 1000,
    state: "queued",
  });
});

test("Mini App enrollment preserves stable validation codes and owned-job 404", async () => {
  let response = await appApi(
    request("/api/app/admin/enrollment/probe", 9, {
      targetIp: "127.0.0.1",
      port: 22,
      nonce: "irrelevant",
    }),
    e,
    now,
  );
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "INVALID_TARGET" });

  response = await appApi(
    request("/api/app/admin/enrollment/jobs/missing", 9),
    e,
    now,
  );
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: "NOT_FOUND" });
});

test("legacy /api/admin enrollment fallback keeps its existing session, probe and job behavior", async () => {
  const session = await adminApi(request("/api/admin/session", 9), e, now);
  expect(session.status).toBe(200);
  const nonce = ((await session.json()) as any).nonce;
  expect(nonce).toBeTruthy();

  const probe = await adminApi(
    request("/api/admin/probe", 9, {
      targetIp: "51.21.199.245",
      port: 22,
      nonce,
    }),
    e,
    now,
  );
  expect(probe.status).toBe(200);
  const jobId = ((await probe.json()) as any).jobId;
  expect(jobId).toBeTruthy();

  const job = await adminApi(request(`/api/admin/jobs/${jobId}`, 9), e, now);
  expect(job.status).toBe(200);
  expect(await job.json()).toMatchObject({ id: jobId, kind: "probe", state: "queued" });
});
