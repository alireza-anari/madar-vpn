import type { PgDatabase } from '../postgres/client';
import type {
  NodeCapacity,
  NodeControlStore,
  NodeCredentialRecord,
  NodeEnrollmentTokenRecord,
  NodeHealth,
  NodeHeartbeatRecord,
  NodePolicy,
  NodePolicyClient,
  NodePublicConfig,
  NodeRecord,
  NodeVersions,
  TelemetryReport,
} from './index';

type QueryDatabase = Pick<PgDatabase, 'query' | 'transaction'>;

type NodeRow = Record<string, unknown> & {
  id: string;
  name: string;
  status: NodeRecord['status'];
  last_seen_at: Date | string | null;
  created_at: Date | string;
};

type EnrollmentTokenRow = Record<string, unknown> & {
  id: string;
  node_id: string;
  token_hash: string;
  created_by: string;
  created_at: Date | string;
  expires_at: Date | string;
  used_at: Date | string | null;
};

type CredentialRow = Record<string, unknown> & {
  id: string;
  node_id: string;
  credential_hash: string;
  created_at: Date | string;
  revoked_at: Date | string | null;
};

type HeartbeatRow = Record<string, unknown> & {
  node_id: string;
  health_json: unknown;
  versions_json: unknown;
  capacity_json: unknown;
  recorded_at: Date | string;
};

type PolicyRow = Record<string, unknown> & {
  node_id: string;
  revision: number;
  valid_until: Date | string;
  policy_json: unknown;
};

type ReturnedNodeRow = Record<string, unknown> & { node_id: string };

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toNullableIso(value: Date | string | null): string | null {
  return value === null ? null : toIso(value);
}

function parseJson<T>(value: unknown): T {
  if (typeof value === 'string') return JSON.parse(value) as T;
  return structuredClone(value) as T;
}

function mapNode(row: NodeRow | undefined): NodeRecord | null {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    lastSeenAt: toNullableIso(row.last_seen_at),
    createdAt: toIso(row.created_at),
  };
}

function mapEnrollmentToken(row: EnrollmentTokenRow | undefined): NodeEnrollmentTokenRecord | null {
  if (!row) return null;
  return {
    id: row.id,
    nodeId: row.node_id,
    tokenHash: row.token_hash,
    createdBy: row.created_by,
    createdAt: toIso(row.created_at),
    expiresAt: toIso(row.expires_at),
    usedAt: toNullableIso(row.used_at),
  };
}

function mapCredential(row: CredentialRow | undefined): NodeCredentialRecord | null {
  if (!row) return null;
  return {
    id: row.id,
    nodeId: row.node_id,
    credentialHash: row.credential_hash,
    createdAt: toIso(row.created_at),
    revokedAt: toNullableIso(row.revoked_at),
  };
}

export class PostgresNodeControlStore implements NodeControlStore {
  constructor(private readonly db: QueryDatabase) {}

  async saveNode(node: NodeRecord) {
    await this.db.query(
      `INSERT INTO nodes (id, name, status, last_seen_at, created_at)
       VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         status = EXCLUDED.status,
         last_seen_at = EXCLUDED.last_seen_at`,
      [node.id, node.name, node.status, node.lastSeenAt, node.createdAt],
    );
  }

  async getNode(nodeId: string) {
    const result = await this.db.query<NodeRow>(
      `SELECT id, name, status, last_seen_at, created_at
       FROM nodes
       WHERE id = $1
       LIMIT 1`,
      [nodeId],
    );
    return mapNode(result.rows[0]);
  }

  async saveEnrollmentToken(record: NodeEnrollmentTokenRecord) {
    await this.db.query(
      `INSERT INTO node_enrollment_tokens (
         id, node_id, token_hash, created_by, created_at, expires_at, used_at
       ) VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, $7::timestamptz)`,
      [
        record.id,
        record.nodeId,
        record.tokenHash,
        record.createdBy,
        record.createdAt,
        record.expiresAt,
        record.usedAt,
      ],
    );
  }

  async consumeEnrollmentToken(tokenHash: string, now: Date) {
    const timestamp = now.toISOString();
    const result = await this.db.query<EnrollmentTokenRow>(
      `UPDATE node_enrollment_tokens
       SET used_at = $1::timestamptz
       WHERE token_hash = $2
         AND used_at IS NULL
         AND expires_at > $1::timestamptz
       RETURNING id, node_id, token_hash, created_by, created_at, expires_at, used_at`,
      [timestamp, tokenHash],
    );
    return mapEnrollmentToken(result.rows[0]);
  }

  async saveCredential(record: NodeCredentialRecord) {
    await this.db.query(
      `INSERT INTO node_credentials (
         id, node_id, credential_hash, created_at, revoked_at
       ) VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz)`,
      [record.id, record.nodeId, record.credentialHash, record.createdAt, record.revokedAt],
    );
  }

  async findActiveCredentialByHash(credentialHash: string) {
    const result = await this.db.query<CredentialRow>(
      `SELECT id, node_id, credential_hash, created_at, revoked_at
       FROM node_credentials
       WHERE credential_hash = $1 AND revoked_at IS NULL
       LIMIT 1`,
      [credentialHash],
    );
    return mapCredential(result.rows[0]);
  }

