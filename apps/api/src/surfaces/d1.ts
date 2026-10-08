import type { D1DatabaseLike, D1PreparedStatementLike } from '../auth/d1';
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

type NodeRow = { ready: number; connected: number };
type SettingsRow = { free_speed_kbps: number; notifications_enabled: number };
type CountsRow = { users: number; ready_nodes: number; plans: number; missions: number };
type UserRow = { id: string; email: string; role: 'user' | 'admin' };
type PlanRow = {
  id: string;
  title: string;
  duration_days: number;
  price_minor: number;
  currency: string;
  enabled: number;
  created_at: string;
  updated_at: string;
};
type MissionRow = {
  id: string;
  title: string;
  description: string;
  reward_seconds: number;
  status: 'draft' | 'active' | 'paused';
  created_at: string;
  updated_at: string;
};
type AdminNodeRow = {
  id: string;
  name: string;
  status: 'enrolled' | 'ready' | 'offline' | 'error';
  last_seen_at: string | null;
  created_at: string;
};
type NotificationRow = {
  id: string;
  title: string;
  body: string;
  target: string;
  created_by: string;
  created_at: string;
};
type AuditRow = {
  id: string;
  actor_user_id: string;
  action: string;
  details_json: string;
  created_at: string;
};

type D1ListStatement = D1PreparedStatementLike & {
  all<T>(): Promise<{ results?: T[] }>;
};

async function allRows<T>(statement: D1PreparedStatementLike) {
  const result = await (statement as D1ListStatement).all<T>();
  return result.results ?? [];
}

