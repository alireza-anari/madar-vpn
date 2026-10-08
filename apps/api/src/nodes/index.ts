export type NodeStatus = 'enrolled' | 'ready' | 'offline' | 'error';

export type NodeRecord = {
  id: string;
  name: string;
  status: NodeStatus;
  lastSeenAt: string | null;
  createdAt: string;
};

export type NodeEnrollmentTokenRecord = {
  id: string;
  nodeId: string;
  tokenHash: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
};

export type NodeCredentialRecord = {
  id: string;
  nodeId: string;
  credentialHash: string;
  createdAt: string;
  revokedAt: string | null;
};

export type NodePublicConfig = {
  address: string;
  port: number;
  serverName: string;
  realityPublicKey: string;
  realityShortId: string;
};

export type NodeHealth = {
  healthy: boolean;
  ready: boolean;
};

export type NodeVersions = {
  agent: string;
  xray: string;
};

export type NodeCapacity = {
  accepting: boolean;
  activeClients: number;
  maxClients: number;
};

export type NodeHeartbeatRecord = {
  nodeId: string;
  health: NodeHealth;
  versions: NodeVersions;
  capacity: NodeCapacity;
  recordedAt: string;
};

export type NodePolicyClient = {
  userId: string;
  policyRevision: number;
  clientId: string;
  tier: 'free' | 'premium';
  speedKbps: number | null;
};

export type NodePolicy = {
  nodeId: string;
  revision: number;
  validUntil: string;
  clients: NodePolicyClient[];
};

export type TelemetryReport = {
  nodeId: string;
  clientId: string;
  windowId: string;
  sequence: number;
  seconds: number;
  timestamp: string;
  observedFrom?: string | undefined;
  observedTo?: string | undefined;
  sessionId?: string | undefined;
};

export interface NodeControlStore {
  saveNode(node: NodeRecord): Promise<void>;
  getNode(nodeId: string): Promise<NodeRecord | null>;
  saveEnrollmentToken(record: NodeEnrollmentTokenRecord): Promise<void>;
  consumeEnrollmentToken(tokenHash: string, now: Date): Promise<NodeEnrollmentTokenRecord | null>;
  saveCredential(record: NodeCredentialRecord): Promise<void>;
  findActiveCredentialByHash(credentialHash: string): Promise<NodeCredentialRecord | null>;
  saveCapabilities(nodeId: string, capabilities: Record<string, unknown>, updatedAt: string): Promise<void>;
  savePublicConfig(nodeId: string, config: NodePublicConfig, updatedAt: string): Promise<void>;
  saveHeartbeat(record: NodeHeartbeatRecord): Promise<void>;
  getLatestHeartbeat(nodeId: string): Promise<NodeHeartbeatRecord | null>;
  getPolicy(nodeId: string): Promise<NodePolicy | null>;
  acknowledgePolicy(nodeId: string, revision: number, ackedAt: string, clients: NodePolicyClient[]): Promise<void>;
  insertTelemetry(report: TelemetryReport): Promise<boolean>;
}

function cloneJson<T>(value: T): T {
  return structuredClone(value);
}

export class MemoryNodeControlStore implements NodeControlStore {
  readonly nodes: NodeRecord[] = [];
  readonly enrollmentTokens: NodeEnrollmentTokenRecord[] = [];
  readonly credentials: NodeCredentialRecord[] = [];
  readonly capabilities: Array<{ nodeId: string; capabilities: Record<string, unknown>; updatedAt: string }> = [];
  readonly publicConfigs: Array<{ nodeId: string; config: NodePublicConfig; updatedAt: string }> = [];
  readonly heartbeats: NodeHeartbeatRecord[] = [];
  readonly policies: NodePolicy[] = [];
  readonly policyRevisionAcks: Array<{ nodeId: string; revision: number; ackedAt: string }> = [];
  readonly userPolicyAcks: Array<{ nodeId: string; userId: string; revision: number; ackedAt: string }> = [];
  readonly telemetryReports: TelemetryReport[] = [];

  seedPolicy(policy: NodePolicy) {
    const index = this.policies.findIndex((candidate) => candidate.nodeId === policy.nodeId);
    const copy = cloneJson(policy);
    if (index >= 0) this.policies[index] = copy;
    else this.policies.push(copy);
  }

