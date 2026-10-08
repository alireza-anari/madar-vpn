import { Hono } from 'hono';
import { createAccessService } from './access';
import { D1AccessStore } from './access/d1';
import { createSubscriptionService } from './access/subscription';
import { D1SubscriptionNodeStore } from './access/subscription-d1';
import { AuthError, createAuthService, serializeSessionCookie, type User } from './auth';
import { D1AuthStore, type D1DatabaseLike } from './auth/d1';
import { createCreditService } from './credits';
import { D1CreditStore } from './credits/d1';
import { ProviderUnavailableError, ProviderVerificationError } from './providers';
import { RewardedAdSettlementError, type RewardedAdSettlement } from './providers/rewarded-ad';
import { createSurfaceService, SurfaceError } from './surfaces';
import { D1SurfaceStore } from './surfaces/d1';

type AuthService = ReturnType<typeof createAuthService>;
type SurfaceService = ReturnType<typeof createSurfaceService>;
type SubscriptionService = Pick<ReturnType<typeof createSubscriptionService>, 'renderForToken'>;
type ApiBindings = { DB?: D1DatabaseLike; ADMIN_EMAILS?: string };
type AuthFactory = (env: ApiBindings | undefined) => AuthService | null;
type SurfaceFactory = (env: ApiBindings | undefined) => SurfaceService | null;
type RewardedAdFactory = (env: ApiBindings | undefined) => RewardedAdSettlement | null;
type SubscriptionFactory = (env: ApiBindings | undefined) => SubscriptionService | null;

function configuredAdminEmails(value: string | undefined) {
  return (value ?? '').split(',').map((email) => email.trim()).filter(Boolean);
}

