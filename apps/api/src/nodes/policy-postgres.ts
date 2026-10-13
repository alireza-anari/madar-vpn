import { tehranDateKey } from '../credits';
import type { PgDatabase } from '../postgres/client';
import { NodeControlError } from './index';
import { compilePolicyClients, parsePublicationRequest, policyValidUntil, type PolicyCandidate, type PolicyPublisher, type PublicationRequest } from './policy';

type CandidateRow = Record<string, unknown> & {
  user_id: string; uuid: string; policy_revision: number; suspended_at: Date | null;
  verified_at: Date | null; free_seconds: string | number; premium_until: Date | string | null;
};
export class PostgresPolicyPublisher implements PolicyPublisher {
  constructor(private readonly db: Pick<PgDatabase, 'transaction'>) {}

  async publish(actorId: string, nodeId: string, input: PublicationRequest, now: Date) {
    const request = parsePublicationRequest(input);
    return this.db.transaction(async transaction => {
      const actor = await transaction.query(`SELECT id FROM users WHERE id=$1 AND role='admin' AND suspended_at IS NULL FOR SHARE`, [actorId]);
      if (!actor.rows.length) throw new NodeControlError(403, 'ADMIN_REQUIRED', 'Active administrator is required.');
      // Lock the persistent node row, not a possibly absent latest policy row.
      // This serializes revision allocation across independent connections.
      const node = await transaction.query('SELECT id FROM nodes WHERE id=$1 FOR UPDATE', [nodeId]);
      if (!node.rows.length) throw new NodeControlError(404, 'NODE_NOT_FOUND', 'Node does not exist.');
      const credential = await transaction.query('SELECT id FROM node_credentials WHERE node_id=$1 AND revoked_at IS NULL', [nodeId]);
      if (!credential.rows.length) throw new NodeControlError(409, 'NODE_RETIRED', 'Node has no active credential.');
      const settings = await transaction.query<{ free_speed_kbps: number }>('SELECT free_speed_kbps FROM app_settings WHERE id=1');
      if (!settings.rows.length) throw new NodeControlError(503, 'NODE_POLICY_SETTINGS_UNAVAILABLE', 'Policy settings are unavailable.');
      let candidates: PolicyCandidate[] = [];
      if (request.mode === 'current') {
        // Settlement locks users before debiting credit. Acquire those locks
        // first, then use a new READ COMMITTED statement snapshot for balances.
        await transaction.query(`SELECT u.id FROM users u
          WHERE EXISTS(SELECT 1 FROM client_credentials c WHERE c.user_id=u.id AND c.revoked_at IS NULL)
          ORDER BY u.id FOR SHARE OF u`);
        const rows = await transaction.query<CandidateRow>(`
          SELECT u.id AS user_id, c.uuid, p.policy_revision, u.suspended_at, u.verified_at,
            m.premium_until,
            COALESCE((SELECT SUM(l.delta_seconds) FROM credit_ledger l WHERE l.user_id=u.id AND l.free_day=$1::date),0) AS free_seconds
          FROM users u
          JOIN client_credentials c ON c.user_id=u.id AND c.revoked_at IS NULL
          JOIN access_profiles p ON p.user_id=u.id
          LEFT JOIN memberships m ON m.user_id=u.id
          ORDER BY u.id
          FOR SHARE OF u,c,p`, [tehranDateKey(now)]);
        candidates = rows.rows.map(row => ({
          userId: row.user_id, clientId: row.uuid, policyRevision: row.policy_revision,
          suspended: row.suspended_at !== null, revoked: false, verified: row.verified_at !== null,
          freeSeconds: Number(row.free_seconds),
          premiumUntil: row.premium_until === null ? null : new Date(row.premium_until).toISOString(),
        }));
      }
      const clients = compilePolicyClients(candidates, settings.rows[0]!.free_speed_kbps, now);
      const validUntil = policyValidUntil(candidates, request.ttlSeconds, now);
      const latest = await transaction.query<{ revision: number }>('SELECT COALESCE(MAX(revision),0)::int AS revision FROM node_policy_revisions WHERE node_id=$1', [nodeId]);
      const revision = latest.rows[0]!.revision + 1;
      await transaction.query(`INSERT INTO node_policy_revisions(node_id,revision,valid_until,policy_json,created_at)
        VALUES($1,$2,$3::timestamptz,$4::jsonb,$5::timestamptz)`, [nodeId, revision, validUntil, JSON.stringify({ clients }), now.toISOString()]);
      await transaction.query('DELETE FROM node_policy_acks WHERE node_id=$1', [nodeId]);
      const metadata = { nodeId, revision, mode: request.mode, clientCount: clients.length, validUntil };
      // Audit and policy commit together; audit failure rolls back the policy.
      await transaction.query(`INSERT INTO audit_log(id,actor_user_id,action,details_json,created_at)
        VALUES($1,$2,'node.policy.publish',$3::jsonb,$4::timestamptz)`, [crypto.randomUUID(), actorId, JSON.stringify(metadata), now.toISOString()]);
      return { revision, validUntil, clientCount: clients.length };
    });
  }
}
