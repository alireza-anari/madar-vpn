import { Hono } from 'hono';
import { AuthError, createAuthService, serializeSessionCookie, type User } from './auth';
import { D1AuthStore, type D1DatabaseLike } from './auth/d1';
import { createCreditService } from './credits';
import { D1CreditStore } from './credits/d1';
import { createSurfaceService, SurfaceError } from './surfaces';
import { D1SurfaceStore } from './surfaces/d1';

type AuthService = ReturnType<typeof createAuthService>;
type SurfaceService = ReturnType<typeof createSurfaceService>;

type ApiBindings = {
  DB?: D1DatabaseLike;
  ADMIN_EMAILS?: string;
};

type AuthFactory = (env: ApiBindings | undefined) => AuthService | null;
type SurfaceFactory = (env: ApiBindings | undefined) => SurfaceService | null;

function configuredAdminEmails(value: string | undefined) {
  return (value ?? '')
    .split(',')
    .map((email) => email.trim())
    .filter(Boolean);
}

const defaultAuthFactory: AuthFactory = (env) => {
  if (!env?.DB) return null;
  return createAuthService({
    store: new D1AuthStore(env.DB),
    adminEmails: configuredAdminEmails(env.ADMIN_EMAILS),
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

function unavailable(c: { json: (body: { error: string }, status: 503) => Response }, error: string) {
  return c.json({ error }, 503);
}

async function requireAdminMutation(auth: AuthService, request: Request): Promise<User> {
  const actor = await auth.requireMutationUser(request);
  if (actor.role !== 'admin') {
    throw new AuthError(403, 'ADMIN_REQUIRED', 'Administrator role is required.');
  }
  return actor;
}

export function createApiApp(
  authFactory: AuthFactory = defaultAuthFactory,
  surfaceFactory: SurfaceFactory = defaultSurfaceFactory,
) {
  const app = new Hono<{ Bindings: ApiBindings }>();

  app.onError((error, c) => {
    if (error instanceof AuthError || error instanceof SurfaceError) {
      if (error.status === 400) return c.json({ error: error.code }, 400);
      if (error.status === 401) return c.json({ error: error.code }, 401);
      if (error.status === 403) return c.json({ error: error.code }, 403);
    }
    return c.json({ error: 'INTERNAL_ERROR' }, 500);
  });

  app.get('/api/health', (c) => c.json({ status: 'ok' as const }));

  app.post('/api/auth/request', async (c) => {
    const auth = authFactory(c.env);
    if (!auth) return unavailable(c, 'AUTH_UNAVAILABLE');

    const body = await c.req.json<{ email?: unknown }>().catch(() => null);
    if (!body || typeof body.email !== 'string') {
      return c.json({ error: 'REQUEST_INVALID' }, 400);
    }

    return c.json(await auth.requestLogin(body.email));
  });

  app.post('/api/auth/consume', async (c) => {
    const auth = authFactory(c.env);
    if (!auth) return unavailable(c, 'AUTH_UNAVAILABLE');

    const body = await c.req.json<{ token?: unknown }>().catch(() => null);
    if (!body || typeof body.token !== 'string' || body.token.length === 0) {
      return c.json({ error: 'REQUEST_INVALID' }, 400);
    }

    const session = await auth.consumeLoginToken(body.token);
    c.header('Set-Cookie', serializeSessionCookie(session.token, new Date(session.expiresAt)));
    return c.json({ csrfToken: session.csrfToken, expiresAt: session.expiresAt });
  });

  app.get('/api/account/identity', async (c) => {
    const auth = authFactory(c.env);
    if (!auth) return unavailable(c, 'AUTH_UNAVAILABLE');
    return c.json(await auth.requireUser(c.req.raw));
  });

  app.get('/api/admin/identity', async (c) => {
    const auth = authFactory(c.env);
    if (!auth) return unavailable(c, 'AUTH_UNAVAILABLE');
    return c.json(await auth.requireAdmin(c.req.raw));
  });

  app.get('/api/account', async (c) => {
    const auth = authFactory(c.env);
    const surfaces = surfaceFactory(c.env);
    if (!auth || !surfaces) return unavailable(c, 'ACCOUNT_UNAVAILABLE');
    const user = await auth.requireUser(c.req.raw);
    return c.json(await surfaces.getAccount(user));
  });

  app.post('/api/admin/settings', async (c) => {
    const auth = authFactory(c.env);
    const surfaces = surfaceFactory(c.env);
    if (!auth || !surfaces) return unavailable(c, 'ADMIN_UNAVAILABLE');
    const actor = await requireAdminMutation(auth, c.req.raw);
    const body = await c.req.json<unknown>().catch(() => null);
    return c.json(await surfaces.updateSettings(actor, body));
  });

  app.get('/api/admin/overview', async (c) => {
    const auth = authFactory(c.env);
    const surfaces = surfaceFactory(c.env);
    if (!auth || !surfaces) return unavailable(c, 'ADMIN_UNAVAILABLE');
    await auth.requireAdmin(c.req.raw);
    return c.json(await surfaces.getOverview());
  });

  app.get('/api/admin/resources', async (c) => {
    const auth = authFactory(c.env);
    const surfaces = surfaceFactory(c.env);
    if (!auth || !surfaces) return unavailable(c, 'ADMIN_UNAVAILABLE');
    await auth.requireAdmin(c.req.raw);
    return c.json(await surfaces.getAdminResources());
  });

  app.post('/api/admin/users/:id/free-credit', async (c) => {
    const auth = authFactory(c.env);
    const surfaces = surfaceFactory(c.env);
    if (!auth || !surfaces) return unavailable(c, 'ADMIN_UNAVAILABLE');
    const actor = await requireAdminMutation(auth, c.req.raw);
    const body = await c.req.json<unknown>().catch(() => null);
    return c.json(await surfaces.adjustFreeCredit(actor, c.req.param('id'), body));
  });

  app.post('/api/admin/users/:id/premium', async (c) => {
    const auth = authFactory(c.env);
    const surfaces = surfaceFactory(c.env);
    if (!auth || !surfaces) return unavailable(c, 'ADMIN_UNAVAILABLE');
    const actor = await requireAdminMutation(auth, c.req.raw);
    const body = await c.req.json<unknown>().catch(() => null);
    return c.json(await surfaces.adjustPremium(actor, c.req.param('id'), body));
  });

  app.put('/api/admin/plans/:id', async (c) => {
    const auth = authFactory(c.env);
    const surfaces = surfaceFactory(c.env);
    if (!auth || !surfaces) return unavailable(c, 'ADMIN_UNAVAILABLE');
    const actor = await requireAdminMutation(auth, c.req.raw);
    const body = await c.req.json<unknown>().catch(() => null);
    return c.json(await surfaces.upsertPlan(actor, c.req.param('id'), body));
  });

  app.delete('/api/admin/plans/:id', async (c) => {
    const auth = authFactory(c.env);
    const surfaces = surfaceFactory(c.env);
    if (!auth || !surfaces) return unavailable(c, 'ADMIN_UNAVAILABLE');
    const actor = await requireAdminMutation(auth, c.req.raw);
    await surfaces.deletePlan(actor, c.req.param('id'));
    return new Response(null, { status: 204 });
  });

  app.put('/api/admin/missions/:id', async (c) => {
    const auth = authFactory(c.env);
    const surfaces = surfaceFactory(c.env);
    if (!auth || !surfaces) return unavailable(c, 'ADMIN_UNAVAILABLE');
    const actor = await requireAdminMutation(auth, c.req.raw);
    const body = await c.req.json<unknown>().catch(() => null);
    return c.json(await surfaces.upsertMission(actor, c.req.param('id'), body));
  });

  app.delete('/api/admin/missions/:id', async (c) => {
    const auth = authFactory(c.env);
    const surfaces = surfaceFactory(c.env);
    if (!auth || !surfaces) return unavailable(c, 'ADMIN_UNAVAILABLE');
    const actor = await requireAdminMutation(auth, c.req.raw);
    await surfaces.deleteMission(actor, c.req.param('id'));
    return new Response(null, { status: 204 });
  });

  app.post('/api/admin/nodes', async (c) => {
    const auth = authFactory(c.env);
    const surfaces = surfaceFactory(c.env);
    if (!auth || !surfaces) return unavailable(c, 'ADMIN_UNAVAILABLE');
    const actor = await requireAdminMutation(auth, c.req.raw);
    const body = await c.req.json<unknown>().catch(() => null);
    return c.json(await surfaces.createNodeEnrollment(actor, body), 201);
  });

  app.delete('/api/admin/nodes/:id', async (c) => {
    const auth = authFactory(c.env);
    const surfaces = surfaceFactory(c.env);
    if (!auth || !surfaces) return unavailable(c, 'ADMIN_UNAVAILABLE');
    const actor = await requireAdminMutation(auth, c.req.raw);
    await surfaces.deleteNode(actor, c.req.param('id'));
    return new Response(null, { status: 204 });
  });

  app.post('/api/admin/notification-drafts', async (c) => {
    const auth = authFactory(c.env);
    const surfaces = surfaceFactory(c.env);
    if (!auth || !surfaces) return unavailable(c, 'ADMIN_UNAVAILABLE');
    const actor = await requireAdminMutation(auth, c.req.raw);
    const body = await c.req.json<unknown>().catch(() => null);
    return c.json(await surfaces.createNotificationDraft(actor, body), 201);
  });

  app.delete('/api/admin/notification-drafts/:id', async (c) => {
    const auth = authFactory(c.env);
    const surfaces = surfaceFactory(c.env);
    if (!auth || !surfaces) return unavailable(c, 'ADMIN_UNAVAILABLE');
    const actor = await requireAdminMutation(auth, c.req.raw);
    await surfaces.deleteNotificationDraft(actor, c.req.param('id'));
    return new Response(null, { status: 204 });
  });

  return app;
}

export default createApiApp();
