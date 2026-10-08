import type { AccessStore, AccessProfile, ClientCredential } from './index';
import { hashAccessSecret } from './index';

type AccessService = {
  ensureAccessProfile(userId: string): Promise<AccessProfile>;
  getActiveClientCredential(userId: string): Promise<ClientCredential>;
};

export type NodePublicConfig = {
  id: string;
  name: string;
  address: string;
  port: number;
  serverName: string;
  realityPublicKey: string;
  realityShortId: string;
};

export type SubscriptionRenderProfile = {
  userId: string;
  policyRevision: number;
  clientUuid: string;
};

export type SubscriptionNodeCandidate = {
  id: string;
  name: string;
  status: 'enrolled' | 'ready' | 'offline' | 'error';
  lastSeenAt: string | null;
  ackedRevision: number | null;
  publicConfig: Omit<NodePublicConfig, 'id' | 'name'> | null;
};

export interface SubscriptionNodeStore {
  listCandidates(userId: string): Promise<SubscriptionNodeCandidate[]>;
}

export class MemorySubscriptionNodeStore implements SubscriptionNodeStore {
  private readonly records: Array<{
    id: string;
    name: string;
    status: SubscriptionNodeCandidate['status'];
    lastSeenAt: string | null;
    ackedRevisionByUser: Record<string, number>;
    publicConfig: Omit<NodePublicConfig, 'id' | 'name'> | null;
  }> = [];

  seed(record: {
    id: string;
    name: string;
    status: SubscriptionNodeCandidate['status'];
    lastSeenAt: string | null;
    ackedRevisionByUser: Record<string, number>;
    publicConfig: Omit<NodePublicConfig, 'id' | 'name'> | null;
  }) {
    const index = this.records.findIndex((candidate) => candidate.id === record.id);
    const copy = {
      ...record,
      ackedRevisionByUser: { ...record.ackedRevisionByUser },
      publicConfig: record.publicConfig ? { ...record.publicConfig } : null,
    };
    if (index >= 0) this.records[index] = copy;
    else this.records.push(copy);
  }

  async listCandidates(userId: string) {
    return this.records.map((record) => ({
      id: record.id,
      name: record.name,
      status: record.status,
      lastSeenAt: record.lastSeenAt,
      ackedRevision: record.ackedRevisionByUser[userId] ?? null,
      publicConfig: record.publicConfig ? { ...record.publicConfig } : null,
    }));
  }
}

function formatHost(address: string) {
  return address.includes(':') && !address.startsWith('[') ? `[${address}]` : address;
}

export function renderSubscription(profile: SubscriptionRenderProfile, nodes: NodePublicConfig[]) {
  return nodes.map((node) => {
    const params = new URLSearchParams({
      encryption: 'none',
      security: 'reality',
      sni: node.serverName,
      fp: 'chrome',
      pbk: node.realityPublicKey,
      sid: node.realityShortId,
      type: 'tcp',
      flow: 'xtls-rprx-vision',
    });
    return `vless://${profile.clientUuid}@${formatHost(node.address)}:${node.port}?${params.toString()}#${encodeURIComponent(node.name)}`;
  }).join('\n');
}

export function createSubscriptionService(options: {
  accessStore: AccessStore;
  access: AccessService;
  nodes: SubscriptionNodeStore;
  staleAfterMs?: number;
}) {
  const staleAfterMs = options.staleAfterMs ?? 120_000;

  async function getRenderProfile(userId: string): Promise<SubscriptionRenderProfile> {
    const [profile, credential] = await Promise.all([
      options.access.ensureAccessProfile(userId),
      options.access.getActiveClientCredential(userId),
    ]);
    return {
      userId,
      policyRevision: profile.policyRevision,
      clientUuid: credential.uuid,
    };
  }

  async function listEligibleNodes(userId: string, now: Date): Promise<NodePublicConfig[]> {
    const profile = await options.access.ensureAccessProfile(userId);
    const cutoff = now.getTime() - staleAfterMs;
    const candidates = await options.nodes.listCandidates(userId);

    return candidates.flatMap((candidate) => {
      if (candidate.status !== 'ready' || !candidate.publicConfig) return [];
      const lastSeenAt = candidate.lastSeenAt ? new Date(candidate.lastSeenAt).getTime() : Number.NaN;
      if (!Number.isFinite(lastSeenAt) || lastSeenAt < cutoff) return [];
      if ((candidate.ackedRevision ?? 0) < profile.policyRevision) return [];
      return [{
        id: candidate.id,
        name: candidate.name,
        ...candidate.publicConfig,
      }];
    });
  }

  return {
    getRenderProfile,
    listEligibleNodes,

    async renderForToken(rawToken: string, now: Date) {
      const tokenHash = await hashAccessSecret(rawToken);
      const token = await options.accessStore.findActiveSubscriptionTokenByHash(tokenHash);
      if (!token) return null;
      const [profile, nodes] = await Promise.all([
        getRenderProfile(token.userId),
        listEligibleNodes(token.userId, now),
      ]);
      return renderSubscription(profile, nodes);
    },
  };
}
