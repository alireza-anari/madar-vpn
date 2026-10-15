import { env } from "cloudflare:workers";
import { beforeEach, expect, test } from "vitest";
import { resetDb } from "./db";
import b from "../migrations/0001.sql?raw";
import s from "../migrations/0002.sql?raw";
import n from "../migrations/0003.sql?raw";
import { leaseJob, reportJob } from "../src/runner-api";
import { cleanupCredentials } from "../src/enrollment";
beforeEach(async () => {
  await resetDb();
  for (const sql of [b, s, n]) await env.SALES_DB.exec(sql);
  await env.SALES_DB.prepare(
    "INSERT INTO installation_jobs(id,kind,user_id,target_ip,port,created_at,expires_at) VALUES('p','probe','9','51.21.199.245',22,100,400)",
  ).run();
});
test("one target lease issued to one runner", async () => {
  const r = await Promise.all([
    leaseJob(env, "a", 100),
    leaseJob(env, "b", 100),
  ]);
  expect(r.filter(Boolean)).toHaveLength(1);
  expect(r.find(Boolean)?.leaseUntil).toBe(220);
});
test("expired lease cannot report ready", async () => {
  const job = await leaseJob(env, "a", 100);
  await expect(
    reportJob(env, job!.id, job!.leaseId, "ready", "OK", 221, {
      fingerprint: "SHA256:" + "a".repeat(43),
    }),
  ).rejects.toThrow("LEASE_EXPIRED");
});
test("ciphertext expired after crash is deleted", async () => {
  await env.SALES_DB.prepare(
    "UPDATE installation_jobs SET kind='install',encrypted_credentials='canary',credentials_expire_at=99",
  ).run();
  await cleanupCredentials(env.SALES_DB, 100);
  expect(await leaseJob(env, "a", 100)).toBeNull();
  expect(
    await env.SALES_DB.prepare(
      "SELECT encrypted_credentials FROM installation_jobs WHERE id='p'",
    ).first("encrypted_credentials"),
  ).toBeNull();
});
