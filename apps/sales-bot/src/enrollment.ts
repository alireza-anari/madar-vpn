import { admin, type Actor } from "./contracts";
import { hash } from "./crypto";
import { publicTarget, validatePort } from "./targets";
export type EnrollmentInput = {
  targetIp: string;
  port: number;
  username: string;
  name: string;
  hostFingerprint: string;
  encryptedCredentials: string;
  nonce: string;
  probeId?: string;
};
export async function issueNonce(db: D1Database, actor: Actor, now: number) {
  admin(actor);
  const nonce = crypto.randomUUID();
  await db
    .prepare("INSERT INTO admin_nonces(hash,user_id,expires_at) VALUES(?,?,?)")
    .bind(hash(nonce), actor.telegramId, now + 300)
    .run();
  return nonce;
}
async function consumeNonce(
  db: D1Database,
  actor: Actor,
  nonce: string,
  now: number,
) {
  const r = await db
    .prepare(
      "DELETE FROM admin_nonces WHERE hash=? AND user_id=? AND expires_at>=?",
    )
    .bind(hash(nonce), actor.telegramId, now)
    .run();
  if (!r.meta.changes) throw new Error("NONCE_REPLAY");
}
export async function createProbe(
  env: Env,
  actor: Actor,
  input: { targetIp: string; port: number; nonce: string },
  now: number,
) {
  admin(actor);
  const ip = publicTarget(input.targetIp);
  validatePort(input.port);
  await consumeNonce(env.SALES_DB, actor, input.nonce, now);
  const id = crypto.randomUUID();
  await env.SALES_DB.prepare(
    "INSERT INTO installation_jobs(id,kind,user_id,target_ip,port,created_at,expires_at) VALUES(?,'probe',?,?,?,?,?)",
  )
    .bind(id, actor.telegramId, ip, input.port, now, now + 300)
    .run();
  return { jobId: id };
}
export async function createEnrollment(
  env: Env,
  actor: Actor,
  input: EnrollmentInput,
  now: number,
) {
  admin(actor);
  const ip = publicTarget(input.targetIp);
  validatePort(input.port);
  if (
    !/^[a-z_][a-z0-9_-]{0,31}$/.test(input.username) ||
    !input.name.trim() ||
    input.name.length > 80
  )
    throw new Error("INVALID_INPUT");
  const probe = await env.SALES_DB.prepare(
    "SELECT fingerprint FROM installation_jobs WHERE id=? AND kind='probe' AND state='ready' AND user_id=? AND target_ip=? AND port=? AND expires_at>=?",
  )
    .bind(input.probeId || "", actor.telegramId, ip, input.port, now)
    .first<{ fingerprint: string }>();
  if (
    !probe ||
    probe.fingerprint !== input.hostFingerprint ||
    !/^SHA256:[A-Za-z0-9+/]{43}$/.test(input.hostFingerprint)
  )
    throw new Error("FINGERPRINT_UNCONFIRMED");
  if (input.encryptedCredentials.length > 20000)
    throw new Error("INVALID_CIPHERTEXT");
  const encrypted: unknown = JSON.parse(input.encryptedCredentials);
  if (
    typeof encrypted !== "object" ||
    encrypted === null ||
    !("v" in encrypted) ||
    encrypted.v !== 1 ||
    !["key", "iv", "data"].every(
      (k) =>
        k in encrypted &&
        typeof (encrypted as Record<string, unknown>)[k] === "string" &&
        /^[A-Za-z0-9+/]+=*$/.test(
          String((encrypted as Record<string, unknown>)[k]),
        ),
    )
  )
    throw new Error("INVALID_CIPHERTEXT");
  await consumeNonce(env.SALES_DB, actor, input.nonce, now);
  const existing = await env.SALES_DB.prepare(
    "SELECT j.id,j.node_id,j.user_id,j.port,j.username,j.fingerprint,j.state FROM installation_jobs j JOIN nodes n ON n.id=j.node_id WHERE n.target_ip=? AND j.kind='install' ORDER BY j.created_at DESC LIMIT 1",
  )
    .bind(ip)
    .first<{
      id: string;
      node_id: string;
      user_id: string;
      port: number;
      username: string;
      fingerprint: string;
      state: string;
    }>();
  if (existing) {
    if (
      existing.state !== "failed" ||
      existing.user_id !== actor.telegramId ||
      existing.port !== input.port ||
      existing.username !== input.username ||
      existing.fingerprint !== input.hostFingerprint
    )
      throw new Error("EXISTING_NODE");
    const results = await env.SALES_DB.batch([
      env.SALES_DB.prepare(
        "UPDATE installation_jobs SET state='queued',safe_code=NULL,encrypted_credentials=?,credentials_expire_at=?,expires_at=?,lease_id=NULL,lease_until=0,runner_id=NULL WHERE id=? AND state='failed'",
      ).bind(input.encryptedCredentials, now + 900, now + 900, existing.id),
      env.SALES_DB.prepare(
        "UPDATE nodes SET name=?,state='installing',healthy=0 WHERE id=? AND EXISTS(SELECT 1 FROM installation_jobs WHERE id=? AND state='queued')",
      ).bind(input.name, existing.node_id, existing.id),
      env.SALES_DB.prepare(
        "INSERT INTO audit_events(actor_id,action,target_id,created_at) VALUES(?,'retry_enroll_node',?,?)",
      ).bind(actor.telegramId, existing.node_id, now),
      env.SALES_DB.prepare(
        "UPDATE installation_jobs SET expires_at=? WHERE id=? AND kind='probe'",
      ).bind(now - 1, input.probeId!),
    ]);
    if (!results[0]?.meta.changes) throw new Error("EXISTING_NODE");
    return { jobId: existing.id };
  }
  const nodeId = crypto.randomUUID(),
    jobId = crypto.randomUUID();
  await env.SALES_DB.batch([
    env.SALES_DB.prepare(
      "UPDATE installation_jobs SET expires_at=? WHERE id=? AND kind='probe'",
    ).bind(now - 1, input.probeId!),
    env.SALES_DB.prepare(
      "INSERT INTO nodes(id,name,target_ip) VALUES(?,?,?)",
    ).bind(nodeId, input.name, ip),
    env.SALES_DB.prepare(
      "INSERT INTO installation_jobs(id,node_id,kind,user_id,target_ip,port,username,fingerprint,encrypted_credentials,credentials_expire_at,created_at,expires_at) VALUES(?,?,'install',?,?,?,?,?,?,?,?,?)",
    ).bind(
      jobId,
      nodeId,
      actor.telegramId,
      ip,
      input.port,
      input.username,
      input.hostFingerprint,
      input.encryptedCredentials,
      now + 900,
      now,
      now + 900,
    ),
    env.SALES_DB.prepare(
      "INSERT INTO audit_events(actor_id,action,target_id,created_at) VALUES(?,'enroll_node',?,?)",
    ).bind(actor.telegramId, nodeId, now),
  ]);
  return { jobId };
}
export async function cleanupCredentials(db: D1Database, now: number) {
  await db.batch([
    db
      .prepare(
        "UPDATE installation_jobs SET state='failed',safe_code='JOB_EXPIRED',encrypted_credentials=NULL,lease_until=0 WHERE expires_at<=? AND state NOT IN ('ready','failed')",
      )
      .bind(now),
    db
      .prepare(
        "UPDATE installation_jobs SET encrypted_credentials=NULL,state='failed',safe_code='CREDENTIALS_EXPIRED',lease_until=0 WHERE encrypted_credentials IS NOT NULL AND credentials_expire_at<=? AND state!='ready'",
      )
      .bind(now),
    db.prepare(
      "UPDATE installation_jobs SET encrypted_credentials=NULL WHERE state IN ('ready','failed')",
    ),
    db.prepare("DELETE FROM admin_nonces WHERE expires_at<?").bind(now),
  ]);
}