const defaultAuthFactory: AuthFactory = (env) => {
  if (!env?.DB) return null;
  const auditStore = new D1SurfaceStore(env.DB);
  return createAuthService({
    store: new D1AuthStore(env.DB),
    adminEmails: configuredAdminEmails(env.ADMIN_EMAILS),
    onUserSuspension: async (event) => {
      await auditStore.appendAudit({
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
};

const defaultSurfaceFactory: SurfaceFactory = (env) => {
  if (!env?.DB) return null;
  return createSurfaceService({
    store: new D1SurfaceStore(env.DB),
    credits: createCreditService({ store: new D1CreditStore(env.DB) }),
    providerAvailability: { email: false, ads: false, payments: false, push: false },
  });
};

const defaultRewardedAdFactory: RewardedAdFactory = () => null;

const defaultSubscriptionFactory: SubscriptionFactory = (env) => {
  if (!env?.DB) return null;
  const accessStore = new D1AccessStore(env.DB);
  return createSubscriptionService({
    accessStore,
    access: createAccessService({ store: accessStore }),
    nodes: new D1SubscriptionNodeStore(env.DB),
  });
};

function unavailable(c: { json: (body: { error: string }, status: 503) => Response }, error: string) {
  return c.json({ error }, 503);
}

async function requireAdminMutation(auth: AuthService, request: Request): Promise<User> {
  const actor = await auth.requireMutationUser(request);
  if (actor.role !== 'admin') throw new AuthError(403, 'ADMIN_REQUIRED', 'Administrator role is required.');
  return actor;
}

export function createApiApp(
  authFactory: AuthFactory = defaultAuthFactory,
  surfaceFactory: SurfaceFactory = defaultSurfaceFactory,
  rewardedAdFactory: RewardedAdFactory = defaultRewardedAdFactory,
  subscriptionFactory: SubscriptionFactory = defaultSubscriptionFactory,
) {
  const app = new Hono<{ Bindings: ApiBindings }>();

  app.onError((error, c) => {
    if (error instanceof AuthError || error instanceof SurfaceError || error instanceof RewardedAdSettlementError) {
      if (error.status === 400) return c.json({ error: error.code }, 400);
      if (error.status === 401) return c.json({ error: error.code }, 401);
      if (error.status === 403) return c.json({ error: error.code }, 403);
    }
    if (error instanceof ProviderVerificationError) return c.json({ error: error.code }, 403);
    if (error instanceof ProviderUnavailableError) return c.json({ error: error.code }, 503);
    return c.json({ error: 'INTERNAL_ERROR' }, 500);
  });

  app.get('/api/health', (c) => c.json({ status: 'ok' as const }));

  app.get('/s/:token', async (c) => {
    c.header('Cache-Control', 'no-store');
    const subscriptions = subscriptionFactory(c.env);
    if (!subscriptions) return c.text('Not found', 404);
    const rendered = await subscriptions.renderForToken(c.req.param('token'), new Date());
    if (rendered === null) return c.text('Not found', 404);
    c.header('Content-Type', 'text/plain; charset=utf-8');
    return c.body(rendered);
  });

  app.post('/api/providers/ads/callback', async (c) => {
    const settlement = rewardedAdFactory(c.env);
    if (!settlement) return unavailable(c, 'ADS_UNAVAILABLE');
    return c.json(await settlement.settle(c.req.raw));
  });

  app.post('/api/auth/request', async (c) => {
    const auth = authFactory(c.env); if (!auth) return unavailable(c, 'AUTH_UNAVAILABLE');
    const body = await c.req.json<{ email?: unknown }>().catch(() => null);
    if (!body || typeof body.email !== 'string') return c.json({ error: 'REQUEST_INVALID' }, 400);
    return c.json(await auth.requestLogin(body.email));
  });

  app.post('/api/auth/consume', async (c) => {
    const auth = authFactory(c.env); if (!auth) return unavailable(c, 'AUTH_UNAVAILABLE');
    const body = await c.req.json<{ token?: unknown }>().catch(() => null);
    if (!body || typeof body.token !== 'string' || body.token.length === 0) return c.json({ error: 'REQUEST_INVALID' }, 400);
    const session = await auth.consumeLoginToken(body.token);
    c.header('Set-Cookie', serializeSessionCookie(session.token, new Date(session.expiresAt)));
    return c.json({ csrfToken: session.csrfToken, expiresAt: session.expiresAt });
  });

  app.get('/api/account/identity', async (c) => {
    const auth = authFactory(c.env); if (!auth) return unavailable(c, 'AUTH_UNAVAILABLE');
    return c.json(await auth.requireUser(c.req.raw));
  });

  app.get('/api/admin/identity', async (c) => {
    const auth = authFactory(c.env); if (!auth) return unavailable(c, 'AUTH_UNAVAILABLE');
    return c.json(await auth.requireAdmin(c.req.raw));
  });

  app.get('/api/account', async (c) => {
    const auth = authFactory(c.env); const surfaces = surfaceFactory(c.env);
    if (!auth || !surfaces) return unavailable(c, 'ACCOUNT_UNAVAILABLE');
    return c.json(await surfaces.getAccount(await auth.requireUser(c.req.raw)));
  });

  app.post('/api/admin/settings', async (c) => {
    const auth = authFactory(c.env); const surfaces = surfaceFactory(c.env);
    if (!auth || !surfaces) return unavailable(c, 'ADMIN_UNAVAILABLE');
    const actor = await requireAdminMutation(auth, c.req.raw);
    return c.json(await surfaces.updateSettings(actor, await c.req.json<unknown>().catch(() => null)));
  });

  app.get('/api/admin/overview', async (c) => {
    const auth = authFactory(c.env); const surfaces = surfaceFactory(c.env);
    if (!auth || !surfaces) return unavailable(c, 'ADMIN_UNAVAILABLE');
    await auth.requireAdmin(c.req.raw); return c.json(await surfaces.getOverview());
  });

  app.get('/api/admin/resources', async (c) => {
    const auth = authFactory(c.env); const surfaces = surfaceFactory(c.env);
    if (!auth || !surfaces) return unavailable(c, 'ADMIN_UNAVAILABLE');
    await auth.requireAdmin(c.req.raw); return c.json(await surfaces.getAdminResources());
  });

  app.post('/api/admin/users/:id/suspension', async (c) => {
    const auth = authFactory(c.env); if (!auth) return unavailable(c, 'ADMIN_UNAVAILABLE');
    const actor = await requireAdminMutation(auth, c.req.raw);
    const body = await c.req.json<{ suspended?: unknown; reason?: unknown }>().catch(() => null);
    if (!body || typeof body.suspended !== 'boolean' || typeof body.reason !== 'string') {
      return c.json({ error: 'SUSPENSION_INVALID' }, 400);
    }
    return c.json(await auth.setUserSuspension(actor, c.req.param('id'), body.suspended, body.reason));
  });

  app.post('/api/admin/users/:id/free-credit', async (c) => {
    const auth = authFactory(c.env); const surfaces = surfaceFactory(c.env);
    if (!auth || !surfaces) return unavailable(c, 'ADMIN_UNAVAILABLE');
    const actor = await requireAdminMutation(auth, c.req.raw);
    return c.json(await surfaces.adjustFreeCredit(actor, c.req.param('id'), await c.req.json<unknown>().catch(() => null)));
  });

  app.post('/api/admin/users/:id/premium', async (c) => {
    const auth = authFactory(c.env); const surfaces = surfaceFactory(c.env);
    if (!auth || !surfaces) return unavailable(c, 'ADMIN_UNAVAILABLE');
    const actor = await requireAdminMutation(auth, c.req.raw);
    return c.json(await surfaces.adjustPremium(actor, c.req.param('id'), await c.req.json<unknown>().catch(() => null)));
  });

  app.put('/api/admin/plans/:id', async (c) => {
    const auth = authFactory(c.env); const surfaces = surfaceFactory(c.env);
    if (!auth || !surfaces) return unavailable(c, 'ADMIN_UNAVAILABLE');
    const actor = await requireAdminMutation(auth, c.req.raw);
    return c.json(await surfaces.upsertPlan(actor, c.req.param('id'), await c.req.json<unknown>().catch(() => null)));
  });

  app.delete('/api/admin/plans/:id', async (c) => {
    const auth = authFactory(c.env); const surfaces = surfaceFactory(c.env);
    if (!auth || !surfaces) return unavailable(c, 'ADMIN_UNAVAILABLE');
    const actor = await requireAdminMutation(auth, c.req.raw); await surfaces.deletePlan(actor, c.req.param('id'));
    return new Response(null, { status: 204 });
  });

  app.put('/api/admin/missions/:id', async (c) => {
    const auth = authFactory(c.env); const surfaces = surfaceFactory(c.env);
    if (!auth || !surfaces) return unavailable(c, 'ADMIN_UNAVAILABLE');
    const actor = await requireAdminMutation(auth, c.req.raw);
    return c.json(await surfaces.upsertMission(actor, c.req.param('id'), await c.req.json<unknown>().catch(() => null)));
  });

  app.delete('/api/admin/missions/:id', async (c) => {
    const auth = authFactory(c.env); const surfaces = surfaceFactory(c.env);
    if (!auth || !surfaces) return unavailable(c, 'ADMIN_UNAVAILABLE');
    const actor = await requireAdminMutation(auth, c.req.raw); await surfaces.deleteMission(actor, c.req.param('id'));
    return new Response(null, { status: 204 });
  });

  app.post('/api/admin/nodes', async (c) => {
    const auth = authFactory(c.env); const surfaces = surfaceFactory(c.env);
    if (!auth || !surfaces) return unavailable(c, 'ADMIN_UNAVAILABLE');
    const actor = await requireAdminMutation(auth, c.req.raw);
    return c.json(await surfaces.createNodeEnrollment(actor, await c.req.json<unknown>().catch(() => null)), 201);
  });

  app.delete('/api/admin/nodes/:id', async (c) => {
    const auth = authFactory(c.env); const surfaces = surfaceFactory(c.env);
    if (!auth || !surfaces) return unavailable(c, 'ADMIN_UNAVAILABLE');
    const actor = await requireAdminMutation(auth, c.req.raw); await surfaces.deleteNode(actor, c.req.param('id'));
    return new Response(null, { status: 204 });
  });

  app.post('/api/admin/notification-drafts', async (c) => {
    const auth = authFactory(c.env); const surfaces = surfaceFactory(c.env);
    if (!auth || !surfaces) return unavailable(c, 'ADMIN_UNAVAILABLE');
    const actor = await requireAdminMutation(auth, c.req.raw);
    return c.json(await surfaces.createNotificationDraft(actor, await c.req.json<unknown>().catch(() => null)), 201);
  });

  app.delete('/api/admin/notification-drafts/:id', async (c) => {
    const auth = authFactory(c.env); const surfaces = surfaceFactory(c.env);
    if (!auth || !surfaces) return unavailable(c, 'ADMIN_UNAVAILABLE');
    const actor = await requireAdminMutation(auth, c.req.raw); await surfaces.deleteNotificationDraft(actor, c.req.param('id'));
    return new Response(null, { status: 204 });
  });

  return app;
}

export default createApiApp();
