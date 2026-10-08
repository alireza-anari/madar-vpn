import type { D1DatabaseLike } from '../auth/d1';
import type { AdminCounts, AdminSettings, AuditEntry, SurfaceStore } from './index';

type NodeRow = { ready: number; connected: number };
type SettingsRow = { free_speed_kbps: number; notifications_enabled: number };
type CountsRow = { users: number; ready_nodes: number; plans: number; missions: number };

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
}
