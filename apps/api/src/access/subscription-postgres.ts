import type { PgDatabase } from '../postgres/client';
import type { SubscriptionNodeCandidate, SubscriptionNodeStore } from './subscription';

type QueryDatabase = Pick<PgDatabase, 'query'>;

type SubscriptionNodeRow = Record<string, unknown> & {
  id: string;
  name: string;
  status: SubscriptionNodeCandidate['status'];
  last_seen_at: Date | string | null;
  acked_revision: number | null;
  address: string | null;
  port: number | null;
  server_name: string | null;
  reality_public_key: string | null;
  reality_short_id: string | null;
};

function toNullableIso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export class PostgresSubscriptionNodeStore implements SubscriptionNodeStore {
  constructor(private readonly db: QueryDatabase) {}

  async listCandidates(userId: string) {
    const result = await this.db.query<SubscriptionNodeRow>(
      `SELECT
         n.id,
         n.name,
         n.status,
         n.last_seen_at,
         a.revision AS acked_revision,
         p.address,
         p.port,
         p.server_name,
         p.reality_public_key,
         p.reality_short_id
       FROM nodes n
       LEFT JOIN node_public_configs p ON p.node_id = n.id
       LEFT JOIN node_policy_acks a ON a.node_id = n.id AND a.user_id = $1
       ORDER BY n.created_at ASC, n.id ASC`,
      [userId],
    );

    return result.rows.map((row): SubscriptionNodeCandidate => {
      const hasPublicConfig =
        typeof row.address === 'string' &&
        typeof row.port === 'number' &&
        typeof row.server_name === 'string' &&
        typeof row.reality_public_key === 'string' &&
        typeof row.reality_short_id === 'string';

      return {
        id: row.id,
        name: row.name,
        status: row.status,
        lastSeenAt: toNullableIso(row.last_seen_at),
        ackedRevision: row.acked_revision,
        publicConfig: hasPublicConfig
          ? {
              address: row.address!,
              port: row.port!,
              serverName: row.server_name!,
              realityPublicKey: row.reality_public_key!,
              realityShortId: row.reality_short_id!,
            }
          : null,
      };
    });
  }
}
