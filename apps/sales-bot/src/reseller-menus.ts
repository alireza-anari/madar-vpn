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
    text = u.message?.text;
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
        [btn("صدور کانفیگ", "rs:sale"), btn("تست نیم‌ساعته", "rs:trial")],
        [btn("کانفیگ‌های من", "rs:list")],
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
      await reply("مدیریت کانفیگ مدار", rows);
      return;
    }
    if (data === "rs:sale") {
      await set({ step: "label", requestKey: `sale:${u.update_id}` });
      await reply("نام یا برچسب مشتری را بفرست (حداکثر ۸۰ نویسه).");
      return;
    }
    if (data === "rs:trial") {
      await set({
        step: "confirm",
        requestKey: `trial:${u.update_id}`,
        kind: "trial",
        label: "تست نیم‌ساعته",
        quotaBytes: null,
        durationSeconds: 1800,
      });
      await reply("یک تست مستقل ۳۰ دقیقه‌ای ساخته شود؟", [
        [btn("تأیید تست", `rs:confirm:trial:${u.update_id}`)],
      ]);
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
        `درخواست ثبت شد. شناسه: ${account.id}\nپس از تأیید آماده‌بودن سرور، پیام قابل ارسال به مشتری تحویل می‌شود.`,
      );
      return;
    }
    if (data === "rs:list") {
      const items = await db
        .prepare(
          "SELECT id,label,state FROM managed_accounts WHERE (seller_id=? OR ?=1) ORDER BY created_at DESC LIMIT 30",
        )
        .bind(String(id), actor.role === "admin" ? 1 : 0)
        .all<{ id: string; label: string; state: string }>();
      await reply(
        items.results.length
          ? "کانفیگ را انتخاب کن."
          : "هنوز کانفیگی ثبت نشده.",
        items.results.map((a) => [
          btn(`${a.label} · ${a.state}`, `rs:view:${a.id}`),
        ]),
      );
      return;
    }
    if (data?.startsWith("rs:view:")) {
      const a = await ownedAccount(db, actor, data.slice(8));
      await reply(
        `${a.label}\nوضعیت: ${a.state}\nمصرف ثبت‌شده: ${(a.used_bytes / 1e9).toFixed(3)} گیگابایت\nحجم: ${a.quota_bytes === null ? "تست زمانی" : a.quota_bytes / 1e9 + " گیگابایت"}`,
        actor.role === "admin"
          ? [[btn("لغو کانفیگ", `rs:revoke:${a.id}`)]]
          : undefined,
      );
      return;
    }
    if (data?.startsWith("rs:revoke:")) {
      await revokeAccount(db, actor, data.slice(10), now);
      await reply("کانفیگ لغو شد.");
      return;
    }
    if (data === "rs:seller" || data === "rs:disable") {
      requireSalesAdmin(actor);
      await set({ step: data === "rs:seller" ? "seller" : "disable" });
      await reply("شناسه عددی تلگرام فروشنده را بفرست.");
      return;
    }
    if (data === "rs:nodes") {
      requireSalesAdmin(actor);
      const nodes = await db
        .prepare("SELECT id,name FROM nodes")
        .all<{ id: string; name: string }>();
      await reply(
        "کاربرد هر سرور را انتخاب کن.",
        nodes.results.map((n) => [
          btn(`${n.name}: فروش`, `rs:node:sale:${n.id}`),
          btn(`${n.name}: تست`, `rs:node:trial:${n.id}`),
        ]),
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
      await reply("کاربرد سرور ثبت شد.");
      return;
    }
    if (
      (text && state.step === "seller") ||
      (text && state.step === "disable")
    ) {
      await setReseller(db, actor, text!, state.step === "seller", now);
      await set({});
      await reply("دسترسی فروشنده به‌روزرسانی شد.");
      return;
    }
    if (text && state.step === "label") {
      if (!text.trim() || text.length > 80) throw Error("INVALID");
      await set({ ...state, step: "quota", label: text.trim() });
      await reply("حجم را به گیگابایت بفرست (۱ تا ۱۰۰۰).");
      return;
    }
    if (text && state.step === "quota") {
      if (!/^\d+$/.test(text) || +text < 1 || +text > 1000)
        throw Error("INVALID");
      await set({ ...state, step: "days", quotaBytes: +text * 1e9 });
      await reply("مدت را به روز بفرست (۱ تا ۳۶۵).");
      return;
    }
    if (text && state.step === "days") {
      if (!/^\d+$/.test(text) || +text < 1 || +text > 365)
        throw Error("INVALID");
      await set({
        ...state,
        step: "confirm",
        kind: "sale",
        durationSeconds: +text * 86400,
      });
      await reply(
        `${state.label}\n${state.quotaBytes / 1e9} گیگابایت · ${text} روز`,
        [[btn("تأیید صدور", `rs:confirm:${state.requestKey}`)]],
      );
      return;
    }
    await reply("از منوی فروشندگان استفاده کن.", [[btn("منو", "rs:home")]]);
  } catch (error) {
    if (error instanceof Error && error.message === "CONVERSATION_RETRY")
      throw error;
    await reply("درخواست معتبر نیست یا دسترسی کافی نداری. ورودی را بررسی کن.");
  }
}
