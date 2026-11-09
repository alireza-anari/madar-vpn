import { env } from "cloudflare:workers";
import { beforeEach, expect, test } from "vitest";
import { resetDb } from "./db";
import b from "../migrations/0001.sql?raw";
import s from "../migrations/0002.sql?raw";
import n from "../migrations/0003.sql?raw";
import resellerMigration from "../migrations/0004-reseller-accounts.sql?raw";
import { readApprovedRealityPorts, approvedRealityPortsForDelivery } from "../src/managed-reality-ports";
import { buildQuotaPolicy } from "../src/quota-policies";
import { leaseJob, reportJob } from "../src/runner-api";
import { readManagedWsRollout } from "../src/alternate-transport";
import { cleanupCredentials } from "../src/enrollment";
beforeEach(async () => {
  await resetDb();
  for (const sql of [b, s, n, resellerMigration]) await env.SALES_DB.exec(sql);
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


async function freshInstallFixture() {
  await env.SALES_DB.prepare(
    "INSERT INTO settings(key,value) VALUES('app_mode','reseller')",
  ).run();
  await env.SALES_DB.prepare(
    "INSERT INTO nodes(id,name,target_ip,state,revision,acked_revision,agent_capabilities) VALUES('n','new','8.8.8.8','verifying',0,0,'')",
  ).run();
  await env.SALES_DB.prepare(
    "INSERT INTO installation_jobs(id,node_id,kind,user_id,target_ip,port,state,lease_id,lease_until,created_at,expires_at) VALUES('i','n','install','9','8.8.8.8',22,'verifying','lease',220,99,400)",
  ).run();
}
const installed = {
  installed:true, freshInstall:true, protocolVersion:2,
  autoRealityPorts:[2053,8443],
};

test("fresh v2 server automatically enables 443 and optional ports under one signed metered policy", async () => {
  await freshInstallFixture();
  await reportJob(env,"i","lease","ready","INSTALLED",100,installed);
  expect(await readApprovedRealityPorts(env.SALES_DB,"n")).toEqual([2053,8443]);
  const flag=await env.SALES_DB.prepare(
    "SELECT value FROM settings WHERE key='managed_reality_alt:n:auto_installed'",
  ).first<string>("value");
  expect(flag).toBe("1");
  const policy=await buildQuotaPolicy(env.SALES_DB,"n",101);
  expect(policy.realityAltPorts).toEqual([2053,8443]);
  const liveNode={
    id:"n",state:"ready",revision:policy.revision,
    acked_revision:policy.revision,healthy:1,last_seen:101,
    agent_capabilities:"quota-v2,per-account-process,shared-443",
  };
  expect(approvedRealityPortsForDelivery(liveNode,policy,[2053,8443],101)).toEqual([]);
  expect(approvedRealityPortsForDelivery(
    {...liveNode,agent_capabilities:liveNode.agent_capabilities+",reality-alt-metered"},
    policy,[2053,8443],101,
  )).toEqual([2053,8443]);
});

test("legacy or recovered servers cannot silently activate new public listeners", async () => {
  for(const modified of [
    {...installed,freshInstall:false},
    {...installed,protocolVersion:1},
    {...installed,autoRealityPorts:[8443]},
    {installed:true},
  ]) {
    await resetDb();
    for(const sql of [b,s,n,resellerMigration]) await env.SALES_DB.exec(sql);
    await freshInstallFixture();
    await reportJob(env,"i","lease","ready","INSTALLED",100,modified);
    expect(await readApprovedRealityPorts(env.SALES_DB,"n")).toBeNull();
  }
});

test("previous completed install and admin-disabled rollout are never overwritten", async () => {
  await freshInstallFixture();
  await env.SALES_DB.prepare(
    "INSERT INTO settings(key,value) VALUES('managed_reality_alt:n:enabled','0')",
  ).run();
  await reportJob(env,"i","lease","ready","INSTALLED",100,installed);
  expect(await readApprovedRealityPorts(env.SALES_DB,"n")).toBeNull();
  expect(await env.SALES_DB.prepare(
    "SELECT value FROM settings WHERE key='managed_reality_alt:n:enabled'",
  ).first<string>("value")).toBe("0");
  await resetDb();
  for(const sql of [b,s,n,resellerMigration]) await env.SALES_DB.exec(sql);
  await freshInstallFixture();
  await env.SALES_DB.prepare(
    "INSERT INTO installation_jobs(id,node_id,kind,user_id,target_ip,port,state,created_at,expires_at) VALUES('old','n','install','9','8.8.8.8',22,'ready',1,400)",
  ).run();
  await reportJob(env,"i","lease","ready","INSTALLED",100,installed);
  expect(await readApprovedRealityPorts(env.SALES_DB,"n")).toBeNull();
});

test("no automatic listeners when sales quota mode is disabled", async () => {
  await freshInstallFixture();
  await env.SALES_DB.prepare("UPDATE settings SET value='legacy' WHERE key='app_mode'").run();
  await reportJob(env,"i","lease","ready","INSTALLED",100,installed);
  expect(await readApprovedRealityPorts(env.SALES_DB,"n")).toBeNull();
});

test("fresh real IP-cert install auto publishes precisely its own metered WSS 2087 endpoint", async () => {
  await freshInstallFixture();
  await reportJob(env,"i","lease","ready","INSTALLED",100,{
    ...installed,
    autoWssVerified:true,autoWssIp:"8.8.8.8",
    autoWssPort:2087,autoWssPath:"/madar-"+"a".repeat(24),
  });
  const approved = await readManagedWsRollout(env.SALES_DB,"n");
  expect(approved).toEqual({
    type:"vmess-ws-aead", hostname:"8.8.8.8",
    port:2087,path:"/madar-"+"a".repeat(24),
  });
  const policy = await buildQuotaPolicy(env.SALES_DB,"n",101);
  expect(policy.wsFallback).toEqual(approved);
  const auto = await env.SALES_DB.prepare(
    "SELECT value FROM settings WHERE key='managed_ws:n:auto_installed'",
  ).first<string>("value");
  expect(auto).toBe("1");
});

test("forged/mismatched IP-cert report cannot enable WSS on any node", async () => {
  const good = {
    ...installed, autoWssVerified:true,
    autoWssIp:"8.8.8.8",autoWssPort:2087,
    autoWssPath:"/madar-"+"b".repeat(24),
  };
  const variants = [
    {...good,autoWssVerified:false},
    {...good,autoWssIp:"1.1.1.1"},
    {...good,autoWssPort:443},
    {...good,autoWssPath:"/"},
    {...good,autoWssPath:"/madar-"+"b".repeat(23)},
    {...good,protocolVersion:1},
    {...good,freshInstall:false},
  ];
  for(const v of variants) {
    await resetDb();
    for(const sql of [b,s,n,resellerMigration]) await env.SALES_DB.exec(sql);
    await freshInstallFixture();
    await reportJob(env,"i","lease","ready","INSTALLED",100,v);
    expect(await readManagedWsRollout(env.SALES_DB,"n")).toBeNull();
    const policy = await buildQuotaPolicy(env.SALES_DB,"n",101);
    expect(policy.wsFallback).toBeUndefined();
  }
});
