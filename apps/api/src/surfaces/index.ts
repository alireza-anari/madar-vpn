import type { User } from '../auth';
import type { Entitlement } from '../credits';

type CreditReader = {
  getEntitlement(userId: string, now: Date): Promise<Entitlement>;
};

export type ProviderAvailability = {
  email: boolean;
  ads: boolean;
  payments: boolean;
  push: boolean;
};

export type NodeState = {
  ready: boolean;
  connectionStatus: 'connected' | 'disconnected';
  configAvailable: boolean;
};

export type AdminSettings = {
  freeSpeedKbps: number;
  notificationsEnabled: boolean;
};

export type AdminCounts = {
  users: number;
  readyNodes: number;
  plans: number;
  missions: number;
};

export type AuditEntry = {
  id: string;
  actorUserId: string;
  action: string;
  details: Record<string, unknown>;
  createdAt: string;
};

export interface SurfaceStore {
  getNodeState(userId: string): Promise<NodeState>;
  getSettings(): Promise<AdminSettings>;
  saveSettings(settings: AdminSettings): Promise<void>;
  getCounts(): Promise<AdminCounts>;
  appendAudit(entry: AuditEntry): Promise<void>;
}

const DEFAULT_SETTINGS: AdminSettings = {
  freeSpeedKbps: 256,
  notificationsEnabled: false,
};

export class MemorySurfaceStore implements SurfaceStore {
  settings: AdminSettings = { ...DEFAULT_SETTINGS };
  readonly audit: AuditEntry[] = [];
  private counts: AdminCounts = { users: 0, readyNodes: 0, plans: 0, missions: 0 };
  private readonly nodeStates = new Map<string, NodeState>();

  setCounts(counts: AdminCounts) {
    this.counts = { ...counts };
  }

  setNodeState(userId: string, state: NodeState) {
    this.nodeStates.set(userId, { ...state });
  }

  async getNodeState(userId: string) {
    return (
      this.nodeStates.get(userId) ?? {
        ready: this.counts.readyNodes > 0,
        connectionStatus: 'disconnected' as const,
        configAvailable: false,
      }
    );
  }

  async getSettings() {
    return { ...this.settings };
  }

  async saveSettings(settings: AdminSettings) {
    this.settings = { ...settings };
  }

  async getCounts() {
    return { ...this.counts };
  }

  async appendAudit(entry: AuditEntry) {
    this.audit.push({ ...entry, details: { ...entry.details } });
  }
}

export class SurfaceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SurfaceError';
  }
}

function validateSettings(input: unknown): AdminSettings {
  if (!input || typeof input !== 'object') {
    throw new SurfaceError(400, 'SETTINGS_INVALID', 'Settings payload is invalid.');
  }
  const candidate = input as Partial<AdminSettings>;
  if (
    !Number.isSafeInteger(candidate.freeSpeedKbps) ||
    (candidate.freeSpeedKbps ?? 0) < 64 ||
    (candidate.freeSpeedKbps ?? 0) > 1_000_000 ||
    typeof candidate.notificationsEnabled !== 'boolean'
  ) {
    throw new SurfaceError(400, 'SETTINGS_INVALID', 'Settings payload is invalid.');
  }
  return {
    freeSpeedKbps: candidate.freeSpeedKbps as number,
    notificationsEnabled: candidate.notificationsEnabled,
  };
}

export function createSurfaceService(options: {
  store: SurfaceStore;
  credits: CreditReader;
  providerAvailability?: ProviderAvailability;
  now?: () => Date;
}) {
  const providerAvailability: ProviderAvailability = options.providerAvailability ?? {
    email: false,
    ads: false,
    payments: false,
    push: false,
  };
  const now = options.now ?? (() => new Date());

  return {
    async getAccount(user: User) {
      const [entitlement, node] = await Promise.all([
        options.credits.getEntitlement(user.id, now()),
        options.store.getNodeState(user.id),
      ]);
      return {
        identity: { id: user.id, email: user.email, role: user.role },
        entitlement,
        node,
        providers: { ...providerAvailability },
      };
    },

    async updateSettings(actor: User, input: unknown) {
      const settings = validateSettings(input);
      await options.store.saveSettings(settings);
      await options.store.appendAudit({
        id: crypto.randomUUID(),
        actorUserId: actor.id,
        action: 'settings.update',
        details: { ...settings },
        createdAt: now().toISOString(),
      });
      return settings;
    },

    async getOverview() {
      const [counts, settings] = await Promise.all([options.store.getCounts(), options.store.getSettings()]);
      return {
        counts,
        readiness: {
          nodes: counts.readyNodes > 0,
          ...providerAvailability,
        },
        settings,
      };
    },
  };
}
