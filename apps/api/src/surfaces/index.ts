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

export type AdminUserSummary = Pick<User, 'id' | 'email' | 'role'>;

export type PlanRecord = {
  id: string;
  title: string;
  durationDays: number;
  priceMinor: number;
  currency: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type MissionRecord = {
  id: string;
  title: string;
  description: string;
  rewardSeconds: number;
  status: 'draft' | 'active' | 'paused';
  createdAt: string;
  updatedAt: string;
};

export type AdminNodeRecord = {
  id: string;
  name: string;
  status: 'enrolled' | 'ready' | 'offline' | 'error';
  lastSeenAt: string | null;
  createdAt: string;
};

export type NotificationDraftRecord = {
  id: string;
  title: string;
  body: string;
  target: string;
  createdBy: string;
  createdAt: string;
  deliveryStatus: 'draft';
};

export type AuditEntry = {
  id: string;
  actorUserId: string;
  action: string;
  details: Record<string, unknown>;
  createdAt: string;
};

export type AdminResources = {
  users: AdminUserSummary[];
  plans: PlanRecord[];
  missions: MissionRecord[];
  nodes: AdminNodeRecord[];
  notificationDrafts: NotificationDraftRecord[];
  audit: AuditEntry[];
};

export interface SurfaceStore {
  getNodeState(userId: string): Promise<NodeState>;
  getSettings(): Promise<AdminSettings>;
  saveSettings(settings: AdminSettings): Promise<void>;
  getCounts(): Promise<AdminCounts>;
  appendAudit(entry: AuditEntry): Promise<void>;
  listUsers(): Promise<AdminUserSummary[]>;
  listPlans(): Promise<PlanRecord[]>;
  savePlan(plan: PlanRecord): Promise<void>;
  deletePlan(id: string): Promise<void>;
  listMissions(): Promise<MissionRecord[]>;
  saveMission(mission: MissionRecord): Promise<void>;
  deleteMission(id: string): Promise<void>;
  listNodes(): Promise<AdminNodeRecord[]>;
  saveNode(node: AdminNodeRecord): Promise<void>;
  deleteNode(id: string): Promise<void>;
  listNotificationDrafts(): Promise<NotificationDraftRecord[]>;
  saveNotificationDraft(draft: NotificationDraftRecord): Promise<void>;
  deleteNotificationDraft(id: string): Promise<void>;
  listAudit(): Promise<AuditEntry[]>;
}

const DEFAULT_SETTINGS: AdminSettings = {
  freeSpeedKbps: 256,
  notificationsEnabled: false,
};

export class MemorySurfaceStore implements SurfaceStore {
  settings: AdminSettings = { ...DEFAULT_SETTINGS };
  readonly audit: AuditEntry[] = [];
  readonly users: AdminUserSummary[] = [];
  readonly plans: PlanRecord[] = [];
  readonly missions: MissionRecord[] = [];
  readonly nodes: AdminNodeRecord[] = [];
  readonly notificationDrafts: NotificationDraftRecord[] = [];
  private countsOverride: AdminCounts | null = null;
  private readonly nodeStates = new Map<string, NodeState>();

  setCounts(counts: AdminCounts) {
    this.countsOverride = { ...counts };
  }

  seedUser(user: AdminUserSummary) {
    const index = this.users.findIndex((candidate) => candidate.id === user.id);
    if (index >= 0) this.users[index] = { ...user };
    else this.users.push({ ...user });
  }

  setNodeState(userId: string, state: NodeState) {
    this.nodeStates.set(userId, { ...state });
  }

  async getNodeState(userId: string) {
    return (
      this.nodeStates.get(userId) ?? {
        ready: (this.countsOverride?.readyNodes ?? this.nodes.filter((node) => node.status === 'ready').length) > 0,
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
    if (this.countsOverride) return { ...this.countsOverride };
    return {
      users: this.users.length,
      readyNodes: this.nodes.filter((node) => node.status === 'ready').length,
      plans: this.plans.length,
      missions: this.missions.length,
    };
  }

  async appendAudit(entry: AuditEntry) {
    this.audit.push({ ...entry, details: { ...entry.details } });
  }

  async listUsers() {
    return this.users.map((user) => ({ ...user }));
  }

  async listPlans() {
    return this.plans.map((plan) => ({ ...plan }));
  }

  async savePlan(plan: PlanRecord) {
    const index = this.plans.findIndex((candidate) => candidate.id === plan.id);
    if (index >= 0) this.plans[index] = { ...plan };
    else this.plans.push({ ...plan });
  }

  async deletePlan(id: string) {
    const index = this.plans.findIndex((plan) => plan.id === id);
    if (index >= 0) this.plans.splice(index, 1);
  }

  async listMissions() {
    return this.missions.map((mission) => ({ ...mission }));
  }

  async saveMission(mission: MissionRecord) {
    const index = this.missions.findIndex((candidate) => candidate.id === mission.id);
    if (index >= 0) this.missions[index] = { ...mission };
    else this.missions.push({ ...mission });
  }

  async deleteMission(id: string) {
    const index = this.missions.findIndex((mission) => mission.id === id);
    if (index >= 0) this.missions.splice(index, 1);
  }

  async listNodes() {
    return this.nodes.map((node) => ({ ...node }));
  }

  async saveNode(node: AdminNodeRecord) {
    const index = this.nodes.findIndex((candidate) => candidate.id === node.id);
    if (index >= 0) this.nodes[index] = { ...node };
    else this.nodes.push({ ...node });
  }

  async deleteNode(id: string) {
    const index = this.nodes.findIndex((node) => node.id === id);
    if (index >= 0) this.nodes.splice(index, 1);
  }

  async listNotificationDrafts() {
    return this.notificationDrafts.map((draft) => ({ ...draft }));
  }

  async saveNotificationDraft(draft: NotificationDraftRecord) {
    const index = this.notificationDrafts.findIndex((candidate) => candidate.id === draft.id);
    if (index >= 0) this.notificationDrafts[index] = { ...draft };
    else this.notificationDrafts.push({ ...draft });
  }

  async deleteNotificationDraft(id: string) {
    const index = this.notificationDrafts.findIndex((draft) => draft.id === id);
    if (index >= 0) this.notificationDrafts.splice(index, 1);
  }

  async listAudit() {
    return this.audit.map((entry) => ({ ...entry, details: { ...entry.details } }));
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

function objectInput(input: unknown, code: string) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new SurfaceError(400, code, 'Payload is invalid.');
  }
  return input as Record<string, unknown>;
}

function requiredText(value: unknown, code: string, maxLength = 240) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength) {
    throw new SurfaceError(400, code, 'Text value is invalid.');
  }
  return value.trim();
}

function validateResourceId(id: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(id)) {
    throw new SurfaceError(400, 'RESOURCE_ID_INVALID', 'Resource id is invalid.');
  }
  return id;
}

