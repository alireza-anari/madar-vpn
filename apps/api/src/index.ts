import { Hono } from 'hono';
import { AuthError, createAuthService, serializeSessionCookie } from './auth';
import { D1AuthStore, type D1DatabaseLike } from './auth/d1';

type AuthService = ReturnType<typeof createAuthService>;

type ApiBindings = {
  DB?: D1DatabaseLike;
  ADMIN_EMAILS?: string;
};

type AuthFactory = (env: ApiBindings | undefined) => AuthService | null;

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

function authUnavailable(c: { json: (body: { error: string }, status: 503) => Response }) {
  return c.json({ error: 'AUTH_UNAVAILABLE' }, 503);
}

export function createApiApp(authFactory: AuthFactory = defaultAuthFactory) {
  const app = new Hono<{ Bindings: ApiBindings }>();

  app.onError((error, c) => {
    if (error instanceof AuthError) {
      if (error.status === 400) return c.json({ error: error.code }, 400);
      if (error.status === 401) return c.json({ error: error.code }, 401);
      if (error.status === 403) return c.json({ error: error.code }, 403);
    }
    return c.json({ error: 'INTERNAL_ERROR' }, 500);
  });

  app.get('/api/health', (c) => c.json({ status: 'ok' as const }));

  app.post('/api/auth/request', async (c) => {
    const auth = authFactory(c.env);
    if (!auth) return authUnavailable(c);

    const body = await c.req.json<{ email?: unknown }>().catch(() => null);
    if (!body || typeof body.email !== 'string') {
      return c.json({ error: 'REQUEST_INVALID' }, 400);
    }

    return c.json(await auth.requestLogin(body.email));
  });

  app.post('/api/auth/consume', async (c) => {
    const auth = authFactory(c.env);
    if (!auth) return authUnavailable(c);

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
    if (!auth) return authUnavailable(c);
    return c.json(await auth.requireUser(c.req.raw));
  });

  app.get('/api/admin/identity', async (c) => {
    const auth = authFactory(c.env);
    if (!auth) return authUnavailable(c);
    return c.json(await auth.requireAdmin(c.req.raw));
  });

  return app;
}

export default createApiApp();
