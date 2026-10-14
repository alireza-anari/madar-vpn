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
import { PostgresPolicyPublisher } from '../nodes/policy-postgres';
import { createPaymentService } from '../payments';
import { PostgresPaymentStore } from '../payments/postgres';
import { connectPostgres, type PgClientFactory } from '../postgres/client';
import { createResendMagicLinkSender } from '../providers/resend-email';
import { createPushService } from '../push';
import { PostgresPushStore } from '../push/postgres';
import { createVapidSender } from '../push/vapid';
import { createWebPushTransport, validateVapidKeyPair } from '../push/web-push';
import { createSurfaceService } from '../surfaces';
import { PostgresSurfaceStore } from '../surfaces/postgres';
import { PostgresUsageSettlementStore } from '../usage/postgres';

export type HyperdriveBinding = {
  connectionString: string;
};

export type PostgresRuntimeBindings = {
  HYPERDRIVE?: HyperdriveBinding;
  ADMIN_EMAILS?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
  RESEND_API_KEY?: string;
  RESEND_FROM?: string;
  MAGIC_LINK_BASE_URL?: string;
  STAGING_EMAIL_ALLOWLIST?: string;
};

function configuredAdminEmails(value: string | undefined) {
  return (value ?? '').split(',').map((email) => email.trim()).filter(Boolean);
}

async function configuredVapid(env: PostgresRuntimeBindings | undefined) {
  if (!env?.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !env.VAPID_SUBJECT) return null;
  const config = { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT };
  try {
    const sender = createVapidSender(config, createWebPushTransport());
    await validateVapidKeyPair({ ...config, publicKey: config.publicKey.trim(), privateKey: config.privateKey.trim(), subject: config.subject.trim() });
    return { publicKey: config.publicKey.trim(), sender };
  } catch {
    return null;
  }
}

function configuredEmailSender(env: PostgresRuntimeBindings | undefined) {
  const apiKey = env?.RESEND_API_KEY?.trim();
  const from = env?.RESEND_FROM?.trim();
  const baseUrl = env?.MAGIC_LINK_BASE_URL?.trim();
  const allowedEmails = (env?.STAGING_EMAIL_ALLOWLIST ?? '')
    .split(',')
    .map((email) => email.trim())
    .filter(Boolean);
  if (!apiKey || !from || !baseUrl || allowedEmails.length === 0) return null;
  return createResendMagicLinkSender({ apiKey, from, baseUrl, allowedEmails });
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
  const vapid = await configuredVapid(env);
  const emailSender = configuredEmailSender(env);

  const auth = createAuthService({
    store: new PostgresAuthStore(database),
    adminEmails: configuredAdminEmails(env?.ADMIN_EMAILS),
    sender: emailSender ?? undefined,
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
        email: emailSender !== null,
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
      sender: vapid?.sender,
    }),
    nodes: createNodeControlService({
      store: new PostgresNodeControlStore(database),
      policyPublisher: new PostgresPolicyPublisher(database),
      telemetrySettlement: new PostgresUsageSettlementStore(database),
    }),
    adminAudit: createAdminAuditService({ store: surfaceStore }),
  };
}

export type PostgresRequestRuntime = NonNullable<Awaited<ReturnType<typeof createPostgresRequestRuntime>>>;