function validateSettings(input: unknown): AdminSettings {
  const candidate = objectInput(input, 'SETTINGS_INVALID');
  if (
    !Number.isSafeInteger(candidate.freeSpeedKbps) ||
    Number(candidate.freeSpeedKbps) < 64 ||
    Number(candidate.freeSpeedKbps) > 1_000_000 ||
    typeof candidate.notificationsEnabled !== 'boolean'
  ) {
    throw new SurfaceError(400, 'SETTINGS_INVALID', 'Settings payload is invalid.');
  }
  return {
    freeSpeedKbps: Number(candidate.freeSpeedKbps),
    notificationsEnabled: candidate.notificationsEnabled,
  };
}

function validatePlan(id: string, input: unknown, timestamp: string, existing?: PlanRecord): PlanRecord {
  const candidate = objectInput(input, 'PLAN_INVALID');
  const durationDays = Number(candidate.durationDays);
  const priceMinor = Number(candidate.priceMinor);
  if (
    !Number.isSafeInteger(durationDays) || durationDays <= 0 ||
    !Number.isSafeInteger(priceMinor) || priceMinor < 0 ||
    typeof candidate.enabled !== 'boolean'
  ) {
    throw new SurfaceError(400, 'PLAN_INVALID', 'Plan payload is invalid.');
  }
  const currency = requiredText(candidate.currency, 'PLAN_INVALID', 8).toUpperCase();
  return {
    id: validateResourceId(id),
    title: requiredText(candidate.title, 'PLAN_INVALID', 120),
    durationDays,
    priceMinor,
    currency,
    enabled: candidate.enabled,
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
  };
}

