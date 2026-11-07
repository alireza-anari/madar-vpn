import { env } from "cloudflare:workers";
import { beforeEach, expect, test } from "vitest";
import { hash } from "../src/crypto";
import { acceptSecondaryAck, readConfirmedSecondaryPorts } from "../src/managed-secondary";
import { nodeApi } from "../src/node-api";
import { resetDb } from "./db";
import m1 from "../migrations/0001.sql?raw";
import m2 from "../migrations/0002.sql?raw";
import m3 from "../migrations/0003.sql?raw";
import m4 from "../migrations/0004-reseller-accounts.sql?raw";
import m19 from "../migrations/0019-managed-vision-optin.sql?raw";

const TOKEN = "a".repeat(48);
const now = 100;
const ports = [2053,8443];
const NODE = "n";

beforeEach(async () => {
  await resetDb();
  for (const m of [m1,m2,m3,m4,m19]) await env.SALES_DB.exec(m);
  const policy = {
    version: 2, nodeId: NODE, revision: 5, expiresAt: 400,
    clients: [], realityAltPorts: ports,
  };
  await env.SALES_DB.prepare(
    "INSERT INTO nodes(id,name,target_ip,vpn_port,state,revision,acked_revision,last_seen,healthy,public_key,short_id,sni,token_hash,policy_key,policy_payload,agent_capabilities) VALUES('n','Madar','8.8.8.8',443,'ready',5,5,100,1,?,'1234567890abcdef','www.cloudflare.com',?,?,?,'quota-v2,per-account-process,shared-443')",
  ).bind("A".repeat(43),hash(TOKEN),"f".repeat(64),JSON.stringify(policy)).run();
  for (const [suffix, value] of [
    ["enabled","1"], ["reachability_confirmed","1"],
    ["ports",JSON.stringify(ports)],
  ]) {
    await env.SALES_DB.prepare("INSERT INTO settings(key,value) VALUES(?,?)")
      .bind("managed_reality_alt:n:"+suffix,value).run();
  }
});

test("signed policy approved sidecar expires independently of primary ACK", async () => {
  expect(await readConfirmedSecondaryPorts(env.SALES_DB,NODE,5,100)).toBeNull();
  await acceptSecondaryAck(env.SALES_DB,NODE,{revision:5,ports,healthy:true},now);
  expect(await readConfirmedSecondaryPorts(env.SALES_DB,NODE,5,100)).toEqual(ports);
  expect(await readConfirmedSecondaryPorts(env.SALES_DB,NODE,5,119)).toEqual(ports);
  expect(await readConfirmedSecondaryPorts(env.SALES_DB,NODE,5,120)).toBeNull();
  expect(await readConfirmedSecondaryPorts(env.SALES_DB,NODE,6,105)).toBeNull();
  expect(await readConfirmedSecondaryPorts(env.SALES_DB,"wrong",5,105)).toBeNull();
});

test("stale, tampered or disabled alternative can never ACK itself", async () => {
  for (const bad of [
    {revision:4,ports,healthy:true},
    {revision:5,ports:[443],healthy:true},
    {revision:5,ports:[8443],healthy:true},
    {revision:5,ports,healthy:false},
    {revision:5,ports,healthy:"yes"},
  ]) {
    await expect(acceptSecondaryAck(env.SALES_DB,NODE,bad,now)).rejects.toThrow();
  }
  await env.SALES_DB.exec("UPDATE settings SET value='0' WHERE key='managed_reality_alt:n:enabled'");
  await expect(acceptSecondaryAck(
    env.SALES_DB,NODE,{revision:5,ports,healthy:true},now,
  )).rejects.toThrow("SECONDARY_NOT_APPROVED");
});

test("untrusted requests cannot forge secondary readiness", async () => {
  const req = new Request("https://madar.example.com/api/node/secondary-ack",{
    method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({revision:5,ports,healthy:true}),
  });
  expect((await nodeApi(req,env,now)).status).toBe(401);
  const authorized = new Request(req,{
    headers:{"Authorization":"Bearer "+TOKEN,"Content-Type":"application/json"},
  });
  // Authenticated token is necessary, but the existing production quota-mode
  // gate must also allow the endpoint.
  await env.SALES_DB.prepare("INSERT INTO settings(key,value) VALUES('quota_protocol_enabled','1')").run();
  expect((await nodeApi(authorized,env,now)).status).toBe(200);
  expect(await readConfirmedSecondaryPorts(env.SALES_DB,NODE,5,now)).toEqual(ports);
});

test("node health, primary ACK and policy expiration are separate hard gates", async () => {
  for (const changes of [
    "healthy=0", "last_seen=1", "acked_revision=4", "revision=6",
  ]) {
    await env.SALES_DB.exec("UPDATE nodes SET "+changes+" WHERE id='n'");
    await expect(acceptSecondaryAck(env.SALES_DB,NODE,{revision:5,ports,healthy:true},100))
      .rejects.toThrow();
    await env.SALES_DB.exec("UPDATE nodes SET healthy=1,last_seen=100,acked_revision=5,revision=5 WHERE id='n'");
  }
  await expect(acceptSecondaryAck(env.SALES_DB,NODE,{revision:5,ports,healthy:true},401))
    .rejects.toThrow();
});
