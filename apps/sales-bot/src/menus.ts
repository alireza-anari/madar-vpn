import { getSubscription, subscriptionLink } from "./subscriptions";
import { resolveActor } from "./auth";
import { admin, type Actor, type TelegramUpdate } from "./contracts";
import { enqueue } from "./telegram";
import {
  approveOrder,
  createOrder,
  ensureUser,
  rejectOrder,
  reserveTrial,
} from "./orders";
import { recordReceipt } from "./receipts";
import { savePayment, savePlan } from "./plans";
const button = (text: string, callback_data: string) => ({
  text,
  callback_data,
});
export async function handleUpdate(env: Env, u: TelegramUpdate, now: number) {
  const id = u.message?.from?.id ?? u.callback_query?.from.id;
  const chat = u.message?.chat ?? u.callback_query?.message?.chat;
  if (!id || !chat || chat.type !== "private" || chat.id !== id) return;
  const actor = resolveActor(String(id), env);
  const db = env.SALES_DB;
  await ensureUser(db, actor.telegramId);
  const reply = async (text: string, rows?: Record<string, unknown>[][]) =>
    enqueue(db, `u${u.update_id}:reply`, actor.telegramId, {
      text,
      ...(rows ? { reply_markup: { inline_keyboard: rows } } : {}),
    });
  const setState = async (state: string) =>
    db
      .prepare("UPDATE users SET conversation=? WHERE id=?")
      .bind(state, actor.telegramId)
      .run();
  try {
    const data = u.callback_query?.data;
    if (u.message?.text === "/start" || data === "home") {
      await setState("");
      const rows: Record<string, unknown>[][] = [
        [button("تست رایگان", "trial"), button("خرید اشتراک", "buy")],
        [button("اشتراک من", "mine"), button("راهنما", "help")],
      ];
      if (actor.role === "admin")
        rows.push(
          [
            button("پرداخت‌های منتظر", "admin:orders"),
            button("مدیریت پلن‌ها", "admin:plans"),
          ],
          [
            button("اطلاعات پرداخت", "admin:payment"),
            button("نودها", "admin:nodes"),
          ],
          [button("مدیریت کاربران", "admin:users")],
        );
      await reply("به مدار خوش آمدی. گزینه موردنظر را انتخاب کن.", rows);
      return;
    }
    if (data?.startsWith("admin:")) {
      admin(actor);
      const parts = data.split(":");
      const action = parts[1],
        target = parts[2];
      if (action === "payment") {
        await setState("payment");
        await reply("اطلاعات پرداخت و نام صاحب حساب را در یک پیام بفرست.");
        return;
      }
      if (action === "plans") {
        const plans = await db
          .prepare("SELECT id,name,price,currency,duration,enabled FROM plans")
          .all();
        await reply(
          `پلن‌ها: ${plans.results.length ? plans.results.map((p) => `${p.name}: ${p.price} ${p.currency}، ${Number(p.duration) / 86400} روز، ${p.enabled ? "فعال" : "غیرفعال"}`).join("\n") : "هنوز پلنی تنظیم نشده."}`,
          [[button("افزودن پلن", "admin:newplan")]],
        );
        return;
      }
      if (action === "newplan") {
        await setState("plan:name");
        await reply("نام پلن جدید را بفرست.");
        return;
      }
      if (action === "orders") {
        const orders = await db
          .prepare(
            "SELECT id,user_id,price,currency FROM orders WHERE state='pending_review' ORDER BY created_at LIMIT 20",
          )
          .all<{
            id: string;
            user_id: string;
            price: number;
            currency: string;
          }>();
        await reply(
          orders.results.length
            ? "سفارش را برای مشاهده رسید انتخاب کن."
            : "پرداخت منتظری وجود ندارد.",
          orders.results.map((o) => [
            button(
              `${o.user_id} · ${o.price} ${o.currency}`,
              `admin:order:${o.id}`,
            ),
          ]),
        );
        return;
      }
      if (action === "order" && target) {
        const o = await db
          .prepare(
            "SELECT o.*,r.file_id,r.kind FROM orders o LEFT JOIN receipts r ON r.order_id=o.id WHERE o.id=?",
          )
          .bind(target)
          .first();
        if (!o) throw new Error("ORDER_NOT_AVAILABLE");
        await reply(
          `سفارش ${o.id}\nکاربر: ${o.user_id}\nمبلغ: ${o.price} ${o.currency}\nوضعیت: ${o.state}`,
          [
            [
              button("تأیید پرداخت", `admin:confirm:${target}`),
              button("رد با دلیل", `admin:reject:${target}`),
            ],
          ],
        );
        if (o.file_id)
          await enqueue(db, `u${u.update_id}:receipt`, actor.telegramId, {
            _method: o.kind === "photo" ? "sendPhoto" : "sendDocument",
            [o.kind === "photo" ? "photo" : "document"]: o.file_id,
            caption: "رسید پرداخت",
          });
        return;
      }
      if (action === "confirm" && target) {
        await reply(
          "پرداخت این سفارش را بررسی کرده‌ای؟ تأیید، اعتبار مشتری را فعال می‌کند.",
          [
            [
              button("بله، تأیید نهایی", `admin:approve:${target}`),
              button("بازگشت", "admin:orders"),
            ],
          ],
        );
        return;
      }
      if (action === "approve" && target) {
        const result = await approveOrder(db, actor, target, now);
        await reply(
          result.applied
            ? "پرداخت تأیید و اعتبار ثبت شد."
            : "این سفارش قبلاً تعیین تکلیف شده یا آماده تأیید نیست.",
        );
        if (result.applied) {
          const owner = await db
            .prepare("SELECT user_id FROM orders WHERE id=?")
            .bind(target)
            .first<string>("user_id");
          if (owner)
            await enqueue(db, `approved:${target}`, owner, {
              text: "پرداخت تأیید شد؛ آماده‌سازی اتصال. برای دریافت کانفیگ «اشتراک من» را بزن.",
            });
        }
        return;
      }
      if (action === "reject" && target) {
        await setState(`reject:${target}`);
        await reply("دلیل رد رسید را بفرست.");
        return;
      }
      if (action === "nodes") {
        const nodes = await db
          .prepare("SELECT id,name,state FROM nodes ORDER BY name LIMIT 20")
          .all();
        await reply(
          nodes.results.length
            ? nodes.results.map((n) => `${n.name}: ${n.state}`).join("\n")
            : "هنوز نودی آماده نیست.",
          [
            [
              {
                text: "افزودن VPS با نصب خودکار",
                web_app: { url: `${env.PUBLIC_BASE_URL}/enroll` },
              },
            ],
          ],
        );
        return;
      }
      if (action === "users") {
        await setState("user:lookup");
        await reply("شناسه عددی تلگرام مشتری را بفرست.");
        return;
      }
      if (action === "revoke" && target) {
        await reply("لغو دسترسی این کاربر را تأیید کن.", [
          [button("لغو نهایی", `admin:revoked:${target}`)],
        ]);
        return;
      }
      if (action === "revoked" && target && /^\d+$/.test(target)) {
        await db.batch([
          db
            .prepare("UPDATE entitlements SET revoked=1 WHERE user_id=?")
            .bind(target),
          db
            .prepare(
              "INSERT INTO audit_events(actor_id,action,target_id,created_at) VALUES(?,'revoke_user',?,?)",
            )
            .bind(actor.telegramId, target, now),
        ]);
        await reply(
          "دسترسی لغو شد؛ اعمال روی نود در وضعیت سیاست قابل بررسی است.",
        );
        return;
      }
      throw new Error("INVALID_ACTION");
    }
    if (data === "trial") {
      const result = await reserveTrial(db, actor);
      await reply(
        result.created
          ? "تست رزرو شد؛ پس از آماده‌شدن نود، تست ۳۰ دقیقه‌ای آغاز می‌شود. «اشتراک من» را بررسی کن."
          : "تست این حساب قبلاً رزرو یا استفاده شده است.",
      );
      return;
    }
    if (data === "buy") {
      const plans = await db
        .prepare("SELECT id,name,price,currency FROM plans WHERE enabled=1")
        .all<{ id: string; name: string; price: number; currency: string }>();
      await reply(
        plans.results.length
          ? "پلن را انتخاب کن."
          : "فروش هنوز تنظیم نشده است.",
        plans.results.map((p) => [
          button(`${p.name} · ${p.price} ${p.currency}`, `plan:${p.id}`),
        ]),
      );
      return;
    }
    if (data?.startsWith("plan:")) {
      const o = await createOrder(
        db,
        actor,
        data.slice(5),
        now,
        String(u.update_id),
      );
      await setState(`receipt:${o.id}`);
      const payment = await db
        .prepare("SELECT value FROM settings WHERE key='payment'")
        .first("value");
      await reply(
        `مبلغ: ${o.price} ${o.currency}\n${payment}\nپس از پرداخت عکس یا فایل رسید را همین‌جا بفرست.\nسفارش: ${o.id}`,
      );
      return;
    }
    if (data === "help") {
      await reply(
        "پس از دریافت لینک اشتراک، آن را در v2rayNG اندروید یا برنامه سازگار با VLESS REALITY وارد کن. پرداخت فقط پس از بررسی ادمین فعال می‌شود.",
      );
      return;
    }
    if (data === "mine") {
      const result = await getSubscription(db, actor.telegramId, now);
      if (!result.configs.length) {
        await reply(
          "اشتراک فعال یا نود آماده وجود ندارد؛ اگر تست یا خرید ثبت کرده‌ای، آماده‌سازی را بعداً بررسی کن.",
        );
        return;
      }
      const link = await subscriptionLink(env, actor.telegramId);
      await reply(
        `اشتراک تو تا ${new Date(result.validUntil * 1000).toISOString()} معتبر است.\nلینک اشتراک:\n${link}\n\n${result.configs.join("\n\n")}`,
      );
      return;
    }
    const state =
      (await db
        .prepare("SELECT conversation FROM users WHERE id=?")
        .bind(actor.telegramId)
        .first<string>("conversation")) || "";
    if (state.startsWith("receipt:")) {
      const file =
        u.message?.document?.file_id ?? u.message?.photo?.at(-1)?.file_id;
      if (!file) {
        await reply("رسید را به صورت عکس یا فایل بفرست.");
        return;
      }
      const orderId = state.slice(8);
      await recordReceipt(
        db,
        actor,
        orderId,
        file,
        u.message?.document ? "document" : "photo",
      );
      await setState("");
      await reply("رسید ثبت شد؛ منتظر بررسی ادمین باش.");
      for (const adminId of env.ADMIN_TELEGRAM_IDS.split(",")
        .map((x) => x.trim())
        .filter((x) => /^\d+$/.test(x)))
        await enqueue(db, `receipt:${orderId}:${adminId}`, adminId, {
          text: "رسید جدید برای بررسی ثبت شد.",
          reply_markup: {
            inline_keyboard: [
              [button("مشاهده سفارش", `admin:order:${orderId}`)],
            ],
          },
        });
      return;
    }
    if (state && u.message?.text) {
      admin(actor);
      const text = u.message.text.trim();
      if (state === "payment") {
        await savePayment(db, actor, text, now);
        await setState("");
        await reply("اطلاعات پرداخت ذخیره شد.");
        return;
      }
      if (state.startsWith("reject:")) {
        const orderId = state.slice(7);
        await rejectOrder(db, actor, orderId, text, now);
        const o = await db
          .prepare("SELECT user_id FROM orders WHERE id=? AND state='rejected'")
          .bind(orderId)
          .first<string>("user_id");
        if (o)
          await enqueue(db, `rejected:${orderId}`, o, {
            text: `رسید رد شد: ${text}`,
          });
        await setState("");
        await reply("نتیجه ثبت شد.");
        return;
      }
      if (state === "plan:name") {
        if (!text || text.length > 80) throw new Error("INVALID_PLAN");
        await setState(JSON.stringify({ step: "plan:price", name: text }));
        await reply("قیمت به تومان را فقط با عدد انگلیسی بفرست.");
        return;
      }
      if (state.startsWith("{")) {
        const wizard = JSON.parse(state) as {
          step: string;
          name: string;
          price?: number;
        };
        const n = Number(text);
        if (!Number.isSafeInteger(n) || n <= 0) throw new Error("INVALID_PLAN");
        if (wizard.step === "plan:price") {
          await setState(
            JSON.stringify({ ...wizard, step: "plan:days", price: n }),
          );
          await reply("مدت پلن به روز را با عدد انگلیسی بفرست.");
          return;
        }
        if (wizard.step === "plan:days" && wizard.price) {
          await savePlan(
            db,
            actor,
            {
              id: crypto.randomUUID(),
              name: wizard.name,
              price: wizard.price,
              duration: n * 86400,
              currency: "IRT",
              enabled: true,
            },
            now,
          );
          await setState("");
          await reply("پلن ذخیره و فعال شد.");
          return;
        }
      }
      if (state === "user:lookup") {
        if (!/^\d+$/.test(text)) throw new Error("INVALID_ACTION");
        const e = await db
          .prepare(
            "SELECT valid_until,revoked FROM entitlements WHERE user_id=?",
          )
          .bind(text)
          .first();
        await setState("");
        await reply(
          e
            ? `کاربر ${text}\nانقضا: ${new Date(Number(e.valid_until) * 1000).toISOString()}\nلغو: ${e.revoked ? "بله" : "خیر"}`
            : "کاربر یافت نشد.",
          e ? [[button("لغو دسترسی", `admin:revoke:${text}`)]] : undefined,
        );
        return;
      }
    }
    await reply("برای دیدن منو /start را بفرست.");
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (
      ![
        "ADMIN_REQUIRED",
        "INVALID_ACTION",
        "INVALID_PLAN",
        "INVALID_PAYMENT",
        "INVALID_REASON",
        "ORDER_NOT_AVAILABLE",
        "SALES_DISABLED",
        "INVALID_RECEIPT",
      ].includes(code)
    )
      throw error;
    await reply(
      code === "ADMIN_REQUIRED"
        ? "به این بخش دسترسی نداری."
        : code === "SALES_DISABLED"
          ? "فروش هنوز تنظیم نشده است."
          : "این عملیات در وضعیت فعلی قابل انجام نیست؛ ورودی را بررسی کن.",
    );
  }
}
