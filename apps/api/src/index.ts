import { Hono } from 'hono';
import { createAccessService } from './access';
import { createSubscriptionService } from './access/subscription';
import type { AdminAuditService } from './admin-audit';
import { AuthError, clearSessionCookie, createAuthService, serializeSessionCookie, type User } from './auth';
import { createMissionService, MissionError } from './missions';
import { NodeControlError, type NodeControlService } from './nodes';
import { PaymentError, type PaymentService } from './payments';
import { ProviderUnavailableError, ProviderVerificationError } from './providers';
import { RewardedAdSettlementError, type RewardedAdSettlement } from './providers/rewarded-ad';
import { PushError, type PushService } from './push';
import { consumeRateLimit, type RateLimitBinding } from './rate-limit';
import { createSurfaceService, SurfaceError } from './surfaces';

type AuthService = ReturnType<typeof createAuthService>;
type AccessService = Pick<ReturnType<typeof createAccessService>, 'rotateSubscriptionToken'>;
type SurfaceService = ReturnType<typeof createSurfaceService>;
type FullSubscriptionService = ReturnType<typeof createSubscriptionService>;
type SubscriptionService = Pick<FullSubscriptionService, 'renderForToken'> & Partial<Pick<FullSubscriptionService, 'listEligibleNodes'>>;
type MissionService = ReturnType<typeof createMissionService>;
type ApiBindings = {
  ADMIN_EMAILS?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
  LOGIN_RATE_LIMITER?: RateLimitBinding;
  SUBSCRIPTION_RATE_LIMITER?: RateLimitBinding;
  NODE_ENROLLMENT_RATE_LIMITER?: RateLimitBinding;
  PROVIDER_CALLBACK_RATE_LIMITER?: RateLimitBinding;
  ADMIN_RATE_LIMITER?: RateLimitBinding;
};
type AuthFactory = (env: ApiBindings | undefined) => AuthService | null;
type AccessFactory = (env: ApiBindings | undefined) => AccessService | null;
type SurfaceFactory = (env: ApiBindings | undefined) => SurfaceService | null;
type RewardedAdFactory = (env: ApiBindings | undefined) => RewardedAdSettlement | null;
type SubscriptionFactory = (env: ApiBindings | undefined) => SubscriptionService | null;
type PaymentFactory = (env: ApiBindings | undefined) => PaymentService | null;
type MissionFactory = (env: ApiBindings | undefined) => MissionService | null;
type PushFactory = (env: ApiBindings | undefined) => PushService | null;
type NodeFactory = (env: ApiBindings | undefined) => NodeControlService | null;
type AdminAuditFactory = (env: ApiBindings | undefined) => AdminAuditService | null;

const unavailableAuthFactory: AuthFactory = () => null;
const unavailableAccessFactory: AccessFactory = () => null;
const unavailableSurfaceFactory: SurfaceFactory = () => null;
const unavailableRewardedAdFactory: RewardedAdFactory = () => null;
const unavailableSubscriptionFactory: SubscriptionFactory = () => null;
const unavailablePaymentFactory: PaymentFactory = () => null;
const unavailableMissionFactory: MissionFactory = () => null;
const unavailablePushFactory: PushFactory = () => null;
const unavailableNodeFactory: NodeFactory = () => null;
const unavailableAdminAuditFactory: AdminAuditFactory = () => null;

function unavailable(c: { json: (body: { error: string }, status: 503) => Response }, error: string) {
  return c.json({ error }, 503);
}

async function requireAdminMutation(auth: AuthService, request: Request): Promise<User> {
  const actor = await auth.requireMutationUser(request);
  if (actor.role !== 'admin') throw new AuthError(403, 'ADMIN_REQUIRED', 'Administrator role is required.');
  return actor;
}

function requireBearerSecret(request: Request, code: 'NODE_CREDENTIAL_INVALID' | 'NODE_ENROLLMENT_TOKEN_INVALID') {
  const authorization = request.headers.get('authorization');
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();
  if (!token) throw new NodeControlError(401, code, 'Bearer credential is required.');
  return token;
}

