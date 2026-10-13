import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { PgDatabase } from '../src/postgres/client';
import { PostgresPolicyPublisher } from '../src/nodes/policy-postgres';
import { PostgresNodeControlStore } from '../src/nodes/postgres';
import { PostgresSubscriptionNodeStore } from '../src/access/subscription-postgres';
const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error('TEST_DATABASE_URL is required.');
const client = new Client({ connectionString });
const db = new PgDatabase(client);
const now = new Date('2026-10-13T18:00:00Z');
beforeAll(async () => { await client.connect(); });
afterAll(async () => { await client.end(); });
beforeEach(async () => {
  await client.query('TRUNCATE users, nodes CASCADE');
  await client.query('UPDATE app_settings SET free_speed_kbps=5000 WHERE id=1');
  await client.query(`INSERT INTO users(id,email,role,verified_at) VALUES ('admin-pub','admin-pub@example.test','admin',$1),('free-pub','free-pub@example.test','user',$1),('premium-pub','premium-pub@example.test','user',$1)`, [now]);
  await client.query(`INSERT INTO nodes(id,name,status,created_at) VALUES ('node-pub','Publication test','enrolled',$1)`, [now]);
  await client.query(`INSERT INTO node_credentials(id,node_id,credential_hash,created_at) VALUES ('cred-pub','node-pub','test-hash-only',$1)`, [now]);
  for (const label of ['free-pub', 'premium-pub']) {
    await client.query(`INSERT INTO access_profiles(id,user_id,policy_revision,created_at) VALUES ($1,$1,4,$2)`, [label, now]);
    await client.query(`INSERT INTO client_credentials(id,user_id,uuid,version,created_at) VALUES ($1,$1,$2,1,$3)`, [label, `fixture-${label}`, now]);
  }
  await client.query(`INSERT INTO credit_ledger(unique_key,user_id,kind,free_day,delta_seconds,occurred_at) VALUES ('grant-pub','free-pub','initial','2026-10-13',1800,$1)`, [now]);
  await client.query(`INSERT INTO memberships(user_id,premium_until) VALUES ('premium-pub','2026-10-13T19:00:00Z')`);
});
describe('real PostgreSQL policy publication', () => {
  it('atomically compiles authoritative clients, audits safely, and remains unacknowledged until real ACK', async () => {
    const publisher = new PostgresPolicyPublisher(db);
    const result = await publisher.publish('admin-pub','node-pub',{ mode:'current',ttlSeconds:7200 },now);
    expect(result).toMatchObject({ revision:1,clientCount:2,validUntil:'2026-10-13T19:00:00.000Z' });
    const store = new PostgresNodeControlStore(db);
    const policy = await store.getPolicy('node-pub');
    expect(policy!.clients).toEqual(expect.arrayContaining([expect.objectContaining({userId:'free-pub',tier:'free',speedKbps:5000}),expect.objectContaining({userId:'premium-pub',tier:'premium',speedKbps:null})]));
    expect((await client.query('SELECT acked_at FROM node_policy_revisions')).rows[0].acked_at).toBeNull();
    await store.acknowledgePolicy('node-pub',1,now.toISOString(),policy!.clients);
    expect((await client.query('SELECT count(*)::int AS n FROM node_policy_acks')).rows[0].n).toBe(2);
    const audit=(await client.query(`SELECT details_json FROM audit_log WHERE action='node.policy.publish'`)).rows[0].details_json;
    expect(audit).toEqual({nodeId:'node-pub',revision:1,mode:'current',clientCount:2,validUntil:result.validUntil});
    expect(JSON.stringify(audit)).not.toContain('fixture-');
  });
  it('supports safe empty policy and excludes suspended/revoked/exhausted accounts', async () => {
    await client.query(`UPDATE users SET suspended_at=$1 WHERE id='free-pub'`,[now]);
    await client.query(`UPDATE client_credentials SET revoked_at=$1 WHERE user_id='premium-pub'`,[now]);
    const publisher = new PostgresPolicyPublisher(db);
    expect((await publisher.publish('admin-pub','node-pub',{mode:'current',ttlSeconds:60},now)).clientCount).toBe(0);
    expect((await publisher.publish('admin-pub','node-pub',{mode:'empty',ttlSeconds:7200},now)).revision).toBe(2);
    expect((await new PostgresNodeControlStore(db).getPolicy('node-pub'))!.clients).toEqual([]);
  });
  it('serializes concurrent publications on separate connections', async () => {
    const other = new Client({connectionString}); await other.connect();
    try {
      const results=await Promise.all([new PostgresPolicyPublisher(db).publish('admin-pub','node-pub',{mode:'empty',ttlSeconds:60},now),new PostgresPolicyPublisher(new PgDatabase(other)).publish('admin-pub','node-pub',{mode:'empty',ttlSeconds:60},now)]);
      expect(results.map(r=>r.revision).sort()).toEqual([1,2]);
    } finally { await other.end(); }
  });
  it('withholds previous user ACKs on publication and rejects a late ACK of the superseded revision', async () => {
    const publisher=new PostgresPolicyPublisher(db);const store=new PostgresNodeControlStore(db);
    await publisher.publish('admin-pub','node-pub',{mode:'current',ttlSeconds:7200},now);
    const oldPolicy=(await store.getPolicy('node-pub'))!;
    await store.acknowledgePolicy('node-pub',1,now.toISOString(),oldPolicy.clients);
    await publisher.publish('admin-pub','node-pub',{mode:'empty',ttlSeconds:7200},now);
    expect((await client.query('SELECT count(*)::int AS n FROM node_policy_acks')).rows[0].n).toBe(0);
    await expect(store.acknowledgePolicy('node-pub',1,now.toISOString(),oldPolicy.clients)).rejects.toThrow();
    expect((await client.query('SELECT count(*)::int AS n FROM node_policy_acks')).rows[0].n).toBe(0);
  });
  it('rejects retired nodes and rolls back publication when audit storage fails', async () => {
    await client.query(`UPDATE node_credentials SET revoked_at=$1`,[now]);
    await expect(new PostgresPolicyPublisher(db).publish('admin-pub','node-pub',{mode:'current',ttlSeconds:60},now)).rejects.toThrow();
    expect((await client.query('SELECT count(*)::int AS n FROM node_policy_revisions')).rows[0].n).toBe(0);
    await client.query('UPDATE node_credentials SET revoked_at=NULL');
    // The actor must be a real active administrator; no policy may survive rejection.
    await expect(new PostgresPolicyPublisher(db).publish('free-pub','node-pub',{mode:'empty',ttlSeconds:60},now)).rejects.toThrow();
    expect((await client.query('SELECT count(*)::int AS n FROM node_policy_revisions')).rows[0].n).toBe(0);
    const failingAuditDatabase = new PgDatabase({ query: async (text, values) => {
      if (text.includes('INSERT INTO audit_log')) throw new Error('injected audit storage failure');
      return db.query(text, values);
    } });
    await expect(new PostgresPolicyPublisher(failingAuditDatabase).publish('admin-pub','node-pub',{mode:'empty',ttlSeconds:60},now)).rejects.toThrow('injected audit storage failure');
    expect((await client.query('SELECT count(*)::int AS n FROM node_policy_revisions')).rows[0].n).toBe(0);
  });
  it('excludes an expired ACKed publication even while node heartbeat remains fresh', async () => {
    const publisher=new PostgresPolicyPublisher(db);const store=new PostgresNodeControlStore(db);
    await publisher.publish('admin-pub','node-pub',{mode:'current',ttlSeconds:7200},now);
    const policy=(await store.getPolicy('node-pub'))!;
    await store.acknowledgePolicy('node-pub',1,now.toISOString(),policy.clients);
    await client.query(`UPDATE node_policy_revisions SET valid_until=clock_timestamp()+interval '1 hour'`);
    const subscriptions=new PostgresSubscriptionNodeStore(db);
    expect((await subscriptions.listCandidates('free-pub'))[0]!.ackedRevision).toBe(4);
    await client.query(`UPDATE node_policy_revisions SET valid_until=clock_timestamp()-interval '1 second'`);
    expect((await subscriptions.listCandidates('free-pub'))[0]!.ackedRevision).toBeNull();
  });
  it('rejects an ACK that waits behind the node lock until after expiry', async () => {
    await new PostgresPolicyPublisher(db).publish('admin-pub','node-pub',{mode:'empty',ttlSeconds:60},now);
    const blocker=new Client({connectionString});await blocker.connect();
    try {
      await blocker.query('BEGIN');await blocker.query(`SELECT id FROM nodes WHERE id='node-pub' FOR UPDATE`);
      await blocker.query(`UPDATE node_policy_revisions SET valid_until=clock_timestamp()+interval '500 milliseconds'`);
      const result=new PostgresNodeControlStore(db).acknowledgePolicy('node-pub',1,new Date().toISOString(),[]).then(()=>false,()=>true);
      await blocker.query('SELECT pg_sleep(0.8)');await blocker.query('COMMIT');
      expect(await result).toBe(true);
    } finally {await blocker.query('ROLLBACK');await blocker.end();}
  });
  it('reads the committed ledger balance after waiting for settlement user locks', async () => {
    const pid=(await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const blocker=new Client({connectionString});await blocker.connect();
    try {
      await blocker.query('BEGIN');await blocker.query(`SELECT id FROM users WHERE id='free-pub' FOR UPDATE`);
      const publication=new PostgresPolicyPublisher(db).publish('admin-pub','node-pub',{mode:'current',ttlSeconds:60},now);
      let waiting=false;
      for(let attempt=0;attempt<100;attempt++) {
        waiting=(await blocker.query(`SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=$1`,[pid])).rows[0]?.waiting===true;
        if(waiting)break;await new Promise(resolve=>setTimeout(resolve,20));
      }
      expect(waiting).toBe(true);
      await blocker.query(`INSERT INTO credit_ledger(unique_key,user_id,kind,free_day,delta_seconds,occurred_at) VALUES ('debit-race','free-pub','usage','2026-10-13',-1800,$1)`,[now]);
      await blocker.query('COMMIT');await publication;
      const policy=(await new PostgresNodeControlStore(db).getPolicy('node-pub'))!;
      expect(policy.clients.some(candidate=>candidate.userId==='free-pub')).toBe(false);
    } finally {await blocker.query('ROLLBACK');await blocker.end();}
  });
});
