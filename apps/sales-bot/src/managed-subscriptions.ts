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

/**
 * Opt-in operator feed. Never offers an incomplete or unverified route.
 * The same account UUID, quota and expiration apply to both ports.
 * No data is cached; withdrawing secondary ACK withdraws the feed.
 */
export async function managedCarrierSubscriptionResponse(
  request: Request,
  env: Env,
  now: number,
): Promise<Response> {
  const headers = {
    "Cache-Control": "private, no-store, no-cache, must-revalidate",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Content-Type": "text/plain; charset=utf-8",
  };
  if (request.method !== "GET")
    return new Response("Method not allowed",{status:405,headers});
  const match = /^\/managed-subscription\/v2\/(m1\.[A-Za-z0-9_-]{1,160}\.[A-Za-z0-9_-]{43})$/
    .exec(new URL(request.url).pathname);
  if (!match || new URL(request.url).search)
    return new Response("Not found",{status:404,headers});
  const accountId = verifyManagedSubscriptionForEnv(env,match[1]!);
  if (!accountId) return new Response("Not found",{status:404,headers});
  const artifact = await buildAccountDeliveryArtifact(env,accountId,now);
  if (!artifact) return new Response("Unavailable",{status:503,headers});
  const reality = artifact.profiles.filter(
    profile => profile.config.startsWith("vless://") && (profile.port===443 || profile.port===8443)
  );
  if (reality.length !== 2 || reality[0]!.port !== 443 || reality[1]!.port !== 8443)
    return new Response("Operator routes unavailable",{status:503,headers});
  const labels = ["مدار | همراه اول","مدار | ایرانسل"];
  const links = reality.map((profile,i) => {
    const parsed = new URL(profile.config);
    parsed.hash = labels[i]!;
    return parsed.toString();
  });
  return new Response(Buffer.from(links.join("\n")+"\n","utf8").toString("base64"),{
    status:200,headers:{
      ...headers,
      "Subscription-Userinfo": "expire="+artifact.validUntil,
      "Profile-Update-Interval": "12",
      "Content-Disposition": 'attachment; filename="Madar.txt"',
    }
  });
}
