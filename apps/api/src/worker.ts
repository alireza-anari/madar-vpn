import { Client } from 'pg';
import { createApiApp } from './index';
import type { PgClientFactory } from './postgres/client';
import type { RateLimitBinding } from './rate-limit';
import {
  createPostgresRequestRuntime,
  type PostgresRuntimeBindings,
} from './runtime/postgres';

type WorkerBindings = PostgresRuntimeBindings & {
  LOGIN_RATE_LIMITER?: RateLimitBinding;
  SUBSCRIPTION_RATE_LIMITER?: RateLimitBinding;
  NODE_ENROLLMENT_RATE_LIMITER?: RateLimitBinding;
  PROVIDER_CALLBACK_RATE_LIMITER?: RateLimitBinding;
  ADMIN_RATE_LIMITER?: RateLimitBinding;
};

type DefaultApiOptions = {
  pgClientFactory?: PgClientFactory;
};

const defaultPgClientFactory: PgClientFactory = (connectionString) =>
  new Client({ connectionString });

function requestFromInput(input: string | URL | Request, init?: RequestInit) {
  if (input instanceof Request) return init ? new Request(input, init) : input;
  if (input instanceof URL) return new Request(input, init);
  const url = /^https?:\/\//i.test(input)
    ? input
    : `http://localhost${input.startsWith('/') ? input : `/${input}`}`;
  return new Request(url, init);
}

export function createDefaultApiApp(options: DefaultApiOptions = {}) {
  const pgClientFactory = options.pgClientFactory ?? defaultPgClientFactory;

  async function dispatch(request: Request, env?: WorkerBindings) {
    let runtime;
    try {
      runtime = await createPostgresRequestRuntime(env, pgClientFactory);
    } catch {
      return Response.json({ error: 'DATABASE_UNAVAILABLE' }, { status: 503 });
    }

    const router = createApiApp(
      () => runtime?.auth ?? null,
      () => runtime?.surfaces ?? null,
      () => runtime?.rewardedAds ?? null,
      () => runtime?.subscriptions ?? null,
      () => runtime?.payments ?? null,
      () => runtime?.missions ?? null,
      () => runtime?.push ?? null,
      () => runtime?.nodes ?? null,
      () => runtime?.adminAudit ?? null,
      () => runtime?.access ?? null,
    );

    return router.fetch(request, env as never);
  }

  return {
    fetch(request: Request, env?: WorkerBindings) {
      return dispatch(request, env);
    },
    request(input: string | URL | Request, init?: RequestInit, env?: WorkerBindings) {
      return dispatch(requestFromInput(input, init), env);
    },
  };
}

export default createDefaultApiApp();