function parseDetails(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export class D1SurfaceStore implements SurfaceStore {
  constructor(private readonly db: D1DatabaseLike) {}

  async getNodeState(userId: string) {
    const row = await this.db
      .prepare(
        `SELECT
           EXISTS(SELECT 1 FROM nodes WHERE status = 'ready') AS ready,
           EXISTS(
             SELECT 1 FROM usage_sessions
             WHERE user_id = ? AND ended_at IS NULL
           ) AS connected`,
      )
      .bind(userId)
      .first<NodeRow>();
    return {
      ready: (row?.ready ?? 0) === 1,
      connectionStatus: (row?.connected ?? 0) === 1 ? ('connected' as const) : ('disconnected' as const),
      configAvailable: false,
    };
  }

  async getSettings(): Promise<AdminSettings> {
    const row = await this.db
      .prepare('SELECT free_speed_kbps, notifications_enabled FROM app_settings WHERE id = 1 LIMIT 1')
      .first<SettingsRow>();
    return {
      freeSpeedKbps: row?.free_speed_kbps ?? 256,
      notificationsEnabled: (row?.notifications_enabled ?? 0) === 1,
    };
  }

  async saveSettings(settings: AdminSettings) {
    await this.db
      .prepare(
        `INSERT INTO app_settings (id, free_speed_kbps, notifications_enabled, updated_at)
         VALUES (1, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           free_speed_kbps = excluded.free_speed_kbps,
           notifications_enabled = excluded.notifications_enabled,
           updated_at = excluded.updated_at`,
      )
      .bind(settings.freeSpeedKbps, settings.notificationsEnabled ? 1 : 0, new Date().toISOString())
      .run();
  }

  async getCounts(): Promise<AdminCounts> {
    const row = await this.db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM users) AS users,
           (SELECT COUNT(*) FROM nodes WHERE status = 'ready') AS ready_nodes,
           (SELECT COUNT(*) FROM plans) AS plans,
           (SELECT COUNT(*) FROM missions) AS missions`,
      )
      .first<CountsRow>();
    return {
      users: Number(row?.users ?? 0),
      readyNodes: Number(row?.ready_nodes ?? 0),
      plans: Number(row?.plans ?? 0),
      missions: Number(row?.missions ?? 0),
    };
  }

  async appendAudit(entry: AuditEntry) {
    await this.db
      .prepare(
        `INSERT INTO audit_log (id, actor_user_id, action, details_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(entry.id, entry.actorUserId, entry.action, JSON.stringify(entry.details), entry.createdAt)
      .run();
  }

  async listUsers(): Promise<AdminUserSummary[]> {
    return allRows<UserRow>(this.db.prepare('SELECT id, email, role FROM users ORDER BY verified_at DESC'));
  }

  async listPlans(): Promise<PlanRecord[]> {
    const rows = await allRows<PlanRow>(this.db.prepare('SELECT * FROM plans ORDER BY created_at DESC'));
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      durationDays: row.duration_days,
      priceMinor: row.price_minor,
      currency: row.currency,
      enabled: row.enabled === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  async savePlan(plan: PlanRecord) {
    await this.db
      .prepare(
        `INSERT INTO plans (id, title, duration_days, price_minor, currency, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           duration_days = excluded.duration_days,
           price_minor = excluded.price_minor,
           currency = excluded.currency,
           enabled = excluded.enabled,
           updated_at = excluded.updated_at`,
      )
      .bind(
        plan.id,
        plan.title,
        plan.durationDays,
        plan.priceMinor,
        plan.currency,
        plan.enabled ? 1 : 0,
        plan.createdAt,
        plan.updatedAt,
      )
      .run();
  }

  async deletePlan(id: string) {
    await this.db.prepare('DELETE FROM plans WHERE id = ?').bind(id).run();
  }

  async listMissions(): Promise<MissionRecord[]> {
    const rows = await allRows<MissionRow>(this.db.prepare('SELECT * FROM missions ORDER BY created_at DESC'));
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      description: row.description,
      rewardSeconds: row.reward_seconds,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  async saveMission(mission: MissionRecord) {
    await this.db
      .prepare(
        `INSERT INTO missions (id, title, description, reward_seconds, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           description = excluded.description,
           reward_seconds = excluded.reward_seconds,
           status = excluded.status,
           updated_at = excluded.updated_at`,
      )
      .bind(
        mission.id,
        mission.title,
        mission.description,
        mission.rewardSeconds,
        mission.status,
        mission.createdAt,
        mission.updatedAt,
      )
      .run();
  }

  async deleteMission(id: string) {
    await this.db.prepare('DELETE FROM missions WHERE id = ?').bind(id).run();
  }

  async listNodes(): Promise<AdminNodeRecord[]> {
    const rows = await allRows<AdminNodeRow>(this.db.prepare('SELECT * FROM nodes ORDER BY created_at DESC'));
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      status: row.status,
      lastSeenAt: row.last_seen_at,
      createdAt: row.created_at,
    }));
  }

  async saveNode(node: AdminNodeRecord) {
    await this.db
      .prepare(
        `INSERT INTO nodes (id, name, status, last_seen_at, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           status = excluded.status,
           last_seen_at = excluded.last_seen_at`,
      )
      .bind(node.id, node.name, node.status, node.lastSeenAt, node.createdAt)
      .run();
  }

  async deleteNode(id: string) {
    await this.db.prepare('DELETE FROM nodes WHERE id = ?').bind(id).run();
  }

  async listNotificationDrafts(): Promise<NotificationDraftRecord[]> {
    const rows = await allRows<NotificationRow>(
      this.db.prepare('SELECT * FROM notification_drafts ORDER BY created_at DESC'),
    );
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      body: row.body,
      target: row.target,
      createdBy: row.created_by,
      createdAt: row.created_at,
      deliveryStatus: 'draft',
    }));
  }

  async saveNotificationDraft(draft: NotificationDraftRecord) {
    await this.db
      .prepare(
        `INSERT INTO notification_drafts (id, title, body, target, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           body = excluded.body,
           target = excluded.target`,
      )
      .bind(draft.id, draft.title, draft.body, draft.target, draft.createdBy, draft.createdAt)
      .run();
  }

  async deleteNotificationDraft(id: string) {
    await this.db.prepare('DELETE FROM notification_drafts WHERE id = ?').bind(id).run();
  }

  async listAudit(): Promise<AuditEntry[]> {
    const rows = await allRows<AuditRow>(
      this.db.prepare('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 200'),
    );
    return rows.map((row) => ({
      id: row.id,
      actorUserId: row.actor_user_id,
      action: row.action,
      details: parseDetails(row.details_json),
      createdAt: row.created_at,
    }));
  }
}
