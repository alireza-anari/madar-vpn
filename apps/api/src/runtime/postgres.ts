import { createAccessService } from '../access';
import { PostgresAccessStore } from '../access/postgres';
import { createSubscriptionService } from '../access/subscription';
import { PostgresSubscriptionNodeStore } from '../access/subscription-postgres';
import { createAdminAuditService } from '../admin-audit';
import { createAuthService } from '../auth';
import { PostgresAuthStore } from '../auth/postgres';
import { createCreditService } from '../credits';
import { PostgresCreditStore } from '../credits/postgres';
import { createMissionService } from '../missions';
import { PostgresMissionStore } from '../missions/postgres';
import { createNodeControlService } from '../nodes';
import { PostgresNodeControlStore } from '../nodes/postgres';
import { createPaymentService } from '../payments';
import { PostgresPaymentStore } from '../payments/postgres';
import { connectPostgres, type PgClientFactory } from '../postgres/client';
import { createPushService } from '../push';
import { PostgresPushStore } from '../push/postgres';
import { createVapidSender } from '../push/vapid';
import { createSurfaceService } from '../surfaces';
import { PostgresSurfaceStore } from '../surfaces/postgres';

export type HyperdriveBinding = {
  connectionString: string;
};

export type PostgresRuntimeBindings = {
  HYPERDRIVE?: HyperdriveBinding;
  ADMIN_EMAILS?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
};

function configuredAdminEmails(value: string | undefined) {
  return (value ?? '').split(',').map((email) => email.trim()).filter(Boolean);
}

function configuredVapid(env: PostgresRuntimeBindings | undefined) {
  if (!env?.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !env.VAPID_SUBJECT) return null;
  return {
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
    subject: env.VAPID_SUBJECT,
  };
}

export async function createPostgresRequestRuntime(
  env: PostgresRuntimeBindings | undefined,
  pgClientFactory: PgClientFactory,
) {
  const connectionString = env?.HYPERDRIVE?.connectionString?.trim();
  if (!connectionString) return null;

  const database = await connectPostgres(connectionString, pgClientFactory);
  const surfaceStore = new PostgresSurfaceStore(database);
  const creditStore = new PostgresCreditStore(database);
  const credits = createCreditService({ store: creditStore });
  const accessStore = new PostgresAccessStore(database);
  const access = createAccessService({ store: accessStore });
  const vapid = configuredVapid(env);

  const auth = createAuthService({
    store: new PostgresAuthStore(database),
    adminEmails: configuredAdminEmails(env?.ADMIN_EMAILS),
    onUserSuspension: async (event) => {
      await surfaceStore.appendAudit({
        id: crypto.randomUUID(),
        actorUserId: event.actorUserId,
        action: 'user.suspension.update',
        details: {
          userId: event.targetUserId,
          suspended: event.suspended,
          reason: event.reason,
        },
        createdAt: event.changedAt,
      });
    },
  });

  return {
    auth,
    access,
    surfaces: createSurfaceService({
      store: surfaceStore,
      credits,
      providerAvailability: {
        email: false,
        ads: false,
        payments: false,
        push: vapid !== null,
      },
    }),
    rewardedAds: null,
    subscriptions: createSubscriptionService({
      accessStore,
      access,
      nodes: new PostgresSubscriptionNodeStore(database),
    }),
    payments: createPaymentService({ store: new PostgresPaymentStore(database) }),
    missions: createMissionService({ store: new PostgresMissionStore(database) }),
    push: createPushService({
      store: new PostgresPushStore(database),
      publicKey: vapid?.publicKey,
      sender: vapid ? createVapidSender(vapid) : undefined,
    }),
    nodes: createNodeControlService({ store: new PostgresNodeControlStore(database) }),
    adminAudit: createAdminAuditService({ store: surfaceStore }),
  };
}

export type PostgresRequestRuntime = NonNullable<Awaited<ReturnType<typeof createPostgresRequestRuntime>>>;