  async saveNode(node: NodeRecord) {
    const index = this.nodes.findIndex((candidate) => candidate.id === node.id);
    if (index >= 0) this.nodes[index] = { ...node };
    else this.nodes.push({ ...node });
  }

  async getNode(nodeId: string) {
    const record = this.nodes.find((candidate) => candidate.id === nodeId);
    return record ? { ...record } : null;
  }

  async saveEnrollmentToken(record: NodeEnrollmentTokenRecord) {
    this.enrollmentTokens.push({ ...record });
  }

  async consumeEnrollmentToken(tokenHash: string, now: Date) {
    const record = this.enrollmentTokens.find((candidate) => (
      candidate.tokenHash === tokenHash &&
      candidate.usedAt === null &&
      new Date(candidate.expiresAt).getTime() > now.getTime()
    ));
    if (!record) return null;
    record.usedAt = now.toISOString();
    return { ...record };
  }

  async saveCredential(record: NodeCredentialRecord) {
    this.credentials.push({ ...record });
  }

  async findActiveCredentialByHash(credentialHash: string) {
    const record = this.credentials.find((candidate) => candidate.credentialHash === credentialHash && candidate.revokedAt === null);
    return record ? { ...record } : null;
  }

  async saveCapabilities(nodeId: string, capabilities: Record<string, unknown>, updatedAt: string) {
    const index = this.capabilities.findIndex((candidate) => candidate.nodeId === nodeId);
    const record = { nodeId, capabilities: cloneJson(capabilities), updatedAt };
    if (index >= 0) this.capabilities[index] = record;
    else this.capabilities.push(record);
  }

  async savePublicConfig(nodeId: string, config: NodePublicConfig, updatedAt: string) {
    const index = this.publicConfigs.findIndex((candidate) => candidate.nodeId === nodeId);
    const record = { nodeId, config: { ...config }, updatedAt };
    if (index >= 0) this.publicConfigs[index] = record;
    else this.publicConfigs.push(record);
  }

  async saveHeartbeat(record: NodeHeartbeatRecord) {
    this.heartbeats.push(cloneJson(record));
  }

  async getLatestHeartbeat(nodeId: string) {
    const record = [...this.heartbeats].reverse().find((candidate) => candidate.nodeId === nodeId);
    return record ? cloneJson(record) : null;
  }

  async getPolicy(nodeId: string) {
    const record = this.policies.find((candidate) => candidate.nodeId === nodeId);
    return record ? cloneJson(record) : null;
  }

  async acknowledgePolicy(nodeId: string, revision: number, ackedAt: string, clients: NodePolicyClient[]) {
    const existingRevision = this.policyRevisionAcks.find((candidate) => candidate.nodeId === nodeId && candidate.revision === revision);
    if (!existingRevision) this.policyRevisionAcks.push({ nodeId, revision, ackedAt });

    for (const client of clients) {
      const existing = this.userPolicyAcks.find((candidate) => candidate.nodeId === nodeId && candidate.userId === client.userId);
      const next = { nodeId, userId: client.userId, revision: client.policyRevision, ackedAt };
      if (existing) Object.assign(existing, next);
      else this.userPolicyAcks.push(next);
    }
  }

  async insertTelemetry(report: TelemetryReport) {
    const duplicate = this.telemetryReports.some((candidate) => (
      candidate.nodeId === report.nodeId &&
      candidate.windowId === report.windowId &&
      candidate.sequence === report.sequence
    ));
    if (duplicate) return false;
    this.telemetryReports.push({ ...report });
    return true;
  }
}

export class NodeControlError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'NodeControlError';
  }
}

function secureRandomSecret() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export async function hashNodeSecret(secret: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function validateId(value: string, code = 'NODE_INVALID') {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)) {
    throw new NodeControlError(400, code, 'Identifier is invalid.');
  }
  return value;
}

function objectInput(value: unknown, code: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new NodeControlError(400, code, 'Payload is invalid.');
  }
  return value as Record<string, unknown>;
}

