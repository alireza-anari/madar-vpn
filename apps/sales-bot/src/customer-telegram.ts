import type { TelegramUpdate } from "./contracts";
import { resolveSalesActor } from "./resellers";
import { enqueue } from "./telegram";
import {
  approveCustomerOrder, availableCustomerNodes, cancelUnpaidCustomerOrder, createCustomerOrder, customerConfig,
  customerPlans, getCustomerOrderForAdmin, listCustomerOrders, paymentInstructions,
  rejectCustomerOrder, requestCustomerReceipt, submitCustomerReceipt,
} from "./customer-store";
import { createCustomerQrUrl } from "./customer-qr";
import {
  adminUpgrade, approveUpgrade, cancelUpgrade, createCustomerUpgrade,
  listCustomerUpgrades, ownedCustomerService, rejectUpgrade, requestUpgradeReceipt,
  submitUpgradeReceipt,
} from "./customer-upgrades";

const callback=(label:string,data:string)=>({text:label,callback_data:data});
const NODE_STATE_PREFIX="customer-node-list:";
type NodeChoice={id:string;name:string};
type NodeState={flow:"customer-node-list";planId:string;nodes:NodeChoice[];nonce:string};
const money=(price:number,currency:string)=>price.toLocaleString("fa-IR")+" "+(currency==="IRT"?"تومان":"ریال");
const gb=(bytes:number)=>Math.max(1,Math.round(bytes/1e9)).toLocaleString("fa-IR")+" گیگابایت";
const traffic=(bytes:number|null)=>((Math.max(0,bytes||0)/1e9).toLocaleString("fa-IR",{maximumFractionDigits:1}))+" گیگابایت";
const days=(seconds:number)=>Math.max(1,Math.round(seconds/86400)).toLocaleString("fa-IR")+" روز";
const dateTime=(seconds:number)=>new Date(seconds*1000).toLocaleString("fa-IR",{timeZone:"Asia/Tehran"});
const escapeHtml=(value:string)=>value.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
const usageBar=(used:number,total:number)=>{
  const ratio=total>0?Math.min(1,Math.max(0,used/total)):0;
  const filled=Math.round(ratio*10);
  return "🟩".repeat(filled)+"⬜".repeat(10-filled);
};
type CustomerOrderView={state:string;accountState:string|null;usedBytes:number|null;quotaBytes:number;validUntil:number|null;reason?:string|null};
function statusLabel(order:CustomerOrderView,now:number) {
  if(order.state==="awaiting_receipt") return "در انتظار رسید پرداخت";
  if(order.state==="pending_review") return "رسید در حال بررسی";
  if(order.state==="approving") return "در حال آماده‌سازی";
  if(order.state==="approved") {
    if(order.accountState==="revoked") return "دسترسی لغو شده";
    if(order.accountState==="exhausted" || (order.usedBytes!==null && order.quotaBytes>0 && order.usedBytes>=order.quotaBytes)) return "حجم تمام شده";
    if(order.validUntil!==null && order.validUntil<=now) return "اشتراک منقضی";
    if(order.accountState==="active" && order.validUntil!==null && order.validUntil>now) return "اشتراک فعال";
    return "در حال آماده‌سازی کانفیگ";
  }
  if(order.state==="rejected") return order.reason==="لغو توسط مشتری"?"لغوشده توسط مشتری":"پرداخت رد شده";
  return order.state;
}
function parseNodeState(raw:string):NodeState|null {
  if(!raw.startsWith(NODE_STATE_PREFIX)) return null;
  try {
    const value=JSON.parse(raw.slice(NODE_STATE_PREFIX.length)) as NodeState;
    if(value.flow!=="customer-node-list" || !/^[a-zA-Z0-9_-]{1,40}$/.test(value.planId) ||
      !Array.isArray(value.nodes) || typeof value.nonce!=="string") return null;
    return value;
  } catch { return null; }
}
export async function handleCustomerTelegramUpdate(env:Env,u:TelegramUpdate,now:number):Promise<boolean> {
  const id=u.message?.from?.id ?? u.callback_query?.from.id;
  const chat=u.message?.chat ?? u.callback_query?.message?.chat;
  if (!id || !chat || chat.type!=="private" || chat.id!==id) return false;
  const userId=String(id);
  const actor=await resolveSalesActor(env.SALES_DB,userId,env);
  const data=u.callback_query?.data || "";
  const text=u.message?.text?.trim() || "";
  const command=text.split(/\s+/,1)[0]?.split("@",1)[0] || "";
  const db=env.SALES_DB;
  const callbackMessage=u.callback_query?.message;
  const canEdit=actor.role==="ordinary" && !!data && !!callbackMessage?.text &&
    Number.isSafeInteger(callbackMessage.message_id) && Number(callbackMessage.message_id)>0;
  const reply=(value:string,rows?:Record<string,unknown>[][],extra:Record<string,unknown>={})=>
    enqueue(db,"u"+u.update_id+":reply",userId,{
      ...(canEdit?{_method:"editMessageText",message_id:callbackMessage!.message_id}:{}),
      text:value,...extra,...(rows?{reply_markup:{inline_keyboard:rows}}:{}),
    });
  const setConversation=async(value:string)=> {
    await db.prepare("INSERT OR IGNORE INTO users(id) VALUES(?)").bind(userId).run();
    await db.prepare("UPDATE users SET conversation=? WHERE id=?").bind(value,userId).run();
  };
  const homeRows:Record<string,unknown>[][]=[
    [callback("🛍️ خرید اشتراک","customer:buy"),callback("🌐 سرویس‌های من","customer:services")],
    [callback("📦 سفارش‌های من","customer:orders:0"),callback("📖 راهنمای اتصال","customer:help")],
  ];

  // Customer upgrade receipts use a distinct inbox; never approve by trusting a Telegram image alone.
  const rejectState=actor.role==="admin" && !data && !!text && !text.startsWith("/")
    ? await db.prepare("SELECT conversation FROM users WHERE id=?").bind(userId).first<string>("conversation")
    : null;
  if(data.startsWith("cust:up:") || rejectState?.startsWith("customer-upgrade-reject:")) {
    if(actor.role!=="admin") {
      await reply("این بخش فقط برای مدیر است.");
      return true;
    }
    const pageMatch=data.match(/^cust:up:list:(0|[1-9][0-9]{0,2})$/);
    if(data==="cust:up:list" || pageMatch) {
      const page=pageMatch?Number(pageMatch[1]):0,limit=6;
      const rows=await db.prepare(
        "SELECT id,user_id,kind,price,currency,created_at FROM customer_upgrades " +
        "WHERE state='pending_review' AND EXISTS(SELECT 1 FROM customer_upgrade_receipts r WHERE r.upgrade_id=customer_upgrades.id) " +
        "ORDER BY created_at,id LIMIT ? OFFSET ?"
      ).bind(limit+1,page*limit).all<{id:string;user_id:string;kind:string;price:number;currency:string;created_at:number}>();
      const keyboard:Record<string,unknown>[][]=rows.results.slice(0,limit).map(item=>[
        callback("💳 "+(item.kind==="renew"?"تمدید":"حجم اضافه")+" · "+money(item.price,item.currency)+" · #"+item.id.slice(0,8),
          "cust:up:review:"+item.id),
      ]);
      const nav:Record<string,unknown>[]=[];
      if(page>0) nav.push(callback("◀️ قبلی","cust:up:list:"+(page-1)));
      if(rows.results.length>limit && page<999) nav.push(callback("بعدی ▶️","cust:up:list:"+(page+1)));
      if(nav.length) keyboard.push(nav);
      keyboard.push([callback("🔄 تازه‌سازی","cust:up:list:"+page)]);
      keyboard.push([callback("💳 خریدهای اولیه","cust:inbox:0")],[callback("🏠 منوی اصلی","rs:home")]);
      await reply(rows.results.length
        ?"💳 <b>رسیدهای تمدید و حجم اضافه</b>\nقبل از تأیید، انتقال وجه را مستقلاً از حساب بانکی بررسی کنید."
        :"✅ فعلاً رسید تمدید یا حجم اضافه‌ای در این صفحه منتظر بررسی نیست.",keyboard,{parse_mode:"HTML"});
      return true;
    }
    const review=data.match(/^cust:up:(review|approve|reject):([a-f0-9-]{36})$/);
    try {
      if(review) {
        const [,action,upgradeId]=review;
        const upgrade=await adminUpgrade(db,actor,upgradeId!);
        if(!upgrade) throw Error("ORDER_NOT_AVAILABLE");
        if(action==="review") {
          const canDecide=upgrade.state==="pending_review" && !!upgrade.file_id;
          await reply("🧾 <b>بررسی پرداخت "+(upgrade.kind==="renew"?"تمدید":"حجم اضافه")+"</b>\n"+
            "شماره: <code>"+upgrade.id+"</code>\nمشتری: "+upgrade.user_id+
            "\nمبلغ: <b>"+money(upgrade.price,upgrade.currency)+"</b>"+
            "\n"+(upgrade.kind==="traffic"?"حجم: "+gb(upgrade.delta_bytes):"مدت: "+days(upgrade.delta_seconds))+
            "\nوضعیت: "+upgrade.state+"\n\nفقط پس از تأیید واریز واقعی بانک، اقدام کنید.",[
              ...(canDecide?[
                [callback("✅ تأیید و اعمال روی کانفیگ","cust:up:approve:"+upgrade.id)],
                [callback("❌ رد پرداخت","cust:up:reject:"+upgrade.id)],
              ]:[]),
              [callback("💳 صندوق تمدید و حجم","cust:up:list:0")],
            ],{parse_mode:"HTML"});
          if(upgrade.file_id && upgrade.receipt_kind)
            await enqueue(db,"u"+u.update_id+":upgrade-proof",userId,{
              _method:upgrade.receipt_kind==="photo"?"sendPhoto":"sendDocument",
              [upgrade.receipt_kind==="photo"?"photo":"document"]:upgrade.file_id,
              caption:"رسید تمدید/حجم "+upgrade.id,
            });
          return true;
        }
        if(action==="approve") {
          await approveUpgrade(env,actor,upgradeId!,now);
          await reply("✅ پرداخت تأیید شد؛ همان کانفیگ در حال به‌روزرسانی است. پس از ACK سرور مشتری مطلع می‌شود.",[
            [callback("💳 صندوق تمدید و حجم","cust:up:list:0")],
          ]);
          return true;
        }
        if(upgrade.state!=="pending_review") throw Error("ORDER_NOT_AVAILABLE");
        await setConversation("customer-upgrade-reject:"+upgradeId);
        await reply("دلیل رد این پرداخت را ارسال کنید. مشتری از رد و لزوم پیگیری استرداد وجه مطلع می‌شود.");
        return true;
      }
      if(rejectState?.startsWith("customer-upgrade-reject:")) {
        await rejectUpgrade(db,actor,rejectState.slice("customer-upgrade-reject:".length),text,now);
        await setConversation("");
        await reply("❌ درخواست رد شد و مشتری از نتیجه مطلع شد.",[
          [callback("💳 صندوق تمدید و حجم","cust:up:list:0")],
        ]);
        return true;
      }
    } catch(error) {
      const code=error instanceof Error?error.message:"";
      if(!["ORDER_NOT_AVAILABLE","UPGRADE_CAPACITY_CHANGED","NODE_UNAVAILABLE"].includes(code)) throw error;
      await reply(code==="UPGRADE_CAPACITY_CHANGED"?
        "⚠️ ظرفیت یا وضعیت اشتراک تغییر کرده است. پرداخت را دوباره تأیید نکنید؛ از صندوق سفارش‌ها بررسی و درباره جایگزین یا استرداد وجه تصمیم بگیرید.":
        "درخواست قابل تأیید نیست: "+code,[[callback("💳 صندوق تمدید و حجم","cust:up:list:0")]]);
      return true;
    }
    await reply("درخواست نامعتبر است.");
    return true;
  }

  // Admin reviews the actual Telegram photo/document before confirming any payment.
  if (data.startsWith("cust:") || (actor.role==="admin" && (text==="/receipts" || (!text.startsWith("/") && !!(await db.prepare("SELECT conversation FROM users WHERE id=? AND conversation LIKE 'customer-reject:%'").bind(userId).first()))))) {
    if (actor.role!=="admin") {
      await reply("این بخش فقط برای مدیر است.");
      return true;
    }
    const inboxPage=data.match(/^cust:inbox:(0|[1-9][0-9]{0,2})$/);
    if (data==="/receipts" || data==="cust:inbox" || inboxPage || text==="/receipts") {
      const page=inboxPage?Number(inboxPage[1]):0;
      const pageSize=6;
      const rows=await db.prepare(
        "SELECT o.id,o.user_id,o.price,o.currency,o.created_at,p.name AS plan_name FROM customer_orders o LEFT JOIN plans p ON p.id=o.plan_id WHERE o.state='pending_review' AND EXISTS (SELECT 1 FROM customer_receipts r WHERE r.order_id=o.id) ORDER BY o.created_at,o.id LIMIT ? OFFSET ?",
      ).bind(pageSize+1,page*pageSize).all<{id:string;user_id:string;price:number;currency:string;created_at:number;plan_name:string|null}>();
      const visible=rows.results.slice(0,pageSize);
      const keyboard:Record<string,unknown>[][]=visible.map((order,i)=>[
        callback(`💳 ${(page*pageSize+i+1).toLocaleString("fa-IR")}. ${money(order.price,order.currency)} · ${order.id.slice(0,8)}`,
          "cust:review:"+order.id),
      ]);
      const navigation:Record<string,unknown>[]=[];
      if(page>0) navigation.push(callback("◀️ قبلی","cust:inbox:"+(page-1)));
      if(rows.results.length>pageSize && page<999) navigation.push(callback("بعدی ▶️","cust:inbox:"+(page+1)));
      if(navigation.length) keyboard.push(navigation);
      keyboard.push([callback("🔄 تازه‌سازی","cust:inbox:"+page)]);
      keyboard.push([callback("🔁 صندوق تمدید و حجم اضافه","cust:up:list:0")]);
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
            "\nمبلغ: "+money(order.price,order.currency)+
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
        await setConversation("customer-reject:"+orderId);
        await reply("دلیل رد سفارش را ارسال کنید.");
        return true;
      }
      const state=await db.prepare("SELECT conversation FROM users WHERE id=?").bind(userId).first<string>("conversation");
      if (state?.startsWith("customer-reject:") && text && !text.startsWith("/")) {
        await rejectCustomerOrder(db,actor,state.slice(16),text,now);
        await setConversation("");
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

  if(actor.role!=="ordinary") return false;
  // Preserve reseller invitation deep links for the existing reseller workflow.
  if(command==="/start" && text.startsWith("/start seller_")) return false;
  await db.prepare("INSERT OR IGNORE INTO users(id) VALUES(?)").bind(userId).run();
  const state=await db.prepare("SELECT conversation FROM users WHERE id=?").bind(userId).first<string>("conversation");

  if(["/start","/menu","/cancel"].includes(command) || data==="customer:home") {
    await setConversation("");
    const welcome="✨ <b>مدار | فروشگاه VPN</b>\n"+
      "━━━━━━━━━━━━━━━━\n"+
      "🛡️ اتصال مطمئن، خرید ساده و پشتیبانی مستقیم\n\n"+
      "از انتخاب پلن تا دریافت کانفیگ، همه‌چیز در همین ربات انجام می‌شود؛ نیازی به بازکردن مینی‌اپ نیست.\n\n"+
      "👇 <b>برای شروع یکی از گزینه‌ها را انتخاب کن.</b>";
    if(command==="/start" && env.PUBLIC_BASE_URL) {
      await enqueue(db,"u"+u.update_id+":reply",userId,{
        _method:"sendPhoto",
        photo:new URL("/madar-logo.png",env.PUBLIC_BASE_URL).toString(),
        caption:welcome,
        parse_mode:"HTML",
        reply_markup:{inline_keyboard:homeRows},
      });
    } else {
      await reply(welcome,homeRows,{parse_mode:"HTML"});
    }
    return true;
  }

  const catalogPageMatch=data.match(/^customer:plans:(0|[1-9][0-9]{0,2})$/);
  if(data==="customer:buy" || command==="/buy" || catalogPageMatch) {
    const isBuy=data==="customer:buy" || command==="/buy";
    await setConversation("");
    if(isBuy) {
      const pending=await db.prepare("SELECT id,price,currency FROM customer_orders WHERE user_id=? AND state='awaiting_receipt' ORDER BY created_at DESC,id DESC LIMIT 6")
        .bind(userId).all<{id:string;price:number;currency:string}>();
      if(pending.results.length) {
        const rows:Record<string,unknown>[][]=pending.results.map(order=>[
          callback("📸 ادامه · "+money(order.price,order.currency),"customer:receipt:"+order.id),
          callback("🔎 جزئیات","customer:order:"+order.id),
        ]);
        rows.push([callback("📦 همه سفارش‌ها","customer:orders:0")],[callback("🏠 منوی اصلی","customer:home")]);
        await reply("🧾 <b>یک سفارش پرداخت‌نشده داری</b>\n\nبرای اینکه رسید به سفارش اشتباه وصل نشود، ابتدا همان سفارش را ادامه بده.",rows,{parse_mode:"HTML"});
        return true;
      }
    }
    if(!(await paymentInstructions(db))) {
      await reply("⚠️ <b>فروش موقتاً غیرفعال است</b>\nاطلاعات پرداخت هنوز توسط مدیر تنظیم نشده است.",[[callback("🏠 منوی اصلی","customer:home")] ],{parse_mode:"HTML"});
      return true;
    }
    const plans=await customerPlans(db);
    if(!plans.length) {
      await reply("فعلاً پلن فعالی برای خرید وجود ندارد.",[[callback("🏠 منوی اصلی","customer:home")]]);
      return true;
    }
    const pageSize=4;
    const page=Math.min(catalogPageMatch?Number(catalogPageMatch[1]):0,Math.max(0,Math.ceil(plans.length/pageSize)-1));
    const offset=page*pageSize,visible=plans.slice(offset,offset+pageSize);
    const rows:Record<string,unknown>[][]=visible.map(p=>[
      callback("🛍️ انتخاب "+p.name.slice(0,12)+" · "+Math.round(p.quotaBytes/1e9).toLocaleString("fa-IR")+"GB · "+Math.round(p.durationSeconds/86400).toLocaleString("fa-IR")+"روز","customer:plan:"+p.id),
    ]);
    const nav:Record<string,unknown>[]=[];
    if(page>0) nav.push(callback("◀️ قبلی","customer:plans:"+(page-1)));
    if(offset+pageSize<plans.length) nav.push(callback("بعدی ▶️","customer:plans:"+(page+1)));
    if(nav.length) rows.push(nav);
    rows.push([callback("🏠 منوی اصلی","customer:home")]);
    const details=visible.map((p,i)=>
      "<b>"+(offset+i+1).toLocaleString("fa-IR")+". "+escapeHtml(p.name)+"</b>\n"+
      "📦 حجم: <b>"+gb(p.quotaBytes)+"</b>\n"+
      "⏳ مدت: <b>"+days(p.durationSeconds)+"</b>\n"+
      "💳 قیمت: <b>"+money(p.price,p.currency)+"</b>\n"+
      "📊 هزینه هر گیگ: "+money(Math.round(p.price/(p.quotaBytes/1e9)),p.currency)
    ).join("\n\n────────────\n\n");
    await reply("🛍️ <b>فروشگاه مدار</b>\nپلن مناسب مصرفت را انتخاب کن. قیمت و حجم پیش از ثبت سفارش کاملاً مشخص است.\n\n"+details+
      "\n\n<code>صفحه "+(page+1).toLocaleString("fa-IR")+" از "+Math.max(1,Math.ceil(plans.length/pageSize)).toLocaleString("fa-IR")+"</code>",rows,
      {parse_mode:"HTML",link_preview_options:{is_disabled:true}});
    return true;
  }

  const planMatch=data.match(/^customer:plan:([a-zA-Z0-9_-]{1,40})$/);
  if(planMatch) {
    const planId=planMatch[1]!;
    const plan=(await customerPlans(db)).find(p=>p.id===planId);
    if(!plan) {
      await reply("این پلن دیگر فعال نیست. فهرست پلن‌ها را دوباره باز کن.",[[callback("🛍️ پلن‌ها","customer:buy")],[callback("🏠 منوی اصلی","customer:home")]]);
      return true;
    }
    const nodes=(await availableCustomerNodes(db,now,plan.quotaBytes)).slice(0,100);
    if(!nodes.length) {
      await setConversation("");
      await reply("⚠️ <b>فعلاً سرور آماده‌ای با ظرفیت کافی نداریم</b>\nموجودی سرورها را دوباره بررسی کن یا پلن دیگری انتخاب کن.",[
        [callback("🔄 بررسی دوباره","customer:plan:"+planId)],
        [callback("🛍️ سایر پلن‌ها","customer:buy")],
        [callback("🏠 منوی اصلی","customer:home")],
      ],{parse_mode:"HTML"});
      return true;
    }
    const nodeState:NodeState={flow:"customer-node-list",planId,nodes,nonce:crypto.randomUUID().replaceAll("-","")};
    await setConversation(NODE_STATE_PREFIX+JSON.stringify(nodeState));
    const pageSize=8;
    const rows:Record<string,unknown>[][]=nodes.slice(0,pageSize).map((node,index)=>[
      callback("🟢 "+node.name.slice(0,38),"customer:node:"+planId+":"+index),
    ]);
    if(nodes.length>pageSize) rows.push([callback("سرورهای بیشتر ▶️","customer:nodes:"+planId+":1")]);
    rows.push([callback("◀️ بازگشت به پلن‌ها","customer:buy")],[callback("🏠 منوی اصلی","customer:home")]);
    await reply("<b>🌐 انتخاب سرور</b>\n\n<b>پلن:</b> "+escapeHtml(plan.name)+
      "\n📦 حجم: "+gb(plan.quotaBytes)+" · ⏳ مدت: "+days(plan.durationSeconds)+
      "\n💳 مبلغ: <b>"+money(plan.price,plan.currency)+"</b>\n\nفقط سرورهای سالم و دارای ظرفیت کافی نمایش داده می‌شوند. حالا سرور را انتخاب کن.",rows,{parse_mode:"HTML"});
    return true;
  }

  const nodePage=data.match(/^customer:nodes:([a-zA-Z0-9_-]{1,40}):(0|[1-9][0-9]{0,2})$/);
  if(nodePage) {
    const nodeState=state?parseNodeState(state):null;
    const page=Number(nodePage[2]);
    if(!nodeState || nodeState.planId!==nodePage[1]) {
      await reply("این انتخاب منقضی شده؛ لطفاً پلن و سرور را دوباره انتخاب کن.",[[callback("🛍️ شروع خرید","customer:buy")],[callback("🏠 منوی اصلی","customer:home")]]);
      return true;
    }
    const pageSize=8,offset=page*pageSize;
    const visible=nodeState.nodes.slice(offset,offset+pageSize);
    if(!visible.length) {
      await reply("این صفحه سرور ندارد.",[[callback("◀️ بازگشت به سرورها","customer:nodes:"+nodeState.planId+":"+Math.max(0,page-1))]]);
      return true;
    }
    const rows:Record<string,unknown>[][]=visible.map((node,i)=>[
      callback(node.name.slice(0,45),"customer:node:"+nodeState.planId+":"+(offset+i)),
    ]);
    const nav:Record<string,unknown>[]=[];
    if(page>0) nav.push(callback("◀️ قبلی","customer:nodes:"+nodeState.planId+":"+(page-1)));
    if(offset+pageSize<nodeState.nodes.length) nav.push(callback("بعدی ▶️","customer:nodes:"+nodeState.planId+":"+(page+1)));
    if(nav.length) rows.push(nav);
    rows.push([callback("◀️ بازگشت به پلن‌ها","customer:buy")],[callback("🏠 منوی اصلی","customer:home")]);
    await reply("سرور موردنظر را انتخاب کن:",rows);
    return true;
  }

  const nodeMatch=data.match(/^customer:node:([a-zA-Z0-9_-]{1,40}):(0|[1-9][0-9]{0,2})$/);
  if(nodeMatch) {
    const nodeState=state?parseNodeState(state):null;
    const index=Number(nodeMatch[2]);
    if(!nodeState || nodeState.planId!==nodeMatch[1] || !nodeState.nodes[index]) {
      await reply("این انتخاب منقضی شده؛ برای جلوگیری از ثبت سفارش تکراری، خرید را دوباره آغاز کن.",[[callback("🛍️ شروع خرید","customer:buy")],[callback("🏠 منوی اصلی","customer:home")]]);
      return true;
    }
    const node=nodeState.nodes[index]!;
    try {
      const order=await createCustomerOrder(db,actor,{planId:nodeState.planId,nodeId:node.id,requestKey:"tg_"+userId+"_"+nodeState.nonce},now);
      await requestCustomerReceipt(db,actor,order.id);
      const payment=(await paymentInstructions(db))||"اطلاعات پرداخت ثبت نشده است.";
      const plan=(await customerPlans(db)).find(p=>p.id===order.plan_id);
      const rows:Record<string,unknown>[][]=[
        [callback("📸 ارسال رسید پرداخت","customer:receipt:"+order.id)],
        [callback("📦 سفارش‌های من","customer:orders:0"),callback("🏠 منوی اصلی","customer:home")],
      ];
      if(payment.length<=256) rows.unshift([{text:"📋 کپی اطلاعات پرداخت",copy_text:{text:payment}}]);
      const output="<b>🧾 سفارش مدار ثبت شد</b>\n"+
        "━━━━━━━━━━━━━━━━\n"+
        "🔖 <b>شماره سفارش:</b> #"+order.id.slice(0,8).toUpperCase()+"\n"+
        "🆔 <code>"+order.id+"</code>\n"+
        "📦 <b>پلن:</b> "+escapeHtml(plan?.name||order.plan_id)+"\n"+
        "🌐 <b>سرور:</b> "+escapeHtml(node.name)+"\n"+
        "📊 <b>حجم:</b> "+gb(order.quota_bytes)+" · ⏳ <b>مدت:</b> "+days(order.duration_seconds)+"\n"+
        "💳 <b>مبلغ نهایی:</b> "+money(order.price,order.currency)+"\n"+
        "━━━━━━━━━━━━━━━━\n"+
        "🏦 <b>اطلاعات پرداخت</b>\n"+escapeHtml(payment)+"\n\n"+
        "۱. مبلغ دقیق را واریز کن.\n۲. دکمه «ارسال رسید پرداخت» را بزن یا عکس رسید را همین‌جا بفرست.\n"+
        "۳. پس از بررسی مدیر و تأیید سرور، کانفیگ از همین ربات تحویل داده می‌شود.\n\n"+
        "🔒 تا تأیید پرداخت و آماده‌شدن سرور، کانفیگی صادر نمی‌شود.";
      await reply(output,rows,{parse_mode:"HTML",link_preview_options:{is_disabled:true}});
      return true;
    } catch(error) {
      const code=error instanceof Error?error.message:"";
      const known=["SALES_DISABLED","PLAN_UNAVAILABLE","NODE_UNAVAILABLE","NODE_FULL","NODE_ALLOCATION_FULL","NODE_SLOT_LIMIT","SELLER_ACCOUNT_LIMIT","SELLER_ALLOCATION_FULL","KEY_REUSED","PENDING_ORDER_EXISTS"];
      if(!known.includes(code)) throw error;
      if(code==="PENDING_ORDER_EXISTS") {
        const pending=await db.prepare("SELECT id,price,currency FROM customer_orders WHERE user_id=? AND state='awaiting_receipt' ORDER BY created_at DESC LIMIT 1")
          .bind(userId).first<{id:string;price:number;currency:string}>();
        await reply("یک سفارش هنوز منتظر رسید است. ابتدا همان سفارش را ادامه بده تا رسید به سفارش اشتباه وصل نشود.",[
          ...(pending?[[callback("📸 ادامه سفارش · "+money(pending.price,pending.currency),"customer:receipt:"+pending.id)]]:[]),
          [callback("📦 سفارش‌های من","customer:orders:0")],
          [callback("🏠 منوی اصلی","customer:home")],
        ]);
        return true;
      }
      await reply(code==="SALES_DISABLED"?"خرید موقتاً غیرفعال است؛ مدیر باید اطلاعات پرداخت را تنظیم کند.":
        code==="PLAN_UNAVAILABLE"?"این پلن دیگر فعال نیست.":
        "ظرفیت این سرور تغییر کرده است؛ سرور دیگری انتخاب کن.",[
          [callback("🔄 انتخاب دوباره سرور","customer:plan:"+nodeState.planId)],
          [callback("🛍️ پلن‌ها","customer:buy")],
          [callback("🏠 منوی اصلی","customer:home")],
        ]);
      return true;
    }
  }

  const servicesPage=data.match(/^customer:services:(0|[1-9][0-9]{0,2})$/);
  if(data==="customer:services" || servicesPage || command==="/services") {
    await setConversation("");
    const all=(await listCustomerOrders(db,actor)).filter(order=>order.state==="approved");
    const page=servicesPage?Number(servicesPage[1]):0;
    const pageSize=6,offset=page*pageSize,visible=all.slice(offset,offset+pageSize);
    const rows:Record<string,unknown>[][]=visible.map(order=>[
      callback("🔎 جزئیات · "+order.planName.slice(0,22),"customer:order:"+order.id),
    ]);
    const nav:Record<string,unknown>[]=[];
    if(page>0) nav.push(callback("◀️ قبلی","customer:services:"+(page-1)));
    if(offset+pageSize<all.length) nav.push(callback("بعدی ▶️","customer:services:"+(page+1)));
    if(nav.length) rows.push(nav);
    rows.push([callback("🛍️ خرید اشتراک","customer:buy")],[callback("🏠 منوی اصلی","customer:home")]);
    const cards=visible.map((order,i)=>{
      const used=Math.min(order.quotaBytes,Math.max(0,order.usedBytes||0));
      const remaining=Math.max(0,order.quotaBytes-used);
      let card="<b>"+(offset+i+1).toLocaleString("fa-IR")+". "+escapeHtml(order.planName)+"</b>\n"+
        "📌 وضعیت: <b>"+statusLabel(order,now)+"</b>\n"+
        "📦 حجم کل: "+gb(order.quotaBytes);
      if(order.usedBytes!==null) card+="\n"+usageBar(used,order.quotaBytes)+"\n📈 مصرف: "+traffic(used)+" · 🟢 باقی‌مانده: "+traffic(remaining);
      if(order.validUntil!==null) card+="\n⏰ اعتبار تا: "+dateTime(order.validUntil);
      if(order.serverName) card+="\n🌐 سرور: "+escapeHtml(order.serverName);
      return card;
    }).join("\n\n────────────\n\n");
    await reply(visible.length?
      "🌐 <b>سرویس‌های من</b>\nوضعیت، حجم باقی‌مانده و اعتبار هر اشتراک را از اینجا ببین. برای جزئیات یا دریافت کانفیگ، سرویس را انتخاب کن.\n\n"+cards:
      "🌐 <b>هنوز اشتراک فعالی در حساب تو نیست</b>\nپس از تأیید پرداخت و آماده‌شدن سرور، سرویس اینجا نمایش داده می‌شود.",
      rows,{parse_mode:"HTML"});
    return true;
  }

  const ordersPage=data.match(/^customer:orders:(0|[1-9][0-9]{0,2})$/);
  if(data==="customer:orders" || ordersPage || command==="/orders") {
    await setConversation("");
    const page=ordersPage?Number(ordersPage[1]):0;
    const all=await listCustomerOrders(db,actor);
    const pageSize=6,offset=page*pageSize,visible=all.slice(offset,offset+pageSize);
    const rows:Record<string,unknown>[][]=visible.map((order,i)=>[
      callback("🔎 #"+order.id.slice(0,8).toUpperCase()+" · "+statusLabel(order,now),"customer:order:"+order.id),
    ]);
    const nav:Record<string,unknown>[]=[];
    if(page>0) nav.push(callback("◀️ قبلی","customer:orders:"+(page-1)));
    if(offset+pageSize<all.length) nav.push(callback("بعدی ▶️","customer:orders:"+(page+1)));
    if(nav.length) rows.push(nav);
    rows.push([callback("🌐 سرویس‌های من","customer:services")],[callback("🛍️ خرید اشتراک","customer:buy")],[callback("🏠 منوی اصلی","customer:home")]);
    const cards=visible.map((order,i)=>"<b>"+(offset+i+1).toLocaleString("fa-IR")+". "+escapeHtml(order.planName)+"</b>\n"+
      "🔖 سفارش: #"+order.id.slice(0,8).toUpperCase()+"\n"+
      "💳 مبلغ: "+money(order.price,order.currency)+"\n"+
      "📌 وضعیت: <b>"+statusLabel(order,now)+"</b>\n"+
      "🕒 ثبت: "+dateTime(order.createdAt)).join("\n\n────────────\n\n");
    await reply(visible.length?
      "📦 <b>سفارش‌های من</b>\nبرای دیدن جزئیات، ادامه پرداخت یا دریافت کانفیگ یک سفارش را انتخاب کن.\n\n"+cards:
      "📦 <b>هنوز سفارشی ثبت نکرده‌ای</b>\nاز فروشگاه مدار شروع کن؛ بعد از ثبت سفارش، تمام مراحل همین‌جا قابل پیگیری است.",
      rows,{parse_mode:"HTML"});
    return true;
  }

  const orderMatch=data.match(/^customer:order:([a-f0-9-]{36})$/);
  if(orderMatch) {
    const order=(await listCustomerOrders(db,actor)).find(o=>o.id===orderMatch[1]);
    if(!order) {
      await reply("این سفارش در حساب تو پیدا نشد.",[[callback("📦 سفارش‌های من","customer:orders:0")],[callback("🏠 منوی اصلی","customer:home")]]);
      return true;
    }
    const rows:Record<string,unknown>[][]=[];
    if(order.state==="awaiting_receipt") {
      rows.push([callback("📸 ادامه پرداخت و ارسال رسید","customer:receipt:"+order.id)]);
      rows.push([callback("🗑️ انصراف از سفارش پرداخت‌نشده","customer:cancel-confirm:"+order.id)]);
    }
    if(order.state==="approved") rows.push([callback("📥 دریافت کانفیگ","customer:config:"+order.id)]);
    rows.push([callback("🌐 سرویس‌های من","customer:services")],[callback("📦 سفارش‌های من","customer:orders:0")],[callback("🏠 منوی اصلی","customer:home")]);
    let details="<b>📦 جزئیات سفارش مدار</b>\n\n🔖 شماره: <code>"+order.id+"</code>\n📦 پلن: "+escapeHtml(order.planName)+
      "\n💳 مبلغ: "+money(order.price,order.currency)+"\n📊 حجم کل: "+gb(order.quotaBytes)+
      " · ⏳ مدت: "+days(order.durationSeconds)+"\n📌 وضعیت: <b>"+statusLabel(order,now)+"</b>";
    if(order.serverName) details+="\n🛰️ سرور: "+escapeHtml(order.serverName);
    if(order.state==="approved" && order.accountId) {
      if(order.usedBytes!==null) {
        const used=Math.min(order.quotaBytes,Math.max(0,order.usedBytes));
        const remaining=Math.max(0,order.quotaBytes-used);
        details+="\n\n"+usageBar(used,order.quotaBytes)+"\n📈 مصرف: "+traffic(used)+" از "+gb(order.quotaBytes)+
          "\n🟢 حجم باقی‌مانده: "+traffic(remaining);
      }
      if(order.validUntil!==null) details+="\n⏰ تاریخ انقضا: "+dateTime(order.validUntil);
    }
    if(order.reason) details+="\n\n📝 توضیحات: "+escapeHtml(order.reason);
    await reply(details,rows,{parse_mode:"HTML"});
    return true;
  }

  const cancelConfirm=data.match(/^customer:cancel-confirm:([a-f0-9-]{36})$/);
  if(cancelConfirm) {
    const order=(await listCustomerOrders(db,actor)).find(item=>item.id===cancelConfirm[1] && item.state==="awaiting_receipt");
    if(!order) {
      await reply("این سفارش قابل لغو نیست؛ ممکن است رسید آن ثبت شده باشد.",[
        [callback("📦 سفارش‌های من","customer:orders:0")],[callback("🏠 منوی اصلی","customer:home")],
      ]);
      return true;
    }
    await reply("⚠️ <b>انصراف از سفارش</b>\n\nسفارش #"+order.id.slice(0,8).toUpperCase()+
      "\nپلن: "+escapeHtml(order.planName)+"\nمبلغ: "+money(order.price,order.currency)+
      "\n\n<b>فقط اگر هنوز وجهی واریز نکرده‌ای لغو کن.</b>"+
      "\nاگر واریز انجام شده، برگرد و رسید را ارسال کن. لغو سفارش به معنای استرداد وجه نیست.",[
      [callback("✅ بله، پرداخت نکرده‌ام؛ لغو سفارش","customer:cancel:"+order.id)],
      [callback("📸 بازگشت به ارسال رسید","customer:receipt:"+order.id)],
      [callback("📦 سفارش‌های من","customer:orders:0")],
    ],{parse_mode:"HTML"});
    return true;
  }
  const cancelMatch=data.match(/^customer:cancel:([a-f0-9-]{36})$/);
  if(cancelMatch) {
    try {
      await cancelUnpaidCustomerOrder(db,actor,cancelMatch[1]!,now);
      await setConversation("");
      await reply("✅ <b>سفارش پرداخت‌نشده لغو شد.</b>\nحالا می‌توانی بدون ثبت سفارش تکراری، پلن دیگری انتخاب کنی.",[
        [callback("🛍️ انتخاب پلن جدید","customer:buy")],
        [callback("📦 سفارش‌های من","customer:orders:0")],
        [callback("🏠 منوی اصلی","customer:home")],
      ],{parse_mode:"HTML"});
    } catch(error) {
      if(!(error instanceof Error)||error.message!=="ORDER_NOT_AVAILABLE") throw error;
      await reply("سفارش دیگر قابل لغو نیست؛ اگر رسید فرستاده‌ای وضعیت را از سفارش‌ها بررسی کن.",[
        [callback("📦 سفارش‌های من","customer:orders:0")],
      ]);
    }
    return true;
  }

  const receiptMatch=data.match(/^customer:receipt:([a-f0-9-]{36})$/);
  if(receiptMatch) {
    try {
      await requestCustomerReceipt(db,actor,receiptMatch[1]!);
      const order=(await listCustomerOrders(db,actor)).find(item=>item.id===receiptMatch[1]);
      const rows:Record<string,unknown>[][]=[
        [callback("📦 سفارش‌های من","customer:orders:0"),callback("🏠 منوی اصلی","customer:home")],
      ];
      const output="<b>📸 ارسال رسید پرداخت</b>\n━━━━━━━━━━━━━━━━\n"+
        "🔖 سفارش: #"+receiptMatch[1]!.slice(0,8).toUpperCase()+"\n"+
        (order?"📦 پلن: "+escapeHtml(order.planName)+"\n💳 مبلغ: "+money(order.price,order.currency)+"\n":"")+
        "\nحالا عکس واضح یا فایل رسید بانکی را به‌صورت پیام در همین چت بفرست.\n\n"+
        "🔎 رسید در بخش مدیریت ربات بررسی می‌شود. تا تأیید و آماده‌شدن سرور، کانفیگی صادر نمی‌شود.";
      await reply(output,rows,{parse_mode:"HTML"});
    } catch(error) {
      if(!(error instanceof Error) || error.message!=="ORDER_NOT_AVAILABLE") throw error;
      await reply("این سفارش دیگر منتظر رسید نیست. وضعیت آن را در «سفارش‌های من» بررسی کن.",[[callback("📦 سفارش‌های من","customer:orders:0")]]);
    }
    return true;
  }

  const qrMatch=data.match(/^customer:qr:([a-f0-9-]{36})$/);
  if(qrMatch) {
    try {
      const result=await customerConfig(env,actor,qrMatch[1]!,now);
      if(!result.ready || typeof result.validUntil!=="number" || typeof result.quotaBytes!=="number" || typeof result.config!=="string") {
        await reply("کانفیگ هنوز تأیید نهایی سرور را نگرفته است. کمی بعد دوباره تلاش کن.",[
          [callback("🔄 بررسی کانفیگ","customer:config:"+qrMatch[1])],
          [callback("📦 سفارش‌های من","customer:orders:0")],
        ]);
        return true;
      }
      const qrUrl=await createCustomerQrUrl(env,userId,qrMatch[1]!,now);
      const rows:Record<string,unknown>[][]=[];
      if(result.config.length<=256) rows.push([{text:"📋 کپی کانفیگ",copy_text:{text:result.config}}]);
      if(result.usageUrl) rows.push([{text:"📊 مصرف و اعتبار",url:result.usageUrl}]);
      rows.push([callback("📖 راهنمای اتصال","customer:help")],[callback("🌐 سرویس‌های من","customer:services")],[callback("🏠 منوی اصلی","customer:home")]);
      const caption="<b>📷 QR اختصاصی اشتراک مدار</b>\n\n"+
        "🛰️ سرور: <b>"+escapeHtml(result.serverName)+"</b>\n"+
        "📦 حجم کل: "+gb(result.quotaBytes)+"\n"+
        "⏰ اعتبار تا: "+dateTime(result.validUntil)+"\n\n"+
        "در برنامه VPN گزینه افزودن با QR را انتخاب و این تصویر را اسکن کن.\n"+
        "🔒 این تصویر مخصوص اشتراک توست؛ آن را برای دیگران نفرست.";
      await enqueue(db,"u"+u.update_id+":reply",userId,{
        _method:"sendPhoto",photo:qrUrl,caption,parse_mode:"HTML",
        reply_markup:{inline_keyboard:rows},
      });
    } catch(error) {
      if(!(error instanceof Error) || error.message!=="ORDER_NOT_AVAILABLE") throw error;
      await reply("این سفارش یا کانفیگ برای حساب تو در دسترس نیست.",[[callback("📦 سفارش‌های من","customer:orders:0")]]);
    }
    return true;
  }

  const configMatch=data.match(/^customer:config:([a-f0-9-]{36})$/);
  if(configMatch) {
    try {
      const result=await customerConfig(env,actor,configMatch[1]!,now);
      if(!result.ready || typeof result.validUntil !== "number" || typeof result.quotaBytes !== "number" || typeof result.config !== "string") {
        await reply("پرداخت تأیید شده؛ کانفیگ هنوز از سرور تأیید نهایی نگرفته است. کمی بعد دوباره بررسی کن.",[
          [callback("🔄 بررسی کانفیگ","customer:config:"+configMatch[1])],
          [callback("📦 سفارش‌های من","customer:orders:0")],
        ]);
        return true;
      }
      const output="<b>✅ اشتراک مدار آماده است</b>\n"+
        "━━━━━━━━━━━━━━━━\n"+
        "🛰️ <b>سرور:</b> "+escapeHtml(result.serverName)+"\n"+
        "📦 <b>حجم کل:</b> "+gb(result.quotaBytes)+"\n"+
        "⏰ <b>اعتبار تا:</b> "+dateTime(result.validUntil)+"\n\n"+
        "<b>🔑 کانفیگ اختصاصی تو</b>\n<pre>"+escapeHtml(result.config)+"</pre>\n"+
        "از دکمه کپی استفاده کن یا QR را در برنامه VPN اسکن کن.\n\n"+
        "🔒 این کانفیگ مخصوص حساب توست؛ آن را برای دیگران ارسال نکن.";
      const rows:Record<string,unknown>[][]=[];
      if(result.config.length<=256) rows.push([{text:"📋 کپی کانفیگ",copy_text:{text:result.config}}]);
      rows.push([callback("📷 نمایش QR","customer:qr:"+configMatch[1]),callback("📖 راهنمای اتصال","customer:help")]);
      if(result.usageUrl) rows.push([{text:"📊 مصرف و اعتبار",url:result.usageUrl}]);
      rows.push([callback("🌐 سرویس‌های من","customer:services")],[callback("📦 سفارش‌های من","customer:orders:0")],[callback("🏠 منوی اصلی","customer:home")]);
      await reply(output,rows,{parse_mode:"HTML",link_preview_options:{is_disabled:true}});
    } catch(error) {
      if(!(error instanceof Error) || error.message!=="ORDER_NOT_AVAILABLE") throw error;
      await reply("این سفارش یا کانفیگ برای حساب تو در دسترس نیست.",[[callback("📦 سفارش‌های من","customer:orders:0")]]);
    }
    return true;
  }

  const helpMatch=data.match(/^customer:help:(android|ios|windows|mac)$/);
  if(data==="customer:help" || command==="/help") {
    await reply("📖 راهنمای مدار\n\n<b>خرید:</b> پلن و سرور را انتخاب کن، مبلغ را واریز کن و رسید را در همین چت بفرست. پس از تأیید پرداخت و آماده‌شدن سرور، کانفیگ در دسترس است.\n\n<b>اتصال:</b> سیستم‌عاملت را انتخاب کن تا برنامه سازگار و روش واردکردن کانفیگ را ببینی.",[
      [callback("🤖 اندروید","customer:help:android"),callback("🍎 آیفون و آیپد","customer:help:ios")],
      [callback("💻 ویندوز","customer:help:windows"),callback("🖥️ مک","customer:help:mac")],
      [callback("🛍️ خرید اشتراک","customer:buy")],[callback("🏠 منوی اصلی","customer:home")],
    ],{parse_mode:"HTML"});
    return true;
  }
  if(helpMatch) {
    const guides={
      android:{title:"🤖 اندروید · v2rayNG",url:"https://github.com/2dust/v2rayNG/releases",source:"دانلود v2rayNG از GitHub رسمی",steps:"۱) برنامه را از صفحه رسمی دانلود و نصب کن.\n۲) در مدار، کانفیگ را کپی کن.\n۳) در v2rayNG گزینه Import from clipboard را بزن.\n۴) سرور را انتخاب کن و اتصال را روشن کن."},
      ios:{title:"🍎 آیفون و آیپد · V2Box",url:"https://apps.apple.com/app/v2box-v2ray-client/id6446814690",source:"مشاهده V2Box در App Store",steps:"۱) V2Box را از App Store نصب کن.\n۲) کانفیگ را از مدار کپی کن.\n۳) در برنامه گزینه افزودن یا واردکردن از Clipboard را انتخاب کن.\n۴) پروفایل را فعال کن."},
      windows:{title:"💻 ویندوز · v2rayN",url:"https://github.com/2dust/v2rayN/releases",source:"دانلود v2rayN از GitHub رسمی",steps:"۱) نسخه مناسب ویندوز را از صفحه رسمی بگیر و استخراج کن.\n۲) کانفیگ را در مدار کپی کن.\n۳) در v2rayN گزینه Import share link from clipboard را انتخاب کن.\n۴) پروفایل را فعال کن و اتصال را روشن کن."},
      mac:{title:"🖥️ مک · V2Box",url:"https://apps.apple.com/app/v2box-v2ray-client/id6446814690",source:"مشاهده V2Box در App Store",steps:"۱) V2Box را از App Store نصب کن.\n۲) کانفیگ را از مدار کپی کن.\n۳) در برنامه آن را از Clipboard وارد کن.\n۴) پروفایل را فعال کن."},
    } as const;
    const guide=guides[helpMatch[1] as keyof typeof guides];
    await reply("<b>"+guide.title+"</b>\n\n"+guide.steps+"\n\nاگر اتصال برقرار نشد، اول مطمئن شو اشتراک منقضی یا تمام‌حجم نشده باشد.",[
      [{text:"⬇️ "+guide.source,url:guide.url}],
      [callback("↩️ انتخاب دستگاه دیگر","customer:help")],
      [callback("🌐 سرویس‌های من","customer:services")],[callback("🏠 منوی اصلی","customer:home")],
    ],{parse_mode:"HTML",link_preview_options:{is_disabled:true}});
    return true;
  }

  if(state?.startsWith("customer-receipt:") && (u.message?.photo?.length || u.message?.document)) {
    const orderId=state.slice("customer-receipt:".length);
    const fileId=u.message?.document?.file_id ?? u.message?.photo?.at(-1)?.file_id ?? "";
    try {
      const accepted=await submitCustomerReceipt(db,userId,orderId,fileId,u.message?.document?"document":"photo");
      await setConversation("");
      await reply(accepted?"✅ رسید ثبت شد و برای بررسی مدیر ارسال شد. نتیجه را از «سفارش‌های من» پیگیری کن.":"این سفارش قبلاً رسید دارد و در انتظار بررسی مدیر است.",[
        [callback("📦 سفارش‌های من","customer:orders:0")],[callback("🏠 منوی اصلی","customer:home")],
      ]);
      if(accepted) for(const adminId of (env.ADMIN_TELEGRAM_IDS||"").split(",").map(s=>s.trim()).filter(s=>/^\d+$/.test(s)))
        await enqueue(db,"customer-review:"+orderId+":"+adminId,adminId,{
          text:"💳 رسید جدید مشتری "+userId+"؛ سفارش "+orderId,
          reply_markup:{inline_keyboard:[[callback("بررسی رسید","cust:review:"+orderId)]]},
        });
    } catch(error) {
      if(!(error instanceof Error) || error.message!=="ORDER_NOT_AVAILABLE") throw error;
      await setConversation("");
      await reply("این سفارش دیگر منتظر رسید نیست. وضعیت آن را از «سفارش‌های من» بررسی کن.",[[callback("📦 سفارش‌های من","customer:orders:0")]]);
    }
    return true;
  }
  if(state?.startsWith("customer-receipt:")) {
    await reply("برای این سفارش، عکس یا فایل رسید پرداخت را به‌صورت پیام همین چت بفرست. برای لغو و بازگشت /start را ارسال کن.");
    return true;
  }

  await reply("برای ادامه از دکمه‌های منو استفاده کن یا /start را بفرست.",homeRows);
  return true;
}