function validateMission(id: string, input: unknown, timestamp: string, existing?: MissionRecord): MissionRecord {
  const candidate = objectInput(input, 'MISSION_INVALID');
  const rewardSeconds = Number(candidate.rewardSeconds);
  if (!Number.isSafeInteger(rewardSeconds) || rewardSeconds < 0) {
    throw new SurfaceError(400, 'MISSION_INVALID', 'Mission reward is invalid.');
  }
  if (!['draft', 'active', 'paused'].includes(String(candidate.status))) {
    throw new SurfaceError(400, 'MISSION_INVALID', 'Mission status is invalid.');
  }
  return {
    id: validateResourceId(id),
    title: requiredText(candidate.title, 'MISSION_INVALID', 120),
    description: requiredText(candidate.description, 'MISSION_INVALID', 1000),
    rewardSeconds,
    status: candidate.status as MissionRecord['status'],
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
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

  async function audit(actor: User, action: string, details: Record<string, unknown>) {
    await options.store.appendAudit({
      id: crypto.randomUUID(),
      actorUserId: actor.id,
      action,
      details,
      createdAt: now().toISOString(),
    });
  }

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
      await audit(actor, 'settings.update', { ...settings });
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

    async getAdminResources(): Promise<AdminResources> {
      const [users, plans, missions, nodes, notificationDrafts, auditEntries] = await Promise.all([
        options.store.listUsers(),
        options.store.listPlans(),
        options.store.listMissions(),
        options.store.listNodes(),
        options.store.listNotificationDrafts(),
        options.store.listAudit(),
      ]);
      return { users, plans, missions, nodes, notificationDrafts, audit: auditEntries };
    },

    async upsertPlan(actor: User, id: string, input: unknown) {
      const existing = (await options.store.listPlans()).find((plan) => plan.id === id);
      const plan = validatePlan(id, input, now().toISOString(), existing);
      await options.store.savePlan(plan);
      await audit(actor, 'plan.upsert', { id: plan.id, enabled: plan.enabled });
      return plan;
    },

    async deletePlan(actor: User, id: string) {
      const resourceId = validateResourceId(id);
      await options.store.deletePlan(resourceId);
      await audit(actor, 'plan.delete', { id: resourceId });
    },

    async upsertMission(actor: User, id: string, input: unknown) {
      const existing = (await options.store.listMissions()).find((mission) => mission.id === id);
      const mission = validateMission(id, input, now().toISOString(), existing);
      await options.store.saveMission(mission);
      await audit(actor, 'mission.upsert', { id: mission.id, status: mission.status });
      return mission;
    },

    async deleteMission(actor: User, id: string) {
      const resourceId = validateResourceId(id);
      await options.store.deleteMission(resourceId);
      await audit(actor, 'mission.delete', { id: resourceId });
    },

    async createNodeEnrollment(actor: User, input: unknown) {
      const candidate = objectInput(input, 'NODE_INVALID');
      const timestamp = now().toISOString();
      const node: AdminNodeRecord = {
        id: crypto.randomUUID(),
        name: requiredText(candidate.name, 'NODE_INVALID', 120),
        status: 'enrolled',
        lastSeenAt: null,
        createdAt: timestamp,
      };
      await options.store.saveNode(node);
      await audit(actor, 'node.enroll-record.create', { id: node.id, status: node.status });
      return node;
    },

    async deleteNode(actor: User, id: string) {
      const resourceId = validateResourceId(id);
      await options.store.deleteNode(resourceId);
      await audit(actor, 'node.delete', { id: resourceId });
    },

    async createNotificationDraft(actor: User, input: unknown) {
      const candidate = objectInput(input, 'NOTIFICATION_INVALID');
      const draft: NotificationDraftRecord = {
        id: crypto.randomUUID(),
        title: requiredText(candidate.title, 'NOTIFICATION_INVALID', 120),
        body: requiredText(candidate.body, 'NOTIFICATION_INVALID', 1000),
        target: requiredText(candidate.target, 'NOTIFICATION_INVALID', 120),
        createdBy: actor.id,
        createdAt: now().toISOString(),
        deliveryStatus: 'draft',
      };
      await options.store.saveNotificationDraft(draft);
      await audit(actor, 'notification.draft.create', { id: draft.id, target: draft.target });
      return draft;
    },

    async deleteNotificationDraft(actor: User, id: string) {
      const resourceId = validateResourceId(id);
      await options.store.deleteNotificationDraft(resourceId);
      await audit(actor, 'notification.draft.delete', { id: resourceId });
    },
  };
}