function requiredText(value: unknown, code: string, maxLength: number) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength) {
    throw new NodeControlError(400, code, 'Text value is invalid.');
  }
  return value.trim();
}

function sanitizeObject(value: unknown, code: string, depth = 0): Record<string, unknown> {
  const source = objectInput(value, code);
  if (depth > 4) throw new NodeControlError(400, code, 'Payload is too deeply nested.');
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(source)) {
    if (/(secret|token|credential|password|private.?key)/i.test(key)) continue;
    if (item === null || typeof item === 'string' || typeof item === 'boolean' || typeof item === 'number') {
      result[key] = item;
      continue;
    }
    if (Array.isArray(item)) {
      result[key] = item
        .filter((candidate) => candidate === null || ['string', 'boolean', 'number'].includes(typeof candidate))
        .slice(0, 100);
      continue;
    }
    if (typeof item === 'object') result[key] = sanitizeObject(item, code, depth + 1);
  }
  return result;
}

function validatePublicConfig(input: unknown): NodePublicConfig {
  const candidate = objectInput(input, 'NODE_PUBLIC_CONFIG_INVALID');
  const port = Number(candidate.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new NodeControlError(400, 'NODE_PUBLIC_CONFIG_INVALID', 'Port is invalid.');
  }
  return {
    address: requiredText(candidate.address, 'NODE_PUBLIC_CONFIG_INVALID', 255),
    port,
    serverName: requiredText(candidate.serverName, 'NODE_PUBLIC_CONFIG_INVALID', 255),
    realityPublicKey: requiredText(candidate.realityPublicKey, 'NODE_PUBLIC_CONFIG_INVALID', 512),
    realityShortId: requiredText(candidate.realityShortId, 'NODE_PUBLIC_CONFIG_INVALID', 64),
  };
}

function validateHealth(input: unknown): NodeHealth {
  const candidate = objectInput(input, 'NODE_HEALTH_INVALID');
  if (typeof candidate.healthy !== 'boolean' || typeof candidate.ready !== 'boolean') {
    throw new NodeControlError(400, 'NODE_HEALTH_INVALID', 'Health payload is invalid.');
  }
  return { healthy: candidate.healthy, ready: candidate.ready };
}

function validateVersions(input: unknown): NodeVersions {
  const candidate = objectInput(input, 'NODE_VERSIONS_INVALID');
  return {
    agent: requiredText(candidate.agent, 'NODE_VERSIONS_INVALID', 120),
    xray: requiredText(candidate.xray, 'NODE_VERSIONS_INVALID', 120),
  };
}

function validateCapacity(input: unknown): NodeCapacity {
  const candidate = objectInput(input, 'NODE_CAPACITY_INVALID');
  const activeClients = Number(candidate.activeClients);
  const maxClients = Number(candidate.maxClients);
  if (
    typeof candidate.accepting !== 'boolean' ||
    !Number.isSafeInteger(activeClients) || activeClients < 0 ||
    !Number.isSafeInteger(maxClients) || maxClients < 1 ||
    activeClients > maxClients
  ) {
    throw new NodeControlError(400, 'NODE_CAPACITY_INVALID', 'Capacity payload is invalid.');
  }
  return { accepting: candidate.accepting, activeClients, maxClients };
}

function isoTimestamp(value: unknown, code: string) {
  if (typeof value !== 'string') throw new NodeControlError(400, code, 'Timestamp is invalid.');
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new NodeControlError(400, code, 'Timestamp is invalid.');
  return parsed.toISOString();
}

function optionalTimestamp(value: unknown, code: string) {
  return value === undefined ? undefined : isoTimestamp(value, code);
}

