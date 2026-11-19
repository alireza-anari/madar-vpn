/** Server-side entitlement expiry and quota exhaustion reconciliation.
 * A node must independently remove the expired UUID and acknowledge
 * removal before its allocation can be freed for a new customer.
 */
export async function expireEntitlements(env,nowMs=Date.now()){
  if(!env.DB)return {expired:0};
  const result=await env.DB.prepare(
    "UPDATE subscriptions SET state='expired' "+
    "WHERE state='active' AND (expires_at<=? OR max_bytes<=used_bytes)"
  ).bind(nowMs).run();
  // Any stale route-issued access tokens remain unusable because entitlement
  // resolution checks s.state; remove their hashes after expiry for hygiene.
  await env.DB.prepare(
    "DELETE FROM subscription_tokens WHERE expires_at<=? OR "+
    "EXISTS(SELECT 1 FROM subscriptions s WHERE s.id=subscription_tokens.subscription_id "+
    "AND s.state IN ('expired','revoked'))"
  ).bind(nowMs).run();
  return {expired:Number(result.meta?.changes??0)};
}