  async revokeNodeCredentials(nodeId: string, revokedAt: string) {
    await this.db.query(
      `UPDATE node_credentials
       SET revoked_at = $2::timestamptz
       WHERE node_id = $1 AND revoked_at IS NULL`,
      [nodeId, revokedAt],
    );
  }

  async saveCapabilities(nodeId: string, capabilities: Record<string, unknown>, updatedAt: string) {
    await this.db.query(
      `INSERT INTO node_capabilities (node_id, capabilities_json, updated_at)
       VALUES ($1, $2::jsonb, $3::timestamptz)
       ON CONFLICT (node_id) DO UPDATE SET
         capabilities_json = EXCLUDED.capabilities_json,
         updated_at = EXCLUDED.updated_at`,
      [nodeId, JSON.stringify(capabilities), updatedAt],
    );
  }

  async savePublicConfig(nodeId: string, config: NodePublicConfig, updatedAt: string) {
    await this.db.query(
      `INSERT INTO node_public_configs (
         node_id, address, port, server_name, reality_public_key, reality_short_id, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz)
       ON CONFLICT (node_id) DO UPDATE SET
         address = EXCLUDED.address,
         port = EXCLUDED.port,
         server_name = EXCLUDED.server_name,
         reality_public_key = EXCLUDED.reality_public_key,
         reality_short_id = EXCLUDED.reality_short_id,
         updated_at = EXCLUDED.updated_at`,
      [
        nodeId,
        config.address,
        config.port,
        config.serverName,
        config.realityPublicKey,
        config.realityShortId,
        updatedAt,
      ],
    );
  }

  async saveHeartbeat(record: NodeHeartbeatRecord) {
    await this.db.query(
      `INSERT INTO node_health_samples (
         node_id, recorded_at, health_json, versions_json, capacity_json
       ) VALUES ($1, $2::timestamptz, $3::jsonb, $4::jsonb, $5::jsonb)`,
      [
        record.nodeId,
        record.recordedAt,
        JSON.stringify(record.health),
        JSON.stringify(record.versions),
        JSON.stringify(record.capacity),
      ],
    );
  }

  async getLatestHeartbeat(nodeId: string) {
    const result = await this.db.query<HeartbeatRow>(
      `SELECT node_id, health_json, versions_json, capacity_json, recorded_at
       FROM node_health_samples
       WHERE node_id = $1
       ORDER BY recorded_at DESC
       LIMIT 1`,
      [nodeId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      nodeId: row.node_id,
      health: parseJson<NodeHealth>(row.health_json),
      versions: parseJson<NodeVersions>(row.versions_json),
      capacity: parseJson<NodeCapacity>(row.capacity_json),
      recordedAt: toIso(row.recorded_at),
    };
  }

  async getPolicy(nodeId: string): Promise<NodePolicy | null> {
    const result = await this.db.query<PolicyRow>(
      `SELECT node_id, revision, valid_until, policy_json
       FROM node_policy_revisions
       WHERE node_id = $1
       ORDER BY revision DESC
       LIMIT 1`,
      [nodeId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const payload = parseJson<{ clients?: NodePolicyClient[] }>(row.policy_json);
    return {
      nodeId: row.node_id,
      revision: row.revision,
      validUntil: toIso(row.valid_until),
      clients: Array.isArray(payload.clients) ? payload.clients : [],
    };
  }

  async acknowledgePolicy(nodeId: string, revision: number, ackedAt: string, clients: NodePolicyClient[]) {
    await this.db.transaction(async (transaction) => {
      await transaction.query(
        `UPDATE node_policy_revisions
         SET acked_at = $3::timestamptz
         WHERE node_id = $1 AND revision = $2`,
        [nodeId, revision, ackedAt],
      );

      for (const client of clients) {
        await transaction.query(
          `INSERT INTO node_policy_acks (node_id, user_id, revision, acked_at)
           VALUES ($1, $2, $3, $4::timestamptz)
           ON CONFLICT (node_id, user_id) DO UPDATE SET
             revision = EXCLUDED.revision,
             acked_at = EXCLUDED.acked_at`,
          [nodeId, client.userId, client.policyRevision, ackedAt],
        );
      }
    });
  }

  async insertTelemetry(report: TelemetryReport) {
    const result = await this.db.query<ReturnedNodeRow>(
      `INSERT INTO telemetry_reports (
         node_id, client_id, window_id, sequence, seconds, timestamp,
         observed_from, observed_to, session_id
       ) VALUES (
         $1, $2, $3, $4, $5, $6::timestamptz,
         $7::timestamptz, $8::timestamptz, $9
       )
       ON CONFLICT (node_id, window_id, sequence) DO NOTHING
       RETURNING node_id`,
      [
        report.nodeId,
        report.clientId,
        report.windowId,
        report.sequence,
        report.seconds,
        report.timestamp,
        report.observedFrom ?? null,
        report.observedTo ?? null,
        report.sessionId ?? null,
      ],
    );
    return result.rows.length > 0;
  }
}
