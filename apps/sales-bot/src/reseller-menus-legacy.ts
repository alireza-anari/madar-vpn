import { nodeCapacities, allocationLabel } from "./node-capacity";
import {
  createSellerInvite,
  claimSellerInvite,
  sellerInviteUrl,
} from "./reseller-invites";
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
const home = () => [btn("🏠 منوی اصلی", "rs:home")];
const choices = (step: string, values: number[], unit: string) => [
  values.map((n) =>
    btn(`${n.toLocaleString("fa-IR")} ${unit}`, `rs:pick:${step}:${n}`),
  ),
  [btn("بازگشت", step === "quota" ? "rs:back:label" : "rs:back:quota")],
  home(),
];
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
  if (text?.startsWith("/start seller_")) {
    const token = text.slice(14);
    const accepted = await claimSellerInvite(db, token, String(id), now);
    await ordinaryReply(
      accepted
        ? "✅ دسترسی فروشندگی شما فعال شد.\nاز منوی زیر برای صدور کانفیگ یا دریافت تست شروع کن."
        : "این دعوت معتبر نیست، منقضی شده یا قبلاً استفاده شده است. از مدیر یک لینک تازه بگیر.",
      accepted ? [[btn("🏠 ورود به پنل فروشنده", "rs:home")]] : undefined,
    );
    return;
  }
  if (actor.role === "ordinary") {
    await ordinaryReply(
      `به مدار خوش آمدی.\nاین ربات ویژهٔ فروشندگان مجاز است. برای دریافت دسترسی، از مدیر بخواه لینک دعوت فروشندگی را برایت بفرستد.`,
    );
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
  const reply = async (
    text: string,
    rows?: Record<string, unknown>[][],
    extra: Record<string, unknown> = {},
  ) => {
    const payload = JSON.stringify({
      ...extra,
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
  const chooseServer = async () => {
    const nodes = {
      results: (await nodeCapacities(db, now)).filter(
        (n) =>
          n.operational_status==='active' && n.healthy === 1 &&
          n.last_seen > now - 90 &&
          n.agent_capabilities.split(",").includes("quota-v2"),
      ),
    };
    await reply(
      nodes.results.length
        ? "🌍 انتخاب سرور\nسرور کانفیگ را انتخاب کن. ظرفیت هنگام تأیید نهایی دوباره بررسی می‌شود."
        : "در حال حاضر سرور آماده‌ای در دسترس نیست. کمی بعد دوباره تلاش کن یا به مدیر اطلاع بده.",
      [
        ...nodes.results.map((n) => [
          btn(
            `${n.name} · ${Math.max(0, n.max_accounts - n.reserved_accounts).toLocaleString("fa-IR")} جای خالی · ${allocationLabel(n)}`,
            `rs:choose:${n.id}`,
          ),
        ]),
        home(),
      ],
    );
  };
  let state: any;
  try {
    try {
      state = JSON.parse(raw || "{}");
    } catch {
      state = {};
    }
    if (
      text === "/start" ||
      text === "/menu" ||
      text === "/cancel" ||
      data === "home" ||
      data === "rs:home"
    ) {
      await set({});
      const rows: Record<string, unknown>[][] = [
        [
          btn("➕ صدور کانفیگ", "rs:sale"),
          btn("🎁 تست ۱ گیگ · ۳۰ دقیقه", "rs:trial"),
        ],
        [btn("📋 کانفیگ‌ها", "rs:list"), btn("📖 راهنما", "rs:help")],
      ];
      if (actor.role === "admin")
        rows.push(
          [btn("👥 مدیریت فروشندگان", "rs:sellers")],
          [btn("سرورها", "rs:nodes")],
          [
            {
              text: "افزودن VPS",
              web_app: { url: `${env.PUBLIC_BASE_URL}/enroll` },
            },
          ],
        );
      const summary = await db
        .prepare(
          "SELECT COUNT(*) total,SUM(CASE WHEN state='active' AND valid_until>? AND (quota_bytes IS NULL OR used_bytes<quota_bytes) THEN 1 ELSE 0 END) active FROM managed_accounts WHERE seller_id=? OR ?=1",
        )
        .bind(now, String(id), actor.role === "admin" ? 1 : 0)
        .first<{ total: number; active: number }>();
      await reply(
        `مدار | ${actor.role === "admin" ? "پنل مدیر" : "پنل فروشنده"}\n${(summary?.active || 0).toLocaleString("fa-IR")} کانفیگ فعال از ${(summary?.total || 0).toLocaleString("fa-IR")} درخواست\n\nبرای مشتری کانفیگ بساز یا تست جدید بگیر. پیام تحویل را مستقیم برای مشتری بفرست.`,
        rows,
      );
      return;
    }
    if (data === "rs:help" || text === "/help") {
      await reply(
        "📖 راهنمای مدار\n\n۱. صدور کانفیگ: نام، حجم و مدت را مشخص کن؛ پس از تأیید، پیام مشتری خودکار می‌رسد.\n۲. تست: هر بار یک کانفیگ مستقل با ۱ گیگابایت حجم و ۳۰ دقیقه اعتبار می‌گیری.\n۳. پیام تحویل را کامل برای مشتری فوروارد کن تا دکمه‌های کپی و مصرف همراهش باشند.\n۴. مصرف و اعتبار از دکمهٔ داخل پیام دیده می‌شود؛ گزارش ممکن است چند ثانیه تأخیر داشته باشد.\n۵. تمام دستگاه‌های یک کانفیگ از حجم مشترک استفاده می‌کنند.\n\nبرای توقف صدور در هر مرحله /cancel را بفرست.",
        [home()],
      );
      return;
    }
    if (data === "rs:invite") {
      requireSalesAdmin(actor);
      const token = await createSellerInvite(
        env,
        actor,
        String(u.update_id),
        now,
      );
      const url = await sellerInviteUrl(env, token);
      await reply(
        `👥 دعوت فروشنده\n\nاین لینک را فقط برای فروشندهٔ موردنظر بفرست:\n${url}\n\nبا بازکردن لینک و زدن Start، دسترسی فعال می‌شود. هر لینک برای یک نفر است و ۲۴ ساعت اعتبار دارد.`,
        [
          [{ text: "📋 کپی لینک دعوت", copy_text: { text: url } }],
          [btn("ساخت دعوت جدید", "rs:invite")],
          [btn("بازگشت به فروشندگان", "rs:sellers")],
        ],
        { link_preview_options: { is_disabled: true } },
      );
      return;
    }
    if (data === "rs:sellers") {
      requireSalesAdmin(actor);
      const sellers = await db
        .prepare(
          "SELECT telegram_id,enabled FROM resellers ORDER BY enabled DESC,created_at DESC LIMIT 30",
        )
        .all<{ telegram_id: string; enabled: number }>();
      await reply(
        `👥 فروشندگان\n${sellers.results.length ? sellers.results.map((s) => `${s.enabled ? "🟢 فعال" : "⚪ غیرفعال"} · ${s.telegram_id}`).join("\n") : "هنوز فروشنده‌ای اضافه نشده است."}\n\nغیرفعال‌کردن فروشنده، کانفیگ‌های مشتریانش را لغو نمی‌کند.`,
        [
          [btn("🔗 دعوت فروشنده با لینک", "rs:invite")],
          [btn("افزودن با شناسهٔ عددی", "rs:seller")],
          [btn("قطع دسترسی فروشنده", "rs:disable")],
          home(),
        ],
      );
      return;
    }
    if (data?.startsWith("rs:back:")) {
      if (!state.requestKey || state.kind === "trial") throw Error("INVALID");
      const step = data.slice(8);
      if (!["label", "quota", "days"].includes(step)) throw Error("INVALID");
      await set({ ...state, step });
      await reply(
        step === "label"
          ? "۱ از ۳ · نام مشتری را بفرست."
          : step === "quota"
            ? "۲ از ۳ · حجم را انتخاب کن یا عددی از ۱ تا ۱۰۰۰ بفرست."
            : "۳ از ۳ · مدت را انتخاب کن یا عددی از ۱ تا ۳۶۵ بفرست.",
        step === "label"
          ? [cancel()]
          : choices(
              step,
              step === "quota" ? [10, 30, 50, 100] : [7, 30, 60, 90],
              step === "quota" ? "گیگ" : "روز",
            ),
      );
      return;
    }
    if (data?.startsWith("rs:choose:")) {
      if (state.step !== "confirm" || !state.requestKey) throw Error("INVALID");
      const nodeId = data.slice(10);
      const node = await db
        .prepare(
          "SELECT id,name FROM nodes WHERE id=? AND healthy=1 AND last_seen>? AND NOT EXISTS(SELECT 1 FROM settings WHERE key='node_status:'||id AND value IN ('paused','archived'))",
        )
        .bind(nodeId, now - 90)
        .first<{ id: string; name: string }>();
      if (!node) throw Error("NODE_UNAVAILABLE");
      await set({ ...state, nodeId });
      await reply(
        `✅ بررسی نهایی\nمشتری: ${state.label}\nسرور: ${node.name}\nحجم: ${(state.quotaBytes / 1e9).toLocaleString("fa-IR")} گیگابایت\nمدت: ${state.kind === "trial" ? "۳۰ دقیقه" : (state.durationSeconds / 86400).toLocaleString("fa-IR") + " روز"}`,
        [
          [btn("✅ تأیید و ساخت", `rs:confirm:${state.requestKey}`)],
          [btn("تغییر سرور", "rs:servers")],
          home(),
        ],
      );
      return;
    }
    if (data === "rs:servers") {
      if (state.step !== "confirm") throw Error("INVALID");
      await chooseServer();
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
      await chooseServer();
      return;
    }
    if (data?.startsWith("rs:confirm:")) {
      const key = data.slice(11);
      if (state.step !== "confirm" || state.requestKey !== key) {
        await reply(
          "این تأیید مربوط به درخواست فعلی نیست. از منو درخواست تازه بساز.",
          [home()],
        );
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
    if (data?.startsWith("rs:resend:")) {
      const a = await ownedAccount(db, actor, data.slice(10));
      if (a.state !== "active" || a.valid_until <= now || !a.status_token_hash)
        throw Error("ACCOUNT_NOT_READY");
      const payload = await db
        .prepare("SELECT payload FROM outbox WHERE id=?")
        .bind(`account:${a.id}`)
        .first<string>("payload");
      if (!payload) throw Error("ACCOUNT_NOT_READY");
      const original = JSON.parse(payload);
      await reply(
        original.text,
        original.reply_markup?.inline_keyboard,
        original,
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
      if (a.state === "active" && a.valid_until > now && a.status_token_hash)
        rows.unshift([
          btn("📨 دریافت دوبارهٔ پیام مشتری", `rs:resend:${a.id}`),
        ]);
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
    if (data?.startsWith("rs:allocation:")) {
      requireSalesAdmin(actor);
      const n = (await nodeCapacities(db, now)).find(
        (n) => n.id === data.slice(14),
      );
      if (!n) throw Error("INVALID");
      await set({ step: "allocation", nodeId: n.id });
      await reply(
        `سقف حجم سرور ${n.name}\nحجم رزروشده: ${(n.allocated_bytes / 1e9).toLocaleString("fa-IR")} گیگابایت\n${allocationLabel(n)}\n\nسقف جدید را به گیگابایت از ۱ تا ۱۰۰۰۰۰۰ بفرست. کاهش سقف، کانفیگ‌های قبلی را حذف نمی‌کند؛ فقط صدور جدید محدود می‌شود.`,
        [home()],
      );
      return;
    }
    if (text && state.step === "allocation") {
      requireSalesAdmin(actor);
      const value = digits(text),
        gb = Number(value);
      if (
        !/^\d+$/.test(value) ||
        !Number.isSafeInteger(gb) ||
        gb < 1 ||
        gb > 1000000
      )
        throw Error("INVALID_ALLOCATION_CAP");
      await db.batch([
        db
          .prepare("UPDATE nodes SET max_allocated_bytes=? WHERE id=?")
          .bind(gb * 1e9, state.nodeId),
        db
          .prepare(
            "INSERT INTO audit_events(actor_id,action,target_id,created_at) VALUES(?,'node_allocation_cap',?,?)",
          )
          .bind(String(id), state.nodeId, now),
      ]);
      await set({});
      await reply("✅ سقف حجم اختصاص‌یافتهٔ سرور ثبت شد.", [
        [btn("سرورها", "rs:nodes")],
        home(),
      ]);
      return;
    }
    if (data?.startsWith("rs:capacity:")) {
      requireSalesAdmin(actor);
      const nodeId = data.slice(12);
      const node = await db
        .prepare("SELECT name,max_accounts FROM nodes WHERE id=?")
        .bind(nodeId)
        .first<{ name: string; max_accounts: number }>();
      if (!node) throw Error("INVALID");
      await set({ step: "capacity", nodeId });
      await reply(
        `ظرفیت سرور ${node.name}\nسقف فعلی: ${node.max_accounts.toLocaleString("fa-IR")}\nسقف جدید را از ۱ تا ۱۰۰۰۰ بفرست. کانفیگ‌های فعلی حذف نمی‌شوند.`,
        [home()],
      );
      return;
    }
    if (text && state.step === "capacity") {
      requireSalesAdmin(actor);
      const count = Number(digits(text));
      if (!Number.isSafeInteger(count) || count < 1 || count > 10000)
        throw Error("INVALID_CAPACITY");
      await db.batch([
        db
          .prepare("UPDATE nodes SET max_accounts=? WHERE id=?")
          .bind(count, state.nodeId),
        db
          .prepare(
            "INSERT INTO audit_events(actor_id,action,target_id,created_at) VALUES(?,'node_capacity',?,?)",
          )
          .bind(String(id), state.nodeId, now),
      ]);
      await set({});
      await reply("✅ سقف کانفیگ سرور به‌روزرسانی شد.", [
        [btn("سرورها", "rs:nodes")],
        home(),
      ]);
      return;
    }
    if (data === "rs:nodes") {
      requireSalesAdmin(actor);
      const nodes = await db
        .prepare(
          "SELECT n.id,n.name,n.healthy,n.max_accounts,(SELECT GROUP_CONCAT(purpose) FROM node_purposes p WHERE p.node_id=n.id) purposes FROM nodes n",
        )
        .all<{
          id: string;
          name: string;
          healthy: number;
          max_accounts: number;
          purposes: string | null;
        }>();
      const capacities = await nodeCapacities(db, now);
      const volumeSummary = capacities
        .map(
          (n) =>
            `${n.name}: ${Math.max(0, n.max_accounts - n.reserved_accounts).toLocaleString("fa-IR")} جای خالی · ${allocationLabel(n)}`,
        )
        .join("\n");
      await reply(
        `ظرفیت سرورها\n${volumeSummary}\n\nکاربرد سرورها\n${nodes.results.map((n) => `${n.name}: ${n.purposes?.includes("sale") ? "فروش " : ""}${n.purposes?.includes("trial") ? "تست " : ""}${!n.purposes ? "بدون کاربرد" : ""} · ${n.healthy ? "آخرین گزارش سالم" : "نیاز به بررسی"}`).join("\n")}\n\nبرای تغییر، دکمهٔ زیر سرور را بزن.`,
        [
          ...nodes.results.map((n) => [
            btn(`${n.name}: فروش`, `rs:node:sale:${n.id}`),
            btn(`${n.name}: تست`, `rs:node:trial:${n.id}`),
            btn(`سقف تعداد ${n.max_accounts}`, `rs:capacity:${n.id}`),
            btn("سقف حجم", `rs:allocation:${n.id}`),
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
      await reply("✅ دسترسی فروشنده به‌روزرسانی شد.", [
        [btn("فروشندگان", "rs:sellers")],
        home(),
      ]);
      return;
    }
    if (text && state.step === "label") {
      if (!text.trim() || text.length > 80) throw Error("INVALID");
      await set({ ...state, step: "quota", label: text.trim() });
      await reply(
        "۲ از ۳ · حجم\nحجم را به گیگابایت بفرست (۱ تا ۱۰۰۰).",
        choices("quota", [10, 30, 50, 100], "گیگ"),
      );
      return;
    }
    if (
      (text || data?.startsWith("rs:pick:quota:")) &&
      state.step === "quota"
    ) {
      const amount = digits(text || data!.slice(14));
      if (!/^\d+$/.test(amount) || +amount < 1 || +amount > 1000)
        throw Error("INVALID");
      await set({ ...state, step: "days", quotaBytes: +amount * 1e9 });
      await reply(
        "۳ از ۳ · مدت\nمدت را به روز بفرست (۱ تا ۳۶۵).",
        choices("days", [7, 30, 60, 90], "روز"),
      );
      return;
    }
    if ((text || data?.startsWith("rs:pick:days:")) && state.step === "days") {
      const amount = digits(text || data!.slice(13));
      if (!/^\d+$/.test(amount) || +amount < 1 || +amount > 365)
        throw Error("INVALID");
      await set({
        ...state,
        step: "confirm",
        kind: "sale",
        durationSeconds: +amount * 86400,
      });
      await chooseServer();
      return;
    }
    await reply("از منوی فروشندگان استفاده کن.", [[btn("منو", "rs:home")]]);
  } catch (error) {
    if (error instanceof Error && error.message === "CONVERSATION_RETRY")
      throw error;
    await reply(
      error instanceof Error && error.message === "INVITE_UNAVAILABLE"
        ? "ساخت لینک دعوت فعلاً ممکن نشد. کمی بعد دوباره تلاش کن."
        : error instanceof Error && error.message === "NODE_ALLOCATION_FULL"
          ? "ظرفیت حجمی این سرور برای این کانفیگ کافی نیست. حجم کمتری انتخاب کن یا سرور را تغییر بده."
          : error instanceof Error && error.message === "INVALID_ALLOCATION_CAP"
            ? "سقف حجم باید یک عدد صحیح از ۱ تا ۱۰۰۰۰۰۰ گیگابایت باشد. دوباره بفرست."
            : error instanceof Error && error.message === "NODE_FULL"
              ? "ظرفیت این سرور تکمیل شده است. از گزینهٔ تغییر سرور، سرور دیگری انتخاب کن."
              : error instanceof Error && error.message === "NODE_UNAVAILABLE"
                ? "این سرور فعلاً آماده نیست. سرور دیگری انتخاب کن."
                : error instanceof Error && error.message === "INVALID_CAPACITY"
                  ? "ظرفیت باید عددی از ۱ تا ۱۰۰۰۰ باشد. دوباره بفرست."
                  : error instanceof Error &&
                      error.message === "NODE_NOT_CONFIGURED"
                    ? "سرور این سرویس هنوز انتخاب نشده است. مدیر باید از بخش سرورها، سرور فروش یا تست را مشخص کند."
                    : error instanceof Error &&
                        error.message === "ACCOUNT_NOT_READY"
                      ? "پیام این کانفیگ هنوز آماده نیست یا اعتبارش تمام شده است. وضعیت کانفیگ را بررسی کن."
                      : state?.step === "quota"
                        ? "حجم باید یک عدد از ۱ تا ۱۰۰۰ گیگابایت باشد. دوباره بفرست یا از منو خارج شو."
                        : state?.step === "days"
                          ? "مدت باید یک عدد از ۱ تا ۳۶۵ روز باشد. دوباره بفرست یا از منو خارج شو."
                          : "این درخواست در دسترس نیست یا اجازهٔ انجام آن را نداری. از منو ادامه بده.",
      state?.step === "confirm"
        ? [[btn("تغییر سرور", "rs:servers")], home()]
        : [home()],
    );
  }
}
