import { buildAccountDeliveryArtifact } from "./account-delivery";
import { verifyManagedSubscriptionForEnv } from "./managed-subscription-tokens";

/**
 * A stable multi-profile subscription URL from Madar's EXISTING Worker hostname.
 * No new VPN ingress domain is needed for the subscription endpoint.
 * Every fetch re-evaluates the exact node ACK and signed policy, so removal
 * of the secondary transport immediately removes it from the response.
 */
export async function managedSubscriptionResponse(
  request: Request,
  env: Env,
  now: number,
): Promise<Response> {
  const headers = {
    "Cache-Control": "no-store, no-cache, must-revalidate",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  };
  if (request.method !== "GET")
    return new Response("Method not allowed", { status: 405, headers });

  const path = new URL(request.url).pathname;
  const match = /^\/managed-subscription\/v1\/(m1\.[A-Za-z0-9_-]{1,160}\.[A-Za-z0-9_-]{43})$/.exec(path);
  if (!match)
    return new Response("Not found", { status: 404, headers });

  const accountId = verifyManagedSubscriptionForEnv(env, match[1]!);
  if (!accountId)
    return new Response("Not found", { status: 404, headers });

  const artifact = await buildAccountDeliveryArtifact(env, accountId, now);
  if (!artifact)
    return new Response("Subscription unavailable", { status: 503, headers });

  const configs = artifact.profiles.map(profile => profile.config);
  return new Response(configs.join("\n") + "\n", {
    status: 200,
    headers: {
      ...headers,
      "Content-Type": "text/plain; charset=utf-8",
      "Subscription-Userinfo": `expire=${artifact.validUntil}`,
    },
  });
}
