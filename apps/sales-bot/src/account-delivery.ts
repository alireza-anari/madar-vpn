import { hash } from "./crypto";
import type { ManagedAccount } from "./accounts";
import type { QuotaPolicy } from "./quota-policies";
export async function queueAccountDelivery(
  env: Env,
  accountId: string,
  now: number,
) {
  const db = env.SALES_DB,
    a = await db
      .prepare(
        "SELECT * FROM managed_accounts WHERE id=? AND state='active' AND valid_until>?",
      )
      .bind(accountId, now)
      .first<ManagedAccount & { listen_port: number }>();
  if (!a) return;
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
    return;
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
    return;
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  const digest = hash(token),
    url = `${env.PUBLIC_BASE_URL}/usage/${token}`;
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
  const config = `vless://${a.uuid}@${host}:${publicPort}?${q}#Madar-${a.id.slice(0, 6)}`;
  const escape = (value: string) =>
    value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const text = `🟢 اشتراک مدار · ${escape(a.label)}\n${a.kind === "trial" ? "🎁 تست ۳۰ دقیقه‌ای · حجم: ۱ گیگابایت" : `📦 حجم: ${(Number(a.quota_bytes) / 1e9).toLocaleString("fa-IR")} گیگابایت · مدت: ${(a.duration_seconds / 86400).toLocaleString("fa-IR")} روز`}\n⏳ انقضا: ${new Date(a.valid_until * 1000).toLocaleString("fa-IR", { timeZone: "Asia/Tehran" })} (تهران)\n\n<pre>${escape(config)}</pre>\n\nکانفیگ را کپی و در برنامهٔ اتصال وارد کنید.\nبرای دیدن مصرف و حجم باقی‌مانده، دکمهٔ «مصرف و اعتبار» را بزنید.\n🔒 این پیام مخصوص شماست؛ آن را خصوصی نگه دارید.`;
  const rows: Record<string, unknown>[][] = [];
  // Telegram accepts at most 256 characters in copy_text. Never truncate a URI.
  if (config.length <= 256)
    rows.push([{ text: "📋 کپی کانفیگ", copy_text: { text: config } }]);
  rows.push([{ text: "📊 مصرف و اعتبار", url }]);
  const payload = JSON.stringify({
    text,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    reply_markup: { inline_keyboard: rows },
  });
  // Capability and its only recoverable raw copy are committed in one atomic D1 batch.
  await db.batch([
    db
      .prepare(
        "UPDATE managed_accounts SET status_token_hash=? WHERE id=? AND status_token_hash IS NULL AND state='active'",
      )
      .bind(digest, a.id),
    db
      .prepare(
        "INSERT OR IGNORE INTO outbox(id,chat_id,payload,available_at) SELECT ?,seller_id,?,0 FROM managed_accounts WHERE id=? AND status_token_hash=? AND state='active'",
      )
      .bind(`account:${a.id}`, payload, a.id, digest),
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