function validateTelemetry(nodeId: string, input: unknown): TelemetryReport {
  const candidate = objectInput(input, 'TELEMETRY_INVALID');
  const sequence = Number(candidate.sequence);
  const seconds = Number(candidate.seconds);
  if (!Number.isSafeInteger(sequence) || sequence < 0 || !Number.isSafeInteger(seconds) || seconds < 0 || seconds > 86_400) {
    throw new NodeControlError(400, 'TELEMETRY_INVALID', 'Telemetry counters are invalid.');
  }
  const base: TelemetryReport = {
    nodeId,
    clientId: validateId(requiredText(candidate.clientId, 'TELEMETRY_INVALID', 128), 'TELEMETRY_INVALID'),
    windowId: requiredText(candidate.windowId, 'TELEMETRY_INVALID', 160),
    sequence,
    seconds,
    timestamp: isoTimestamp(candidate.timestamp, 'TELEMETRY_INVALID'),
  };
  const observedFrom = optionalTimestamp(candidate.observedFrom, 'TELEMETRY_INVALID');
  const observedTo = optionalTimestamp(candidate.observedTo, 'TELEMETRY_INVALID');
  const sessionId = candidate.sessionId === undefined
    ? undefined
    : requiredText(candidate.sessionId, 'TELEMETRY_INVALID', 160);
  if (observedFrom !== undefined) base.observedFrom = observedFrom;
  if (observedTo !== undefined) base.observedTo = observedTo;
  if (sessionId !== undefined) base.sessionId = sessionId;
  return base;
}

