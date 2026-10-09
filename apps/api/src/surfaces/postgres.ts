import type { PgDatabase } from '../postgres/client';
import type {
  AdminCounts,
  AdminNodeRecord,
  AdminSettings,
  AdminUserSummary,
  AuditEntry,
  MissionRecord,
  NotificationDraftRecord,
  PlanRecord,
  SurfaceStore,
} from './index';

type QueryDatabase = Pick<PgDatabase, 'query'>;

type NodeStateRow = Record<string, unknown> & { ready: boolean; connected: boolean };
type SettingsRow = Record<string, unknown> & { free_speed_kbps: number; notifications_enabled: boolean };
type CountsRow = Record<string, unknown> & { users: number; ready_nodes: number; plans: number; missions: number };
type UserRow = Record<string, unknown> & { id: string; email: string; role: 'user' | 'admin' };
type PlanRow = Record<string, unknown> & {
  id: string;
  title: string;
  duration_days: number;
  price_minor: number | string | bigint;
  currency: string;
  enabled: boolean;
  created_at: Date | string;
  updated_at: Date | string;
};
type MissionRow = Record<string, unknown> & {
  id: string;
  title: string;
  description: string;
  reward_seconds: number;
  status: MissionRecord['status'];
  verification_kind: MissionRecord['verificationKind'];
  created_at: Date | string;
  updated_at: Date | string;
};
type NodeRow = Record<string, unknown> & {
  id: string;
  name: string;
  status: AdminNodeRecord['status'];
  last_seen_at: Date | string | null;
  created_at: Date | string;
};
type NotificationRow = Record<string, unknown> & {
  id: string;
  title: string;
  body: string;
  target: string;
  created_by: string;
  created_at: Date | string;
};
type AuditRow = Record<string, unknown> & {
  id: string;
  actor_user_id: string;
  action: string;
  details_json: unknown;
  created_at: Date | string;
};

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toNullableIso(value: Date | string | null): string | null {
  return value === null ? null : toIso(value);
}

function parseDetails(value: unknown): Record<string, unknown> {
  const parsed = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? { ...(parsed as Record<string, unknown>) }
    : {};
}

