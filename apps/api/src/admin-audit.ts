import type { User } from './auth';
import type { SurfaceStore } from './surfaces';

export type AdminAuditService = ReturnType<typeof createAdminAuditService>;

export function createAdminAuditService(options: {
  store: Pick<SurfaceStore, 'appendAudit'>;
  now?: () => Date;
}) {
  const now = options.now ?? (() => new Date());

  return {
    async record(actor: User, action: string, details: Record<string, unknown>) {
      await options.store.appendAudit({
        id: crypto.randomUUID(),
        actorUserId: actor.id,
        action,
        details: { ...details },
        createdAt: now().toISOString(),
      });
    },
  };
}