export function createNodeControlService(options: {
  store: NodeControlStore;
  now?: () => Date;
  randomId?: () => string;
  randomSecret?: () => string;
  enrollmentTtlMs?: number;
  staleAfterMs?: number;
}) {
  const now = options.now ?? (() => new Date());
  const randomId = options.randomId ?? (() => crypto.randomUUID());
  const randomSecret = options.randomSecret ?? secureRandomSecret;
  const enrollmentTtlMs = options.enrollmentTtlMs ?? 15 * 60_000;
  const staleAfterMs = options.staleAfterMs ?? 120_000;

  return {
    async createEnrollmentToken(adminId: string, nodeDraft: unknown, issuedAt: Date) {
      validateId(adminId, 'ADMIN_INVALID');
      const candidate = objectInput(nodeDraft, 'NODE_INVALID');
      const node: NodeRecord = {
        id: randomId(),
        name: requiredText(candidate.name, 'NODE_INVALID', 120),
        status: 'enrolled',
        lastSeenAt: null,
        createdAt: issuedAt.toISOString(),
      };
      const rawToken = randomSecret();
      const expiresAt = new Date(issuedAt.getTime() + enrollmentTtlMs).toISOString();
      await options.store.saveNode(node);
      await options.store.saveEnrollmentToken({
        id: randomId(),
        nodeId: node.id,
        tokenHash: await hashNodeSecret(rawToken),
        createdBy: adminId,
        createdAt: issuedAt.toISOString(),
        expiresAt,
        usedAt: null,
      });
      return { node: { ...node }, rawToken, expiresAt };
    },

    async enrollNode(rawToken: string, capabilitiesInput: unknown, publicConfigInput: unknown) {
      if (typeof rawToken !== 'string' || rawToken.length < 8 || rawToken.length > 4096) {
        throw new NodeControlError(401, 'NODE_ENROLLMENT_TOKEN_INVALID', 'Enrollment token is invalid.');
      }
      const enrolledAt = now();
      const token = await options.store.consumeEnrollmentToken(await hashNodeSecret(rawToken), enrolledAt);
      if (!token) throw new NodeControlError(401, 'NODE_ENROLLMENT_TOKEN_INVALID', 'Enrollment token is invalid.');
      const node = await options.store.getNode(token.nodeId);
      if (!node) throw new NodeControlError(404, 'NODE_NOT_FOUND', 'Node does not exist.');

      const capabilities = sanitizeObject(capabilitiesInput, 'NODE_CAPABILITIES_INVALID');
      const publicConfig = validatePublicConfig(publicConfigInput);
      const rawCredential = randomSecret();
      await options.store.saveCapabilities(node.id, capabilities, enrolledAt.toISOString());
      await options.store.savePublicConfig(node.id, publicConfig, enrolledAt.toISOString());
      await options.store.saveCredential({
        id: randomId(),
        nodeId: node.id,
        credentialHash: await hashNodeSecret(rawCredential),
        createdAt: enrolledAt.toISOString(),
        revokedAt: null,
      });
      return { node: { ...node }, rawCredential, publicConfig: { ...publicConfig } };
    },

    async authenticateNode(rawCredential: string) {
      if (typeof rawCredential !== 'string' || rawCredential.length < 8 || rawCredential.length > 4096) {
        throw new NodeControlError(401, 'NODE_CREDENTIAL_INVALID', 'Node credential is invalid.');
      }
      const credential = await options.store.findActiveCredentialByHash(await hashNodeSecret(rawCredential));
      if (!credential) throw new NodeControlError(401, 'NODE_CREDENTIAL_INVALID', 'Node credential is invalid.');
      return { nodeId: credential.nodeId };
    },

    async heartbeatNode(nodeId: string, healthInput: unknown, versionsInput: unknown, capacityInput: unknown) {
      const id = validateId(nodeId);
      const node = await options.store.getNode(id);
      if (!node) throw new NodeControlError(404, 'NODE_NOT_FOUND', 'Node does not exist.');
      const health = validateHealth(healthInput);
      const versions = validateVersions(versionsInput);
      const capacity = validateCapacity(capacityInput);
      const recordedAt = now().toISOString();
      const canAccept = capacity.accepting && capacity.activeClients < capacity.maxClients;
      const status: NodeStatus = !health.healthy ? 'error' : health.ready && canAccept ? 'ready' : 'offline';
      const updated: NodeRecord = { ...node, status, lastSeenAt: recordedAt };
      await options.store.saveNode(updated);
      await options.store.saveHeartbeat({ nodeId: id, health, versions, capacity, recordedAt });
      return { ...updated };
    },

    async getNodeReadiness(nodeId: string, at: Date) {
      const id = validateId(nodeId);
      const heartbeat = await options.store.getLatestHeartbeat(id);
      if (!heartbeat) return { ready: false as const, reason: 'no-heartbeat' as const };
      if (at.getTime() - new Date(heartbeat.recordedAt).getTime() > staleAfterMs) {
        return { ready: false as const, reason: 'stale' as const };
      }
      if (!heartbeat.health.healthy || !heartbeat.health.ready) {
        return { ready: false as const, reason: 'unhealthy' as const };
      }
      if (!heartbeat.capacity.accepting || heartbeat.capacity.activeClients >= heartbeat.capacity.maxClients) {
        return { ready: false as const, reason: 'capacity' as const };
      }
      return { ready: true as const, reason: 'ready' as const };
    },

    async getNodePolicy(nodeId: string, knownRevision: number) {
      const id = validateId(nodeId);
      if (!Number.isSafeInteger(knownRevision) || knownRevision < 0) {
        throw new NodeControlError(400, 'NODE_POLICY_REVISION_INVALID', 'Policy revision is invalid.');
      }
      const policy = await options.store.getPolicy(id);
      if (!policy || policy.revision <= knownRevision || new Date(policy.validUntil).getTime() <= now().getTime()) return null;
      return cloneJson(policy);
    },

    async ackNodePolicy(nodeId: string, revision: number) {
      const id = validateId(nodeId);
      if (!Number.isSafeInteger(revision) || revision < 1) {
        throw new NodeControlError(400, 'NODE_POLICY_REVISION_INVALID', 'Policy revision is invalid.');
      }
      const policy = await options.store.getPolicy(id);
      if (!policy || policy.revision !== revision || new Date(policy.validUntil).getTime() <= now().getTime()) {
        throw new NodeControlError(409, 'NODE_POLICY_STALE', 'Policy revision is no longer current.');
      }
      const ackedAt = now().toISOString();
      await options.store.acknowledgePolicy(id, revision, ackedAt, policy.clients);
      return { acknowledged: true as const, revision };
    },

    async postTelemetry(nodeId: string, reportsInput: unknown) {
      const id = validateId(nodeId);
      if (!Array.isArray(reportsInput) || reportsInput.length > 10_000) {
        throw new NodeControlError(400, 'TELEMETRY_INVALID', 'Telemetry report list is invalid.');
      }
      let accepted = 0;
      let duplicates = 0;
      for (const input of reportsInput) {
        const report = validateTelemetry(id, input);
        if (await options.store.insertTelemetry(report)) accepted += 1;
        else duplicates += 1;
      }
      return { accepted, duplicates };
    },
  };
}

export type NodeControlService = ReturnType<typeof createNodeControlService>;