async function requireNode(nodes: NodeControlService, request: Request) {
  return nodes.authenticateNode(requireBearerSecret(request, 'NODE_CREDENTIAL_INVALID'));
}

async function enforceProviderCallbackRateLimit(
  c: { env?: ApiBindings; req: { raw: Request }; header: (name: string, value: string) => void; json: (body: { error: string }, status: 429) => Response },
  scope: 'provider-ad' | 'provider-payment',
) {
  const edgeSource = c.req.raw.headers.get('cf-connecting-ip')?.trim() || 'unknown-edge-source';
  const allowed = await consumeRateLimit(c.env?.PROVIDER_CALLBACK_RATE_LIMITER, scope, edgeSource);
  if (allowed) return null;
  c.header('Retry-After', '60');
  return c.json({ error: 'RATE_LIMITED' }, 429);
}

export function createApiApp(
  authFactory: AuthFactory = unavailableAuthFactory,
  surfaceFactory: SurfaceFactory = unavailableSurfaceFactory,
  rewardedAdFactory: RewardedAdFactory = unavailableRewardedAdFactory,
  subscriptionFactory: SubscriptionFactory = unavailableSubscriptionFactory,
  paymentFactory: PaymentFactory = unavailablePaymentFactory,
  missionFactory: MissionFactory = unavailableMissionFactory,
  pushFactory: PushFactory = unavailablePushFactory,
  nodeFactory: NodeFactory = unavailableNodeFactory,
  adminAuditFactory: AdminAuditFactory = unavailableAdminAuditFactory,
  accessFactory: AccessFactory = unavailableAccessFactory,
) {
  const app = new Hono<{ Bindings: ApiBindings }>();

  app.use('/api/admin/*', async (c, next) => {
    const edgeSource = c.req.raw.headers.get('cf-connecting-ip')?.trim() || 'unknown-edge-source';
    const allowed = await consumeRateLimit(c.env?.ADMIN_RATE_LIMITER, 'admin', edgeSource);
    if (!allowed) {
      c.header('Retry-After', '60');
      return c.json({ error: 'RATE_LIMITED' }, 429);
    }
    await next();
  });

  app.onError((error, c) => {
    if (error instanceof AuthError || error instanceof SurfaceError || error instanceof RewardedAdSettlementError) {
      if (error.status === 400) return c.json({ error: error.code }, 400);
      if (error.status === 401) return c.json({ error: error.code }, 401);
      if (error.status === 403) return c.json({ error: error.code }, 403);
    }
    if (error instanceof PaymentError) {
      if (error.status === 400) return c.json({ error: error.code }, 400);
      return c.json({ error: error.code }, 404);
    }
    if (error instanceof MissionError) {
      if (error.status === 400) return c.json({ error: error.code }, 400);
      if (error.status === 403) return c.json({ error: error.code }, 403);
      if (error.status === 404) return c.json({ error: error.code }, 404);
      if (error.status === 409) return c.json({ error: error.code }, 409);
    }
    if (error instanceof PushError) {
      if (error.status === 400) return c.json({ error: error.code }, 400);
      if (error.status === 403) return c.json({ error: error.code }, 403);
      return c.json({ error: error.code }, 503);
    }
    if (error instanceof NodeControlError) {
      if (error.status === 400) return c.json({ error: error.code }, 400);
      if (error.status === 401) return c.json({ error: error.code }, 401);
      if (error.status === 404) return c.json({ error: error.code }, 404);
      if (error.status === 409) return c.json({ error: error.code }, 409);
    }
    if (error instanceof ProviderVerificationError) return c.json({ error: error.code }, 403);
    if (error instanceof ProviderUnavailableError) return c.json({ error: error.code }, 503);
    return c.json({ error: 'INTERNAL_ERROR' }, 500);
  });

  app.get('/api/health', (c) => c.json({ status: 'ok' as const }));

  app.get('/s/:token', async (c) => {
    c.header('Cache-Control', 'no-store');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Robots-Tag', 'noindex, nofollow, noarchive');
    c.header('X-Content-Type-Options', 'nosniff');
    const token = c.req.param('token');
    const allowed = await consumeRateLimit(c.env?.SUBSCRIPTION_RATE_LIMITER, 'subscription', token);
    if (!allowed) {
      c.header('Retry-After', '60');
      return c.text('Too Many Requests', 429);
    }
    const subscriptions = subscriptionFactory(c.env);
    if (!subscriptions) return c.text('Not found', 404);
    const rendered = await subscriptions.renderForToken(token, new Date());
    if (rendered === null) return c.text('Not found', 404);
    c.header('Content-Type', 'text/plain; charset=utf-8');
    return c.body(rendered);
  });

  app.post('/api/providers/ads/callback', async (c) => {
    const limited = await enforceProviderCallbackRateLimit(c, 'provider-ad');
    if (limited) return limited;
    const settlement = rewardedAdFactory(c.env);
    if (!settlement) return unavailable(c, 'ADS_UNAVAILABLE');
    return c.json(await settlement.settle(c.req.raw));
  });

  app.post('/api/providers/payments/callback', async (c) => {
    const limited = await enforceProviderCallbackRateLimit(c, 'provider-payment');
    if (limited) return limited;
    const payments = paymentFactory(c.env);
    if (!payments) return unavailable(c, 'PAYMENTS_UNAVAILABLE');
    return c.json(await payments.settleProviderCallback(c.req.raw));
  });

  app.get('/api/auth/readiness', (c) => {
    const auth = authFactory(c.env); if (!auth) return unavailable(c, 'AUTH_UNAVAILABLE');
    c.header('Cache-Control', 'no-store');
    return c.json(auth.getReadiness());
  });

  app.post('/api/auth/request', async (c) => {
    const body = await c.req.json<{ email?: unknown }>().catch(() => null);
    if (!body || typeof body.email !== 'string') return c.json({ error: 'REQUEST_INVALID' }, 400);
    const emailKey = body.email.trim().toLowerCase();
    const allowed = await consumeRateLimit(c.env?.LOGIN_RATE_LIMITER, 'login', emailKey);
    if (!allowed) {
      c.header('Retry-After', '60');
      return c.json({ error: 'RATE_LIMITED' }, 429);
    }
    const auth = authFactory(c.env); if (!auth) return unavailable(c, 'AUTH_UNAVAILABLE');
    return c.json(await auth.requestLogin(body.email));
  });

  app.post('/api/auth/consume', async (c) => {
    const auth = authFactory(c.env); if (!auth) return unavailable(c, 'AUTH_UNAVAILABLE');
    const body = await c.req.json<{ token?: unknown }>().catch(() => null);
    if (!body || typeof body.token !== 'string' || body.token.length === 0) return c.json({ error: 'REQUEST_INVALID' }, 400);
    const session = await auth.consumeLoginToken(body.token);
    c.header('Cache-Control', 'no-store');
    c.header('Set-Cookie', serializeSessionCookie(session.token, new Date(session.expiresAt)));
    return c.json({ csrfToken: session.csrfToken, expiresAt: session.expiresAt });
  });

  app.get('/api/auth/csrf', async (c) => {
    const auth = authFactory(c.env); if (!auth) return unavailable(c, 'AUTH_UNAVAILABLE');
    c.header('Cache-Control', 'no-store');
    return c.json({ csrfToken: await auth.issueCsrfToken(c.req.raw) });
  });

  app.post('/api/auth/logout', async (c) => {
    const auth = authFactory(c.env); if (!auth) return unavailable(c, 'AUTH_UNAVAILABLE');
    await auth.revokeCurrentSession(c.req.raw);
    c.header('Set-Cookie', clearSessionCookie());
    return c.body(null, 204);
  });

  app.get('/api/account/identity', async (c) => {
    const auth = authFactory(c.env); if (!auth) return unavailable(c, 'AUTH_UNAVAILABLE');
    return c.json(await auth.requireUser(c.req.raw));
  });

  app.get('/api/admin/identity', async (c) => {
    const auth = authFactory(c.env); if (!auth) return unavailable(c, 'AUTH_UNAVAILABLE');
    return c.json(await auth.requireAdmin(c.req.raw));
  });

  app.post('/api/admin/nodes/enrollment-token', async (c) => {
    const auth = authFactory(c.env); const nodes = nodeFactory(c.env);
    if (!auth || !nodes) return unavailable(c, 'NODE_CONTROL_UNAVAILABLE');
    const actor = await requireAdminMutation(auth, c.req.raw);
    const body = await c.req.json<unknown>().catch(() => null);
    c.header('Cache-Control', 'no-store');
    const issued = await nodes.createEnrollmentToken(actor.id, body, new Date());
    const audit = adminAuditFactory(c.env);
    if (audit) {
      await audit.record(actor, 'node.enrollment-token.issue', {
        nodeId: issued.node.id,
        expiresAt: issued.expiresAt,
      });
    }
    return c.json(issued, 201);
  });

  app.post('/api/node/enroll', async (c) => {
    c.header('Cache-Control', 'no-store');
    const enrollmentToken = requireBearerSecret(c.req.raw, 'NODE_ENROLLMENT_TOKEN_INVALID');
    const allowed = await consumeRateLimit(c.env?.NODE_ENROLLMENT_RATE_LIMITER, 'node-enrollment', enrollmentToken);
    if (!allowed) {
      c.header('Retry-After', '60');
      return c.json({ error: 'RATE_LIMITED' }, 429);
    }
    const nodes = nodeFactory(c.env);
    if (!nodes) return unavailable(c, 'NODE_CONTROL_UNAVAILABLE');
    const body = await c.req.json<{ capabilities?: unknown; publicConfig?: unknown }>().catch(() => null);
    if (!body) return c.json({ error: 'NODE_ENROLLMENT_INVALID' }, 400);
    return c.json(await nodes.enrollNode(
      enrollmentToken,
      body.capabilities,
      body.publicConfig,
    ), 201);
  });

  app.post('/api/node/heartbeat', async (c) => {
    const nodes = nodeFactory(c.env);
    if (!nodes) return unavailable(c, 'NODE_CONTROL_UNAVAILABLE');
    const principal = await requireNode(nodes, c.req.raw);
    const body = await c.req.json<{ health?: unknown; versions?: unknown; capacity?: unknown }>().catch(() => null);
    if (!body) return c.json({ error: 'NODE_HEARTBEAT_INVALID' }, 400);
    return c.json(await nodes.heartbeatNode(principal.nodeId, body.health, body.versions, body.capacity));
  });

  app.get('/api/node/policy', async (c) => {
    const nodes = nodeFactory(c.env);
    if (!nodes) return unavailable(c, 'NODE_CONTROL_UNAVAILABLE');
    const principal = await requireNode(nodes, c.req.raw);
    const knownRevision = Number(c.req.query('knownRevision') ?? '0');
    const policy = await nodes.getNodePolicy(principal.nodeId, knownRevision);
    if (policy === null) return new Response(null, { status: 204 });
    c.header('Cache-Control', 'no-store');
    return c.json(policy);
  });

  app.post('/api/node/policy/ack', async (c) => {
    const nodes = nodeFactory(c.env);
    if (!nodes) return unavailable(c, 'NODE_CONTROL_UNAVAILABLE');
    const principal = await requireNode(nodes, c.req.raw);
    const body = await c.req.json<{ revision?: unknown }>().catch(() => null);
    if (!body) return c.json({ error: 'NODE_POLICY_REVISION_INVALID' }, 400);
    return c.json(await nodes.ackNodePolicy(principal.nodeId, Number(body.revision)));
  });

  app.post('/api/node/telemetry', async (c) => {
    const nodes = nodeFactory(c.env);
    if (!nodes) return unavailable(c, 'NODE_CONTROL_UNAVAILABLE');
    const principal = await requireNode(nodes, c.req.raw);
    const body = await c.req.json<{ reports?: unknown }>().catch(() => null);
    if (!body) return c.json({ error: 'TELEMETRY_INVALID' }, 400);
    return c.json(await nodes.postTelemetry(principal.nodeId, body.reports));
  });

  app.get('/api/account', async (c) => {
    const auth = authFactory(c.env); const surfaces = surfaceFactory(c.env);
    if (!auth || !surfaces) return unavailable(c, 'ACCOUNT_UNAVAILABLE');
    return c.json(await surfaces.getAccount(await auth.requireUser(c.req.raw)));
  });

  app.get('/api/account/access', async (c) => {
    const auth = authFactory(c.env); const subscriptions = subscriptionFactory(c.env);
    if (!auth || !subscriptions?.listEligibleNodes) return unavailable(c, 'ACCESS_UNAVAILABLE');
    const user = await auth.requireUser(c.req.raw);
    const eligibleNodes = await subscriptions.listEligibleNodes(user.id, new Date());
    c.header('Cache-Control', 'no-store');
    return c.json({ ready: eligibleNodes.length > 0, eligibleNodeCount: eligibleNodes.length });
  });

  app.post('/api/account/access/subscription-url', async (c) => {
    const auth = authFactory(c.env); const subscriptions = subscriptionFactory(c.env); const access = accessFactory(c.env);
    if (!auth || !access || !subscriptions?.listEligibleNodes) return unavailable(c, 'ACCESS_UNAVAILABLE');
    const user = await auth.requireMutationUser(c.req.raw);
    const eligibleNodes = await subscriptions.listEligibleNodes(user.id, new Date());
    c.header('Cache-Control', 'no-store');
    c.header('Referrer-Policy', 'no-referrer');
    if (eligibleNodes.length === 0) return c.json({ error: 'ACCESS_NOT_READY' }, 409);
    const issued = await access.rotateSubscriptionToken(user.id);
    const subscriptionUrl = new URL(`/s/${encodeURIComponent(issued.rawToken)}`, c.req.url).toString();
    return c.json({ subscriptionUrl, version: issued.version }, 201);
  });

  app.post('/api/account/orders', async (c) => {
    const auth = authFactory(c.env); const payments = paymentFactory(c.env);
    if (!auth || !payments) return unavailable(c, 'PAYMENTS_UNAVAILABLE');
    const user = await auth.requireMutationUser(c.req.raw);
    const body = await c.req.json<{ planId?: unknown }>().catch(() => null);
    if (!body || typeof body.planId !== 'string') return c.json({ error: 'ORDER_INVALID' }, 400);
    return c.json(await payments.createOrder(user.id, body.planId), 201);
  });

  app.post('/api/account/missions/:id/submissions', async (c) => {
    const auth = authFactory(c.env); const missions = missionFactory(c.env);
    if (!auth || !missions) return unavailable(c, 'MISSIONS_UNAVAILABLE');
    const user = await auth.requireMutationUser(c.req.raw);
    const body = await c.req.json<unknown>().catch(() => null);
    return c.json(await missions.submitEvidence(user.id, c.req.param('id'), body), 201);
  });

  app.get('/api/account/missions/submissions', async (c) => {
    const auth = authFactory(c.env); const missions = missionFactory(c.env);
    if (!auth || !missions) return unavailable(c, 'MISSIONS_UNAVAILABLE');
    const user = await auth.requireUser(c.req.raw);
    return c.json(await missions.getUserStatus(user.id));
  });

  app.post('/api/account/push-subscriptions', async (c) => {
    const auth = authFactory(c.env); const push = pushFactory(c.env);
    if (!auth || !push) return unavailable(c, 'PUSH_UNAVAILABLE');
    const user = await auth.requireMutationUser(c.req.raw);
    const body = await c.req.json<unknown>().catch(() => null);
    return c.json(await push.saveSubscription(user.id, body), 201);
  });

  app.get('/api/account/push-subscriptions', async (c) => {
    const auth = authFactory(c.env); const push = pushFactory(c.env);
    if (!auth || !push) return unavailable(c, 'PUSH_UNAVAILABLE');
    const user = await auth.requireUser(c.req.raw);
    return c.json(await push.listSubscriptions(user.id));
  });

  app.delete('/api/account/push-subscriptions/:id', async (c) => {
    const auth = authFactory(c.env); const push = pushFactory(c.env);
    if (!auth || !push) return unavailable(c, 'PUSH_UNAVAILABLE');
    const user = await auth.requireMutationUser(c.req.raw);
    await push.removeSubscription(user.id, c.req.param('id'));
    return new Response(null, { status: 204 });
  });

  app.get('/api/account/push/vapid-public-key', async (c) => {
    const auth = authFactory(c.env); const push = pushFactory(c.env);
    if (!auth || !push) return unavailable(c, 'PUSH_UNAVAILABLE');
    await auth.requireUser(c.req.raw);
    const publicKey = push.getPublicKey();
    if (!publicKey) return unavailable(c, 'PUSH_UNAVAILABLE');
    c.header('Cache-Control', 'no-store');
    return c.json({ publicKey });
  });

  app.post('/api/admin/orders/:id/confirm', async (c) => {
    const auth = authFactory(c.env); const payments = paymentFactory(c.env);
    if (!auth || !payments) return unavailable(c, 'PAYMENTS_UNAVAILABLE');
    const actor = await requireAdminMutation(auth, c.req.raw);
    const body = await c.req.json<{ confirmationId?: unknown }>().catch(() => null);
    if (!body || typeof body.confirmationId !== 'string') return c.json({ error: 'ORDER_INVALID' }, 400);
    const result = await payments.confirmOrder(c.req.param('id'), body.confirmationId);
    const audit = adminAuditFactory(c.env);
    if (audit) {
      await audit.record(actor, 'payment.manual.confirm', {
        orderId: c.req.param('id'),
        applied: result.applied,
      });
    }
    return c.json(result);
  });

  app.post('/api/admin/mission-submissions/:id/review', async (c) => {
    const auth = authFactory(c.env); const missions = missionFactory(c.env);
    if (!auth || !missions) return unavailable(c, 'MISSIONS_UNAVAILABLE');
    const actor = await requireAdminMutation(auth, c.req.raw);
    const body = await c.req.json<{ decision?: unknown; reason?: unknown }>().catch(() => null);
    if (!body || (body.decision !== 'approve' && body.decision !== 'reject')) {
      return c.json({ error: 'REVIEW_INVALID' }, 400);
    }
    if (body.reason !== undefined && typeof body.reason !== 'string') {
      return c.json({ error: 'REVIEW_INVALID' }, 400);
    }
    const review: { decision: 'approve' | 'reject'; reason?: string } = body.reason === undefined
      ? { decision: body.decision }
      : { decision: body.decision, reason: body.reason };
    const result = await missions.reviewSubmission(actor.id, c.req.param('id'), review);
    const audit = adminAuditFactory(c.env);
    if (audit) {
      await audit.record(actor, 'mission.submission.review', {
        submissionId: c.req.param('id'),
        status: result.status,
        rewardApplied: result.rewardApplied,
        rewardSeconds: result.rewardSeconds,
      });
    }
    return c.json(result);
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
    const auth = authFactory(c.env); const surfaces = surfaceFactory(c.env); const nodes = nodeFactory(c.env);
    if (!auth || !surfaces || !nodes) return unavailable(c, 'NODE_CONTROL_UNAVAILABLE');
    const actor = await requireAdminMutation(auth, c.req.raw);
    const nodeId = c.req.param('id');
    await nodes.retireNode(nodeId);
    await surfaces.deleteNode(actor, nodeId);
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
