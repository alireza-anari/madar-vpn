import { hash } from "./crypto";
import type { ManagedAccount } from "./accounts";
import type { QuotaPolicy } from "./quota-policies";
import { buildVlessRealityConfig } from "./connection-config";
import { buildManagedVmessWsConfig, managedWsFallbackIsDeliverable, readManagedWsRollout } from "./alternate-transport";
import { usageUrl as createUsageUrl } from "./usage-links";
import { managedSubscriptionUrl } from "./managed-subscription-tokens";

export interface AccountDeliveryArtifact {
  accountId: string;
  sellerId: string;
  label: string;
  kind: "sale" | "trial";
  quotaBytes: number | null;
  durationSeconds: number;
  validUntil: number;
  serverName: string;
  config: string;
  alternateConfig?: string;
  usageUrl: string;
}

interface DeliveryNode {
  id: string;
  name: string;
  target_ip: string;
  vpn_port: number | null;
  state: string;
  revision: number;
  acked_revision: number;
  last_seen: number;
  healthy: number;
  agent_capabilities: string;
  public_key: string | null;
  short_id: string | null;
  sni: string | null;
  policy_payload: string | null;
}

const capabilitiesOf = (raw: string) =>
  new Set(raw.split(",").map((value) => value.trim()).filter(Boolean));

export async function buildAccountDeliveryArtifact(
  env: Env,
  accountId: string,
  now: number,
): Promise<AccountDeliveryArtifact | null> {
  const db = env.SALES_DB;
  const a = await db
    .prepare(
      "SELECT * FROM managed_accounts WHERE id=? AND state='active' AND valid_until>?",
    )
    .bind(accountId, now)
    .first<ManagedAccount & { listen_port: number | null }>();
  if (!a) return null;

  const node = await db
    .prepare(
      "SELECT * FROM nodes WHERE id=? AND state='ready' AND healthy=1 AND revision=acked_revision AND last_seen>?",
    )
    .bind(a.node_id, now - 90)
    .first<DeliveryNode>();
  if (
    !node ||
    !node.policy_payload ||
    !Number.isSafeInteger(node.revision) ||
    node.revision < 1 ||
    node.acked_revision !== node.revision
  )
    return null;

  const capabilities = capabilitiesOf(node.agent_capabilities || "");
  if (
    !capabilities.has("quota-v2") ||
    !capabilities.has("per-account-process")
  )
    return null;

  const flow = a.connection_flow;
  if (flow !== "" && flow !== "xtls-rprx-vision") return null;
  const shared443 = capabilities.has("shared-443");
  if (
    flow === "xtls-rprx-vision" &&
    (!shared443 || !capabilities.has("vision-metered"))
  )
    return null;

  const accountRevision = a.activation_revision ?? a.prepared_revision;
  if (
    !Number.isSafeInteger(a.valid_until) ||
    a.valid_until <= now ||
    (accountRevision !== null &&
      (!Number.isSafeInteger(accountRevision) ||
        accountRevision < 1 ||
        accountRevision > node.acked_revision)) ||
    !Number.isSafeInteger(a.quota_epoch) ||
    !Number.isSafeInteger(a.listen_port) ||
    a.listen_port! < 20000 ||
    a.listen_port! > 20999
  )
    return null;

  let policy: QuotaPolicy;
  try {
    policy = JSON.parse(node.policy_payload) as QuotaPolicy;
  } catch {
    return null;
  }
  if (
    policy.version !== 2 ||
    policy.nodeId !== node.id ||
    policy.revision !== node.revision ||
    !Number.isSafeInteger(policy.expiresAt) ||
    policy.expiresAt <= now ||
    policy.expiresAt > now + 330 ||
    !Array.isArray(policy.clients)
  )
    return null;

  const matchingClients = policy.clients.filter(
    (client) => client.accountId === a.id,
  );
  if (matchingClients.length !== 1) return null;
  const client = matchingClients[0]!;
  if (
    client.uuid !== a.uuid ||
    client.quotaEpoch !== a.quota_epoch ||
    client.quotaBytes !== a.quota_bytes ||
    client.generation !== `${a.id}:${a.quota_epoch}` ||
    client.validUntil !== a.valid_until ||
    client.listenPort !== a.listen_port ||
    client.flow !== flow
  )
    return null;

  let publicPort: number;
  if (shared443) {
    if (node.vpn_port !== 443) return null;
    publicPort = node.vpn_port;
  } else {
    publicPort = a.listen_port;
  }

  let config: string;
  try {
    config = buildVlessRealityConfig({
      uuid: a.uuid,
      host: node.target_ip,
      port: publicPort,
      sni: node.sni || "",
      publicKey: node.public_key || "",
      shortId: node.short_id || "",
      flow,
      label: `Madar-${a.id.slice(0, 6)}`,
    });
  } catch {
    // A config is never delivered from incomplete or malformed node metadata.
    return null;
  }

  // Extra transport uses the SAME account UUID and the SAME metered loopback
  // backend. No delivery on stale ACK, missing agent capability, missing
  // admin approval, endpoint mismatch, or temporary Cloudflare hostnames.
  let alternateConfig: string | undefined;
  if (policy.wsFallback && capabilities.has("ws-metered")) {
    const approved = await readManagedWsRollout(db, node.id);
    if (
      approved &&
      JSON.stringify(approved) === JSON.stringify(policy.wsFallback) &&
      managedWsFallbackIsDeliverable(
        policy.wsFallback,
        capabilities,
        true,
        true,
      )
    ) {
      try {
        alternateConfig = buildManagedVmessWsConfig({
          ...approved,
          uuid: a.uuid,
          label: `Madar-Irancell-${a.id.slice(0, 6)}`,
        });
      } catch {
        // Preserve the working MCI path if secondary delivery cannot be built.
      }
    }
  }

  let usageUrl = "";
  try {
    usageUrl = createUsageUrl(env, a.id);
  } catch {
    // During rolling deployment the new secret may not be present yet. The
    // delivery queue retains the legacy random-token path until it is.
  }
  return {
    accountId: a.id,
    sellerId: a.seller_id,
    label: a.label,
    kind: a.kind,
    quotaBytes: a.quota_bytes,
    durationSeconds: a.duration_seconds,
    validUntil: a.valid_until,
    serverName: node.name,
    config,
    ...(alternateConfig ? { alternateConfig } : {}),
    usageUrl,
  };
}

