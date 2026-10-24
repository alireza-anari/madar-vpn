import type { TelegramUpdate } from "./contracts";
import { resolveSalesActor } from "./resellers";
import { enqueue } from "./telegram";
import {
  approveCustomerOrder, getCustomerOrderForAdmin, rejectCustomerOrder, submitCustomerReceipt,
} from "./customer-store";

const callback=(label:string,data:string)=>({text:label,callback_data:data});
export async function handleCustomerTelegramUpdate(env:Env,u:TelegramUpdate,now:number):Promise<boolean> {
  const id=u.message?.from?.id ?? u.callback_query?.from.id;
  const chat=u.message?.chat ?? u.callback_query?.message?.chat;
  if (!id || !chat || chat.type!=="private" || chat.id!==id) return false;
  const userId=String(id);
  const actor=await resolveSalesActor(env.SALES_DB,userId,env);
  const data=u.callback_query?.data || "";
  const text=u.message?.text?.trim() || "";
  const db=env.SALES_DB;
  const reply=(value:string,rows?:Record<string,unknown>[][])=>
    enqueue(db,"u"+u.update_id+":reply",userId,{
      text:value,...(rows?{reply_markup:{inline_keyboard:rows}}:{}),
    });

  // Admin reviews the actual Telegram photo/document before confirming any payment.
  if (data.startsWith("cust:") || (actor.role==="admin" && !text.startsWith("/") && !!(await db.prepare("SELECT conversation FROM users WHERE id=? AND conversation LIKE 'customer-reject:%'").bind(userId).first()))) {
    if (actor.role!=="admin") {
      await reply("این بخش فقط برای مدیر است.");
      return true;
    }
    // Keep payment review inside this Telegram bot, without a Mini App.
    // Only the authenticated admin can enumerate pending receipts.
    const inboxPage=data.match(/^cust:inbox:(0|[1-9][0-9]{0,2})$/);
    if (data==="/receipts" || data==="cust:inbox" || inboxPage || text==="/receipts") {
      const page=inboxPage?Number(inboxPage[1]):0;
      const pageSize=6;
      const rows=await db.prepare(
        "SELECT o.id,o.user_id,o.price,o.currency,o.created_at,p.name AS plan_name FROM customer_orders o LEFT JOIN plans p ON p.id=o.plan_id WHERE o.state='pending_review' AND EXISTS (SELECT 1 FROM customer_receipts r WHERE r.order_id=o.id) ORDER BY o.created_at,o.id LIMIT ? OFFSET ?",
      ).bind(pageSize+1,page*pageSize).all<{id:string;user_id:string;price:number;currency:string;created_at:number;plan_name:string|null}>();
      const visible=rows.results.slice(0,pageSize);
      const keyboard:Record<string,unknown>[][]=visible.map((order,i)=>[
        callback(`💳 ${page*pageSize+i+1}. ${order.price.toLocaleString("fa-IR")} ${order.currency==="IRT"?"تومان":"ریال"} · ${order.id.slice(0,8)}`,
          "cust:review:"+order.id),
      ]);
      const navigation:Record<string,unknown>[]=[];
      if(page>0) navigation.push(callback("◀️ قبلی","cust:inbox:"+(page-1)));
      if(rows.results.length>pageSize && page<999) navigation.push(callback("بعدی ▶️","cust:inbox:"+(page+1)));
      if(navigation.length) keyboard.push(navigation);
      keyboard.push([callback("🔄 تازه‌سازی","cust:inbox:"+page)]);
      keyboard.push([callback("🏠 منوی اصلی","rs:home")]);
      await reply(visible.length?
        "💳 رسیدهای در انتظار تأیید\nروی هر سفارش بزن تا عکس یا فایل رسید را ببینی و سپس تأیید یا رد کنی.\nقبل از تأیید، واریز واقعی را از حساب بانکی بررسی کن.":
        page>0?"در این صفحه رسیدی وجود ندارد. به صفحه قبلی برگرد.":"✅ فعلاً هیچ رسیدی در انتظار تأیید نیست.",keyboard);
      return true;
    }
    const match=data.match(/^cust:(review|approve|reject):([a-f0-9-]{36})$/);
    try {
      if (match) {
        const [,action,orderId]=match;
        const order=await getCustomerOrderForAdmin(db,actor,orderId!);
        if (!order) throw Error("ORDER_NOT_AVAILABLE");
        if (action==="review") {
          const canDecide=order.state==="pending_review" && !!order.file_id;
          await reply("سفارش "+order.id+"\nمشتری: "+order.user_id+
            "\nمبلغ: "+order.price.toLocaleString("fa-IR")+" "+(order.currency==="IRT"?"تومان":"ریال")+
            "\nوضعیت: "+order.state+
            "\nرسید را بررسی کنید و فقط بعد از اطمینان از واریز، تأیید کنید.",[
            ...(canDecide?[
              [callback("✅ تأیید پرداخت","cust:approve:"+order.id)],
              [callback("❌ رد پرداخت","cust:reject:"+order.id)],
            ]:[]),
            [callback("💳 رسیدهای در انتظار","cust:inbox:0")],
          ]);
          if (order.file_id && order.kind)
            await enqueue(db,"u"+u.update_id+":customer-proof",userId,{
              _method:order.kind==="photo"?"sendPhoto":"sendDocument",
              [order.kind==="photo"?"photo":"document"]:order.file_id,
              caption:"رسید سفارش "+order.id,
            });
          return true;
        }
        if (action==="approve") {
          await approveCustomerOrder(env,actor,orderId!,now);
          await reply("✅ پرداخت تأیید و صدور کانفیگ درخواست شد. فعال‌شدن پس از ACK سرور خواهد بود.",[[callback("💳 رسیدهای در انتظار","cust:inbox:0")]]);
          return true;
        }
        await db.prepare("INSERT OR IGNORE INTO users(id) VALUES(?)").bind(userId).run();
        await db.prepare("UPDATE users SET conversation=? WHERE id=?")
          .bind("customer-reject:"+orderId,userId).run();
        await reply("دلیل رد سفارش را ارسال کنید.");
        return true;
      }
      const state=await db.prepare("SELECT conversation FROM users WHERE id=?")
        .bind(userId).first<string>("conversation");
      if (state?.startsWith("customer-reject:") && text && !text.startsWith("/")) {
        await rejectCustomerOrder(db,actor,state.slice(16),text,now);
        await db.prepare("UPDATE users SET conversation='' WHERE id=?").bind(userId).run();
        await reply("❌ سفارش رد شد و مشتری مطلع شد.",[[callback("💳 رسیدهای در انتظار","cust:inbox:0")]]);
        return true;
      }
    } catch(error) {
      const code=error instanceof Error?error.message:"";
      const expected=["ORDER_NOT_AVAILABLE","NODE_FULL","NODE_UNAVAILABLE","NODE_ALLOCATION_FULL","SELLER_ALLOCATION_FULL","SELLER_ACCOUNT_LIMIT"];
      if (!expected.includes(code)) throw error;
      await reply("امکان تأیید نیست: "+code+"؛ ظرفیت سرور یا وضعیت سفارش را بررسی کنید.");
      return true;
    }
    await reply("درخواست نامعتبر است.");
    return true;
  }

  if (actor.role!=="ordinary") return false;
  // Keep reseller invitation deep links handled by the existing reseller workflow.
  if (text.startsWith("/start seller_")) return false;
  await db.prepare("INSERT OR IGNORE INTO users(id) VALUES(?)").bind(userId).run();
  const state=await db.prepare("SELECT conversation FROM users WHERE id=?").bind(userId).first<string>("conversation");
  if (text==="/start" || text==="/menu" || data==="customer:home") {
    await db.prepare("UPDATE users SET conversation='' WHERE id=?").bind(userId).run();
    const url=(env.PUBLIC_BASE_URL || "").replace(/\/+$/,"")+"/customer";
    await reply("✨ به مدار خوش آمدید.\nبرای مشاهده طرح‌ها، خرید اشتراک و دریافت کانفیگ وارد پنل مشتری شوید.",env.PUBLIC_BASE_URL?[
      [{text:"🛍️ ورود به پنل مشتری",web_app:{url}}],
    ]:undefined);
    return true;
  }
  if (state?.startsWith("customer-receipt:") && (u.message?.photo?.length || u.message?.document)) {
    const orderId=state.slice(17);
    const fileId=u.message?.document?.file_id ?? u.message?.photo?.at(-1)?.file_id ?? "";
    try {
      const accepted=await submitCustomerReceipt(db,userId,orderId,fileId,u.message?.document?"document":"photo");
      await db.prepare("UPDATE users SET conversation='' WHERE id=?").bind(userId).run();
      await reply("✅ رسید ثبت شد و در انتظار بررسی مدیر است. وضعیت سفارش را از پنل مشتری ببینید.");
      if (accepted) for (const adminId of (env.ADMIN_TELEGRAM_IDS || "").split(",").map(s=>s.trim()).filter(s=>/^\d+$/.test(s)))
        await enqueue(db,"customer-review:"+orderId+":"+adminId,adminId,{
          text:"💳 رسید جدید مشتری "+userId+"؛ سفارش "+orderId,
          reply_markup:{inline_keyboard:[[callback("بررسی رسید","cust:review:"+orderId)]]},
        });
    } catch(error) {
      if (!(error instanceof Error) || error.message!=="ORDER_NOT_AVAILABLE") throw error;
      await reply("این سفارش دیگر منتظر رسید نیست. وضعیت آن را در پنل بررسی کنید.");
    }
    return true;
  }
  if (state?.startsWith("customer-receipt:")) {
    await reply("برای این سفارش عکس یا فایل رسید پرداخت را ارسال کنید. با /start می‌توانید به پنل برگردید.");
    return true;
  }
  await reply("برای خرید و مشاهده سفارش‌ها /start را بفرستید.");
  return true;
}
