import type { D1DatabaseLike } from '../auth/d1';
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

type NodeRow = {
  id: string;
  name: string;
  status: NodeRecord['status'];
  last_seen_at: string | null;
  created_at: string;
};

type EnrollmentTokenRow = {
  id: string;
  node_id: string;
  token_hash: string;
  created_by: string;
  created_at: string;
  expires_at: string;
  used_at: string | null;
};

type CredentialRow = {
  id: string;
  node_id: string;
  credential_hash: string;
  created_at: string;
  revoked_at: string | null;
};

type HeartbeatRow = {
  node_id: string;
  health_json: string;
  versions_json: string;
  capacity_json: string;
  recorded_at: string;
};

type PolicyRow = {
  node_id: string;
  revision: number;
  valid_until: string;
  policy_json: string;
};

function mapNode(row: NodeRow | null): NodeRecord | null {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
  };
}

function mapEnrollmentToken(row: EnrollmentTokenRow | null): NodeEnrollmentTokenRecord | null {
  if (!row) return null;
  return {
    id: row.id,
    nodeId: row.node_id,
    tokenHash: row.token_hash,
    createdBy: row.created_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    usedAt: row.used_at,
  };
}

function mapCredential(row: CredentialRow | null): NodeCredentialRecord | null {
  if (!row) return null;
  return {
    id: row.id,
    nodeId: row.node_id,
    credentialHash: row.credential_hash,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}

function parseJson<T>(raw: string): T {
  return JSON.parse(raw) as T;
}

export class D1NodeControlStore implements NodeControlStore {
  constructor(private readonly db: D1DatabaseLike) {}

  async saveNode(node: NodeRecord) {
    await this.db.prepare(`INSERT INTO nodes (id, name, status, last_seen_at, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        status = excluded.status,
        last_seen_at = excluded.last_seen_at`)
      .bind(node.id, node.name, node.status, node.lastSeenAt, node.createdAt)
      .run();
  }

  async getNode(nodeId: string) {
    const row = await this.db.prepare(`SELECT id, name, status, last_seen_at, created_at
      FROM nodes WHERE id = ? LIMIT 1`)
      .bind(nodeId)
      .first<NodeRow>();
    return mapNode(row);
  }

  async saveEnrollmentToken(record: NodeEnrollmentTokenRecord) {
    await this.db.prepare(`INSERT INTO node_enrollment_tokens
      (id, node_id, token_hash, created_by, created_at, expires_at, used_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        record.id,
        record.nodeId,
        record.tokenHash,
        record.createdBy,
        record.createdAt,
        record.expiresAt,
        record.usedAt,
      )
      .run();
  }

  async consumeEnrollmentToken(tokenHash: string, now: Date) {
    const timestamp = now.toISOString();
    const row = await this.db.prepare(`UPDATE node_enrollment_tokens SET used_at = ?
      WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?
      RETURNING id, node_id, token_hash, created_by, created_at, expires_at, used_at`)
      .bind(timestamp, tokenHash, timestamp)
      .first<EnrollmentTokenRow>();
    return mapEnrollmentToken(row);
  }

  async saveCredential(record: NodeCredentialRecord) {
    await this.db.prepare(`INSERT INTO node_credentials
      (id, node_id, credential_hash, created_at, revoked_at)
      VALUES (?, ?, ?, ?, ?)`)
      .bind(record.id, record.nodeId, record.credentialHash, record.createdAt, record.revokedAt)
      .run();
  }

  async findActiveCredentialByHash(credentialHash: string) {
    const row = await this.db.prepare(`SELECT id, node_id, credential_hash, created_at, revoked_at
      FROM node_credentials
      WHERE credential_hash = ? AND revoked_at IS NULL
      LIMIT 1`)
      .bind(credentialHash)
      .first<CredentialRow>();
    return mapCredential(row);
  }

  async saveCapabilities(nodeId: string, capabilities: Record<string, unknown>, updatedAt: string) {
    await this.db.prepare(`INSERT INTO node_capabilities (node_id, capabilities_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(node_id) DO UPDATE SET
        capabilities_json = excluded.capabilities_json,
        updated_at = excluded.updated_at`)
      .bind(nodeId, JSON.stringify(capabilities), updatedAt)
      .run();
  }

  async savePublicConfig(nodeId: string, config: NodePublicConfig, updatedAt: string) {
    await this.db.prepare(`INSERT INTO node_public_configs
      (node_id, address, port, server_name, reality_public_key, reality_short_id, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(node_id) DO UPDATE SET
        address = excluded.address,
        port = excluded.port,
        server_name = excluded.server_name,
        reality_public_key = excluded.reality_public_key,
        reality_short_id = excluded.reality_short_id,
        updated_at = excluded.updated_at`)
      .bind(
        nodeId,
        config.address,
        config.port,
        config.serverName,
        config.realityPublicKey,
        config.realityShortId,
        updatedAt,
      )
      .run();
  }

  async saveHeartbeat(record: NodeHeartbeatRecord) {
    await this.db.prepare(`INSERT INTO node_health_samples
      (node_id, recorded_at, health_json, versions_json, capacity_json)
      VALUES (?, ?, ?, ?, ?)`)
      .bind(
        record.nodeId,
        record.recordedAt,
        JSON.stringify(record.health),
        JSON.stringify(record.versions),
        JSON.stringify(record.capacity),
      )
      .run();
  }

  async getLatestHeartbeat(nodeId: string) {
    const row = await this.db.prepare(`SELECT node_id, health_json, versions_json, capacity_json, recorded_at
      FROM node_health_samples
      WHERE node_id = ?
      ORDER BY recorded_at DESC
      LIMIT 1`)
      .bind(nodeId)
      .first<HeartbeatRow>();
    if (!row) return null;
    return {
      nodeId: row.node_id,
      health: parseJson<NodeHealth>(row.health_json),
      versions: parseJson<NodeVersions>(row.versions_json),
      capacity: parseJson<NodeCapacity>(row.capacity_json),
      recordedAt: row.recorded_at,
    };
  }

  async getPolicy(nodeId: string) {
    const row = await this.db.prepare(`SELECT node_id, revision, valid_until, policy_json
      FROM node_policy_revisions
      WHERE node_id = ?
      ORDER BY revision DESC
      LIMIT 1`)
      .bind(nodeId)
      .first<PolicyRow>();
    if (!row) return null;
    const payload = parseJson<{ clients?: NodePolicyClient[] }>(row.policy_json);
    return {
      nodeId: row.node_id,
      revision: row.revision,
      validUntil: row.valid_until,
      clients: Array.isArray(payload.clients) ? payload.clients : [],
    } satisfies NodePolicy;
  }

  async acknowledgePolicy(nodeId: string, revision: number, ackedAt: string, clients: NodePolicyClient[]) {
    await this.db.prepare(`UPDATE node_policy_revisions
      SET acked_at = ?
      WHERE node_id = ? AND revision = ?`)
      .bind(ackedAt, nodeId, revision)
      .run();

    for (const client of clients) {
      await this.db.prepare(`INSERT INTO node_policy_acks (node_id, user_id, revision, acked_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(node_id, user_id) DO UPDATE SET
          revision = excluded.revision,
          acked_at = excluded.acked_at`)
        .bind(nodeId, client.userId, client.policyRevision, ackedAt)
        .run();
    }
  }

  async insertTelemetry(report: TelemetryReport) {
    const row = await this.db.prepare(`INSERT OR IGNORE INTO telemetry_reports
      (node_id, client_id, window_id, sequence, seconds, timestamp, observed_from, observed_to, session_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING node_id`)
      .bind(
        report.nodeId,
        report.clientId,
        report.windowId,
        report.sequence,
        report.seconds,
        report.timestamp,
        report.observedFrom ?? null,
        report.observedTo ?? null,
        report.sessionId ?? null,
      )
      .first<{ node_id: string }>();
    return row !== null;
  }
}