const escape = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export async function queueAccountDelivery(
  env: Env,
  accountId: string,
  now: number,
) {
  const db = env.SALES_DB;
  const artifact = await buildAccountDeliveryArtifact(env, accountId, now);
  if (!artifact) return;
  let token: string;
  let url: string;
  if (artifact.usageUrl) {
    url = artifact.usageUrl;
    token = new URL(url).pathname.split("/").pop() || "";
  } else {
    token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
    url = `${env.PUBLIC_BASE_URL}/usage/${token}`;
  }
  let currentSubscriptionUrl = "";
  try {
    currentSubscriptionUrl = managedSubscriptionUrl(env, artifact.accountId);
  } catch {
    // No signed subscription URL when credentials/origin are unavailable.
    // Keep the existing verified one-config Telegram delivery.
  }
  const digest = hash(token);
  const alternateText = artifact.alternateConfig
    ? `\n\n📶 مسیر جایگزین ایرانسل (همان حجم و اعتبار):\n<pre>${escape(artifact.alternateConfig)}</pre>`
    : "";
  const text = `🟢 اشتراک مدار · ${escape(artifact.label)}\n${artifact.kind === "trial" ? "🎁 تست ۳۰ دقیقه‌ای · حجم: ۱ گیگابایت" : `📦 حجم: ${(Number(artifact.quotaBytes) / 1e9).toLocaleString("fa-IR")} گیگابایت · مدت: ${(artifact.durationSeconds / 86400).toLocaleString("fa-IR")} روز`}\n⏳ انقضا: ${new Date(artifact.validUntil * 1000).toLocaleString("fa-IR", { timeZone: "Asia/Tehran" })} (تهران)\n\n<pre>${escape(artifact.config)}</pre>${alternateText}\n\nکانفیگ را کپی و در برنامهٔ اتصال وارد کنید.\nبرای دیدن مصرف و حجم باقی‌مانده، دکمهٔ «مصرف و اعتبار» را بزنید.\n🔒 این پیام مخصوص شماست؛ آن را خصوصی نگه دارید.`;
  const rows: Record<string, unknown>[][] = [];
  if (artifact.config.length <= 256)
    rows.push([{ text: "📋 کپی کانفیگ", copy_text: { text: artifact.config } }]);
  if (currentSubscriptionUrl)
    rows.push([{ text: "🔄 لینک اشتراک به‌روزشونده", url: currentSubscriptionUrl }]);
  rows.push([{ text: "📊 مصرف و اعتبار", url }]);
  const payload = JSON.stringify({
    text,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    reply_markup: { inline_keyboard: rows },
  });
  let recipient = artifact.sellerId;
  const requestKey = await db.prepare("SELECT request_key FROM managed_accounts WHERE id=?")
    .bind(artifact.accountId).first<string>("request_key");
  if (requestKey?.startsWith("customer-order:")) {
    // This is a customer account. Never fall back to the seller or silently consume
    // delivery if the checkout row is missing or the D1 migration is incomplete.
    const customer = await db.prepare(
      "SELECT user_id FROM customer_orders WHERE id=? AND state IN ('approving','approved')",
    ).bind(requestKey.slice("customer-order:".length)).first<string>("user_id");
    if (!customer) return;
    recipient = customer;
  }
  await db.batch([
    db
      .prepare(
        "UPDATE managed_accounts SET status_token_hash=? WHERE id=? AND status_token_hash IS NULL AND state='active'",
      )
      .bind(digest, artifact.accountId),
    db
      .prepare(
        "INSERT OR IGNORE INTO outbox(id,chat_id,payload,available_at) SELECT ?,?,?,0 FROM managed_accounts WHERE id=? AND status_token_hash=? AND state='active'",
      )
      .bind(
        `account:${artifact.accountId}`,
        recipient,
        payload,
        artifact.accountId,
        digest,
      ),
  ]);
}

export async function deliverReadyAccounts(env: Env, now: number) {
  const accounts = await env.SALES_DB.prepare(
    "SELECT id FROM managed_accounts WHERE state='active' AND status_token_hash IS NULL AND valid_until>? LIMIT 100",
  )
    .bind(now)
    .all<{ id: string }>();
  for (const a of accounts.results) await queueAccountDelivery(env, a.id, now);
}