function mapPlan(row: PlanRow): PlanRecord {
  return {
    id: row.id,
    title: row.title,
    durationDays: row.duration_days,
    priceMinor: Number(row.price_minor),
    currency: row.currency,
    enabled: row.enabled,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function mapMission(row: MissionRow): MissionRecord {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    rewardSeconds: row.reward_seconds,
    status: row.status,
    verificationKind: row.verification_kind,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function mapNode(row: NodeRow): AdminNodeRecord {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    lastSeenAt: toNullableIso(row.last_seen_at),
    createdAt: toIso(row.created_at),
  };
}

function mapNotification(row: NotificationRow): NotificationDraftRecord {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    target: row.target,
    createdBy: row.created_by,
    createdAt: toIso(row.created_at),
    deliveryStatus: 'draft',
  };
}

function mapAudit(row: AuditRow): AuditEntry {
  return {
    id: row.id,
    actorUserId: row.actor_user_id,
    action: row.action,
    details: parseDetails(row.details_json),
    createdAt: toIso(row.created_at),
  };
}

export class PostgresSurfaceStore implements SurfaceStore {
  constructor(private readonly db: QueryDatabase) {}

  async getNodeState(userId: string) {
    const result = await this.db.query<NodeStateRow>(
      `SELECT
         EXISTS(SELECT 1 FROM nodes WHERE status = 'ready') AS ready,
         EXISTS(
           SELECT 1 FROM usage_sessions
           WHERE user_id = $1 AND ended_at IS NULL
         ) AS connected`,
      [userId],
    );
    const row = result.rows[0];
    return {
      ready: row?.ready ?? false,
      connectionStatus: row?.connected ? ('connected' as const) : ('disconnected' as const),
      configAvailable: false,
    };
  }

  async getSettings(): Promise<AdminSettings> {
    const result = await this.db.query<SettingsRow>(
      `SELECT free_speed_kbps, notifications_enabled
       FROM app_settings
       WHERE id = 1
       LIMIT 1`,
    );
    const row = result.rows[0];
    return {
      freeSpeedKbps: row?.free_speed_kbps ?? 5000,
      notificationsEnabled: row?.notifications_enabled ?? false,
    };
  }

  async saveSettings(settings: AdminSettings) {
    await this.db.query(
      `INSERT INTO app_settings (id, free_speed_kbps, notifications_enabled, updated_at)
       VALUES (1, $1, $2, $3::timestamptz)
       ON CONFLICT (id) DO UPDATE SET
         free_speed_kbps = EXCLUDED.free_speed_kbps,
         notifications_enabled = EXCLUDED.notifications_enabled,
         updated_at = EXCLUDED.updated_at`,
      [settings.freeSpeedKbps, settings.notificationsEnabled, new Date().toISOString()],
    );
  }

  async getCounts(): Promise<AdminCounts> {
    const result = await this.db.query<CountsRow>(
      `SELECT
         (SELECT COUNT(*)::int FROM users) AS users,
         (SELECT COUNT(*)::int FROM nodes WHERE status = 'ready') AS ready_nodes,
         (SELECT COUNT(*)::int FROM plans) AS plans,
         (SELECT COUNT(*)::int FROM missions) AS missions`,
    );
    const row = result.rows[0];
    return {
      users: row?.users ?? 0,
      readyNodes: row?.ready_nodes ?? 0,
      plans: row?.plans ?? 0,
      missions: row?.missions ?? 0,
    };
  }

  async appendAudit(entry: AuditEntry) {
    await this.db.query(
      `INSERT INTO audit_log (id, actor_user_id, action, details_json, created_at)
       VALUES ($1, $2, $3, $4::jsonb, $5::timestamptz)`,
      [entry.id, entry.actorUserId, entry.action, JSON.stringify(entry.details), entry.createdAt],
    );
  }

  async listUsers(): Promise<AdminUserSummary[]> {
    const result = await this.db.query<UserRow>(
      `SELECT id, email, role
       FROM users
       ORDER BY verified_at DESC, id ASC`,
    );
    return result.rows.map((row) => ({ id: row.id, email: row.email, role: row.role }));
  }

  async listPlans(): Promise<PlanRecord[]> {
    const result = await this.db.query<PlanRow>(
      `SELECT id, title, duration_days, price_minor, currency, enabled, created_at, updated_at
       FROM plans
       ORDER BY created_at DESC, id ASC`,
    );
    return result.rows.map(mapPlan);
  }

  async savePlan(plan: PlanRecord) {
    await this.db.query(
      `INSERT INTO plans (
         id, title, duration_days, price_minor, currency, enabled, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz)
       ON CONFLICT (id) DO UPDATE SET
         title = EXCLUDED.title,
         duration_days = EXCLUDED.duration_days,
         price_minor = EXCLUDED.price_minor,
         currency = EXCLUDED.currency,
         enabled = EXCLUDED.enabled,
         updated_at = EXCLUDED.updated_at`,
      [
        plan.id,
        plan.title,
        plan.durationDays,
        plan.priceMinor,
        plan.currency,
        plan.enabled,
        plan.createdAt,
        plan.updatedAt,
      ],
    );
  }

  async deletePlan(id: string) {
    await this.db.query('DELETE FROM plans WHERE id = $1', [id]);
  }

  async listMissions(): Promise<MissionRecord[]> {
    const result = await this.db.query<MissionRow>(
      `SELECT id, title, description, reward_seconds, status, verification_kind, created_at, updated_at
       FROM missions
       ORDER BY created_at DESC, id ASC`,
    );
    return result.rows.map(mapMission);
  }

  async saveMission(mission: MissionRecord) {
    await this.db.query(
      `INSERT INTO missions (
         id, title, description, reward_seconds, status, verification_kind, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz)
       ON CONFLICT (id) DO UPDATE SET
         title = EXCLUDED.title,
         description = EXCLUDED.description,
         reward_seconds = EXCLUDED.reward_seconds,
         status = EXCLUDED.status,
         verification_kind = EXCLUDED.verification_kind,
         updated_at = EXCLUDED.updated_at`,
      [
        mission.id,
        mission.title,
        mission.description,
        mission.rewardSeconds,
        mission.status,
        mission.verificationKind,
        mission.createdAt,
        mission.updatedAt,
      ],
    );
  }

  async deleteMission(id: string) {
    await this.db.query('DELETE FROM missions WHERE id = $1', [id]);
  }

  async listNodes(): Promise<AdminNodeRecord[]> {
    const result = await this.db.query<NodeRow>(
      `SELECT id, name, status, last_seen_at, created_at
       FROM nodes
       ORDER BY created_at DESC, id ASC`,
    );
    return result.rows.map(mapNode);
  }

  async saveNode(node: AdminNodeRecord) {
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

  async deleteNode(id: string) {
    await this.db.query('DELETE FROM nodes WHERE id = $1', [id]);
  }

  async listNotificationDrafts(): Promise<NotificationDraftRecord[]> {
    const result = await this.db.query<NotificationRow>(
      `SELECT id, title, body, target, created_by, created_at
       FROM notification_drafts
       ORDER BY created_at DESC, id ASC`,
    );
    return result.rows.map(mapNotification);
  }

  async saveNotificationDraft(draft: NotificationDraftRecord) {
    await this.db.query(
      `INSERT INTO notification_drafts (id, title, body, target, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::timestamptz)
       ON CONFLICT (id) DO UPDATE SET
         title = EXCLUDED.title,
         body = EXCLUDED.body,
         target = EXCLUDED.target`,
      [draft.id, draft.title, draft.body, draft.target, draft.createdBy, draft.createdAt],
    );
  }

  async deleteNotificationDraft(id: string) {
    await this.db.query('DELETE FROM notification_drafts WHERE id = $1', [id]);
  }

  async listAudit(): Promise<AuditEntry[]> {
    const result = await this.db.query<AuditRow>(
      `SELECT id, actor_user_id, action, details_json, created_at
       FROM audit_log
       ORDER BY created_at DESC, id ASC
       LIMIT 200`,
    );
    return result.rows.map(mapAudit);
  }
}
