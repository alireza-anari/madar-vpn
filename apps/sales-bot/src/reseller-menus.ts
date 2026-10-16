import type { TelegramUpdate } from "./contracts";
import { enqueue } from "./telegram";
import {
  resolveSalesActor,
  requireSalesAdmin,
  setReseller,
  setNodePurpose,
} from "./resellers";
import {
  createAccount,
  ownedAccount,
  revokeAccount,
  type AccountInput,
} from "./accounts";
const digits = (value: string) =>
  value
    .trim()
    .replace(/[۰-۹]/g, (c) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(c)))
    .replace(/[٠-٩]/g, (c) => String("٠١٢٣٤٥٦٧٨٩".indexOf(c)));
const statusLabel = (state: string) =>
  ({
    preparing: "⏳ در حال آماده‌سازی",
    active: "🟢 فعال",
    expired: "⌛ پایان اعتبار",
    exhausted: "📦 پایان حجم",
    revoked: "⛔ لغوشده",
    failed: "⚠️ نیاز به بررسی",
    blocked: "⛔ متوقف‌شده",
  })[state] || "⏳ در حال بررسی";
const cancel = () => [btn("✖️ انصراف و منوی اصلی", "rs:home")];
const btn = (text: string, callback_data: string) => ({ text, callback_data });
export async function handleResellerUpdate(
  env: Env,
  u: TelegramUpdate,
  now: number,
) {
  const id = u.message?.from?.id ?? u.callback_query?.from.id,
    chat = u.message?.chat ?? u.callback_query?.message?.chat;
  if (!id || !chat || chat.type !== "private" || chat.id !== id) return;
  const db = env.SALES_DB,
    actor = await resolveSalesActor(db, String(id), env),
    data = u.callback_query?.data,
    text = u.message?.text?.trim();
  const ordinaryReply = (text: string, rows?: Record<string, unknown>[][]) =>
    enqueue(db, `u${u.update_id}:reply`, String(id), {
      text,
      ...(rows ? { reply_markup: { inline_keyboard: rows } } : {}),
    });
  if (actor.role === "ordinary") {
    await ordinaryReply("دسترسی فقط برای فروشندگان مجاز است.");
    return;
  }
  await db
    .prepare("INSERT OR IGNORE INTO users(id) VALUES(?)")
    .bind(String(id))
    .run();
  const replyId = `u${u.update_id}:reply`;
  if (
    await db.prepare("SELECT id FROM outbox WHERE id=?").bind(replyId).first()
  )
    return;
  const snapshot = await db
    .prepare("SELECT conversation,sales_update_id FROM users WHERE id=?")
    .bind(String(id))
    .first<{ conversation: string; sales_update_id: number }>();
  if (!snapshot) throw Error("USER_NOT_FOUND");
  const raw = snapshot.conversation;
  let nextConversation = raw;
  const set = async (value: unknown) => {
    nextConversation = JSON.stringify(value);
  };
  const reply = async (text: string, rows?: Record<string, unknown>[][]) => {
    const payload = JSON.stringify({
      text,
      ...(rows ? { reply_markup: { inline_keyboard: rows } } : {}),
    });
    const result = await db.batch([
      db
        .prepare(
          "UPDATE users SET conversation=?,sales_update_id=? WHERE id=? AND conversation=? AND sales_update_id=?",
        )
        .bind(
          nextConversation,
          u.update_id,
          String(id),
          raw,
          snapshot.sales_update_id,
        ),
      db
        .prepare(
          "INSERT OR IGNORE INTO outbox(id,chat_id,payload,available_at) SELECT ?,?,?,0 FROM users WHERE id=? AND sales_update_id=?",
        )
        .bind(replyId, String(id), payload, String(id), u.update_id),
    ]);
    if (
      !result[0]?.meta.changes &&
      !(await db
        .prepare("SELECT id FROM outbox WHERE id=?")
        .bind(replyId)
        .first())
    )
      throw Error("CONVERSATION_RETRY");
  };
  try {
    let state: any;
    try {
      state = JSON.parse(raw || "{}");
    } catch {
      state = {};
    }
    if (text === "/start" || data === "home" || data === "rs:home") {
      await set({});
      const rows: Record<string, unknown>[][] = [
        [
          btn("➕ صدور کانفیگ", "rs:sale"),
          btn("🎁 تست ۱ گیگ · ۳۰ دقیقه", "rs:trial"),
        ],
        [btn("📋 کانفیگ‌های من", "rs:list")],
      ];
      if (actor.role === "admin")
        rows.push(
          [
            btn("افزودن فروشنده", "rs:seller"),
            btn("حذف دسترسی فروشنده", "rs:disable"),
          ],
          [btn("سرورها", "rs:nodes")],
          [
            {
              text: "افزودن VPS",
              web_app: { url: `${env.PUBLIC_BASE_URL}/enroll` },
            },
          ],
        );
      await reply(
        "مدار | پنل فروشنده\nبرای مشتری کانفیگ بساز یا یک تست جدید بگیر. پیام تحویل آمادهٔ ارسال به مشتری است.",
        rows,
      );
      return;
    }
    if (data === "rs:sale") {
      await set({ step: "label", requestKey: `sale:${u.update_id}` });
      await reply(
        "۱ از ۳ · نام مشتری\nنام یا برچسب مشتری را بفرست (حداکثر ۸۰ نویسه).",
        [cancel()],
      );
      return;
    }
    if (data === "rs:trial") {
      await set({
        step: "confirm",
        requestKey: `trial:${u.update_id}`,
        kind: "trial",
        label: "تست نیم‌ساعته",
        quotaBytes: 1e9,
        durationSeconds: 1800,
      });
      await reply(
        "🎁 تست جدید\nحجم: ۱ گیگابایت\nاعتبار: ۳۰ دقیقه از زمان فعال‌شدن\nهر درخواست یک کانفیگ مستقل می‌سازد.",
        [[btn("✅ ساخت تست", `rs:confirm:trial:${u.update_id}`)], cancel()],
      );
      return;
    }
    if (data?.startsWith("rs:confirm:")) {
      const key = data.slice(11);
      if (state.step !== "confirm" || state.requestKey !== key) {
        await reply("این تأیید منقضی شده؛ از منو درخواست جدید بساز.");
        return;
      }
      const account = await createAccount(
        db,
        actor,
        state as AccountInput,
        now,
      );
      await reply(
        `⏳ درخواست ثبت شد.\nپس از آماده‌شدن سرور، کانفیگ در یک پیام جداگانه می‌رسد؛ همان پیام را برای مشتری بفرست.`,
        [
          [btn("وضعیت درخواست", `rs:view:${account.id}`)],
          [btn("🏠 منوی اصلی", "rs:home")],
        ],
      );
      return;
    }
    if (data === "rs:list" || data?.startsWith("rs:list:")) {
      const page = data === "rs:list" ? 0 : Number(data!.slice(8));
      if (!Number.isSafeInteger(page) || page < 0 || page > 100000)
        throw Error("INVALID");
      const items = await db
        .prepare(
          "SELECT id,label,state FROM managed_accounts WHERE (seller_id=? OR ?=1) ORDER BY created_at DESC,id DESC LIMIT 9 OFFSET ?",
        )
        .bind(String(id), actor.role === "admin" ? 1 : 0, page * 8)
        .all<{ id: string; label: string; state: string }>();
      await reply(
        items.results.length
          ? `کانفیگ را انتخاب کن · صفحهٔ ${(page + 1).toLocaleString("fa-IR")}`
          : "هنوز کانفیگی ثبت نشده.",
        [
          ...items.results
            .slice(0, 8)
            .map((a) => [
              btn(`${a.label} · ${statusLabel(a.state)}`, `rs:view:${a.id}`),
            ]),
          ...(page > 0 || items.results.length > 8
            ? [
                [
                  ...(page > 0 ? [btn("قبلی", `rs:list:${page - 1}`)] : []),
                  ...(items.results.length > 8
                    ? [btn("بعدی", `rs:list:${page + 1}`)]
                    : []),
                ],
              ]
            : []),
          [btn("🏠 منوی اصلی", "rs:home")],
        ],
      );
      return;
    }
    if (data?.startsWith("rs:view:")) {
      const a = await ownedAccount(db, actor, data.slice(8));
      const rows = [
        [btn("🔄 به‌روزرسانی", `rs:view:${a.id}`)],
        [btn("بازگشت به کانفیگ‌ها", "rs:list")],
      ];
      if (
        actor.role === "admin" &&
        !["revoked", "expired", "exhausted"].includes(a.state)
      )
        rows.push([btn("لغو کانفیگ", `rs:revoke:${a.id}`)]);
      const quota =
        a.quota_bytes === null
          ? "—"
          : `${(a.quota_bytes / 1e9).toLocaleString("fa-IR")} گیگابایت`;
      const remaining =
        a.quota_bytes === null
          ? "—"
          : `${(Math.max(0, a.quota_bytes - a.used_bytes) / 1e9).toLocaleString("fa-IR", { maximumFractionDigits: 3 })} گیگابایت`;
      await reply(
        `${a.label}\nوضعیت: ${statusLabel(a.state)}\nحجم کل: ${quota}\nمصرف ثبت‌شده: ${(a.used_bytes / 1e9).toLocaleString("fa-IR", { maximumFractionDigits: 3 })} گیگابایت\nباقی‌مانده: ${remaining}\nانقضا: ${a.valid_until ? new Date(a.valid_until * 1000).toLocaleString("fa-IR", { timeZone: "Asia/Tehran" }) + " (تهران)" : "پس از فعال‌شدن مشخص می‌شود"}\nآخرین گزارش: ${a.last_report_at ? new Date(a.last_report_at * 1000).toLocaleString("fa-IR", { timeZone: "Asia/Tehran" }) : "هنوز دریافت نشده"}`,
        rows,
      );
      return;
    }
    if (data?.startsWith("rs:revoke:")) {
      requireSalesAdmin(actor);
      const a = await ownedAccount(db, actor, data.slice(10));
      await reply(`کانفیگ «${a.label}» لغو شود؟ اتصال مشتری قطع می‌شود.`, [
        [btn("بله، لغو شود", `rs:revokeok:${a.id}`)],
        [btn("بازگشت", `rs:view:${a.id}`)],
      ]);
      return;
    }
    if (data?.startsWith("rs:revokeok:")) {
      await revokeAccount(db, actor, data.slice(12), now);
      await reply("کانفیگ لغو شد.", [
        [btn("کانفیگ‌ها", "rs:list")],
        [btn("منوی اصلی", "rs:home")],
      ]);
      return;
    }
    if (data === "rs:seller" || data === "rs:disable") {
      requireSalesAdmin(actor);
      await set({ step: data === "rs:seller" ? "seller" : "disable" });
      await reply("شناسه عددی تلگرام فروشنده را بفرست.", [cancel()]);
      return;
    }
    if (data === "rs:nodes") {
      requireSalesAdmin(actor);
      const nodes = await db
        .prepare(
          "SELECT n.id,n.name,n.healthy,(SELECT GROUP_CONCAT(purpose) FROM node_purposes p WHERE p.node_id=n.id) purposes FROM nodes n",
        )
        .all<{
          id: string;
          name: string;
          healthy: number;
          purposes: string | null;
        }>();
      await reply(
        `کاربرد سرورها\n${nodes.results.map((n) => `${n.name}: ${n.purposes?.includes("sale") ? "فروش " : ""}${n.purposes?.includes("trial") ? "تست " : ""}${!n.purposes ? "بدون کاربرد" : ""} · ${n.healthy ? "آخرین گزارش سالم" : "نیاز به بررسی"}`).join("\n")}\n\nبرای تغییر، دکمهٔ زیر سرور را بزن.`,
        [
          ...nodes.results.map((n) => [
            btn(`${n.name}: فروش`, `rs:node:sale:${n.id}`),
            btn(`${n.name}: تست`, `rs:node:trial:${n.id}`),
          ]),
          [btn("🏠 منوی اصلی", "rs:home")],
        ],
      );
      return;
    }
    if (data?.startsWith("rs:node:")) {
      requireSalesAdmin(actor);
      const [, , purpose, nodeId] = data.split(":");
      await setNodePurpose(
        db,
        actor,
        nodeId!,
        purpose as "sale" | "trial",
        now,
      );
      await reply("کاربرد سرور ثبت شد. کانفیگ‌های قبلی جابه‌جا نمی‌شوند.", [
        [btn("سرورها", "rs:nodes")],
        [btn("منوی اصلی", "rs:home")],
      ]);
      return;
    }
    if (
      (text && state.step === "seller") ||
      (text && state.step === "disable")
    ) {
      await setReseller(db, actor, digits(text!), state.step === "seller", now);
      await set({});
      await reply("دسترسی فروشنده به‌روزرسانی شد.");
      return;
    }
    if (text && state.step === "label") {
      if (!text.trim() || text.length > 80) throw Error("INVALID");
      await set({ ...state, step: "quota", label: text.trim() });
      await reply("۲ از ۳ · حجم\nحجم را به گیگابایت بفرست (۱ تا ۱۰۰۰).", [
        cancel(),
      ]);
      return;
    }
    if (text && state.step === "quota") {
      const amount = digits(text);
      if (!/^\d+$/.test(amount) || +amount < 1 || +amount > 1000)
        throw Error("INVALID");
      await set({ ...state, step: "days", quotaBytes: +amount * 1e9 });
      await reply("۳ از ۳ · مدت\nمدت را به روز بفرست (۱ تا ۳۶۵).", [cancel()]);
      return;
    }
    if (text && state.step === "days") {
      const amount = digits(text);
      if (!/^\d+$/.test(amount) || +amount < 1 || +amount > 365)
        throw Error("INVALID");
      await set({
        ...state,
        step: "confirm",
        kind: "sale",
        durationSeconds: +amount * 86400,
      });
      await reply(
        `${state.label}\n${state.quotaBytes / 1e9} گیگابایت · ${text} روز`,
        [[btn("✅ تأیید صدور", `rs:confirm:${state.requestKey}`)], cancel()],
      );
      return;
    }
    await reply("از منوی فروشندگان استفاده کن.", [[btn("منو", "rs:home")]]);
  } catch (error) {
    if (error instanceof Error && error.message === "CONVERSATION_RETRY")
      throw error;
    await reply(
      error instanceof Error && error.message === "NODE_NOT_CONFIGURED"
        ? "سرور این سرویس هنوز انتخاب نشده است. مدیر باید از بخش سرورها، سرور فروش یا تست را مشخص کند."
        : "ورودی معتبر نیست یا دسترسی کافی نداری. مقدار خواسته‌شده را بررسی و دوباره ارسال کن.",
      [cancel()],
    );
  }
}
