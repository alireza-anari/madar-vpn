import { hash } from "./crypto";
import type { ManagedAccount } from "./accounts";
import type { QuotaPolicy } from "./quota-policies";
import { usageUrl as createUsageUrl } from "./usage-links";

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
  usageUrl: string;
}

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
    .first<ManagedAccount & { listen_port: number }>();
  if (!a) return null;
  const node = await db
    .prepare(
      "SELECT * FROM nodes WHERE id=? AND healthy=1 AND revision=acked_revision AND last_seen>?",
    )
    .bind(a.node_id, now - 90)
    .first<any>();
  if (
    !node ||
    !node.agent_capabilities.split(",").includes("quota-v2") ||
    !node.public_key ||
    !node.policy_payload
  )
    return null;
  const policy = JSON.parse(node.policy_payload) as QuotaPolicy;
  if (
    policy.version !== 2 ||
    policy.expiresAt <= now ||
    node.acked_revision < a.activation_revision! ||
    !policy.clients.some(
      (c) =>
        c.accountId === a.id &&
        c.uuid === a.uuid &&
        c.validUntil === a.valid_until,
    )
  )
    return null;
  const q = new URLSearchParams({
    encryption: "none",
    flow: "",
    security: "reality",
    sni: node.sni,
    fp: "chrome",
    pbk: node.public_key,
    sid: node.short_id,
    type: "tcp",
  });
  const host = node.target_ip.includes(":")
    ? `[${node.target_ip}]`
    : node.target_ip;
  const publicPort = node.agent_capabilities.split(",").includes("shared-443")
    ? node.vpn_port
    : a.listen_port;
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
    config: `vless://${a.uuid}@${host}:${publicPort}?${q}#Madar-${a.id.slice(0, 6)}`,
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
  const digest = hash(token);
  const text = `🟢 اشتراک مدار · ${escape(artifact.label)}\n${artifact.kind === "trial" ? "🎁 تست ۳۰ دقیقه‌ای · حجم: ۱ گیگابایت" : `📦 حجم: ${(Number(artifact.quotaBytes) / 1e9).toLocaleString("fa-IR")} گیگابایت · مدت: ${(artifact.durationSeconds / 86400).toLocaleString("fa-IR")} روز`}\n⏳ انقضا: ${new Date(artifact.validUntil * 1000).toLocaleString("fa-IR", { timeZone: "Asia/Tehran" })} (تهران)\n\n<pre>${escape(artifact.config)}</pre>\n\nکانفیگ را کپی و در برنامهٔ اتصال وارد کنید.\nبرای دیدن مصرف و حجم باقی‌مانده، دکمهٔ «مصرف و اعتبار» را بزنید.\n🔒 این پیام مخصوص شماست؛ آن را خصوصی نگه دارید.`;
  const rows: Record<string, unknown>[][] = [];
  if (artifact.config.length <= 256)
    rows.push([{ text: "📋 کپی کانفیگ", copy_text: { text: artifact.config } }]);
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
